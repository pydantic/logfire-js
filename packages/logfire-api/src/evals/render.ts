/* eslint-disable @typescript-eslint/no-non-null-assertion */
/**
 * Plain-text report renderer. No `rich` equivalent; we hand-roll a compact
 * fixed-width table that's readable in a TTY and reasonable in CI logs.
 */

import type { EvaluationReport, ReportCase, ReportCaseFailure } from './reporting'

export interface RenderOptions {
  includeFailures?: boolean
  includeInput?: boolean
  includeOutput?: boolean
}

export function renderReport<I, O, M>(report: EvaluationReport<I, O, M>, opts: RenderOptions = {}): string {
  const lines: string[] = []
  lines.push(`Experiment: ${report.name}`)
  lines.push(`Cases: ${report.cases.length.toString()}, Failures: ${report.failures.length.toString()}`)

  if (report.cases.length > 0) {
    lines.push('')
    lines.push(...renderCaseTable(report.cases, opts))
  }

  if ((opts.includeFailures ?? true) && report.failures.length > 0) {
    lines.push('')
    lines.push('Failures:')
    for (const f of report.failures) {
      lines.push(...renderFailure(f))
    }
  }

  if (report.analyses.length > 0) {
    lines.push('')
    lines.push(`Analyses: ${report.analyses.length.toString()}`)
    for (const a of report.analyses) {
      lines.push(`  • ${a.title} (${a.type})`)
    }
  }

  return lines.join('\n')
}

function renderCaseTable<I, O, M>(cases: readonly ReportCase<I, O, M>[], opts: RenderOptions): string[] {
  const headers = ['name', 'duration(s)']
  if (opts.includeInput === true) headers.push('input')
  if (opts.includeOutput === true) headers.push('output')
  headers.push('scores', 'labels', 'assertions')

  const rows: string[][] = []
  for (const c of cases) {
    const row: string[] = [c.name, c.task_duration.toFixed(3)]
    if (opts.includeInput === true) row.push(truncate(JSON.stringify(c.inputs), 30))
    if (opts.includeOutput === true) row.push(truncate(JSON.stringify(c.output), 30))
    row.push(formatResultMap(c.scores), formatResultMap(c.labels), formatResultMap(c.assertions))
    rows.push(row)
  }

  return formatTable(headers, rows)
}

function renderFailure(f: ReportCaseFailure): string[] {
  return [`  ✗ ${f.name}: ${f.error_type}: ${f.error_message}`]
}

function formatResultMap(m: Record<string, { value: unknown }>): string {
  const entries = Object.entries(m)
  if (entries.length === 0) return '-'
  return entries.map(([k, r]) => `${k}=${formatValue(r.value)}`).join(', ')
}

function formatValue(v: unknown): string {
  if (typeof v === 'boolean') return v ? '✓' : '✗'
  if (typeof v === 'number') return v.toFixed(3).replace(/\.?0+$/, '')
  return String(v)
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return `${s.slice(0, max - 1)}…`
}

function formatTable(headers: string[], rows: string[][]): string[] {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)))
  const sep = (ch: string): string => `+${widths.map((w) => ch.repeat(w + 2)).join('+')}+`
  const formatRow = (cells: string[]): string => `| ${cells.map((c, i) => c.padEnd(widths[i]!)).join(' | ')} |`
  return [sep('-'), formatRow(headers), sep('='), ...rows.map(formatRow), sep('-')]
}
