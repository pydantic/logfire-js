import { Replayer } from '@rrweb/replay'

type ReplayEvents = ConstructorParameters<typeof Replayer>[0]

const root = document.querySelector<HTMLElement>('#replay')
if (root === null) {
  throw new Error('missing replay root')
}

Reflect.set(window, 'logfireReplayPlayback', {
  async load(events: ReplayEvents): Promise<void> {
    const replayer = new Replayer(events, {
      mouseTail: false,
      root,
      showWarning: false,
      skipInactive: true,
      speed: 1_000,
    })
    const finished = new Promise<void>((resolve) => {
      replayer.on('finish', () => {
        resolve()
      })
    })
    replayer.play()
    await finished
    await nextFrame()
  },
})

async function nextFrame(): Promise<void> {
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      resolve()
    })
  })
}
