// Ported word for word from pydantic-ai CodeMode at commit abd4293f14d0d1923389e5358445144243c4c650,
// src/pydantic_ai_harness/pydantic_ai_harness/code_mode/_toolset.py and _parts.py. The parity test compares the
// rendered description with pydantic-ai's own, so copy changes from there rather than editing here.

export const RUN_CODE_TOOL_NAME = 'run_code'

export const CODE_DESCRIPTION = 'The Python code to execute in the sandbox.'

export const RESTART_DESCRIPTION = 'Set to true to reset REPL state. When false (default), state is preserved between calls.'

const RUN_CODE_DESCRIPTION_HEAD = `Write and run Python code in a sandboxed environment.

The sandbox uses Monty, a subset of Python. Key restrictions:
- **No third-party libraries**: only the standard library modules listed below can be used
- **Importable standard library modules**: \`sys\`, \`typing\`, \`asyncio\`, \`math\`, \`json\`, \`re\`, \`unicodedata\`, \`datetime\`, \`time\`, \`random\`, \`os\`, \`pathlib\`, \`collections\`, \`itertools\`, \`functools\`, \`dataclasses\`, \`copy\`, \`base64\`, \`binascii\`, \`bisect\`, \`csv\`, \`decimal\`, \`hashlib\`, \`os.path\`, \`tomllib\`. These must be imported before use, just like in regular Python.`

const NO_OS_RESTRICTION =
  '- **No filesystem, environment, or clock**: `pathlib.Path` I/O, `os.getenv`/`os.environ`, ' +
  '`datetime.datetime.now()`, `datetime.date.today()`, and `time.time()` are unavailable here ' +
  '(no filesystem mount or OS handler is configured). `os` and `pathlib` import successfully, but ' +
  'their I/O operations are not supported in this configuration. `time.sleep` and `asyncio.sleep` really wait.'

const RUN_CODE_DESCRIPTION_TAIL =
  '- **No `import *`**: wildcard imports are not supported\n' +
  '\n' +
  'State is preserved between calls (REPL-style). Set `restart: true` to reset state.\n' +
  '\n' +
  "The last expression's value is automatically captured as the return value -- you do **not** need to " +
  '`print()` it. End the snippet with the value to return as a bare expression. A final assignment stores ' +
  'the value but does not return it. A final expression that evaluates to `None` is treated as no result. ' +
  'Without a non-`None` final expression or print output, `run_code` returns `{}`. For example:\n' +
  '\n' +
  '```python\n' +
  'result = some_expression\n' +
  'result\n' +
  '```\n' +
  '\n' +
  'Avoid `print()` for return values as it produces Python string representations, not structured data. ' +
  'Use `print()` only for supplementary logging or debug output.\n' +
  '\n' +
  "Returns a non-`None` last expression's value directly when nothing is printed. With `print()` output " +
  'and no non-`None` final expression, returns `{"output": "<printed text>"}`. With `print()` output and a ' +
  'plain, non-`None` final expression, returns ' +
  '`{"output": "<printed text>", "result": <last expression>}`. With `print()` output and a multimodal ' +
  'final expression, returns a list with the printed text followed by the native content.'

// AI SDK tools have no `sequential` flag, so every function is async and only this header variant applies.
const ASYNC_FUNCTIONS_HEADER =
  '\nThe following functions are available inside the sandbox. These functions are already defined' +
  ' in the sandbox; call them by name without redefining or importing them.' +
  ' All parameters are keyword-only.' +
  ' All tool functions are async: invoke them with `await`,' +
  ' e.g. `await tool_name(arg=value)`.' +
  ' Calling without `await` returns an unresolved future, not the value.' +
  '\n\nTo run calls concurrently, first `import asyncio`, then use `await asyncio.gather(...)`' +
  ' with positional awaitables.' +
  ' Monty does not support `asyncio.gather` keyword arguments or other task creation' +
  ' and wait APIs.'

const BASE_DESCRIPTION = `${RUN_CODE_DESCRIPTION_HEAD}\n${NO_OS_RESTRICTION}\n${RUN_CODE_DESCRIPTION_TAIL}`

/** The `run_code` description: pydantic-ai's prose, then the TypedDicts and function signatures. */
export function runCodeDescription(typeDefinitions: readonly string[], functions: readonly string[]): string {
  if (functions.length === 0) {
    return BASE_DESCRIPTION
  }
  const sections = [ASYNC_FUNCTIONS_HEADER]
  if (typeDefinitions.length > 0) {
    sections.push('```python\n' + typeDefinitions.join('\n\n') + '\n```')
  }
  sections.push('```python\n' + functions.join('\n\n') + '\n```')
  return `${BASE_DESCRIPTION}\n\n${sections.join('\n\n')}`
}
