// A company-wide Q3 travel review, extended from Monty's expense_analysis example. There are hundreds of line
// items in four currencies, so calling these tools one model turn at a time would flood the context; code mode
// fetches them in parallel inside the sandbox and returns only the summary.
import { tool } from 'ai'
import { z } from 'zod'

export const STANDARD_BUDGET_USD = 5000

const CURRENCIES = ['USD', 'EUR', 'GBP', 'CHF'] as const
type Currency = (typeof CURRENCIES)[number]

const USD_PER_UNIT: Record<Currency, number> = { USD: 1, EUR: 1.08, GBP: 1.27, CHF: 1.13 }

// The rate service has no CHF rate, so the tool fails for it. Its error message tells the caller what to use.
const UNAVAILABLE_RATES: ReadonlySet<Currency> = new Set(['CHF'])

const DEPARTMENTS = ['Engineering', 'Sales', 'Marketing', 'Support']
const FIRST_NAMES = ['Alice', 'Bob', 'Carol', 'David', 'Eve', 'Frank', 'Grace', 'Hiro', 'Ines', 'Jamal', 'Kira', 'Liam']
const LAST_NAMES = ['Chen', 'Smith', 'Jones', 'Kim', 'Wilson', 'Garcia', 'Novak', 'Okafor', 'Rossi', 'Tanaka', 'Weber', 'Silva']
const TRIP_CITIES = ['London', 'Berlin', 'Zurich', 'New York', 'Tokyo', 'Paris', 'Austin', 'Lisbon']

interface Member {
  id: number
  name: string
  department: string
}

interface Expense {
  date: string
  amount: number
  currency: Currency
  description: string
}

// mulberry32: the data is generated, but the same on every run, so the smoke test can check exact results.
function random(seed: number): () => number {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const next = random(20260704)
const pick = <T>(items: readonly T[]): T => items[Math.floor(next() * items.length)] as T
const between = (low: number, high: number): number => Math.round(low + next() * (high - low))

const members: Member[] = DEPARTMENTS.flatMap((department, d) =>
  Array.from({ length: 6 }, (_, i) => ({
    id: d * 6 + i + 1,
    name: `${FIRST_NAMES[(d * 6 + i) % FIRST_NAMES.length] ?? ''} ${LAST_NAMES[(d * 5 + i * 7) % LAST_NAMES.length] ?? ''}`,
    department,
  }))
)

const travelExpenses = new Map<number, Expense[]>(
  members.map((member) => {
    // Some people travel much more than others, so only a few go over budget.
    const intensity = 0.4 + next() * 1.3
    const expenses = Array.from({ length: between(8, 22) }, (): Expense => {
      const kind = pick(['Flight', 'Hotel', 'Meals'] as const)
      const [low, high] = kind === 'Flight' ? [150, 900] : kind === 'Hotel' ? [80, 300] : [15, 90]
      const month = between(7, 9)
      const day = between(1, 28)
      return {
        date: `2026-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
        amount: Math.round(between(low, high) * intensity),
        currency: pick(['USD', 'USD', 'EUR', 'GBP', 'CHF'] as const),
        description: `${kind} ${pick(TRIP_CITIES)}`,
      }
    })
    return [member.id, expenses.sort((a, b) => a.date.localeCompare(b.date))]
  })
)

const customBudgets = new Map<number, { budget: number; reason: string }>([
  [3, { budget: 8000, reason: 'International customer visits' }],
  [8, { budget: 7000, reason: 'Regional sales lead' }],
  [15, { budget: 6500, reason: 'Conference speaker' }],
])

const Currency = z.enum(CURRENCIES)

export const expenseTools = {
  list_departments: tool({
    description: 'List the departments in the company.',
    inputSchema: z.object({}),
    outputSchema: z.object({ departments: z.array(z.string()) }),
    execute: async () => ({ departments: DEPARTMENTS }),
  }),
  get_team_members: tool({
    description: 'Get the members of a department. Raises an error for an unknown department.',
    inputSchema: z.object({ department: z.string().describe('The department name, such as "Engineering".') }),
    outputSchema: z.object({ department: z.string(), members: z.array(z.object({ id: z.number().int(), name: z.string() })) }),
    execute: async ({ department }) => {
      if (!DEPARTMENTS.includes(department)) {
        throw new Error(`Unknown department "${department}". The departments are: ${DEPARTMENTS.join(', ')}.`)
      }
      return { department, members: members.filter((m) => m.department === department).map(({ id, name }) => ({ id, name })) }
    },
  }),
  get_expenses: tool({
    description: 'Get the expense line items of an employee for one quarter and category. Amounts are in the currency they were paid in.',
    inputSchema: z.object({
      user_id: z.number().int().describe("The employee's ID."),
      quarter: z.enum(['Q1', 'Q2', 'Q3', 'Q4']),
      category: z.enum(['travel', 'meals', 'software']),
    }),
    outputSchema: z.object({
      user_id: z.number().int(),
      expenses: z.array(z.object({ date: z.string(), amount: z.number(), currency: Currency, description: z.string() })),
    }),
    execute: async ({ user_id, quarter, category }) => ({
      user_id,
      expenses: quarter === 'Q3' && category === 'travel' ? (travelExpenses.get(user_id) ?? []) : [],
    }),
  }),
  get_custom_budget: tool({
    description: 'Get the custom quarterly travel budget of an employee, in USD, or None if they have the standard budget.',
    inputSchema: z.object({ user_id: z.number().int() }),
    outputSchema: z.object({ budget: z.number(), reason: z.string() }).nullable(),
    execute: async ({ user_id }) => customBudgets.get(user_id) ?? null,
  }),
  get_exchange_rate: tool({
    description: 'Get the Q3 exchange rate of a currency, as US dollars per unit. Raises an error when the rate service has no rate.',
    inputSchema: z.object({ currency: Currency }),
    outputSchema: z.object({ currency: Currency, usd_per_unit: z.number() }),
    execute: async ({ currency }) => {
      if (UNAVAILABLE_RATES.has(currency)) {
        throw new Error(
          `The exchange rate service has no rate for ${currency}. Finance uses a fixed Q3 rate of ${String(USD_PER_UNIT[currency])} USD per ${currency}.`
        )
      }
      return { currency, usd_per_unit: USD_PER_UNIT[currency] }
    },
  }),
}

export const QUESTION = `Review Q3 travel spending for the whole company.
Expenses are recorded in the currency they were paid in, so convert them to US dollars.
Every employee has a standard quarterly travel budget of $${String(STANDARD_BUDGET_USD)}, unless they have a custom budget.
Report the total Q3 travel spending of each department in USD, and list every employee who went over their budget, with how much they spent, their budget, and how much they went over by.`

export interface Report {
  department_totals_usd: Record<string, number>
  over_budget: { name: string; department: string; spent_usd: number; budget_usd: number; over_by_usd: number }[]
  line_items: number
}

/** The correct answer, computed directly from the data, to check what the agent reports. */
export function expectedReport(): Report {
  const round = (n: number): number => Math.round(n * 100) / 100
  const department_totals_usd: Record<string, number> = {}
  const over_budget: Report['over_budget'] = []
  let lineItems = 0
  for (const member of members) {
    const expenses = travelExpenses.get(member.id) ?? []
    lineItems += expenses.length
    const spent = expenses.reduce((sum, e) => sum + e.amount * USD_PER_UNIT[e.currency], 0)
    department_totals_usd[member.department] = (department_totals_usd[member.department] ?? 0) + spent
    const budget = customBudgets.get(member.id)?.budget ?? STANDARD_BUDGET_USD
    if (spent > budget) {
      over_budget.push({
        name: member.name,
        department: member.department,
        spent_usd: round(spent),
        budget_usd: budget,
        over_by_usd: round(spent - budget),
      })
    }
  }
  for (const department of Object.keys(department_totals_usd)) {
    department_totals_usd[department] = round(department_totals_usd[department] ?? 0)
  }
  over_budget.sort((a, b) => b.over_by_usd - a.over_by_usd)
  return { department_totals_usd, over_budget, line_items: lineItems }
}
