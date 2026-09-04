import { expect, it } from 'vitest'
import { TraceFlags } from '@opentelemetry/api'
import type { Resource } from '@opentelemetry/resources'

import { SpanImpl } from '../src/span'

function makeSpan(): SpanImpl {
  return new SpanImpl({
    attributes: {},
    name: 'test-span',
    onEnd: () => undefined,
    resource: { attributes: {} } as Resource,
    scope: { name: 'test' },
    spanContext: { spanId: '0000000000000001', traceFlags: TraceFlags.SAMPLED, traceId: '00000000000000000000000000000001' },
  })
}

it('keeps an attribute named like an Object.prototype member as an own property', () => {
  const span = makeSpan()

  // A plain write to a `__proto__` key runs the inherited setter: a primitive value was silently
  // dropped, and an array value replaced the attribute record's prototype.
  span.setAttribute('__proto__', 'value')
  span.setAttribute('ok', 1)

  expect(Object.hasOwn(span.attributes, '__proto__')).toBe(true)
  expect(span.attributes.__proto__).toBe('value')
  expect(span.attributes.ok).toBe(1)
  expect(Object.getPrototypeOf(span.attributes)).toBe(Object.prototype)

  span.setAttribute('__proto__', ['a'])
  expect(span.attributes.__proto__).toEqual(['a'])
  expect(Object.getPrototypeOf(span.attributes)).toBe(Object.prototype)
})
