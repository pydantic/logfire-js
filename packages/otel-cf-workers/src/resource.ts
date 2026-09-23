import type { Resource } from '@opentelemetry/resources'
import { resourceFromAttributes } from '@opentelemetry/resources'
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_NAMESPACE,
  ATTR_SERVICE_VERSION,
  ATTR_TELEMETRY_SDK_LANGUAGE,
  ATTR_TELEMETRY_SDK_NAME,
  ATTR_TELEMETRY_SDK_VERSION,
} from '@opentelemetry/semantic-conventions'

import { ATTR_DEPLOYMENT_ENVIRONMENT_NAME, ATTR_FAAS_MAX_MEMORY } from './semconv.js'
import type { ServiceConfig } from './types.js'

const OTEL_CF_WORKERS_PACKAGE_NAME = '@pydantic/otel-cf-workers'

export function createResource(service: ServiceConfig, environment: string | undefined): Resource {
  const workerResourceAttrs = {
    'cloud.provider': 'cloudflare',
    'cloud.platform': 'cloudflare.workers',
    'cloud.region': 'earth',
    [ATTR_FAAS_MAX_MEMORY]: 134217728,
    [ATTR_TELEMETRY_SDK_LANGUAGE]: 'js',
    [ATTR_TELEMETRY_SDK_NAME]: OTEL_CF_WORKERS_PACKAGE_NAME,
    [ATTR_TELEMETRY_SDK_VERSION]: PACKAGE_VERSION,
  }
  const serviceResource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: service.name,
    [ATTR_SERVICE_NAMESPACE]: service.namespace,
    [ATTR_SERVICE_VERSION]: service.version,
    ...(environment !== undefined ? { [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: environment } : {}),
  })
  const resource = resourceFromAttributes(workerResourceAttrs)
  return resource.merge(serviceResource)
}
