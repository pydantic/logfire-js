import type { LogFireLevel, MinLevel } from 'logfire'
import { Level } from 'logfire'

export interface ConsoleOptions {
  /**
   * Whether to print spans to the console. Defaults to true when console is an object.
   */
  enabled?: boolean
  /**
   * Minimum Logfire level to print to the console. Defaults to info.
   *
   * This filters console output only and does not control telemetry creation.
   */
  minLevel?: MinLevel
  /**
   * Whether to include logfire.tags in printed attributes. Defaults to true.
   */
  includeTags?: boolean
  /**
   * Whether to include span timestamps in printed metadata. Defaults to true.
   */
  includeTimestamps?: boolean
}

export type ConsoleConfig = boolean | ConsoleOptions

export interface ResolvedConsoleOptions {
  enabled: boolean
  includeTags: boolean
  includeTimestamps: boolean
  minLevel: LogFireLevel
}

const LEVEL_NAMES = ['trace', 'debug', 'info', 'notice', 'warning', 'error', 'fatal'] as const
const LEVEL_NUMBERS: Record<(typeof LEVEL_NAMES)[number], LogFireLevel> = {
  debug: Level.Debug,
  error: Level.Error,
  fatal: Level.Fatal,
  info: Level.Info,
  notice: Level.Notice,
  trace: Level.Trace,
  warning: Level.Warning,
}
const LEVEL_NUMBER_VALUES = new Set<LogFireLevel>(Object.values(Level))

export function resolveConsoleOptions(config: ConsoleConfig | undefined): ResolvedConsoleOptions {
  if (config === undefined || config === false) {
    return {
      enabled: false,
      includeTags: true,
      includeTimestamps: true,
      minLevel: Level.Info,
    }
  }

  if (config === true) {
    return {
      enabled: true,
      includeTags: true,
      includeTimestamps: true,
      minLevel: Level.Info,
    }
  }

  return {
    enabled: config.enabled ?? true,
    includeTags: config.includeTags ?? true,
    includeTimestamps: config.includeTimestamps ?? true,
    minLevel: config.minLevel === undefined ? Level.Info : resolveConsoleMinLevel(config.minLevel),
  }
}

function resolveConsoleMinLevel(value: MinLevel): LogFireLevel {
  if (typeof value === 'number') {
    if (LEVEL_NUMBER_VALUES.has(value)) {
      return value
    }
  } else {
    const normalized = value.trim().toLowerCase()
    if (Object.hasOwn(LEVEL_NUMBERS, normalized)) {
      return LEVEL_NUMBERS[normalized as keyof typeof LEVEL_NUMBERS]
    }
  }

  throw new Error(
    `Invalid console.minLevel: ${String(value)}. Expected one of ${LEVEL_NAMES.join(', ')} or a numeric value from logfire.Level.`
  )
}
