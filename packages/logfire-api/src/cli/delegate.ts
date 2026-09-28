import { createRequire } from 'node:module'

type ModuleLoader = (id: string) => unknown
type ErrorWriter = (message: string) => void

const CLI_LAUNCHER = 'logfire-cli/run-logfire.js'
const MISSING_CLI_MESSAGE = 'Logfire CLI is unavailable. Reinstall logfire without --omit=optional or --no-optional.'

function isMissingCliLauncher(error: unknown): boolean {
  return (
    error instanceof Error &&
    'code' in error &&
    error.code === 'MODULE_NOT_FOUND' &&
    error.message.startsWith(`Cannot find module '${CLI_LAUNCHER}'`)
  )
}

/** Run the native Logfire CLI while preserving the JavaScript SDK identity. */
export function runNativeCli(
  sdkVersion: string = PACKAGE_VERSION,
  env: NodeJS.ProcessEnv = process.env,
  load: ModuleLoader = createRequire(import.meta.url)
): void {
  env['LOGFIRE_CLI_SDK_VERSION'] = sdkVersion
  load(CLI_LAUNCHER)
}

/** Start the CLI with a concise recovery message when its optional package is absent. */
export function runCli(run: () => void = runNativeCli, writeError: ErrorWriter = console.error): boolean {
  try {
    run()
    return true
  } catch (error) {
    if (isMissingCliLauncher(error)) {
      writeError(MISSING_CLI_MESSAGE)
      return false
    }
    throw error
  }
}
