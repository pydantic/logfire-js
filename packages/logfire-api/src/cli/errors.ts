export class LogfireCliError extends Error {
  readonly exitCode: number

  constructor(message: string, exitCode = 1) {
    super(message)
    this.name = 'LogfireCliError'
    this.exitCode = exitCode
  }
}

export function isLogfireCliError(error: unknown): error is LogfireCliError {
  return error instanceof LogfireCliError
}
