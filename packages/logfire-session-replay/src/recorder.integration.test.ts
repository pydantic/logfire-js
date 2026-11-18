/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'

import { startRecording } from './recorder'
import { EventType, IncrementalSource } from './types'
import type { RrwebEvent } from './types'

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

function attributesOf(value: unknown, id: string): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = attributesOf(item, id)
      if (found !== undefined) {
        return found
      }
    }
    return undefined
  }
  const record = value as Record<string, unknown>
  const attributes = record['attributes']
  if (typeof attributes === 'object' && attributes !== null && (attributes as Record<string, unknown>)['id'] === id) {
    return attributes as Record<string, unknown>
  }
  return attributesOf(Object.values(record), id)
}

describe('same-document references through rrweb serialization', () => {
  afterEach(() => {
    window.history.replaceState(null, '', '/')
  })

  it('keeps element id fragments of anchors and SVG use in full snapshots and attribute mutations', async () => {
    window.history.replaceState(null, '', '/page?token=secret')
    document.body.innerHTML = [
      '<a id="anchor" href="#section-2">Section</a>',
      '<a id="route" href="#/reset-password?token=secret">Reset</a>',
      '<svg><use id="icon" href="#icon-home"></use></svg>',
    ].join('')
    const events: RrwebEvent[] = []
    const recorder = startRecording({
      emit: (event) => {
        events.push(event)
      },
      maskAllInputs: true,
      maskAllText: false,
      redactUrlPatterns: [/.+/u],
    })
    stopRecording = () => {
      recorder.stop()
    }

    const snapshot = events.find((event) => event.type === EventType.FullSnapshot)
    expect(attributesOf(snapshot?.data, 'anchor')).toEqual({ id: 'anchor', href: 'http://localhost:3000/page#section-2' })
    expect(attributesOf(snapshot?.data, 'route')).toEqual({ id: 'route', href: 'http://localhost:3000/page' })
    expect(attributesOf(snapshot?.data, 'icon')).toEqual({ id: 'icon', href: '#icon-home' })

    document.getElementById('anchor')?.setAttribute('href', '#section-3')
    // rrweb reports attribute changes from a MutationObserver, which runs after this task.
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0)
    })

    const mutation = events.find(
      (event) => event.type === EventType.IncrementalSnapshot && (event.data as { source?: unknown }).source === IncrementalSource.Mutation
    )
    expect((mutation?.data as { attributes?: { attributes: unknown }[] }).attributes?.map((entry) => entry.attributes)).toEqual([
      { href: 'http://localhost:3000/page#section-3' },
    ])
  })
})

describe('image masking with rrweb', () => {
  function collectStrings(value: unknown, into: string[] = []): string[] {
    if (typeof value === 'string') {
      into.push(value)
    } else if (Array.isArray(value)) {
      for (const item of value) {
        collectStrings(item, into)
      }
    } else if (typeof value === 'object' && value !== null) {
      for (const item of Object.values(value)) {
        collectStrings(item, into)
      }
    }
    return into
  }

  it('uploads no recorded image URL from snapshots or mutations', async () => {
    document.body.innerHTML = `
      <img id="avatar" src="/users/jane/avatar.png" srcset="/users/jane/avatar@2x.png 2x">
      <picture><source srcset="/users/jane/hero.avif"><img src="/users/jane/hero.jpg"></picture>
      <svg><image href="/users/jane/a.svg"></image><image xlink:href="/users/jane/b.svg"></image></svg>
      <video poster="/users/jane/poster.jpg"></video>
      <div style="background-image: url(/users/jane/bg.png)"></div>`
    const events: RrwebEvent[] = []
    const recorder = startRecording({
      emit: (event) => {
        events.push(event)
      },
      maskAllImages: true,
      maskAllInputs: true,
      maskAllText: true,
      redactUrlPatterns: [],
    })
    stopRecording = () => {
      recorder.stop()
    }

    document.querySelector('#avatar')?.setAttribute('src', '/users/jane/changed.png')
    const added = document.createElement('img')
    added.src = '/users/jane/added.png'
    document.body.append(added)
    // rrweb delivers mutation records from a MutationObserver callback.
    await new Promise((resolve) => {
      setTimeout(resolve, 0)
    })

    const types = events.map((event) => event.type)
    expect(types).toContain(EventType.FullSnapshot)
    expect(
      events.some(
        (event) =>
          event.type === EventType.IncrementalSnapshot &&
          typeof event.data === 'object' &&
          event.data !== null &&
          'source' in event.data &&
          event.data.source === IncrementalSource.Mutation
      )
    ).toBe(true)
    expect(collectStrings(events).filter((text) => text.includes('/users/jane'))).toEqual([])
  })
})
