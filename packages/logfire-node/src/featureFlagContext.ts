import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'

import { trace } from '@opentelemetry/api'
import type { Span } from '@opentelemetry/api'
import type { SpanProcessor } from '@opentelemetry/sdk-trace-base'

export interface FeatureContext {
  targetingKey?: string
  attributes?: Readonly<Record<string, unknown>>
}

interface Assignment {
  key?: string
}

interface Scope {
  context: FeatureContext
  overrides: ReadonlyMap<object, unknown>
  assignment?: Assignment
}

const rootScope: Scope = { context: {}, overrides: new Map() }
const scopes = new AsyncLocalStorage<Scope>()
const spanScopes = new WeakMap<Span, { root: Span; assignment: Assignment }>()

/** Associates locally created spans with their root span by object identity. */
export function featureFlagSpanProcessor(): SpanProcessor {
  return {
    onStart(span, parent) {
      const parentSpan = trace.getSpan(parent)
      const previous = parentSpan === undefined ? undefined : spanScopes.get(parentSpan)
      const scope = previous?.root.isRecording() === true ? previous : { root: span, assignment: {} }
      spanScopes.set(span, scope)
    },
    onEnd: () => undefined,
    forceFlush: async () => Promise.resolve(),
    shutdown: async () => Promise.resolve(),
  }
}

export function withFeatureContext<R>(context: FeatureContext, callback: () => R): R {
  const previous = scopes.getStore() ?? rootScope
  const targetingKey = nonemptyTargetingKey(context.targetingKey) ?? previous.context.targetingKey
  return scopes.run(
    {
      assignment: previous.assignment ?? {},
      context: {
        ...(targetingKey === undefined ? {} : { targetingKey }),
        attributes: { ...previous.context.attributes, ...context.attributes },
      },
      overrides: previous.overrides,
    },
    callback
  )
}

export function withFlagOverride<R>(flag: object, value: unknown, callback: () => R): R {
  const scope = scopes.getStore() ?? rootScope
  const overrides = new Map(scope.overrides).set(flag, value)
  return scopes.run({ ...scope, overrides }, callback)
}

export function getFlagEvaluationInputs(options: FeatureContext): {
  targetingKey: string | undefined
  attributes: Record<string, unknown>
  anonymous: boolean
  overrides: ReadonlyMap<object, unknown>
} {
  const scope = scopes.getStore() ?? rootScope
  const explicitKey = nonemptyTargetingKey(options.targetingKey) ?? scope.context.targetingKey
  const span = trace.getActiveSpan()
  const traceScope = span === undefined ? undefined : spanScopes.get(span)
  const assignment = traceScope?.root.isRecording() === true ? traceScope.assignment : scope.assignment
  const anonymous = explicitKey === undefined && assignment !== undefined
  if (anonymous) {
    assignment.key ??= `anonymous:${randomUUID()}`
  }
  return {
    targetingKey: explicitKey ?? assignment?.key,
    attributes: { ...scope.context.attributes, ...options.attributes },
    anonymous,
    overrides: scope.overrides,
  }
}

function nonemptyTargetingKey(key: string | undefined): string | undefined {
  return key === '' ? undefined : key
}
