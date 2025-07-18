/* eslint-disable perfectionist/sort-objects */
import { Context, context as ContextAPI, trace as TraceAPI, Tracer } from '@opentelemetry/api'

import { BaseScrubber, LogfireAttributeScrubber, NoopAttributeScrubber, ScrubCallback } from './AttributeScrubber'
import { DEFAULT_OTEL_SCOPE } from './constants'

export * from './AttributeScrubber'
export { serializeAttributes } from './serializeAttributes'

export interface ScrubbingOptions {
  callback?: ScrubCallback
  extraPatterns?: string[]
}

export interface LogfireApiConfigOptions {
  otelScope?: string
  /**
   * Options for scrubbing sensitive data. Set to False to disable.
   */
  scrubbing?: false | ScrubbingOptions
}

export type SendToLogfire = 'if-token-present' | boolean | undefined

export const Level = {
  Trace: 1 as const,
  Debug: 5 as const,
  Info: 9 as const,
  Notice: 10 as const,
  Warning: 13 as const,
  Error: 17 as const,
  Fatal: 21 as const,
}

export type Env = Record<string, string | undefined>

export type LogFireLevel = (typeof Level)[keyof typeof Level]

export interface LogOptions {
  level?: LogFireLevel
  log?: true
  tags?: string[]
}

export interface LogfireApiConfig {
  context: Context
  otelScope: string
  scrubber: BaseScrubber
  tracer: Tracer
}

export interface RegionData {
  baseUrl: string
  gcpRegion: string
}

const DEFAULT_LOGFIRE_API_CONFIG: LogfireApiConfig = {
  get context() {
    return ContextAPI.active()
  },
  otelScope: DEFAULT_OTEL_SCOPE,
  scrubber: new LogfireAttributeScrubber(),
  tracer: TraceAPI.getTracer(DEFAULT_OTEL_SCOPE),
}

export const logfireApiConfig: LogfireApiConfig = DEFAULT_LOGFIRE_API_CONFIG

export function configureLogfireApi(config: LogfireApiConfigOptions) {
  if (config.scrubbing !== undefined) {
    logfireApiConfig.scrubber = resolveScrubber(config.scrubbing)
  }

  if (config.otelScope !== undefined) {
    logfireApiConfig.otelScope = config.otelScope
    logfireApiConfig.tracer = TraceAPI.getTracer(config.otelScope)
  }
}

function resolveScrubber(scrubbing: LogfireApiConfigOptions['scrubbing']) {
  if (scrubbing !== undefined) {
    if (scrubbing === false) {
      return new NoopAttributeScrubber()
    } else {
      return new LogfireAttributeScrubber(scrubbing.extraPatterns, scrubbing.callback)
    }
  } else {
    return new LogfireAttributeScrubber()
  }
}

export function resolveSendToLogfire(env: Env, option: SendToLogfire, token: string | undefined) {
  const sendToLogfireConfig = option ?? env.LOGFIRE_SEND_TO_LOGFIRE ?? 'if-token-present'

  if (sendToLogfireConfig === 'if-token-present') {
    if (token) {
      return true
    } else {
      return false
    }
  } else {
    return Boolean(sendToLogfireConfig)
  }
}

export function resolveBaseUrl(env: Env, passedUrl: string | undefined, token: string) {
  let url = passedUrl ?? env.LOGFIRE_BASE_URL ?? getBaseUrlFromToken(token)
  if (url.endsWith('/')) {
    url = url.slice(0, -1)
  }
  return url
}

const PYDANTIC_LOGFIRE_TOKEN_PATTERN = /^(?<safe_part>pylf_v(?<version>[0-9]+)_(?<region>[a-z]+)_)(?<token>[a-zA-Z0-9]+)$/

const REGIONS: Record<string, RegionData> = {
  eu: {
    baseUrl: 'https://logfire-eu.pydantic.dev',
    gcpRegion: 'europe-west4',
  },
  us: {
    baseUrl: 'https://logfire-us.pydantic.dev',
    gcpRegion: 'us-east4',
  },
}

function getBaseUrlFromToken(token: string | undefined): string {
  let regionKey = 'us'
  if (token) {
    const match = PYDANTIC_LOGFIRE_TOKEN_PATTERN.exec(token)
    if (match) {
      const region = match.groups?.region
      if (region && region in REGIONS) {
        regionKey = region
      }
    }
  }
  return REGIONS[regionKey].baseUrl
}
