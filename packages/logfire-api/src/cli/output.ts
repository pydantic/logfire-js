export interface WritableOutput {
  write(chunk: string): unknown
}

export interface CliOutput {
  stderr: WritableOutput
  stdout: WritableOutput
}

export function writeLine(output: WritableOutput, message = ''): void {
  output.write(`${message}\n`)
}

/**
 * Strip control characters from text before it reaches a terminal. Telemetry fields, a
 * saved credentials file inside the user's repo, and a server's own response body are all
 * text this CLI did not author -- written raw, escape sequences in any of them could clear
 * the screen, reposition the cursor, or forge rows in whatever table or message the
 * operator is actually reading to decide whether their setup worked.
 */
export function sanitizeForTerminal(text: string): string {
  // eslint-disable-next-line no-control-regex -- the control characters ARE the target.
  return text.replace(/[\x00-\x1f\x7f-\x9f]/gu, '�')
}

export function prettyTable(header: string[], rows: string[][]): string {
  const indent = (cells: string[]): string[] => [` ${cells[0] ?? ''}`, ...cells.slice(1)]
  const tableRows = [indent(header), ...rows.map(indent)]
  const widths = header.map((_, index) => Math.max(...tableRows.map((row) => row[index]?.length ?? 0)))
  const lines = tableRows.map((row) => row.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join('   | '))
  lines.splice(1, 0, widths.map((width) => '-'.repeat(width)).join('---|-'))
  return `${lines.join('\n')}\n`
}
