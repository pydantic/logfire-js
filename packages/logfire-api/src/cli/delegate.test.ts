import { describe, expect, it, vi } from 'vite-plus/test'

import { runCli, runNativeCli } from './delegate'

describe('native CLI delegation', () => {
  it('loads the packaged launcher with the JavaScript SDK version', () => {
    const env: NodeJS.ProcessEnv = {}
    const load = vi.fn<(id: string) => unknown>()

    runNativeCli('0.22.9', env, load)

    expect(env).toEqual({ LOGFIRE_CLI_SDK_VERSION: '0.22.9' })
    expect(load).toHaveBeenCalledExactlyOnceWith('logfire-cli/run-logfire.js')
  })

  it('reports how to restore an omitted native package', () => {
    const writeError = vi.fn<(message: string) => void>()
    const missingLauncher = Object.assign(new Error("Cannot find module 'logfire-cli/run-logfire.js'"), {
      code: 'MODULE_NOT_FOUND',
    })

    expect(
      runCli(() => {
        throw missingLauncher
      }, writeError)
    ).toBe(false)
    expect(writeError).toHaveBeenCalledExactlyOnceWith(
      'Logfire CLI is unavailable. Reinstall logfire without --omit=optional or --no-optional.'
    )
  })

  it('does not hide launcher initialization failures', () => {
    const failure = new Error('launcher initialization failed')
    const writeError = vi.fn<(message: string) => void>()

    expect(() =>
      runCli(() => {
        throw failure
      }, writeError)
    ).toThrow(failure)
    expect(writeError).not.toHaveBeenCalled()
  })

  it('does not mistake a missing transitive module for the optional launcher', () => {
    const failure = Object.assign(new Error("Cannot find module 'launcher-internal-dependency'"), {
      code: 'MODULE_NOT_FOUND',
    })

    expect(() =>
      runCli(() => {
        throw failure
      })
    ).toThrow(failure)
  })

  it('preserves a successful native CLI exit', () => {
    const run = vi.fn<() => void>()

    expect(runCli(run)).toBe(true)
    expect(run).toHaveBeenCalledExactlyOnceWith()
  })
})
