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
} from '@pydantic/logfire-api'

// Import all exports to construct default export
import * as logfireConfigExports from './logfireConfig'

export * from './logfireConfig'
export { DiagLogLevel } from '@opentelemetry/api'
export * from '@pydantic/logfire-api'

// Create default export by listing all exports explicitly
export default {
  ...logfireConfigExports,
  configureLogfireApi,
  debug,
  DiagLogLevel,
  error,
  fatal,
  info,
  // Re-export all from @pydantic/logfire-api
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
}
