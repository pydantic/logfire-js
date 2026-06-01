export const Level = {
  Trace: 1 as const,
  Debug: 5 as const,
  Info: 9 as const,
  Notice: 10 as const,
  Warning: 13 as const,
  Error: 17 as const,
  Fatal: 21 as const,
}

export type LogFireLevel = (typeof Level)[keyof typeof Level]
const LEVEL_NAMES = ['trace', 'debug', 'info', 'notice', 'warning', 'error', 'fatal'] as const
export type LevelName = (typeof LEVEL_NAMES)[number]
export type MinLevel = LogFireLevel | LevelName

export const LEVEL_NUMBERS: Record<LevelName, LogFireLevel> = {
  trace: Level.Trace,
  debug: Level.Debug,
  info: Level.Info,
  notice: Level.Notice,
  warning: Level.Warning,
  error: Level.Error,
  fatal: Level.Fatal,
}

const LEVEL_NUMBER_VALUES = new Set<LogFireLevel>(Object.values(Level))

export function isLogFireLevel(value: number): value is LogFireLevel {
  return LEVEL_NUMBER_VALUES.has(value as LogFireLevel)
}

export function parseLevelName(value: string): LevelName | undefined {
  const normalized = value.trim().toLowerCase()
  return Object.hasOwn(LEVEL_NUMBERS, normalized) ? (normalized as LevelName) : undefined
}

export function resolveMinLevel(value: MinLevel): LogFireLevel {
  if (typeof value === 'number') {
    if (isLogFireLevel(value)) {
      return value
    }
  } else {
    const levelName = parseLevelName(value)
    if (levelName !== undefined) {
      return LEVEL_NUMBERS[levelName]
    }
  }

  throw new Error(`Invalid minLevel: ${value}. Expected one of ${LEVEL_NAMES.join(', ')} or a numeric value from logfire.Level.`)
}
