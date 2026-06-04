import { createAuthenticatedClient } from '../authClient'
import type { CliContext, GlobalOptions } from '../context'
import { LogfireCliError } from '../errors'
import { writeLine } from '../output'

export async function runReadTokensCommand(args: string[], globalOptions: GlobalOptions, context: CliContext): Promise<void> {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printReadTokensHelp(context)
    return
  }
  const parsed = parseReadTokensArgs(args)
  if (parsed.command === undefined) {
    printReadTokensHelp(context)
    return
  }
  if (parsed.command !== 'create') {
    throw new LogfireCliError(`Unknown read-tokens command "${parsed.command}".`)
  }
  if (parsed.organization === undefined || parsed.project === undefined) {
    throw new LogfireCliError('Missing --project. Expected <org>/<project>.')
  }
  const client = await createAuthenticatedClient(globalOptions, context)
  const response = await client.createReadToken(parsed.organization, parsed.project)
  writeLine(context.stdout, response.token)
}

interface ReadTokensArgs {
  command: string | undefined
  organization: string | undefined
  project: string | undefined
}

function parseReadTokensArgs(args: string[]): ReadTokensArgs {
  let organization: string | undefined
  let project: string | undefined
  let command: string | undefined

  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? ''
    if (arg === '--project') {
      ;[organization, project] = parseOrgProject(readRequiredValue(args, ++index, '--project'))
    } else if (arg.startsWith('--project=')) {
      ;[organization, project] = parseOrgProject(arg.slice('--project='.length))
    } else if (arg.startsWith('-')) {
      throw new LogfireCliError(`Unknown option ${arg}`)
    } else if (command === undefined) {
      command = arg
    } else {
      throw new LogfireCliError(`Unexpected argument ${arg}`)
    }
  }

  return { command, organization, project }
}

function parseOrgProject(value: string): [string, string] {
  const parts = value.split('/')
  const organization = parts[0]
  const project = parts[1]
  if (parts.length !== 2 || organization === undefined || organization === '' || project === undefined || project === '') {
    throw new LogfireCliError(`Invalid format: ${value}. Expected <org>/<project>`)
  }
  return [organization, project]
}

function readRequiredValue(args: string[], index: number, option: string): string {
  const value = args[index]
  if (value === undefined) {
    throw new LogfireCliError(`Missing value for ${option}`)
  }
  return value
}

function printReadTokensHelp(context: CliContext): void {
  writeLine(context.stdout, 'usage: logfire read-tokens --project <org>/<project> create')
}
