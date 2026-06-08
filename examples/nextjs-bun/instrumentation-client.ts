import { getWebAutoInstrumentations } from '@opentelemetry/auto-instrumentations-web'
import * as logfire from '@pydantic/logfire-browser'

logfire.configure({
  traceUrl: '/client-traces',
  serviceName: process.env.NEXT_PUBLIC_OTEL_SERVICE_NAME ?? 'nextjs-bun-browser',
  serviceVersion: process.env.NEXT_PUBLIC_OTEL_SERVICE_VERSION,
  instrumentations: [
    getWebAutoInstrumentations({
      '@opentelemetry/instrumentation-user-interaction': {
        enabled: false,
      },
    }),
  ],
})
