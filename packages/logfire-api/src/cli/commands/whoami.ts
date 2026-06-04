import { createAuthenticatedClient } from '../authClient'
import { getTokenInfo } from '../client'
import type { CliContext, GlobalOptions } from '../context'
import { defaultDataDir, readProjectCredentials } from '../credentials'
import { LogfireCliError } from '../errors'
import { writeLine } from '../output'
import { getBaseUrlFromToken } from '../../tokenBaseUrl'

export async function runWhoamiCommand(args: string[], globalOptions: GlobalOptions, context: CliContext): Promise<void> {
  const dataDir = parseDataDir(args) ?? defaultDataDir(context.cwd)
  const envTokens = parseTokenList(context.env['LOGFIRE_TOKEN'])

  if (envTokens.length > 0) {
    let anySucceeded = false
    for (const [index, token] of envTokens.entries()) {
      if (envTokens.length > 1) {
        if (index > 0) {
          writeLine(context.stderr)
        }
        writeLine(context.stderr, `Token ${String(index + 1)} of ${String(envTokens.length)}:`)
      }
      const baseUrl = globalOptions.baseUrl ?? getBaseUrlFromToken(token)
      // eslint-disable-next-line no-await-in-loop -- each env token is validated against the backend in order.
      const credentials = await getTokenInfo(token, baseUrl, context.fetch)
      if (credentials !== undefined) {
        writeProjectSummary(context, credentials.project_url)
        anySucceeded = true
      }
    }
    if (anySucceeded) {
      return
    }
  }

  try {
    const client = await createAuthenticatedClient(globalOptions, context)
    const currentUser = await client.getUserInformation()
    writeLine(context.stderr, `Logged in as: ${currentUser.name ?? 'unknown'}`)
  } catch {
    writeLine(context.stderr, 'Not logged in. Run `logfire auth` to log in.')
  }

  const credentials = readProjectCredentials(dataDir)
  if (credentials === undefined) {
    throw new LogfireCliError(`No Logfire credentials found in ${dataDir}`)
  }
  writeLine(context.stderr, `Credentials loaded from data dir: ${dataDir}`)
  writeLine(context.stderr)
  writeProjectSummary(context, credentials.project_url)
}

function writeProjectSummary(context: CliContext, projectUrl: string): void {
  writeLine(context.stderr, `Logfire project URL: ${projectUrl}`)
}

function parseTokenList(value: string | undefined): string[] {
  if (value === undefined || value.trim() === '') {
    return []
  }
  return value
    .split(',')
    .map((token) => token.trim())
    .filter((token) => token !== '')
}

function parseDataDir(args: string[]): string | undefined {
  let dataDir: string | undefined
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? ''
    if (arg === '--data-dir') {
      dataDir = readRequiredValue(args, ++index, '--data-dir')
    } else if (arg.startsWith('--data-dir=')) {
      dataDir = arg.slice('--data-dir='.length)
    } else {
      throw new LogfireCliError(`Unexpected argument ${arg}`)
    }
  }
  return dataDir
}

function readRequiredValue(args: string[], index: number, option: string): string {
  const value = args[index]
  if (value === undefined) {
    throw new LogfireCliError(`Missing value for ${option}`)
  }
  return value
}
