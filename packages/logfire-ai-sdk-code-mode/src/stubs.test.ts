import type { ToolSet } from 'ai'

import { jsonSchema, tool } from 'ai'
import { setTimeout as sleep } from 'node:timers/promises'
import type { MockInstance } from 'vitest'

import { afterEach, describe, expect, test, vi } from 'vitest'
import { z } from 'zod'

import { normalizeSchema } from './normalize'
import { pythonFunctions, toolStubs } from './stubs'
import { saveTree, shapes } from './zodToolSets.fixture'

afterEach(() => {
  vi.restoreAllMocks()
})

function silenceWarnings(): MockInstance<typeof console.warn> {
  return vi.spyOn(console, 'warn').mockImplementation(() => undefined)
}

const noParameters = z.object({})

describe('AI SDK tools', () => {
  test('nested and recursive zod schemas render as named TypedDicts', () => {
    silenceWarnings()
    const { typeCheckStubs } = toolStubs(shapes)

    expect(typeCheckStubs).not.toMatch(/__schema|#|tree-node/u)
    expect(typeCheckStubs).toContain('class TreeNode(TypedDict):\n    name: str\n    children: list[TreeNode]')
    expect(typeCheckStubs).toContain('async def get_category(*, path: list[str]) -> GetCategoryReturn:')
    expect(typeCheckStubs).toContain('class GetTreeReturn(TypedDict):\n    name: str\n    children: list[GetTreeReturn]')
  })

  test('a root-recursive input keeps every parameter and its required set', () => {
    silenceWarnings()
    const [saveTreeFunction] = pythonFunctions({ save_tree: saveTree }).functions

    expect(saveTreeFunction?.parametersSchema['properties']).toEqual({
      name: { type: 'string' },
      children: { type: 'array', items: { $ref: '#/$defs/SaveTree' } },
    })
    expect(saveTreeFunction?.parametersSchema['required']).toEqual(['name', 'children'])
    expect(toolStubs({ save_tree: saveTree }).functions).toEqual([
      'async def save_tree(*, name: str, children: list[SaveTree]) -> SaveTreeReturn:\n    """Save a whole tree."""\n    ...',
    ])
  })

  test('the return type follows the output shape of a transforming schema', () => {
    const stubs = toolStubs({
      parse_amount: tool({
        inputSchema: z.object({ text: z.string() }),
        outputSchema: z.object({ amount: z.string().pipe(z.coerce.number()) }),
      }),
    })
    expect(stubs.typeDefinitions).toEqual(['class ParseAmountReturn(TypedDict):\n    amount: float'])
  })

  test('jsonSchema() tools use their schemas unchanged', () => {
    const stubs = toolStubs({
      lookup: tool({
        inputSchema: jsonSchema<{ q: string }>({ type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }),
        outputSchema: jsonSchema<string[]>({ type: 'array', items: { type: 'string' } }),
      }),
    })
    expect(stubs.functions).toEqual(['async def lookup(*, q: str) -> list[str]:\n    ...'])
  })
})

describe('tool names', () => {
  test('names that are not Python identifiers are sanitized and mapped back', () => {
    silenceWarnings()
    const tools: ToolSet = {
      'get-weather': tool({ inputSchema: noParameters }),
      class: tool({ inputSchema: noParameters }),
      '3d': tool({ inputSchema: noParameters }),
      plain: tool({ inputSchema: noParameters }),
    }
    const stubs = toolStubs(tools)

    expect(stubs.functions.map((f) => f.split('(')[0])).toEqual([
      'async def get_weather',
      'async def class_',
      'async def _3d',
      'async def plain',
    ])
    expect([...stubs.toolNames]).toEqual([
      ['get_weather', 'get-weather'],
      ['class_', 'class'],
      ['_3d', '3d'],
    ])
  })

  test('a tool that becomes run_code is rejected', () => {
    expect(() => toolStubs({ 'run-code': tool({ inputSchema: noParameters }) })).toThrow(
      'Tool "run-code" becomes the Python function "run_code", which code mode reserves for itself. Rename the tool.'
    )
  })

  test('two tools that become the same Python name are rejected', () => {
    silenceWarnings()
    expect(() => toolStubs({ 'get-user': tool({ inputSchema: noParameters }), get_user: tool({ inputSchema: noParameters }) })).toThrow(
      'Tools "get-user" and "get_user" both become the Python function "get_user". Rename one of them.'
    )
  })
})

describe('type names', () => {
  test('titles and definition ids that would shadow a Python name are not used', () => {
    const stubs = toolStubs({
      search: tool({
        inputSchema: jsonSchema({
          type: 'object',
          properties: {
            a: { type: 'object', title: 'str', properties: { x: { type: 'string' } }, required: ['x'] },
            b: { type: 'object', title: 'class', properties: { y: { type: 'string' } }, required: ['y'] },
            c: { $ref: '#/definitions/Any' },
          },
          required: ['a', 'b', 'c'],
          definitions: { Any: { type: 'object', properties: { z: { type: 'string' } }, required: ['z'] } },
        }),
        outputSchema: z.object({}),
      }),
    })
    expect(stubs.functions).toEqual(['async def search(*, a: SearchA, b: SearchB, c: SearchC) -> SearchReturn:\n    ...'])
  })

  test('data in defaults is left alone', () => {
    const [search] = pythonFunctions({
      search: tool({
        inputSchema: jsonSchema({ type: 'object', properties: { q: { type: 'object', default: { $ref: 'x', title: 'class' } } } }),
        outputSchema: z.object({}),
      }),
    }).functions
    expect(search?.parametersSchema['properties']).toEqual({ q: { type: 'object', default: { $ref: 'x', title: 'class' } } })
  })
})

describe('property names', () => {
  test('a parameter that is not a Python name renders under a sanitized name', () => {
    silenceWarnings()
    const stubs = toolStubs({ search: tool({ inputSchema: z.object({ from: z.string(), 'user-id': z.string(), user_id: z.string() }) }) })
    expect(stubs.functions).toEqual(['async def search(*, from_: str, user_id_2: str, user_id: str) -> Any:\n    ...'])
    expect(stubs.schemaArgNames).toEqual(
      new Map([
        [
          'search',
          new Map([
            ['from_', 'from'],
            ['user_id_2', 'user-id'],
          ]),
        ],
      ])
    )
  })

  test('a field that is not a Python name keeps its name in a functional TypedDict', () => {
    silenceWarnings()
    const stubs = toolStubs({
      search: tool({
        inputSchema: z.object({ filter: z.object({ '@type': z.string(), ok: z.boolean().optional() }) }),
        outputSchema: z.object({ 'hit-count': z.number() }),
      }),
    })
    expect(stubs.typeDefinitions).toEqual([
      "SearchFilter = TypedDict('SearchFilter', {\n    '@type': str,\n    'ok': NotRequired[bool],\n})",
      "SearchReturn = TypedDict('SearchReturn', {\n    'hit-count': float,\n})",
    ])
    expect(stubs.schemaArgNames).toEqual(new Map())
  })

  test('soft keywords and enum values are not property names', () => {
    silenceWarnings()
    const stubs = toolStubs({ search: tool({ inputSchema: z.object({ match: z.enum(['x-y', 'from']), type: z.string() }) }) })
    expect(stubs.functions).toEqual(["async def search(*, match: Literal['x-y', 'from'], type: str) -> Any:\n    ..."])
    expect(stubs.schemaArgNames).toEqual(new Map())
  })
})

describe('return types', () => {
  test('a tool without an outputSchema returns Any and warns once', () => {
    const warn = silenceWarnings()
    const tools: ToolSet = { search: tool({ inputSchema: noParameters }) }

    expect(toolStubs(tools).functions).toEqual(['async def search() -> Any:\n    ...'])
    toolStubs(tools)

    expect(warn.mock.calls).toEqual([
      [
        'Tool "search" has no outputSchema, so code mode shows its return type as Any. Add an outputSchema so that the model knows the shape of its result.',
      ],
    ])
  })
})

describe('unsupported schemas', () => {
  test('a schema that converts asynchronously is rejected', () => {
    // eslint-disable-next-line @typescript-eslint/require-await -- the point is a schema that resolves asynchronously
    const asyncSchema = jsonSchema(async () => ({ type: 'object' as const, properties: {} }))
    expect(() => toolStubs({ slow: tool({ inputSchema: asyncSchema }) })).toThrow(
      'Tool "slow" has a schema that converts to JSON Schema asynchronously, which code mode does not support'
    )
  })

  test('a description that depends on context is rejected', () => {
    silenceWarnings()
    expect(() => toolStubs({ greet: tool({ inputSchema: noParameters, description: () => 'Hello.' }) })).toThrow(
      'Tool "greet" has a description that depends on its context, which code mode cannot render yet'
    )
  })

  test.each([
    ['a remote reference', 'https://example.com/schema.json'],
    ['a pointer into properties', '#/properties/a'],
    ['an unknown definition', '#/$defs/Missing'],
  ])('%s is rejected', (_label, ref) => {
    expect(() => normalizeSchema({ type: 'object', properties: { a: { $ref: ref } } }, 'search', 'parameters')).toThrow(
      `Tool "search" has a schema reference "${ref}" that code mode cannot resolve`
    )
  })

  test('a parameters schema that is only a reference is rejected', () => {
    expect(() =>
      normalizeSchema({ $ref: '#/$defs/Args', $defs: { Args: { type: 'object', properties: {} } } }, 'search', 'parameters')
    ).toThrow('Tool "search" has a parameters schema that is only a reference, which code mode cannot read')
  })

  test('two definitions that become the same type name are rejected', () => {
    expect(() =>
      normalizeSchema(
        {
          type: 'object',
          properties: { a: { $ref: '#/definitions/tree-node' }, b: { $ref: '#/definitions/TreeNode' } },
          definitions: { 'tree-node': { type: 'object', properties: {} }, TreeNode: { type: 'object', properties: {} } },
        },
        'search',
        'parameters'
      )
    ).toThrow('Tool "search" has two schema definitions that both become the Python type "TreeNode"')
  })
})

describe('review fixes', () => {
  test('every variant of a discriminated union keeps its own TypedDict', () => {
    const stubs = toolStubs({
      operate: tool({
        inputSchema: z.object({
          operation: z.discriminatedUnion('kind', [
            z.object({ kind: z.literal('read'), path: z.string() }),
            z.object({ kind: z.literal('write'), path: z.string(), content: z.string() }),
          ]),
        }),
        outputSchema: z.object({}),
      }),
    })
    expect(stubs.typeDefinitions).toEqual([
      "class OperateOperationRead(TypedDict):\n    kind: Literal['read']\n    path: str",
      "class OperateOperationWrite(TypedDict):\n    kind: Literal['write']\n    path: str\n    content: str",
      'class OperateReturn(TypedDict):\n    pass',
    ])
  })

  test('a property named after a schema keyword still has its references rewritten', () => {
    const [search] = pythonFunctions({
      search: tool({
        inputSchema: jsonSchema({
          type: 'object',
          properties: { default: { $ref: '#/definitions/tree-node' } },
          required: ['default'],
          definitions: { 'tree-node': { type: 'object', properties: { name: { type: 'string' } } } },
        }),
        outputSchema: z.object({}),
      }),
    }).functions
    expect(search?.parametersSchema['properties']).toEqual({ default: { $ref: '#/$defs/TreeNode' } })
  })

  test('a rejected async schema does not leave an unhandled rejection', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      // eslint-disable-next-line @typescript-eslint/require-await -- the point is a schema that rejects asynchronously
      const failing = jsonSchema(async () => {
        throw new Error('schema service is down')
      })
      expect(() => toolStubs({ slow: tool({ inputSchema: failing }) })).toThrow('converts to JSON Schema asynchronously')
      await sleep(10)
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})

describe('second review fixes', () => {
  test('a reference inside default data does not make the root recursive', () => {
    const normalized = normalizeSchema(
      {
        type: 'object',
        title: 'Node',
        properties: { x: { type: 'object', default: { $ref: '#' } } },
        $defs: { Node: { type: 'object', properties: {} } },
      },
      't',
      'parameters'
    )
    expect(normalized['$defs']).toEqual({ Node: { type: 'object', properties: {} } })
  })
})
