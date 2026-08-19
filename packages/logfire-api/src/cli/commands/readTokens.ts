import { createAuthenticatedClient } from '../authClient'
import type { CliContext, GlobalOptions } from '../context'
import { defaultDataDir, organizationFromProjectUrl, readProjectCredentials, saveReadToken } from '../credentials'
import { LogfireCliError } from '../errors'
import { writeLine } from '../output'

// Only tokens this CLI writes to disk get an expiry. It cannot revoke a token, so one
// sitting in a file needs some end; a token printed for the caller to paste elsewhere
// does not get one, because we do not know what it was wired into and silently breaking
// it later would be worse than leaving it.
const READ_TOKEN_TTL_DAYS = 30

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

  const dataDir = parsed.dataDir ?? defaultDataDir(context.cwd)
  let organization = parsed.organization
  let project = parsed.project
  if (organization === undefined || project === undefined) {
    // No --project, so fall back to whatever this directory is linked to. That is what
    // makes `read-tokens create --save` work with no arguments at all, which is the case
    // this option exists for.
    const credentials = readProjectCredentials(dataDir)
    if (credentials === undefined) {
      throw new LogfireCliError(
        `No Logfire credentials found in ${dataDir}\nPass --project <org>/<project>, or run \`logfire projects use PROJECT_NAME\` first.`
      )
    }
    organization = organization ?? organizationFromProjectUrl(credentials.project_url)
    project = project ?? credentials.project_name
    if (organization === undefined) {
      throw new LogfireCliError(`Cannot tell which organization ${credentials.project_url} belongs to.`)
    }
  }

  const client = await createAuthenticatedClient(globalOptions, context)

  if (!parsed.save) {
    const response = await client.createReadToken(organization, project)
    writeLine(context.stdout, response.token)
    return
  }

  const expiresAt = new Date(Date.now() + READ_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000)
  const response = await client.createReadToken(organization, project, expiresAt)
  const path = saveReadToken(dataDir, {
    baseUrl: client.baseUrl,
    expiresAt,
    organization,
    projectName: project,
    token: response.token,
  })
  // To stderr, and without the token. The whole point of `--save` is that the credential
  // never reaches a terminal, a log, or an agent's transcript.
  writeLine(context.stderr, `Read token for ${organization}/${project} saved to ${path}.`)
  writeLine(context.stderr, `It expires in ${String(READ_TOKEN_TTL_DAYS)} days. \`logfire projects status\` will use it.`)
}

interface ReadTokensArgs {
  command: string | undefined
  dataDir: string | undefined
  organization: string | undefined
  project: string | undefined
  save: boolean
}

function parseReadTokensArgs(args: string[]): ReadTokensArgs {
  let organization: string | undefined
  let project: string | undefined
  let dataDir: string | undefined
  let command: string | undefined
  let save = false

  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? ''
    if (arg === '--project') {
      ;[organization, project] = parseOrgProject(readRequiredValue(args, ++index, '--project'))
    } else if (arg.startsWith('--project=')) {
      ;[organization, project] = parseOrgProject(arg.slice('--project='.length))
    } else if (arg === '--data-dir') {
      dataDir = readRequiredValue(args, ++index, '--data-dir')
    } else if (arg.startsWith('--data-dir=')) {
      dataDir = arg.slice('--data-dir='.length)
    } else if (arg === '--save') {
      save = true
    } else if (arg.startsWith('-')) {
      throw new LogfireCliError(`Unknown option ${arg}`)
    } else if (command === undefined) {
      command = arg
    } else {
      throw new LogfireCliError(`Unexpected argument ${arg}`)
    }
  }

  return { command, dataDir, organization, project, save }
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
  writeLine(context.stdout, '   or: logfire read-tokens create --save')
  writeLine(context.stdout)
  writeLine(context.stdout, '--save writes the token into the data directory instead of printing it, for `logfire projects status`.')
}
