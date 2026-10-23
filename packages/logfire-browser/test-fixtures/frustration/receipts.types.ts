import type { RrwebEvent } from '../../../logfire-session-replay/dist/index.js'

export interface FrustrationSpan {
  name: string
  attributes: { key: string; value: { stringValue?: string; intValue?: string | number; doubleValue?: number } }[]
}

export interface FrustrationReceipts {
  spans: FrustrationSpan[]
  chunks: { id: string; seq: number; events: RrwebEvent[] }[]
}
