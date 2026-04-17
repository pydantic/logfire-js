import { ReportAnalysis } from '../reporting/analyses'
import { EvaluatorSpec } from './spec'

export interface ReportEvaluatorContext<InputsT = unknown, OutputT = unknown, MetadataT = unknown> {
  experimentMetadata: null | Record<string, unknown>
  name: string
  report: {
    cases: {
      assertions: Record<string, { reason: null | string; value: boolean }>
      expectedOutput: null | OutputT
      inputs: InputsT
      labels: Record<string, { reason: null | string; value: string }>
      metadata: MetadataT | null
      metrics: Record<string, number>
      name: string
      output: OutputT
      scores: Record<string, { reason: null | string; value: number }>
    }[]
  }
}

export abstract class ReportEvaluator<InputsT = unknown, OutputT = unknown, MetadataT = unknown> {
  asSpec(): EvaluatorSpec {
    const args = this.buildSerializationArguments()
    return { arguments: Object.keys(args).length === 0 ? null : args, name: this.getSerializationName() }
  }

  buildSerializationArguments(): Record<string, unknown> {
    const self = this as unknown as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(self)) {
      /* v8 ignore next - defensive guard for undefined instance fields */
      if (v === undefined) continue
      out[k] = v
    }
    return out
  }

  abstract evaluate(
    ctx: ReportEvaluatorContext<InputsT, OutputT, MetadataT>
  ): Promise<ReportAnalysis | ReportAnalysis[]> | ReportAnalysis | ReportAnalysis[]

  async evaluateAsync(ctx: ReportEvaluatorContext<InputsT, OutputT, MetadataT>): Promise<ReportAnalysis | ReportAnalysis[]> {
    return await Promise.resolve(this.evaluate(ctx))
  }

  getSerializationName(): string {
    const ctor = (this as unknown as { constructor: { name: string } }).constructor
    return ctor.name
  }
}
