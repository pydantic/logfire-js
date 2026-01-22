/*
 * Copyright The OpenTelemetry Authors
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

/** Properties of an ArrayValue. */
export interface IArrayValue {
  /** ArrayValue values */
  values: IAnyValue[]
}

/** Properties of a KeyValueList. */
export interface IKeyValueList {
  /** KeyValueList values */
  values: IKeyValue[]
}

export interface LongBits {
  high: number
  low: number
}

export type Fixed64 = LongBits | number | string

/** Properties of an AnyValue. */
export interface IAnyValue {
  /** AnyValue arrayValue */
  arrayValue?: IArrayValue

  /** AnyValue boolValue */
  boolValue?: boolean | null

  /** AnyValue bytesValue */
  bytesValue?: Uint8Array

  /** AnyValue doubleValue */
  doubleValue?: null | number

  /** AnyValue intValue */
  intValue?: null | number

  /** AnyValue kvlistValue */
  kvlistValue?: IKeyValueList

  /** AnyValue stringValue */
  stringValue?: null | string
}

/** Properties of a KeyValue. */
export interface IKeyValue {
  /** KeyValue key */
  key: string

  /** KeyValue value */
  value: IAnyValue
}

/** Properties of a Resource. */
export interface Resource {
  /** Resource attributes */
  attributes: IKeyValue[]

  /** Resource droppedAttributesCount */
  droppedAttributesCount: number
}

/** Properties of an ExportTraceServiceRequest. */
export interface IExportTraceServiceRequest {
  /** ExportTraceServiceRequest resourceSpans */
  resourceSpans?: IResourceSpans[]
}

/** Properties of a ResourceSpans. */
export interface IResourceSpans {
  /** ResourceSpans resource */
  resource?: Resource

  /** ResourceSpans schemaUrl */
  schemaUrl?: string

  /** ResourceSpans scopeSpans */
  scopeSpans: IScopeSpans[]
}

/** Properties of an ScopeSpans. */
export interface IScopeSpans {
  /** IScopeSpans schemaUrl */
  schemaUrl?: null | string

  /** IScopeSpans scope */
  scope?: IInstrumentationScope

  /** IScopeSpans spans */
  spans?: ISpan[]
}

/** Properties of an InstrumentationScope. */
export interface IInstrumentationScope {
  /** InstrumentationScope attributes */
  attributes?: IKeyValue[]

  /** InstrumentationScope droppedAttributesCount */
  droppedAttributesCount?: number

  /** InstrumentationScope name */
  name: string

  /** InstrumentationScope version */
  version?: string
}
/** Properties of a Span. */
export interface ISpan {
  /** Span attributes */
  attributes: IKeyValue[]

  /** Span droppedAttributesCount */
  droppedAttributesCount: number

  /** Span droppedEventsCount */
  droppedEventsCount: number

  /** Span droppedLinksCount */
  droppedLinksCount: number

  /** Span endTimeUnixNano */
  endTimeUnixNano: Fixed64

  /** Span events */
  // events: IEvent[]

  /** Span kind */
  // kind: ESpanKind

  /** Span links */
  // links: ILink[]

  /** Span name */
  name: string

  /** Span parentSpanId */
  parentSpanId?: string | Uint8Array

  /** Span spanId */
  spanId: string | Uint8Array

  /** Span startTimeUnixNano */
  startTimeUnixNano: Fixed64

  /** Span status */
  // status: IStatus

  /** Span traceId */
  traceId: string | Uint8Array

  /** Span traceState */
  traceState?: null | string
}
