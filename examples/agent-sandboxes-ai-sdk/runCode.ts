import type { MontySession } from '@pydantic/monty'
import type { Tool, ToolExecutionOptions, ToolSet } from 'ai'

import { toolStubs } from '@pydantic/logfire-code-mode'
import { MontyTypingError } from '@pydantic/monty'
import * as logfire from '@pydantic/logfire-node'
import { tool } from 'ai'
import { z } from 'zod'

// Adapted from the run_code description in Pydantic AI Code Mode, which lists what Monty 1.4 can import.
const DESCRIPTION = `Write and run Python code in a sandboxed environment.

The sandbox uses Monty, a subset of Python. Key restrictions:
- No third-party libraries. Only these standard library modules can be imported: sys, typing, asyncio, math, json, re, unicodedata, datetime, time, random, os, pathlib, collections, itertools, functools, dataclasses, copy, base64, binascii, bisect, csv, decimal, hashlib, os.path, tomllib.
- No filesystem, environment variables, or clock.
- Variables, functions, and imports from earlier calls are kept, so build on earlier results instead of fetching them again.

The value of the last expression is returned, so end the code with the value you want back instead of printing it.

These async functions are already defined in the sandbox. Call them with keyword arguments and await them, without importing or redefining them. To run calls concurrently, import asyncio and use await asyncio.gather(...) with positional awaitables.`

function fence(blocks: string[]): string {
  return `\`\`\`python\n${blocks.join('\n\n')}\n\`\`\``
}

// Monty passes Python dicts as Maps, at any depth, which JSON.stringify would send to the model as {}.
function toJson(value: unknown): unknown {
  if (value instanceof Map) {
    return Object.fromEntries(Array.from(value, ([key, item]: [unknown, unknown]) => [String(key), toJson(item)]))
  }
  if (Array.isArray(value)) {
    return value.map(toJson)
  }
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, toJson(item)]))
  }
  return value
}

// Keyword arguments arrive as one trailing object without a prototype; anything before it is positional.
function keywordArguments(name: string, args: unknown[]): Record<string, unknown> {
  const last = args.at(-1)
  const hasKwargs = typeof last === 'object' && last !== null && Object.getPrototypeOf(last) === null
  if (args.length > (hasKwargs ? 1 : 0)) {
    throw new TypeError(`${name}() does not accept positional arguments; use keyword arguments`)
  }
  return hasKwargs ? (toJson(last) as Record<string, unknown>) : {}
}

export interface RunCodeOptions {
  /**
   * Which snippets the session's type checker sees, when the session was checked out with `typeCheck: true`.
   * `'first-snippet'` checks until one snippet passes, as pydantic-ai does. Monty's checker rejects some valid
   * code, such as a None check on an indexed value (`budgets[i] is not None`), and a model can spend every step
   * trying to satisfy it.
   */
  typeCheck?: 'every-snippet' | 'first-snippet'
}

// The model sees only run_code, and `tools` become typed Python functions inside the sandbox, so one model turn
// can make many tool calls. Every call runs in `session`, which the sandbox keeps like a REPL.
export function runCode(session: MontySession, tools: ToolSet, { typeCheck = 'first-snippet' }: RunCodeOptions = {}): Tool {
  const { typeDefinitions, functions, toolNames } = toolStubs(tools)
  const catalog = typeDefinitions.length > 0 ? [fence(typeDefinitions), fence(functions)] : [fence(functions)]
  const pythonNames = new Map([...toolNames].map(([pythonName, toolName]) => [toolName, pythonName]))
  // A session runs one feed at a time, and a second feed while one is waiting on a tool call breaks it.
  let queue: Promise<unknown> = Promise.resolve()
  let snippetPassedTypeCheck = false

  return tool({
    description: [DESCRIPTION, ...catalog].join('\n\n'),
    inputSchema: z.object({ code: z.string().describe('The Python code to run.') }),
    execute: async ({ code }, options: ToolExecutionOptions<unknown>) => {
      // Sandbox code calls these directly, so the AI SDK records no tool spans for them.
      const externalLookup = Object.fromEntries(
        Object.entries(tools).map(([toolName, { execute }]) => {
          const name = pythonNames.get(toolName) ?? toolName
          return [
            name,
            async (...args: unknown[]) => {
              const kwargs = keywordArguments(name, args)
              return logfire.span('run_code called {tool_name}', { tool_name: toolName, ...kwargs }, {}, async () =>
                execute?.(kwargs, options)
              )
            },
          ]
        })
      )

      const result = queue.then(async () => {
        const skipTypeCheck = typeCheck === 'first-snippet' && snippetPassedTypeCheck
        try {
          const value = await session.feedRun(code, { externalLookup, skipTypeCheck })
          snippetPassedTypeCheck = true
          return value
        } catch (error) {
          // A snippet that failed at run time still passed type checking.
          snippetPassedTypeCheck ||= !(error instanceof MontyTypingError)
          throw error
        }
      })
      queue = result.catch(() => undefined)
      return toJson(await result)
    },
  })
}
