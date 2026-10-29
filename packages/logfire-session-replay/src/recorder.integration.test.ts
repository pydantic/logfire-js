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

describe('rrweb callback errors', () => {
  it('reports an error thrown inside an rrweb callback once and keeps it from the page', () => {
    const pageErrors: unknown[] = []
    const onPageError = (event: ErrorEvent) => {
      pageErrors.push(event.error)
      event.preventDefault()
    }
    window.addEventListener('error', onPageError)
    const reportedErrors: unknown[] = []
    const button = document.createElement('button')
    document.body.append(button)
    const recorder = startRecording({
      beforeUserActivity: () => {
        throw new Error('Permission denied to access property "nodeType"')
      },
      emit: () => undefined,
      maskAllInputs: true,
      maskAllText: false,
      onError: (error) => {
        reportedErrors.push(error)
      },
      redactUrlPatterns: [],
    })
    stopRecording = () => {
      recorder.stop()
      window.removeEventListener('error', onPageError)
    }

    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    button.dispatchEvent(new MouseEvent('click', { bubbles: true }))

    expect(pageErrors).toEqual([])
    expect(reportedErrors).toEqual([new Error('Permission denied to access property "nodeType"')])
  })
})
