import type { Context } from '@opentelemetry/api'
import { context } from '@opentelemetry/api'
import type { ExporterConfig, ParentRatioSamplingConfig, ResolvedTraceConfig, TraceConfig, Trigger } from './types.js'
import { isSpanProcessorConfig } from './types.js'
import { W3CTraceContextPropagator } from '@opentelemetry/core'
import type { ReadableSpan, Sampler, SpanExporter } from '@opentelemetry/sdk-trace-base'
import { AlwaysOnSampler, RandomIdGenerator } from '@opentelemetry/sdk-trace-base'

import { OTLPExporter } from './exporter.js'
import { multiTailSampler, isHeadSampled, isRootErrorSpan, createSampler } from './sampling.js'
import { BatchTraceSpanProcessor } from './spanprocessor.js'

const configSymbol = Symbol('Otel Workers Tracing Configuration')

export type Initialiser = (env: Record<string, unknown>, trigger: Trigger) => ResolvedTraceConfig

export function setConfig(config: ResolvedTraceConfig, ctx: Context = context.active()): Context {
  return ctx.setValue(configSymbol, config)
}

export function getActiveConfig(): ResolvedTraceConfig | undefined {
  return context.active().getValue(configSymbol) as ResolvedTraceConfig | undefined
}

function isSpanExporter(exporterConfig: ExporterConfig): exporterConfig is SpanExporter {
  return typeof (exporterConfig as SpanExporter).export === 'function'
}

function isSampler(sampler: Sampler | ParentRatioSamplingConfig): sampler is Sampler {
  return typeof (sampler as Sampler).shouldSample === 'function'
}

export function parseConfig(supplied: TraceConfig): ResolvedTraceConfig {
  if (isSpanProcessorConfig(supplied)) {
    const headSampleConf = supplied.sampling?.headSampler
    const headSampler = headSampleConf
      ? isSampler(headSampleConf)
        ? headSampleConf
        : createSampler(headSampleConf)
      : new AlwaysOnSampler()
    const spanProcessors = Array.isArray(supplied.spanProcessors) ? supplied.spanProcessors : [supplied.spanProcessors]
    if (spanProcessors.length === 0) {
      console.log(
        'Warning! You must either specify an exporter or your own SpanProcessor(s)/Exporter combination in the open-telemetry configuration.'
      )
    }
    return {
      fetch: {
        includeTraceContext: supplied.fetch?.includeTraceContext ?? true,
        captureHeaders: supplied.fetch?.captureHeaders ?? {},
      },
      handlers: {
        fetch: {
          acceptTraceContext: supplied.handlers?.fetch?.acceptTraceContext ?? true,
          captureHeaders: supplied.handlers?.fetch?.captureHeaders ?? {},
        },
      },
      postProcessor: supplied.postProcessor ?? ((spans: ReadableSpan[]) => spans),
      sampling: {
        headSampler,
        tailSampler: supplied.sampling?.tailSampler ?? multiTailSampler([isHeadSampled, isRootErrorSpan]),
      },
      service: supplied.service,
      spanProcessors,
      propagator: supplied.propagator ?? new W3CTraceContextPropagator(),
      instrumentation: {
        instrumentGlobalCache: supplied.instrumentation?.instrumentGlobalCache ?? true,
        instrumentGlobalFetch: supplied.instrumentation?.instrumentGlobalFetch ?? true,
      },
      scope: supplied.scope ?? { name: 'cf-worker' },
      idGenerator: supplied.idGenerator ?? new RandomIdGenerator(),
      ...(supplied.environment !== undefined ? { environment: supplied.environment } : {}),
    }
  } else {
    const exporter = isSpanExporter(supplied.exporter) ? supplied.exporter : new OTLPExporter(supplied.exporter)
    const spanProcessors = [new BatchTraceSpanProcessor(exporter), ...(supplied.additionalSpanProcessors ?? [])]
    const newConfig = Object.assign(supplied, { exporter: undefined, spanProcessors }) as TraceConfig
    return parseConfig(newConfig)
  }
}
