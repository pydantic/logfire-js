import { createInterface } from 'node:readline/promises'

import type { Readable, Writable } from 'node:stream'

export interface Prompt {
  choice(message: string, choices: readonly string[], defaultChoice?: string): Promise<string>
  confirm(message: string, defaultYes?: boolean): Promise<boolean>
  text(message: string, defaultValue?: string): Promise<string>
  waitForEnter(message: string): Promise<void>
}

export interface PromptStreams {
  input: Readable
  output: Writable
}

export function createPrompt({ input, output }: PromptStreams): Prompt {
  async function ask(question: string): Promise<string> {
    const rl = createInterface({ input, output, terminal: false })
    try {
      return await rl.question(question)
    } finally {
      rl.close()
    }
  }

  return {
    async choice(message, choices, defaultChoice) {
      const suffix = defaultChoice !== undefined ? ` [${defaultChoice}]` : ''
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- reprompt until a valid choice is entered.
      while (true) {
        // eslint-disable-next-line no-await-in-loop -- prompts are inherently sequential.
        const value = (await ask(`${message}${suffix}: `)).trim() || defaultChoice
        if (value !== undefined && choices.includes(value)) {
          return value
        }
      }
    },
    async confirm(message, defaultYes = true) {
      const suffix = defaultYes ? ' [Y/n]' : ' [N/y]'
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- reprompt until a yes/no answer is entered.
      while (true) {
        // eslint-disable-next-line no-await-in-loop -- prompts are inherently sequential.
        const value = (await ask(`${message}${suffix}`)).trim().toLowerCase()
        if (value === '') {
          return defaultYes
        }
        if (value === 'y' || value === 'yes') {
          return true
        }
        if (value === 'n' || value === 'no') {
          return false
        }
      }
    },
    async text(message, defaultValue) {
      const suffix = defaultValue !== undefined ? ` [${defaultValue}]` : ''
      return ((await ask(`${message}${suffix}: `)).trim() || defaultValue) ?? ''
    },
    async waitForEnter(message) {
      await ask(`${message}\n`)
    },
  }
}
