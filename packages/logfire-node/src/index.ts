import { DiagLogLevel } from '@opentelemetry/api'
import {
  configureLogfireApi,
  debug,
  error,
  fatal,
  info,
  Level,
  log,
  logfireApiConfig,
  LogfireAttributeScrubber,
  NoopAttributeScrubber,
  notice,
  reportError,
  resolveBaseUrl,
  resolveSendToLogfire,
  serializeAttributes,
  span,
  startSpan,
  trace,
  ULIDGenerator,
  warning,
} from 'logfire'

import { configure, logfireConfig } from './logfireConfig'
import { forceFlush, shutdown } from './sdk'

export * from './logfireConfig'
export { forceFlush, shutdown } from './sdk'
export { DiagLogLevel } from '@opentelemetry/api'
export * from 'logfire'

const defaultExport: {
  configure: typeof configure
  logfireConfig: typeof logfireConfig
  DiagLogLevel: typeof DiagLogLevel
  Level: typeof Level
  LogfireAttributeScrubber: typeof LogfireAttributeScrubber
  NoopAttributeScrubber: typeof NoopAttributeScrubber
  ULIDGenerator: typeof ULIDGenerator
  configureLogfireApi: typeof configureLogfireApi
  debug: typeof debug
  error: typeof error
  fatal: typeof fatal
  forceFlush: typeof forceFlush
  info: typeof info
  log: typeof log
  logfireApiConfig: typeof logfireApiConfig
  notice: typeof notice
  reportError: typeof reportError
  resolveBaseUrl: typeof resolveBaseUrl
  resolveSendToLogfire: typeof resolveSendToLogfire
  serializeAttributes: typeof serializeAttributes
  shutdown: typeof shutdown
  span: typeof span
  startSpan: typeof startSpan
  trace: typeof trace
  warning: typeof warning
} = {
  configure,
  configureLogfireApi,
  debug,
  DiagLogLevel,
  error,
  fatal,
  forceFlush,
  info,
  // Re-export all from logfire
  Level,
  log,
  logfireConfig,
  logfireApiConfig,
  LogfireAttributeScrubber,
  NoopAttributeScrubber,
  notice,
  reportError,
  resolveBaseUrl,
  resolveSendToLogfire,
  serializeAttributes,
  shutdown,
  span,
  startSpan,
  trace,
  ULIDGenerator,
  warning,
}

export default defaultExport
