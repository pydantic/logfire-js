import type { ToolSet } from 'ai'

import { asSchema } from 'ai'

import type { JsonSchema } from './signature'

import { normalizeSchema } from './normalize'
import { pyIsKeyword } from './python'
import { FunctionSignature } from './signature'

/** A tool as the sandbox sees it: a Python function name and its normalized schemas. */
export interface PythonFunction {
  name: string
  description?: string | undefined
  parametersSchema: JsonSchema
  returnSchema?: JsonSchema | undefined
}

export interface PythonStubs {
  /** TypedDict definitions for the model-facing catalog, each one a Python class. */
  typeDefinitions: string[]
  /** One `async def` per tool for the model-facing catalog, with `...` as the body. */
  functions: string[]
  /** A module for Monty's type checker: imports, TypedDicts, and every function. */
  typeCheckStubs: string
}

export interface ToolStubs extends PythonStubs {
  /** The tool name behind each Python function name, for tools whose names had to change. */
  toolNames: ReadonlyMap<string, string>
}

type AnyTool = ToolSet[string]

const RUN_CODE = 'run_code'

const TYPE_CHECK_HEADER = 'import asyncio\nfrom typing import Any, TypedDict, NotRequired, Literal'

/**
 * Render the Python catalog and type-check stubs for AI SDK tools, as pydantic-ai CodeMode renders them for
 * its tools.
 */
export function toolStubs(tools: ToolSet): ToolStubs {
  const { functions, toolNames } = pythonFunctions(tools)
  return { ...renderPythonStubs(functions), toolNames }
}

/** Python names and normalized schemas for AI SDK tools. */
export function pythonFunctions(tools: ToolSet): { functions: PythonFunction[]; toolNames: Map<string, string> } {
  const functions: PythonFunction[] = []
  const toolNames = new Map<string, string>()
  const seen = new Map<string, string>()

  for (const [toolName, tool] of Object.entries(tools)) {
    const name = sanitizeToolName(toolName)
    if (name === RUN_CODE) {
      throw new Error(`Tool "${toolName}" becomes the Python function "${name}", which code mode reserves for itself. Rename the tool.`)
    }
    const existing = seen.get(name)
    if (existing !== undefined) {
      // pydantic-ai keeps the first tool and hides the other with a warning. A tool set here is fixed in code,
      // so a hidden tool would be a bug that nobody sees.
      throw new Error(`Tools "${existing}" and "${toolName}" both become the Python function "${name}". Rename one of them.`)
    }
    seen.set(name, toolName)
    if (name !== toolName) {
      toolNames.set(name, toolName)
    }

    const outputSchema = tool.outputSchema === undefined ? undefined : outputJsonSchema(toolName, tool)
    if (outputSchema === undefined) {
      warnMissingOutputSchema(toolName, tool)
    }
    if (typeof tool.description === 'function') {
      throw new Error(`Tool "${toolName}" has a description that depends on its context, which code mode cannot render yet`)
    }
    functions.push({
      name,
      description: tool.description,
      parametersSchema: normalizeSchema(inputJsonSchema(toolName, tool), name, 'parameters'),
      returnSchema: outputSchema === undefined ? undefined : normalizeSchema(outputSchema, name, 'return'),
    })
  }
  return { functions, toolNames }
}

/** Port of pydantic-ai CodeMode's `_render_catalog` and `_build_type_check_stubs`, without the prose header. */
export function renderPythonStubs(functions: PythonFunction[]): PythonStubs {
  const entries = functions.map((f) => ({ f, sig: FunctionSignature.fromSchema(f.name, f.parametersSchema, f.returnSchema) }))
  const sigs = entries.map(({ sig }) => sig)
  const conflicting = FunctionSignature.getConflictingTypeNames(sigs)
  const typeNames = FunctionSignature.prefixedTypeNames(sigs, conflicting)
  const typeDefinitions = FunctionSignature.renderTypeDefinitions(sigs, conflicting)
  const render = (body: string): string[] =>
    entries.map(({ f, sig }) =>
      sig.render(body, { name: f.name, description: f.description, isAsync: true, conflictingTypeNames: conflicting, typeNames })
    )
  return {
    typeDefinitions,
    functions: render('...'),
    typeCheckStubs: [TYPE_CHECK_HEADER, ...typeDefinitions, ...render('raise NotImplementedError()')].join('\n\n'),
  }
}

/** Port of pydantic-ai's `sanitize_tool_name`. */
export function sanitizeToolName(name: string): string {
  let sanitized = name.replace(/[^a-zA-Z0-9_]/gu, '_')
  if (/^[0-9]/u.test(sanitized)) {
    sanitized = `_${sanitized}`
  }
  if (pyIsKeyword(sanitized)) {
    sanitized = `${sanitized}_`
  }
  return sanitized || '_'
}

function inputJsonSchema(toolName: string, tool: AnyTool): JsonSchema {
  return syncSchema(toolName, asSchema(tool.inputSchema).jsonSchema)
}

type OutputConverter = (options: { target: string }) => unknown

// The Standard JSON Schema `output()` converter, which zod 4 and other Standard Schema libraries provide.
function standardOutputConverter(schema: unknown): OutputConverter | undefined {
  const standard = (schema as { '~standard'?: { jsonSchema?: { output?: unknown } } } | null | undefined)?.['~standard']
  const output = standard?.jsonSchema?.output
  return typeof output === 'function' ? (output as OutputConverter) : undefined
}

// asSchema() converts zod with `io: 'input'`, which is the wrong shape for a schema that transforms its value,
// such as `z.string().pipe(z.coerce.number())`. Standard JSON Schema converters can produce the output shape.
function outputJsonSchema(toolName: string, tool: AnyTool): JsonSchema {
  const convert = standardOutputConverter(tool.outputSchema)
  if (convert !== undefined) {
    return syncSchema(toolName, convert({ target: 'draft-07' }))
  }
  return syncSchema(toolName, asSchema(tool.outputSchema).jsonSchema)
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return typeof (value as { then?: unknown }).then === 'function'
}

function syncSchema(toolName: string, schema: unknown): JsonSchema {
  if (isPromiseLike(schema)) {
    // The conversion has already started. Without a handler, its rejection would be unhandled after we throw.
    Promise.resolve(schema).catch(() => undefined)
    throw new Error(`Tool "${toolName}" has a schema that converts to JSON Schema asynchronously, which code mode does not support`)
  }
  return schema as JsonSchema
}

const warnedTools = new WeakSet<AnyTool>()

function warnMissingOutputSchema(toolName: string, tool: AnyTool): void {
  if (warnedTools.has(tool)) {
    return
  }
  warnedTools.add(tool)
  console.warn(
    `Tool "${toolName}" has no outputSchema, so code mode shows its return type as Any. Add an outputSchema so that the model knows the shape of its result.`
  )
}
