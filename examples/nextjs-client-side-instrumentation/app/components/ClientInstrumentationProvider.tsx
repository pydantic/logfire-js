import { getWebAutoInstrumentations } from '@opentelemetry/auto-instrumentations-web'
import * as logfire from '@pydantic/logfire-browser'
import { ReactNode, useEffect, useRef } from 'react'

interface ClientInstrumentationProviderProps {
  children: ReactNode
}

export default function ClientInstrumentationProvider({ children }: ClientInstrumentationProviderProps) {
  const logfireConfigured = useRef<boolean>(false)

  useEffect(() => {
    const url = new URL(window.location.href)
    url.pathname = '/client-traces'
    if (!logfireConfigured.current) {
      logfire.configure({
        traceUrl: url.toString(),
        serviceName: process.env.NEXT_PUBLIC_OTEL_SERVICE_NAME,
        serviceVersion: process.env.NEXT_PUBLIC_OTEL_SERVICE_VERSION,
        instrumentations: [getWebAutoInstrumentations()],
        diagLogLevel: logfire.DiagLogLevel.ALL,
      })
      logfireConfigured.current = true
    }
  }, [])

  return children
}
