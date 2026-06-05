#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import type { Readable, Writable } from 'node:stream'
import { pathToFileURL } from 'node:url'

import { runAuthCommand } from './commands/auth'
import { runCleanCommand } from './commands/clean'
import { runInfoCommand } from './commands/info'
import { runProjectsCommand } from './commands/projects'
import { runReadTokensCommand } from './commands/readTokens'
import { runWhoamiCommand } from './commands/whoami'
import type { CliContext, GlobalOptions } from './context'
import { LogfireCliError, isLogfireCliError } from './errors'
import { createPrompt } from './interactivePrompt'
import type { Prompt } from './interactivePrompt'
import { writeLine } from './output'
import { resolveSelectedBaseUrl } from './regions'

export interface CliContextOptions {
  cwd?: string
  env?: Record<string, string | undefined>
  fetch?: typeof fetch
  homeDir?: string
  openBrowser?: (url: string) => Promise<void> | void
  platform?: NodeJS.Platform
  prompt?: Prompt
  stderr?: Writable
  stdin?: Readable
  stdout?: Writable
}

interface ParsedArgs {
  command: string | undefined
  commandArgs: string[]
  globalOptions: GlobalOptions
  help: boolean
  version: boolean
}

export async function runCli(argv: string[] = process.argv.slice(2), options: CliContextOptions = {}): Promise<number> {
  const context = createCliContext(options)
  try {
    const parsed = parseArgs(argv)
    if (parsed.version) {
      printVersion(context)
      return 0
    }
    if (parsed.help || parsed.command === undefined) {
      printHelp(context)
      return 0
    }

    await dispatch(parsed.command, parsed.commandArgs, parsed.globalOptions, context)
    return 0
  } catch (error) {
    if (isLogfireCliError(error)) {
      if (error.message !== '') {
        writeLine(context.stderr, error.message)
      }
      return error.exitCode
    }
    throw error
  }
}

function createCliContext(options: CliContextOptions): CliContext {
  const stdin = options.stdin ?? process.stdin
  const stderr = options.stderr ?? process.stderr
  const stdout = options.stdout ?? process.stdout
  const platform = options.platform ?? process.platform
  return {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    fetch: options.fetch ?? fetch,
    homeDir: options.homeDir ?? homedir(),
    openBrowser:
      options.openBrowser ??
      ((url: string) => {
        openBrowser(url, platform)
      }),
    platform,
    prompt: options.prompt ?? createPrompt({ input: stdin, output: stderr }),
    stderr,
    stdin,
    stdout,
  }
}

async function dispatch(command: string, args: string[], globalOptions: GlobalOptions, context: CliContext): Promise<void> {
  if (command === 'auth') {
    await runAuthCommand(args, globalOptions, context)
    return
  }
  if (command === 'clean') {
    await runCleanCommand(args, context)
    return
  }
  if (command === 'info') {
    runInfoCommand(context)
    return
  }
  if (command === 'projects') {
    await runProjectsCommand(args, globalOptions, context)
    return
  }
  if (command === 'read-tokens') {
    await runReadTokensCommand(args, globalOptions, context)
    return
  }
  if (command === 'whoami') {
    await runWhoamiCommand(args, globalOptions, context)
    return
  }
  throw new LogfireCliError(`Unknown command "${command}".`)
}

function parseArgs(argv: string[]): ParsedArgs {
  let command: string | undefined
  let baseUrl: string | undefined
  let region: string | undefined
  let help = false
  let version = false

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] ?? ''
    if (arg === '--help' || arg === '-h') {
      help = true
    } else if (arg === '--version') {
      version = true
    } else if (arg === '--base-url' || arg === '--logfire-url') {
      assertNoRegionConflict(baseUrl, region, arg)
      baseUrl = readRequiredValue(argv, ++index, arg)
    } else if (arg.startsWith('--base-url=')) {
      assertNoRegionConflict(baseUrl, region, '--base-url')
      baseUrl = arg.slice('--base-url='.length)
    } else if (arg.startsWith('--logfire-url=')) {
      assertNoRegionConflict(baseUrl, region, '--logfire-url')
      baseUrl = arg.slice('--logfire-url='.length)
    } else if (arg === '--region') {
      assertNoRegionConflict(baseUrl, region, '--region')
      region = readRequiredValue(argv, ++index, '--region')
    } else if (arg.startsWith('--region=')) {
      assertNoRegionConflict(baseUrl, region, '--region')
      region = arg.slice('--region='.length)
    } else if (arg.startsWith('-')) {
      throw new LogfireCliError(`Unknown option ${arg}`)
    } else {
      command = arg
      return {
        command,
        commandArgs: argv.slice(index + 1),
        globalOptions: buildGlobalOptions(baseUrl, region),
        help,
        version,
      }
    }
  }

  return {
    command,
    commandArgs: [],
    globalOptions: buildGlobalOptions(baseUrl, region),
    help,
    version,
  }
}

function buildGlobalOptions(baseUrl: string | undefined, region: string | undefined): GlobalOptions {
  const resolvedBaseUrl = resolveSelectedBaseUrl(baseUrl, region)
  const options: GlobalOptions = {}
  if (resolvedBaseUrl !== undefined) {
    options.baseUrl = resolvedBaseUrl
  }
  if (region !== undefined) {
    options.region = region
  }
  return options
}

function assertNoRegionConflict(baseUrl: string | undefined, region: string | undefined, option: string): void {
  if ((option === '--region' && baseUrl !== undefined) || (option !== '--region' && region !== undefined)) {
    throw new LogfireCliError('Only one of --base-url and --region can be used.')
  }
}

function readRequiredValue(args: string[], index: number, option: string): string {
  const value = args[index]
  if (value === undefined) {
    throw new LogfireCliError(`Missing value for ${option}`)
  }
  return value
}

function printHelp(context: CliContext): void {
  writeLine(context.stdout, 'The CLI for Pydantic Logfire.')
  writeLine(context.stdout)
  writeLine(context.stdout, 'Usage: logfire [--version] [--base-url <url> | --region <region>] <command>')
  writeLine(context.stdout)
  writeLine(context.stdout, 'Commands:')
  writeLine(context.stdout, '  auth         Authenticate with Logfire')
  writeLine(context.stdout, '  clean        Remove local Logfire project credentials')
  writeLine(context.stdout, '  info         Show SDK and runtime information')
  writeLine(context.stdout, '  projects     Project management for Logfire')
  writeLine(context.stdout, '  read-tokens  Manage read tokens for a project')
  writeLine(context.stdout, '  whoami       Show authenticated user and project information')
}

function printVersion(context: CliContext): void {
  writeLine(context.stdout, `Running Logfire ${PACKAGE_VERSION} with Node ${process.version} on ${context.platform}.`)
}

function openBrowser(url: string, platform: NodeJS.Platform): void {
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' })
    child.on('error', () => undefined)
    child.unref()
  } catch {
    // The auth command prints the URL after this attempt, so opening failure is non-fatal.
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli()
    .then((exitCode) => {
      process.exitCode = exitCode
    })
    .catch((error: unknown) => {
      writeLine(process.stderr, String(error instanceof Error ? error.message : error))
      process.exitCode = 1
    })
}
