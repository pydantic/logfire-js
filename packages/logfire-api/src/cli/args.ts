import { LogfireCliError } from './errors'

/**
 * Read the value that follows an option. A value starting with `-` is another option, not
 * this one's value: consuming it would silently swallow a flag and leave the option set to
 * the flag's own name.
 */
export function readRequiredValue(args: string[], index: number, option: string): string {
  const value = args[index]
  if (value === undefined || value.startsWith('-')) {
    throw new LogfireCliError(`Missing value for ${option}`)
  }
  return value
}
