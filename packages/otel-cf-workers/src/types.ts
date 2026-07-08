import type { TextMapPropagator } from '@opentelemetry/api'
import type { IdGenerator, ReadableSpan, Sampler, SpanExporter, SpanProcessor } from '@opentelemetry/sdk-trace-base'
import type { OTLPExporterConfig } from './exporter.js'
import type { FetchHandlerConfig, FetcherConfig } from './instrumentation/fetch.js'
import type { TailSampleFn } from './sampling.js'
import type { InstrumentationScope } from '@opentelemetry/core'

export type PostProcessorFn = (spans: ReadableSpan[]) => ReadableSpan[]

export type ExporterConfig = OTLPExporterConfig | SpanExporter

export type {
  FetchHandlerConfig,
  FetcherConfig,
  HeaderCaptureConfig,
  HeaderCapturePredicate,
  HeaderCaptureSelector,
} from './instrumentation/fetch.js'

export interface HandlerConfig {
  fetch?: FetchHandlerConfig
}

export interface ServiceConfig {
  name: string
  namespace?: string
  version?: string
}

export interface ScopeConfig {
  name: string
  version?: string
  schemaUrl?: string
}

export interface ParentRatioSamplingConfig {
  acceptRemote?: boolean
  ratio: number
}

type HeadSamplerConf = Sampler | ParentRatioSamplingConfig
export interface SamplingConfig<HS extends HeadSamplerConf = HeadSamplerConf> {
  headSampler?: HS
  tailSampler?: TailSampleFn
}

export interface InstrumentationOptions {
  instrumentGlobalFetch?: boolean
  instrumentGlobalCache?: boolean
}

interface TraceConfigBase {
  service: ServiceConfig
  scope?: ScopeConfig
  handlers?: HandlerConfig
  fetch?: FetcherConfig
  postProcessor?: PostProcessorFn
  sampling?: SamplingConfig
  propagator?: TextMapPropagator
  instrumentation?: InstrumentationOptions
  idGenerator?: IdGenerator
  environment?: string
}

interface TraceConfigExporter extends TraceConfigBase {
  exporter: ExporterConfig
  additionalSpanProcessors?: SpanProcessor[]
}

interface TraceConfigSpanProcessors extends TraceConfigBase {
  spanProcessors: SpanProcessor | SpanProcessor[]
}

export type TraceConfig = TraceConfigExporter | TraceConfigSpanProcessors

export function isSpanProcessorConfig(config: TraceConfig): config is TraceConfigSpanProcessors {
  return 'spanProcessors' in config
}

export interface ResolvedTraceConfig extends TraceConfigBase {
  handlers: Required<HandlerConfig>
  fetch: Required<FetcherConfig>
  postProcessor: PostProcessorFn
  sampling: Required<SamplingConfig<Sampler>>
  spanProcessors: SpanProcessor[]
  propagator: TextMapPropagator
  instrumentation: InstrumentationOptions
  scope: InstrumentationScope
  idGenerator: IdGenerator
}

export interface DOConstructorTrigger {
  id: string
  name?: string
}

export type Trigger = Request | MessageBatch | ScheduledController | DOConstructorTrigger | 'do-alarm' | ForwardableEmailMessage
