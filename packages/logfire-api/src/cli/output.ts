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

export function prettyTable(header: string[], rows: string[][]): string {
  const indent = (cells: string[]): string[] => [` ${cells[0] ?? ''}`, ...cells.slice(1)]
  const tableRows = [indent(header), ...rows.map(indent)]
  const widths = header.map((_, index) => Math.max(...tableRows.map((row) => row[index]?.length ?? 0)))
  const lines = tableRows.map((row) => row.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join('   | '))
  lines.splice(1, 0, widths.map((width) => '-'.repeat(width)).join('---|-'))
  return `${lines.join('\n')}\n`
}
