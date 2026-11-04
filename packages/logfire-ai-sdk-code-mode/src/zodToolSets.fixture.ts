import type { ToolSet } from 'ai'

import { jsonSchema, tool } from 'ai'
import { z } from 'zod'

// Tool sets written the way AI SDK users write them. Their normalized schemas are recorded in
// `fixtures/signatures/zod-cases.json`, where pydantic-ai renders the expected stubs.

const Member = z.object({ id: z.number().int(), name: z.string() })
const LineItem = z.object({ date: z.string(), amount: z.number(), description: z.string() })

export const expenses: ToolSet = {
  get_team_members: tool({
    description: 'Get the team members of a department.',
    inputSchema: z.object({ department: z.string().describe('The department name, such as "Engineering".') }),
    outputSchema: z.object({ department: z.string(), members: z.array(Member) }),
  }),
  get_expenses: tool({
    description: 'Get the expense line items for a user.',
    inputSchema: z.object({
      user_id: z.number().int().describe("The user's ID."),
      quarter: z.enum(['Q1', 'Q2', 'Q3', 'Q4']),
      category: z.string().default('travel'),
    }),
    outputSchema: z.object({ user_id: z.number().int(), expenses: z.array(LineItem) }),
  }),
  get_custom_budget: tool({
    description: 'Get the custom budget for a user, or None if they have none.',
    inputSchema: z.object({ user_id: z.number().int() }),
    outputSchema: z.object({ budget: z.number(), reason: z.string() }).nullable(),
  }),
}

interface TreeShape {
  name: string
  children: TreeShape[]
}
const Tree: z.ZodType<TreeShape> = z.lazy(() => z.object({ name: z.string(), children: z.array(Tree) }))
const NamedTree: z.ZodType<TreeShape> = z.lazy(() => z.object({ name: z.string(), children: z.array(NamedTree) })).meta({ id: 'tree-node' })

export const saveTree: ToolSet[string] = tool({
  description: 'Save a whole tree.',
  inputSchema: Tree,
  outputSchema: z.object({ saved: z.number().int() }),
})

export const shapes: ToolSet = {
  plan_trip: tool({
    description: 'Plan a trip.',
    inputSchema: z.object({
      destination: z.string().describe('City or airport code.'),
      travelers: z.number().int().min(1),
      cabin: z.enum(['economy', 'business']).optional(),
      budget: z.number().default(1000),
      departure: z.iso.datetime().nullable(),
      stops: z.union([z.string(), z.number()]),
      preferences: z.record(z.string(), z.boolean()),
      itinerary: z.object({ days: z.array(z.object({ city: z.string(), nights: z.number().int() })) }).optional(),
    }),
  }),
  save_tree: saveTree,
  get_tree: tool({
    inputSchema: z.object({ id: z.string() }),
    outputSchema: Tree,
  }),
  get_category: tool({
    inputSchema: z.object({ path: z.array(z.string()) }),
    outputSchema: z.object({ root: NamedTree, parent: NamedTree.optional() }),
  }),
  parse_amount: tool({
    inputSchema: z.object({ text: z.string() }),
    outputSchema: z.object({ amount: z.string().pipe(z.coerce.number()) }),
  }),
  lookup: tool({
    description: 'Look something up.',
    inputSchema: jsonSchema<{ q: string }>({ type: 'object', properties: { q: { type: 'string' } }, required: ['q'] }),
    outputSchema: jsonSchema<{ hits: string[] }>({
      type: 'object',
      properties: { hits: { type: 'array', items: { type: 'string' } } },
      required: ['hits'],
    }),
  }),
}

export const zodToolSets: Readonly<Record<string, ToolSet>> = { zod_expenses: expenses, zod_shapes: shapes }
