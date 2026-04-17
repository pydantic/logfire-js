import { SpanTreeRecordingError } from '../otel/errors'
import { SpanTree } from '../otel/spanTree'

export interface EvaluatorContextInit<InputsT, OutputT, MetadataT> {
  attributes: Record<string, unknown>
  duration: number
  expectedOutput: null | OutputT
  inputs: InputsT
  metadata: MetadataT | null
  metrics: Record<string, number>
  name: null | string
  output: OutputT
  spanTree: SpanTree | SpanTreeRecordingError
}

export class EvaluatorContext<InputsT = unknown, OutputT = unknown, MetadataT = unknown> {
  readonly attributes: Record<string, unknown>
  readonly duration: number
  readonly expectedOutput: null | OutputT
  readonly inputs: InputsT
  readonly metadata: MetadataT | null
  readonly metrics: Record<string, number>
  readonly name: null | string
  readonly output: OutputT
  get spanTree(): SpanTree {
    if (this._spanTree instanceof SpanTreeRecordingError) {
      throw this._spanTree
    }
    /* v8 ignore next - covered via contextSubtree integration but branch detection is flaky */
    return this._spanTree
  }

  private readonly _spanTree: SpanTree | SpanTreeRecordingError

  constructor(init: EvaluatorContextInit<InputsT, OutputT, MetadataT>) {
    this.name = init.name
    this.inputs = init.inputs
    this.metadata = init.metadata
    this.expectedOutput = init.expectedOutput
    this.output = init.output
    this.duration = init.duration
    this._spanTree = init.spanTree
    this.attributes = init.attributes
    this.metrics = init.metrics
  }
}
