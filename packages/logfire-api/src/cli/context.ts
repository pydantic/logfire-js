import type { Readable, Writable } from 'node:stream'

import type { CliOutput } from './output'
import type { Prompt } from './interactivePrompt'

export interface CliContext extends CliOutput {
  cwd: string
  env: Record<string, string | undefined>
  fetch: typeof fetch
  homeDir: string
  openBrowser(url: string): Promise<void> | void
  platform: NodeJS.Platform
  prompt: Prompt
  stdin: Readable
  stderr: Writable
  stdout: Writable
}

export interface GlobalOptions {
  authFile?: string
  baseUrl?: string
  region?: string
}
