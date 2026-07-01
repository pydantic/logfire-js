import type { Attributes, SpanOptions } from '@opentelemetry/api'
import { SpanKind, trace } from '@opentelemetry/api'
import { ATTR_DB_NAMESPACE, ATTR_DB_OPERATION_NAME, ATTR_DB_QUERY_TEXT, ATTR_DB_SYSTEM_NAME } from '@opentelemetry/semantic-conventions'
import { wrap } from '../wrap.js'

type ExtraAttributeFn = (argArray: any[], result: any) => Attributes

const dbSystem = 'Cloudflare Analytics Engine'

export const AEAttributes: Record<string | symbol, ExtraAttributeFn> = {
  writeDataPoint(argArray) {
    const attrs: Attributes = {}
    const opts = argArray[0] as AnalyticsEngineDataPoint | undefined
    if (typeof opts === 'object' && opts !== null) {
      const firstIndex = opts.indexes?.[0]
      attrs['db.cf.ae.indexes'] = opts.indexes?.length ?? 0
      if (firstIndex !== undefined && firstIndex !== null) {
        attrs['db.cf.ae.index'] = firstIndex.toString()
      }
      attrs['db.cf.ae.doubles'] = opts.doubles?.length ?? 0
      attrs['db.cf.ae.blobs'] = opts.blobs?.length ?? 0
    }
    return attrs
  },
}

function instrumentAEFn(fn: Function, name: string, operation: string) {
  const tracer = trace.getTracer('AnalyticsEngine')
  const fnHandler: ProxyHandler<any> = {
    apply: async (target, thisArg, argArray) => {
      const attributes = {
        binding_type: 'AnalyticsEngine',
        [ATTR_DB_NAMESPACE]: name,
        [ATTR_DB_SYSTEM_NAME]: dbSystem,
        [ATTR_DB_OPERATION_NAME]: operation,
      }
      const options: SpanOptions = {
        kind: SpanKind.CLIENT,
        attributes,
      }
      return tracer.startActiveSpan(`Analytics Engine ${name} ${operation}`, options, async (span) => {
        const result = await Reflect.apply(target, thisArg, argArray)
        const extraAttrsFn = AEAttributes[operation]
        const extraAttrs = extraAttrsFn ? extraAttrsFn(argArray, result) : {}
        span.setAttributes(extraAttrs)
        span.setAttribute(ATTR_DB_QUERY_TEXT, `${operation} ${argArray[0]}`)
        span.end()
        return result
      })
    },
  }
  return wrap(fn, fnHandler)
}

export function instrumentAnalyticsEngineDataset(dataset: AnalyticsEngineDataset, name: string): AnalyticsEngineDataset {
  const datasetHandler: ProxyHandler<AnalyticsEngineDataset> = {
    get: (target, prop, receiver) => {
      const operation = String(prop)
      const fn = Reflect.get(target, prop, receiver)
      return instrumentAEFn(fn, name, operation)
    },
  }
  return wrap(dataset, datasetHandler)
}
