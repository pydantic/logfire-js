import type { RrwebEvent } from '@pydantic/logfire-session-replay'

export interface FrustrationSpan {
  name: string
  attributes: { key: string; value: { stringValue?: string; intValue?: string | number; doubleValue?: number } }[]
}

export interface FrustrationReceipts {
  spans: FrustrationSpan[]
  chunks: { id: string; seq: number; events: RrwebEvent[] }[]
}
