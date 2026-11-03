import type { JSONSchema7, Tool, ToolExecutionOptions, ToolSet } from 'ai'

import { agentSandboxes } from '@pydantic/logfire-agent-sandboxes'
import * as logfire from '@pydantic/logfire-node'
import { asSchema, experimental_toolCaller, tool } from 'ai'
import { z } from 'zod'

// Adapted from the run_code description in Pydantic AI Code Mode, which lists what Monty 1.4 can import.
const DESCRIPTION = `Write and run Python code in a sandboxed environment.

The sandbox uses Monty, a subset of Python. Key restrictions:
- No third-party libraries. Only these standard library modules can be imported: sys, typing, asyncio, math, json, re, unicodedata, datetime, time, random, os, pathlib, collections, itertools, functools, dataclasses, copy, base64, binascii, bisect, csv, decimal, hashlib, os.path, tomllib.
- No filesystem, environment variables, or clock.
- State is not kept between calls.

The value of the last expression is returned, so end the code with the value you want back instead of printing it.

These async functions are already defined in the sandbox. Call them with keyword arguments and await them, without importing or redefining them. To run calls concurrently, import asyncio and use await asyncio.gather(...) with positional awaitables.`

const PYTHON_TYPES: Record<string, string> = {
  array: 'list[Any]',
  boolean: 'bool',
  integer: 'int',
  number: 'float',
  object: 'dict[str, Any]',
  string: 'str',
}

function pythonStub(name: string, { description, inputSchema }: Tool): string {
  const schema = asSchema(inputSchema).jsonSchema
  if ('then' in schema) {
    throw new Error(`run_code needs a schema that converts synchronously, but ${name} has an async one`)
  }
  const required = new Set(schema.required)
  const params = Object.entries(schema.properties ?? {}).map(([param, property]: [string, JSONSchema7 | boolean]) => {
    const type = typeof property === 'object' && typeof property.type === 'string' ? (PYTHON_TYPES[property.type] ?? 'Any') : 'Any'
    return required.has(param) ? `${param}: ${type}` : `${param}: ${type} | None = None`
  })
  // A bare `*` with no parameters after it is a syntax error.
  const signature = params.length === 0 ? '' : ['*', ...params].join(', ')
  return `async def ${name}(${signature}) -> Any:\n    """${description ?? ''}"""\n    ...`
}

// Monty returns Python dicts as Maps, which JSON.stringify would send to the model as {}.
function toJson(value: unknown): unknown {
  if (value instanceof Map) {
    return Object.fromEntries(Array.from(value, ([key, item]: [unknown, unknown]) => [String(key), toJson(item)]))
  }
  return Array.isArray(value) ? value.map(toJson) : value
}

function bindRunCode(tools: ToolSet): Tool {
  const stubs = ['from typing import Any', ...Object.entries(tools).map(([name, t]) => pythonStub(name, t))].join('\n\n')

  return tool({
    description: `${DESCRIPTION}\n\n\`\`\`python\n${stubs}\n\`\`\``,
    inputSchema: z.object({ code: z.string().describe('The Python code to run.') }),
    execute: async ({ code }, options: ToolExecutionOptions<unknown>) => {
      // Sandbox code calls these directly, so the AI SDK records no tool spans for them.
      const externalLookup = Object.fromEntries(
        Object.entries(tools).map(([name, { execute }]) => [
          name,
          (kwargs: Record<string, unknown> = {}) =>
            logfire.span('run_code called {tool_name}', { tool_name: name, ...kwargs }, {}, () => execute?.(kwargs, options)),
        ])
      )

      await using pool = await agentSandboxes()
      await using session = await pool.checkout({ ephemeral: true, scriptName: 'run_code.py', typeCheck: true, typeCheckStubs: stubs })
      return toJson(await session.feedRun(code, { externalLookup }))
    },
  })
}

// Tools routed to this caller through `experimental_toolCallers` are hidden from the model and become
// Python functions inside the sandbox, so one model turn can make many tool calls.
export const runCode = experimental_toolCaller(
  tool({
    description: DESCRIPTION,
    inputSchema: z.object({ code: z.string() }),
  }),
  { type: 'local', bind: bindRunCode }
)
