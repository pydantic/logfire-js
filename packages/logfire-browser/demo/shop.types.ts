import type { RrwebEvent } from '../../logfire-session-replay/dist/index.js'

export interface DemoSpan {
  name: string
  attributes: { key: string; value: { stringValue?: string; intValue?: string | number; doubleValue?: number } }[]
}

export interface DemoEvidence {
  spans: DemoSpan[]
  chunks: { id: string; seq: number; events: RrwebEvent[] }[]
}
