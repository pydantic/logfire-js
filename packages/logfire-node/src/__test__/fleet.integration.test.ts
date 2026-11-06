// `configure({ fleet })` against the real NodeSDK, with a fake Fleet client in place of
// `@pydantic/logfire-fleet-otel`: what the SDK hands it, and how it runs when Fleet can't be joined.
import type { ProxyTracerProvider } from '@opentelemetry/api'
import type { Resource } from '@opentelemetry/resources'
import type { Sampler, SpanProcessor } from '@opentelemetry/sdk-trace-base'

import { trace } from '@opentelemetry/api'
import { AlwaysOffSampler } from '@opentelemetry/sdk-trace-base'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import type { FleetClient, FleetHook, FleetOptions } from '../fleet'

import { fleetLoader } from '../fleet'
import { configure, info, shutdown } from '../index'

const base = { metrics: false as const, sendToLogfire: false, serviceName: 'fleet-itest' }

/** The tracer provider the SDK registered behind the global proxy: `NoopTracerProvider` before it starts. */
function registeredProvider(): string {
  return (trace.getTracerProvider() as ProxyTracerProvider).getDelegate().constructor.name
}

function recordingProcessor() {
  const names: string[] = []
  const processor: SpanProcessor = {
    forceFlush: async () => Promise.resolve(),
    onEnd: (span) => {
      names.push(span.name)
    },
    onStart: () => undefined,
    shutdown: async () => Promise.resolve(),
  }
  return { names, processor }
}

interface FakeFleet {
  calls: string[]
  given: FleetOptions[]
  resources: Resource[]
  sampledWith: (Sampler | undefined)[]
}

function fakeFleet(sampler: Sampler = new AlwaysOffSampler()): FakeFleet & { client: FleetClient } {
  const fake: FakeFleet = { calls: [], given: [], resources: [], sampledWith: [] }
  const hook: FleetHook = {
    contract: 1,
    headSampler: (s) => {
      fake.calls.push('headSampler')
      fake.sampledWith.push(s)
      return sampler
    },
    resourceAttributes: { 'service.instance.id': 'fleet-uid' },
    shutdown: async () => {
      fake.calls.push('shutdown')
      return Promise.resolve()
    },
    start: (startSdk, resource) => {
      fake.calls.push('start')
      fake.resources.push(resource)
      startSdk()
      // The providers are registered once the SDK has started.
      fake.calls.push(registeredProvider())
    },
  }
  const client: FleetClient = {
    LOGFIRE_FLEET_CONTRACT: 1,
    logfireFleet: (options) => {
      fake.given.push(options)
      return hook
    },
  }
  vi.spyOn(fleetLoader, 'load').mockReturnValue(client)
  return { ...fake, client }
}

describe('configure({ fleet })', () => {
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.stubEnv('OTEL_OPAMP_ENDPOINT', '')
    vi.stubEnv('OTEL_OPAMP_DISABLED', '')
    vi.stubEnv('LOGFIRE_FLEET', '')
  })

  afterEach(async () => {
    await shutdown()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  it('hands the Fleet client its sampler, its resource and the SDK to start', async () => {
    const fake = fakeFleet()
    const rec = recordingProcessor()
    configure({ ...base, additionalSpanProcessors: [rec.processor], fleet: { endpoint: 'https://fleet.example/v1/opamp' } })

    expect(fake.given).toEqual([{ endpoint: 'https://fleet.example/v1/opamp' }])
    expect(fake.calls).toEqual(['headSampler', 'start', 'TracerProvider'])
    // No head sample rate: every trace, until Fleet says otherwise.
    expect(fake.sampledWith).toEqual([undefined])
    expect(fake.resources[0]?.attributes['service.instance.id']).toBe('fleet-uid')
    expect(fake.resources[0]?.attributes['service.name']).toBe('fleet-itest')

    // The sampler the client hands back is the SDK's: this one samples nothing.
    info('dropped')
    expect(rec.names).toEqual([])

    await shutdown()
    expect(fake.calls.at(-1)).toBe('shutdown')
    expect(warn).not.toHaveBeenCalled()
  })

  it('is turned on by LOGFIRE_FLEET, with the server from the OTEL_OPAMP_* variables', () => {
    vi.stubEnv('LOGFIRE_FLEET', 'true')
    vi.stubEnv('OTEL_OPAMP_ENDPOINT', 'https://fleet.example/v1/opamp')
    const fake = fakeFleet()
    configure(base)
    expect(fake.given).toEqual([{}])
    expect(fake.calls).toContain('start')
  })

  it('is off by default', () => {
    const fake = fakeFleet()
    configure(base)
    expect(fake.given).toEqual([])
    expect(fleetLoader.load).not.toHaveBeenCalled()
  })

  it('keeps the client across configure() again, saying goodbye only at shutdown', () => {
    const fake = fakeFleet()
    configure({ ...base, fleet: { endpoint: 'https://fleet.example/v1/opamp' } })
    configure({ ...base, fleet: { endpoint: 'https://fleet.example/v1/opamp' } })
    expect(fake.calls.filter((c) => c === 'start')).toHaveLength(2)
    expect(fake.calls).not.toContain('shutdown')
  })

  it('says goodbye when configure() again drops fleet', async () => {
    const fake = fakeFleet()
    configure({ ...base, fleet: { endpoint: 'https://fleet.example/v1/opamp' } })
    configure(base)
    await vi.waitFor(() => {
      expect(fake.calls).toContain('shutdown')
    })
  })

  it('uses the Fleet client passed in, without loading the package', () => {
    const fake = fakeFleet()
    configure({ ...base, fleet: { client: fake.client, endpoint: 'https://fleet.example/v1/opamp' } })
    expect(fleetLoader.load).not.toHaveBeenCalled()
    // The client itself isn't one of its options.
    expect(fake.given).toEqual([{ endpoint: 'https://fleet.example/v1/opamp' }])
    expect(fake.calls).toContain('start')
  })

  it('runs unmanaged, with a warning, without the Fleet package', () => {
    vi.spyOn(fleetLoader, 'load').mockImplementation(() => {
      throw Object.assign(new Error('not found'), { code: 'MODULE_NOT_FOUND' })
    })
    const rec = recordingProcessor()
    configure({ ...base, additionalSpanProcessors: [rec.processor], fleet: true })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('npm install @pydantic/logfire-fleet-otel'))
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('`fleet: { client }`'))
    info('still sent')
    expect(rec.names).toEqual(['still sent'])
  })

  it('runs unmanaged, with a warning, on a Fleet package of another contract', () => {
    vi.spyOn(fleetLoader, 'load').mockReturnValue({ LOGFIRE_FLEET_CONTRACT: 2, logfireFleet: () => undefined })
    configure({ ...base, fleet: { endpoint: 'https://fleet.example/v1/opamp' } })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('speaks contract 2, not 1'))
  })

  it('runs unmanaged, with a warning, without an endpoint', () => {
    const fake = fakeFleet()
    configure({ ...base, fleet: true })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no Fleet endpoint is set'))
    expect(fake.given).toEqual([])
  })

  it('starts the SDK unmanaged when the Fleet client fails before starting it', () => {
    vi.spyOn(fleetLoader, 'load').mockReturnValue({
      LOGFIRE_FLEET_CONTRACT: 1,
      logfireFleet: () => ({
        contract: 1,
        headSampler: (s: Sampler | undefined) => s ?? new AlwaysOffSampler(),
        resourceAttributes: {},
        shutdown: async () => Promise.resolve(),
        start: () => {
          throw new Error('boom')
        },
      }),
    })
    const rec = recordingProcessor()
    configure({ ...base, additionalSpanProcessors: [rec.processor], fleet: { endpoint: 'https://fleet.example/v1/opamp' } })
    // The client's sampler was handed to the SDK already: it samples nothing.
    info('not sampled')
    expect(rec.names).toEqual([])
    expect(registeredProvider()).toBe('TracerProvider')
    expect(warn).toHaveBeenCalledWith('logfire: Logfire Fleet could not start (Error: boom). The SDK runs unmanaged.')
  })
})
