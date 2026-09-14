/**
 * Keeping a managed tool rename inside the model boundary.
 *
 * A rename is the one overlay that has to be undone again. Everything else a managed config changes
 * -- a description, a parameter description, a prompt, a setting -- is only ever *sent*, but a new
 * name comes back: the model calls the tool by it, and whatever the framework is handed then decides
 * which tool runs, what a hook context says, what a span records, and what is written into a thread's
 * message history. If the framework is handed the new name, a rename published in Logfire silently
 * rewrites your code's own vocabulary.
 *
 * So Mastra is never told. The tool record it dispatches, remembers and traces keeps its code-side
 * keys, and this module wraps the model instead: the tools go out advertised under their managed
 * names, a `toolChoice` written against a code name goes out translated with them, the calls the
 * model makes come back translated, and the history Mastra replays -- written in code names, and
 * still in code names after the rename changes or is withdrawn -- is translated forward on every
 * request. What the model sees is the managed vocabulary; what everything on this side of the
 * boundary sees is the code's. An `activeTools` list needs nothing done to it for the same reason:
 * Mastra filters the record by its keys, and those are the names the code wrote.
 *
 * The wrapper is a `Proxy`, which is how Mastra writes its own model wrappers
 * (`withAzureResponsesInputCompatibility`), and it matters here for a second reason: the runner
 * accepts a model a processor returns only after `resolveModelConfig` hands it back unchanged, which
 * it does for an instance of one of its own model classes. A proxy is still that instance.
 */

import type { resolveModelConfig } from '@mastra/core/llm'
import { toolKey, useResolution } from '@pydantic/logfire-node/agent-control'
import type { AppliedTools, Resolution, ToolDef } from '@pydantic/logfire-node/agent-control'

/**
 * A model as Mastra resolves one, which is the only shape its loop will call.
 *
 * `resolveModelConfig` also has a legacy v1 arm; that one is left out, because Mastra's loop refuses
 * a step whose model is not v2, v3 or v4 before it ever calls it.
 */
export type ResolvedModel = Extract<Awaited<ReturnType<typeof resolveModelConfig>>, { specificationVersion: 'v2' | 'v3' | 'v4' }>

/** Which tools this request advertises under a name other than the one the code gave them. */
export interface ToolRenames {
  /** Code-side name to advertised name: the direction everything on the way *out* is rewritten in. */
  toModel: ReadonlyMap<string, string>
  /** Advertised name to code-side name: the direction a call coming *back* is rewritten in. */
  toCode: ReadonlyMap<string, string>
}

/**
 * The renames a request's applied tool definitions amount to, in both directions.
 *
 * Read out of the core's `forward` table rather than by comparing names, so the one place that
 * decides what a tool ends up advertised as -- including a rename it refused for colliding -- is also
 * the place this reads. Mastra advertises every tool into one flat namespace and has no toolsets, so
 * every lookup is under the `null` one.
 *
 * `toCode` is `toModel` inverted, which is exact: the core refuses a rename onto a name that is
 * already advertised, so no two tools of one request share an advertised name.
 */
export function toolRenames(definitions: readonly ToolDef[], applied: AppliedTools): ToolRenames {
  const toModel = new Map<string, string>()
  const toCode = new Map<string, string>()
  for (const def of definitions) {
    const advertised = applied.forward.get(toolKey(null, def.name)) ?? def.name
    if (advertised === def.name) {
      continue
    }
    toModel.set(def.name, advertised)
    toCode.set(advertised, def.name)
  }
  return { toModel, toCode }
}

/**
 * The parts of a model call this adapter rewrites, in the fields every specification version shares.
 *
 * Mastra runs AI SDK v2, v3 and v4 models, and their call options differ -- but not in any of the
 * three fields here, and not in how a tool is named in any of them. So the wrapper reads this shape
 * rather than branching on a version whose differences it never touches.
 */
interface ModelCall {
  /** The tool declarations, absent when the request offers the model none. */
  tools?: readonly ModelTool[]
  /** What the model may or must call; `{ type: 'tool', toolName }` is the one that names a tool. */
  toolChoice?: NamesTool
  /** The messages, whose assistant and tool parts name the tools earlier steps called. */
  prompt: readonly ModelMessage[]
}

/** One advertised tool declaration. */
interface ModelTool {
  readonly name: string
}

/** One message of a prompt: `content` is a string for a system message and a part list otherwise. */
interface ModelMessage {
  readonly content: string | readonly NamesTool[]
}

/** Anything that may name a tool: a content part, a stream chunk, a tool choice. */
interface NamesTool {
  readonly toolName?: string
}

/** What a Mastra model returns from both of its call methods: the response, as a stream. */
interface ModelResult {
  readonly stream: ReadableStream<NamesTool>
}

/**
 * One signature for both call methods.
 *
 * `ResolvedModel` is a union of the v2, v3 and v4 model shapes, so the union's own `doGenerate` takes
 * the *intersection* of their call options -- a type nothing can be passed. Going through one
 * structural signature is what lets the wrapper stay version-agnostic; it is the same reason
 * `ModelCall` describes only the shared fields.
 */
type ModelCallFn = (options: ModelCall) => Promise<ModelResult>

/** The two methods a model call arrives through. Mastra's own wrappers give both a stream. */
const CALL_METHODS = new Set<string | symbol>(['doGenerate', 'doStream'])

/**
 * A model that speaks the managed tool names, wrapping one that is given the code's.
 *
 * Both call methods are wrapped, and both return a stream: Mastra's model classes exist to give
 * `doGenerate` one, and `MastraModelInput` reads the response from `stream` alone -- so the call's
 * `content`, which the v2 wrapper also carries, is not what any tool is dispatched from.
 *
 * The call is made inside the run's resolution, so the request the provider actually receives is
 * attributed to the published version that shaped it.
 *
 * **Everything reaches the wrapped model as itself.** A `Proxy` whose `get` trap forwards the
 * receiver hands the proxy to whatever it read, and a model that keeps anything in a `#private`
 * field -- Mastra's own `ModelRouterLanguageModel` keeps its transport in one -- then throws
 * `Cannot read private member ... from an object whose class did not declare it` the moment that
 * field is touched, because the proxy is not an instance of the class that declared it. So every
 * read is made *with the target as the receiver*, and every method comes back bound to the target,
 * which is what keeps a rename from turning a working model into a broken one. Bound methods are
 * cached per property so that reading the same method twice gives the same function, as it would on
 * the model itself.
 */
export function renamingModel(model: ResolvedModel, renames: ToolRenames, resolution: Resolution): ResolvedModel {
  const bound = new Map<string | symbol, unknown>()
  return new Proxy(model, {
    get(target, property) {
      const cached = bound.get(property)
      if (cached !== undefined) {
        return cached
      }
      const value: unknown = Reflect.get(target, property, target)
      if (!CALL_METHODS.has(property)) {
        if (typeof value !== 'function') {
          return value
        }
        const method: unknown = (value as (...args: never[]) => unknown).bind(target)
        bound.set(property, method)
        return method
      }
      const call = value as ModelCallFn
      const wrapped = async (options: ModelCall): Promise<ModelResult> =>
        useResolution(resolution, async () => {
          const result = await call.call(target, withManagedNames(options, renames.toModel))
          return { ...result, stream: withCodeNames(result.stream, renames.toCode) }
        })
      bound.set(property, wrapped)
      return wrapped
    },
  })
}

/** One call, with every tool it names rewritten to the name the model is being shown. */
function withManagedNames(call: ModelCall, names: ReadonlyMap<string, string>): ModelCall {
  return {
    ...call,
    ...(call.tools === undefined ? {} : { tools: call.tools.map((tool) => renameTool(tool, names)) }),
    ...(call.toolChoice === undefined ? {} : { toolChoice: rename(call.toolChoice, names) }),
    prompt: call.prompt.map((message) => renameMessage(message, names)),
  }
}

/** One response stream, with every tool the model named rewritten to the name the code gave it. */
function withCodeNames(stream: ReadableStream<NamesTool>, names: ReadonlyMap<string, string>): ReadableStream<NamesTool> {
  return stream.pipeThrough(
    new TransformStream<NamesTool, NamesTool>({
      transform(chunk, controller) {
        controller.enqueue(rename(chunk, names))
      },
    })
  )
}

/**
 * Rewrite whatever names a tool, and hand back the original when nothing does.
 *
 * Keyed on carrying a `toolName` rather than on a list of part or chunk types, so a shape a later AI
 * SDK release adds is renamed too rather than quietly going unmapped.
 */
function rename<T extends NamesTool>(value: T, names: ReadonlyMap<string, string>): T {
  const renamed = value.toolName === undefined ? undefined : names.get(value.toolName)
  return renamed === undefined ? value : { ...value, toolName: renamed }
}

/** A tool declaration names its tool in `name`, which is the one place the advertised name is set. */
function renameTool<T extends ModelTool>(tool: T, names: ReadonlyMap<string, string>): T {
  const renamed = names.get(tool.name)
  return renamed === undefined ? tool : { ...tool, name: renamed }
}

/** One prompt message, with the tool names in its parts rewritten; unchanged when none were. */
function renameMessage<T extends ModelMessage>(message: T, names: ReadonlyMap<string, string>): T {
  const parts = message.content
  if (typeof parts === 'string') {
    return message
  }
  const content = parts.map((part) => rename(part, names))
  // The original is handed back when nothing named a tool, so a message this adapter did not change
  // is the very object Mastra passed in rather than a copy of it.
  return content.some((part, index) => part !== parts[index]) ? { ...message, content } : message
}
