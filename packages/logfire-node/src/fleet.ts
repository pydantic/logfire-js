import type { Resource } from '@opentelemetry/resources'
import type { Sampler } from '@opentelemetry/sdk-trace-base'

import { diag } from '@opentelemetry/api'
import { createRequire } from 'node:module'

/** The contract version of `@pydantic/logfire-fleet-otel`'s `LogfireFleet` this SDK calls. */
export const FLEET_CONTRACT = 1

const FLEET_PACKAGE = '@pydantic/logfire-fleet-otel'

/**
 * Options for joining Logfire Fleet. Each one left out comes from its environment variable, which
 * is what the Fleet setup page in Logfire gives you.
 */
export interface FleetOptions {
  /** The Fleet server's OpAMP endpoint. Defaults to the `OTEL_OPAMP_ENDPOINT` environment variable. */
  endpoint?: string
  /**
   * Headers sent to the Fleet server, such as the enrollment key's `Authorization` header.
   * Defaults to the `OTEL_OPAMP_HEADERS` environment variable.
   */
  headers?: Record<string, string>
  /** How often to tell the Fleet server this instance is alive. Defaults to `OTEL_OPAMP_HEARTBEAT_INTERVAL`. */
  heartbeatIntervalMs?: number
  /**
   * Where the last policy received and the instance ID are kept, so a restart starts with them even
   * when the Fleet server can't be reached. Defaults to `OTEL_OPAMP_STATE_DIR`, else a directory of
   * the Fleet client's own; `'none'` keeps nothing.
   */
  stateDir?: string
  /**
   * The Fleet client, as `import * as fleetClient from '@pydantic/logfire-fleet-otel'`. Left out, the
   * SDK loads the package itself, which a bundler or a file tracer (Vercel, Next.js standalone
   * output) can't see, so it may leave the package out of the deployment. Passing it in makes the
   * import one they see.
   */
  client?: FleetClient
}

/** What `@pydantic/logfire-fleet-otel` hands back: see its `LogfireFleet`. */
export interface FleetHook {
  readonly contract: number
  headSampler(sampler: Sampler | undefined): Sampler
  readonly resourceAttributes: Readonly<Record<string, string>>
  shutdown(): Promise<void>
  start(startSdk: () => void, resource: Resource): void
}

/** What `@pydantic/logfire-fleet-otel` exports that the SDK uses. */
export interface FleetClient {
  LOGFIRE_FLEET_CONTRACT?: number
  logfireFleet?: (options: Omit<FleetOptions, 'client'>) => FleetHook | undefined
}

/** Loads the Fleet package. Replaced in tests. */
export const fleetLoader = {
  load: (): FleetClient => createRequire(import.meta.url)(FLEET_PACKAGE) as FleetClient,
}

/** Says, on the console too, that Fleet can't be joined and the SDK runs unmanaged. */
export function warnUnmanaged(reason: string): void {
  // Said on the console, not only on diag: a fleet that was asked for and isn't joined must not be silent.
  console.warn(`logfire: ${reason}. The SDK runs unmanaged.`)
  diag.warn(`logfire: ${reason}`)
}

/**
 * The Fleet client's hook for `options`, or undefined (with a warning) where it can't run. Never
 * throws: telemetry is sent either way, under the SDK's own settings.
 */
export function loadFleet(options: FleetOptions, env: NodeJS.ProcessEnv = process.env): FleetHook | undefined {
  const { client, ...clientOptions } = options
  let fleet: FleetClient
  try {
    fleet = client ?? fleetLoader.load()
  } catch (e: unknown) {
    const missing = (e as { code?: string }).code === 'MODULE_NOT_FOUND'
    warnUnmanaged(
      missing
        ? `Logfire Fleet needs ${FLEET_PACKAGE}: \`npm install ${FLEET_PACKAGE}\`. If it is installed, a bundler or ` +
            `file tracer left it out of the deployment: pass it in, as \`fleet: { client }\``
        : `${FLEET_PACKAGE} could not be loaded (${String(e)})`
    )
    return undefined
  }
  if (fleet.LOGFIRE_FLEET_CONTRACT !== FLEET_CONTRACT || typeof fleet.logfireFleet !== 'function') {
    warnUnmanaged(
      `the installed ${FLEET_PACKAGE} speaks contract ${String(fleet.LOGFIRE_FLEET_CONTRACT)}, not ${String(FLEET_CONTRACT)}: install a matching version`
    )
    return undefined
  }
  const disabled = ['1', 'true', 'yes'].includes((env['OTEL_OPAMP_DISABLED'] ?? '').trim().toLowerCase())
  if ((options.endpoint ?? env['OTEL_OPAMP_ENDPOINT'] ?? '').trim() === '' && !disabled) {
    warnUnmanaged('no Fleet endpoint is set: set `OTEL_OPAMP_ENDPOINT` or `fleet: { endpoint }`')
    return undefined
  }
  try {
    return fleet.logfireFleet(clientOptions)
  } catch (e: unknown) {
    warnUnmanaged(`the Fleet client could not start (${String(e)})`)
    return undefined
  }
}
