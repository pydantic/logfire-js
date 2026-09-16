import { describe, expect, it } from 'vite-plus/test'

import { sessionReplayIntegration } from './integration'

describe('sessionReplayIntegration', () => {
  it('preserves capture options and lazily loads the recorder', async () => {
    const integration = sessionReplayIntegration({
      captureConsole: true,
      maskAllText: false,
      sessionSampleRate: 0.25,
    })

    expect(integration).toMatchObject({
      captureConsole: true,
      maskAllText: false,
      sessionSampleRate: 0.25,
    })
    expect(integration.load).toBeTypeOf('function')

    const recorder = await integration.load()
    expect(recorder.startSessionReplay).toBeTypeOf('function')
  })
})
