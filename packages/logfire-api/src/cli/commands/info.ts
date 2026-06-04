import type { CliContext } from '../context'
import { writeLine } from '../output'

export function runInfoCommand(context: CliContext): void {
  writeLine(context.stderr, `logfire="${PACKAGE_VERSION}"`)
  writeLine(context.stderr, `platform="${context.platform}"`)
  writeLine(context.stderr, `node="${process.version}"`)
  writeLine(context.stderr, '[related_packages]')
  writeLine(context.stderr, 'logfire="' + PACKAGE_VERSION + '"')
}
