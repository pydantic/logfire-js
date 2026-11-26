import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'

const CLI_MANIFEST = 'logfire-cli/package.json'

/** Delegate to the installed package's declared bin, without resolving a command from PATH. */
export function runNativeCli(args: string[], sdkVersion: string, load: NodeJS.Require = createRequire(import.meta.url)): number {
  let manifestPath: string
  try {
    manifestPath = load.resolve(CLI_MANIFEST)
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'MODULE_NOT_FOUND') {
      console.error('Logfire CLI is unavailable. Install optional dependencies on a supported platform.')
      return 1
    }
    throw error
  }

  const manifest = load(manifestPath) as { bin?: { logfire?: unknown } }
  const bin = manifest.bin?.logfire
  if (typeof bin !== 'string' || bin.length === 0) {
    throw new Error('The installed logfire-cli package does not declare a logfire command.')
  }

  const result = spawnSync(process.execPath, [resolve(dirname(manifestPath), bin), ...args], {
    env: { ...process.env, LOGFIRE_CLI_SDK_VERSION: sdkVersion, LOGFIRE_CLI_COMMAND_NAME: 'logfire' },
    stdio: 'inherit',
  })
  if (result.error) {
    throw result.error
  }
  if (result.signal) {
    process.kill(process.pid, result.signal)
  }
  return result.status ?? 1
}
