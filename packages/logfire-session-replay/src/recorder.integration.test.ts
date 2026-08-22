/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'

import { startRecording } from './recorder'
import { EventType, IncrementalSource } from './types'

let stopRecording: (() => void) | undefined

afterEach(() => {
  stopRecording?.()
  stopRecording = undefined
  document.body.replaceChildren()
})

describe('rrweb activity hooks', () => {
  it('can emit a checkout snapshot before the triggering interaction', () => {
    const emittedTypes: number[] = []
    const button = document.createElement('button')
    document.body.append(button)
    const recorder = startRecording({
      beforeUserActivity: () => {
        recorder.takeFullSnapshot()
      },
      checkoutEveryNms: 0,
      emit: (event) => {
        if (
          event.type === EventType.IncrementalSnapshot &&
          typeof event.data === 'object' &&
          event.data !== null &&
          'source' in event.data &&
          event.data.source === IncrementalSource.MouseInteraction
        ) {
          emittedTypes.push(event.type)
        } else if (event.type === EventType.Meta || event.type === EventType.FullSnapshot) {
          emittedTypes.push(event.type)
        }
      },
      maskAllInputs: true,
      maskAllText: false,
      redactUrlPatterns: [],
    })
    stopRecording = () => {
      recorder.stop()
    }
    emittedTypes.length = 0

    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(emittedTypes).toEqual([EventType.Meta, EventType.FullSnapshot, EventType.IncrementalSnapshot])
  })
})
