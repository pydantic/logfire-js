import { Monty, MontyTypingError } from '@pydantic/monty'
import { tool } from 'ai'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import { z } from 'zod'

import { toolStubs } from './stubs'
import { expenses as expenseTools, shapes as shapeTools } from './zodToolSets.fixture'

// Monty type-checks function bodies, so each snippet wraps its calls in a function that never runs. That keeps
// the test about the stubs: no host functions are needed.
function unexecuted(body: string): string {
  return `async def check() -> None:\n${body
    .trim()
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n')}\n\n"checked"`
}

let pool: Monty

beforeAll(async () => {
  pool = await Monty.create()
})

afterAll(async () => {
  await pool.close()
})

async function typeCheck(stubs: string, code: string): Promise<unknown> {
  await using session = await pool.checkout({ typeCheck: true, typeCheckStubs: stubs })
  // Awaited here, so that `await using` does not close the session while the feed runs.
  return await session.feedRun(code)
}

describe('Monty type checking with the generated stubs', () => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined)
  const shapes = toolStubs(shapeTools).typeCheckStubs
  const expenses = toolStubs(expenseTools).typeCheckStubs

  test('valid calls to every function pass', async () => {
    const code = unexecuted(`
trip = await plan_trip(destination="LHR", travelers=2, departure=None, stops=1, preferences={"aisle": True})
saved = await save_tree(name="root", children=[])
tree = await get_tree(id="t1")
names = [child["name"] for child in tree["children"]]
category = await get_category(path=["books"])
root_name = category["root"]["name"]
amount = (await parse_amount(text="1.5"))["amount"] + 1.0
hits = (await lookup(q="x"))["hits"]
`)
    await expect(typeCheck(shapes, code)).resolves.toBe('checked')
  })

  test('a wrong argument type fails', async () => {
    await expect(typeCheck(shapes, unexecuted('tree = await get_tree(id=5)'))).rejects.toThrow(MontyTypingError)
  })

  test('code that uses the typed results the way a model writes it passes', async () => {
    const code = unexecuted(`
team = await get_team_members(department="Engineering")
over_budget = []
for member in team["members"]:
    data = await get_expenses(user_id=member["id"], quarter="Q3")
    total = sum(item["amount"] for item in data["expenses"])
    custom = await get_custom_budget(user_id=member["id"])
    budget = custom["budget"] if custom is not None else 5000
    if total > budget:
        over_budget.append({"name": member["name"], "total": total})
`)
    await expect(typeCheck(expenses, code)).resolves.toBe('checked')
  })

  test('renamed parameters and functional TypedDict fields are checked', async () => {
    const search = toolStubs({
      search: tool({
        inputSchema: z.object({ from: z.string(), filter: z.object({ '@type': z.string() }) }),
        outputSchema: z.object({ 'hit-count': z.number() }),
      }),
    }).typeCheckStubs
    const call = (filter: string): string => unexecuted(`hits = (await search(from_="ana", filter=${filter}))["hit-count"] + 1`)
    await expect(typeCheck(search, call(`{"@type": "mail"}`))).resolves.toBe('checked')
    await expect(typeCheck(search, call(`{"@type": 5}`))).rejects.toThrow(MontyTypingError)
  })

  // Known Monty 1.4.0 behavior, recorded so that a change shows up here. Roadmap decision D-typecheck decides
  // what code mode does about it before the runtime ships.
  test('a dict built in a variable and passed to a TypedDict parameter fails today', async () => {
    const code = unexecuted(`
child = {"name": "leaf", "children": []}
saved = await save_tree(name="root", children=[child])
`)
    await expect(typeCheck(shapes, code)).rejects.toThrow(MontyTypingError)
  })
})
