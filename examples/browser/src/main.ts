import { getWebAutoInstrumentations } from '@opentelemetry/auto-instrumentations-web';
import * as logfire from '@pydantic/logfire-browser';


logfire.configure({
  traceUrl: 'http://localhost:8989/client-traces',
  serviceName: 'my-service',
  serviceVersion: '0.1.0',
  // The instrumentations to use
  // https://www.npmjs.com/package/@opentelemetry/auto-instrumentations-web - for more options and configuration
  instrumentations: [
    getWebAutoInstrumentations({
      "@opentelemetry/instrumentation-document-load": { enabled: true },
      "@opentelemetry/instrumentation-user-interaction": {
        eventNames: ['click']
      },
    })
  ],
  // This outputs details about the generated spans in the browser console, use only in development and for troubleshooting.
  diagLogLevel: logfire.DiagLogLevel.ALL,
  batchSpanProcessorConfig: {
    maxExportBatchSize: 10
  },
})


document.querySelector('button')?.addEventListener('click', () => {
  logfire.info('Button clicked!')
  logfire.span('fetch wrapper',
    {
      callback: async () => { return fetch('https://jsonplaceholder.typicode.com/posts/1') }
    }
  )

  logfire.span('test something', {
    callback: async () => {
      const promise = await new Promise((resolve) => setTimeout(resolve, 1000))
      logfire.info('something!')
      return promise
    },
  })
})
