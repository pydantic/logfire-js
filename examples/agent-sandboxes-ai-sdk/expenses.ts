// Ported from Monty's expense_analysis example, which follows Anthropic's programmatic tool calling cookbook.
// Each person has many line items, so calling these tools one model turn at a time would flood the context.
import { tool } from 'ai'
import { z } from 'zod'

interface Expense {
  amount: number
  date: string
  description: string
}

const teamMembers = [
  { id: 1, name: 'Alice Chen' },
  { id: 2, name: 'Bob Smith' },
  { id: 3, name: 'Carol Jones' },
  { id: 4, name: 'David Kim' },
  { id: 5, name: 'Eve Wilson' },
]

const expenses: Record<number, Expense[]> = {
  1: [
    { date: '2024-07-15', amount: 450, description: 'Flight to NYC' },
    { date: '2024-07-16', amount: 200, description: 'Hotel NYC' },
    { date: '2024-07-17', amount: 85, description: 'Meals NYC' },
    { date: '2024-08-20', amount: 380, description: 'Flight to Chicago' },
    { date: '2024-08-21', amount: 175, description: 'Hotel Chicago' },
    { date: '2024-09-05', amount: 520, description: 'Flight to Seattle' },
    { date: '2024-09-06', amount: 225, description: 'Hotel Seattle' },
    { date: '2024-09-07', amount: 95, description: 'Meals Seattle' },
  ],
  2: [
    { date: '2024-07-01', amount: 850, description: 'Flight to London' },
    { date: '2024-07-02', amount: 450, description: 'Hotel London' },
    { date: '2024-07-03', amount: 125, description: 'Meals London' },
    { date: '2024-07-04', amount: 450, description: 'Hotel London' },
    { date: '2024-07-05', amount: 120, description: 'Meals London' },
    { date: '2024-08-10', amount: 780, description: 'Flight to Tokyo' },
    { date: '2024-08-11', amount: 380, description: 'Hotel Tokyo' },
    { date: '2024-08-12', amount: 380, description: 'Hotel Tokyo' },
    { date: '2024-08-13', amount: 150, description: 'Meals Tokyo' },
    { date: '2024-09-15', amount: 920, description: 'Flight to Singapore' },
    { date: '2024-09-16', amount: 320, description: 'Hotel Singapore' },
    { date: '2024-09-17', amount: 320, description: 'Hotel Singapore' },
    { date: '2024-09-18', amount: 180, description: 'Meals Singapore' },
  ],
  3: [
    { date: '2024-07-08', amount: 1200, description: 'Flight to Paris' },
    { date: '2024-07-09', amount: 550, description: 'Hotel Paris' },
    { date: '2024-07-10', amount: 550, description: 'Hotel Paris' },
    { date: '2024-07-11', amount: 550, description: 'Hotel Paris' },
    { date: '2024-07-12', amount: 200, description: 'Meals Paris' },
    { date: '2024-08-25', amount: 1100, description: 'Flight to Sydney' },
    { date: '2024-08-26', amount: 480, description: 'Hotel Sydney' },
    { date: '2024-08-27', amount: 480, description: 'Hotel Sydney' },
    { date: '2024-08-28', amount: 480, description: 'Hotel Sydney' },
    { date: '2024-08-29', amount: 220, description: 'Meals Sydney' },
    { date: '2024-09-20', amount: 650, description: 'Flight to Denver' },
    { date: '2024-09-21', amount: 280, description: 'Hotel Denver' },
  ],
  4: [
    { date: '2024-07-22', amount: 420, description: 'Flight to Boston' },
    { date: '2024-07-23', amount: 190, description: 'Hotel Boston' },
    { date: '2024-07-24', amount: 75, description: 'Meals Boston' },
    { date: '2024-08-05', amount: 510, description: 'Flight to Austin' },
    { date: '2024-08-06', amount: 210, description: 'Hotel Austin' },
    { date: '2024-08-07', amount: 90, description: 'Meals Austin' },
    { date: '2024-09-12', amount: 480, description: 'Flight to Portland' },
    { date: '2024-09-13', amount: 195, description: 'Hotel Portland' },
    { date: '2024-09-14', amount: 85, description: 'Meals Portland' },
  ],
  5: [
    { date: '2024-07-03', amount: 680, description: 'Flight to Miami' },
    { date: '2024-07-04', amount: 320, description: 'Hotel Miami' },
    { date: '2024-07-05', amount: 320, description: 'Hotel Miami' },
    { date: '2024-07-06', amount: 145, description: 'Meals Miami' },
    { date: '2024-08-18', amount: 750, description: 'Flight to San Diego' },
    { date: '2024-08-19', amount: 290, description: 'Hotel San Diego' },
    { date: '2024-08-20', amount: 290, description: 'Hotel San Diego' },
    { date: '2024-08-21', amount: 130, description: 'Meals San Diego' },
    { date: '2024-09-08', amount: 820, description: 'Flight to Las Vegas' },
    { date: '2024-09-09', amount: 380, description: 'Hotel Las Vegas' },
    { date: '2024-09-10', amount: 380, description: 'Hotel Las Vegas' },
    { date: '2024-09-11', amount: 175, description: 'Meals Las Vegas' },
  ],
}

const customBudgets: Record<number, { amount: number; reason: string }> = {
  2: { amount: 7000, reason: 'International travel required' },
}

export const expenseTools = {
  get_team_members: tool({
    description: 'Get the team members of a department. Returns {"department": str, "members": [{"id": int, "name": str}]}.',
    inputSchema: z.object({ department: z.string().describe('The department name, such as "Engineering".') }),
    execute: async ({ department }) => ({ department, members: teamMembers }),
  }),
  get_expenses: tool({
    description:
      'Get the expense line items for a user. Returns {"user_id": int, "quarter": str, "category": str, "expenses": [{"date": str, "amount": int, "description": str}]}.',
    inputSchema: z.object({
      user_id: z.number().int().describe("The user's ID."),
      quarter: z.string().describe('The quarter, such as "Q3".'),
      category: z.string().describe('The expense category, such as "travel".'),
    }),
    execute: async ({ user_id, quarter, category }) => ({ user_id, quarter, category, expenses: expenses[user_id] ?? [] }),
  }),
  get_custom_budget: tool({
    description: 'Get the custom budget for a user. Returns {"user_id": int, "budget": int, "reason": str}, or None if they have none.',
    inputSchema: z.object({ user_id: z.number().int().describe("The user's ID.") }),
    execute: async ({ user_id }) => {
      const budget = customBudgets[user_id]
      return budget === undefined ? null : { user_id, budget: budget.amount, reason: budget.reason }
    },
  }),
}
