import { EvaluatorContext } from './evaluators/context'

export interface Case<InputsT = unknown, OutputT = unknown, MetadataT = unknown> {
  evaluators: unknown[]
  expectedOutput: null | OutputT
  inputs: InputsT
  metadata: MetadataT | null
  name: null | string
}

export interface ReportCaseLike {
  name: string
}

export abstract class CaseLifecycle<InputsT = unknown, OutputT = unknown, MetadataT = unknown> {
  readonly case: Case<InputsT, OutputT, MetadataT>

  constructor(caseObj: Case<InputsT, OutputT, MetadataT>) {
    this.case = caseObj
  }

  async prepareContext(ctx: EvaluatorContext<InputsT, OutputT, MetadataT>): Promise<EvaluatorContext<InputsT, OutputT, MetadataT>> {
    return await Promise.resolve(ctx)
  }

  async setup(): Promise<void> {
    // no-op
    await Promise.resolve()
  }

  async teardown(_result: ReportCaseLike): Promise<void> {
    // no-op
    await Promise.resolve()
  }
}
