/**
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it } from 'vitest'

import { MASKED_IMAGE_SOURCE, startRecording } from './recorder'
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

  function record(options: Partial<Parameters<typeof startRecording>[0]> = {}): RrwebEvent[] {
    const events: RrwebEvent[] = []
    const recorder = startRecording({
      emit: (event) => {
        events.push(event)
      },
      maskAllInputs: true,
      maskAllText: false,
      redactUrlPatterns: [/.+/u],
      ...options,
    })
    stopRecording = () => {
      recorder.stop()
    }
    return events
  }

  // rrweb reports attribute changes from a MutationObserver, which runs after this task.
  async function mutationAttributes(events: RrwebEvent[], change: () => void): Promise<unknown[]> {
    change()
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0)
    })
    return events.flatMap((event) =>
      event.type === EventType.IncrementalSnapshot && (event.data as { source?: unknown }).source === IncrementalSource.Mutation
        ? ((event.data as { attributes?: { attributes: unknown }[] }).attributes?.map((entry) => entry.attributes) ?? [])
        : []
    )
  }

  const PAGE = [
    '<h2 id="section-2">Two</h2><h2 id="section-3">Three</h2><h2 class="later">Four</h2>',
    '<a id="anchor" href="#section-2">Section</a>',
    '<a id="route" href="#/reset-password?token=secret">Reset</a>',
    '<svg><symbol id="icon-home"></symbol><use id="icon" href="#icon-home"></use></svg>',
  ].join('')

  it('keeps element id fragments of anchors and SVG use in full snapshots and attribute mutations', async () => {
    window.history.replaceState(null, '', '/page?token=secret')
    document.body.innerHTML = PAGE
    const events = record()

    const snapshot = events.find((event) => event.type === EventType.FullSnapshot)
    expect(attributesOf(snapshot?.data, 'anchor')).toEqual({ id: 'anchor', href: 'http://localhost:3000/page#section-2' })
    expect(attributesOf(snapshot?.data, 'route')).toEqual({ id: 'route', href: 'http://localhost:3000/page' })
    expect(attributesOf(snapshot?.data, 'icon')).toEqual({ id: 'icon', href: '#icon-home' })

    const mutations = await mutationAttributes(events, () => {
      document.getElementById('anchor')?.setAttribute('href', '#section-3')
      document.querySelector('.later')?.setAttribute('id', 'section-4')
      document.getElementById('route')?.setAttribute('href', '#section-4')
    })
    expect(mutations).toEqual([
      { href: 'http://localhost:3000/page#section-3' },
      { id: 'section-4' },
      { href: 'http://localhost:3000/page#section-4' },
    ])
  })

  it('uses the URL transform result as is for kept references', async () => {
    window.history.replaceState(null, '', '/page')
    document.body.innerHTML = PAGE
    const events = record({ transformUrl: (url) => (url.includes('section-3') ? '' : '[redacted]') })

    const snapshot = events.find((event) => event.type === EventType.FullSnapshot)
    expect(attributesOf(snapshot?.data, 'anchor')).toEqual({ id: 'anchor', href: '[redacted]' })
    expect(attributesOf(snapshot?.data, 'icon')).toEqual({ id: 'icon', href: '[redacted]' })

    const mutations = await mutationAttributes(events, () => {
      document.getElementById('anchor')?.setAttribute('href', '#section-3')
      document.getElementById('icon')?.setAttribute('href', '#section-2')
    })
    expect(mutations).toEqual([{ href: '' }, { href: '[redacted]' }])
  })

  it('redacts references to elements that the recording omits', async () => {
    window.history.replaceState(null, '', '/page')
    document.body.innerHTML = [
      '<svg><g class="rr-block"><symbol id="patient-123-45-6789"></symbol></g>',
      '<symbol id="blocked-self" class="rr-block"></symbol>',
      '<use id="nested" href="#patient-123-45-6789"></use><use id="self" href="#blocked-self"></use></svg>',
      '<div data-private><span id="jane-doe"></span></div>',
      '<a id="selector" href="#jane-doe">Jane</a><a id="missing" href="#not-on-page">Missing</a><a id="top" href="#">Top</a>',
      '<script type="application/json" id="patient-987-65-4321">{}</script><a id="ignored" href="#patient-987-65-4321">Ignored</a>',
      '<h2 id="public-heading">Public</h2><div class="rr-block" id="vault"></div>',
    ].join('')
    const events = record({ blockSelector: '[data-private]' })

    const snapshot = events.find((event) => event.type === EventType.FullSnapshot)
    expect(['nested', 'self', 'selector', 'missing', 'top', 'ignored'].map((id) => attributesOf(snapshot?.data, id))).toEqual([
      { id: 'nested', href: 'http://localhost:3000/page' },
      { id: 'self', href: 'http://localhost:3000/page' },
      { id: 'selector', href: 'http://localhost:3000/page' },
      { id: 'missing', href: 'http://localhost:3000/page' },
      { id: 'top', href: 'http://localhost:3000/page' },
      { id: 'ignored', href: 'http://localhost:3000/page' },
    ])

    const mutations = await mutationAttributes(events, () => {
      document.getElementById('nested')?.setAttribute('href', '#blocked-self')
      document.getElementById('top')?.setAttribute('href', '#patient-987-65-4321')
    })
    expect(mutations).toEqual([{ href: 'http://localhost:3000/page' }, { href: 'http://localhost:3000/page' }])

    const heading = document.getElementById('public-heading')
    const moved = await mutationAttributes(events, () => {
      if (heading !== null) {
        document.getElementById('vault')?.append(heading)
        heading.id = 'patient-555-12-3456'
      }
    })
    const relinked = await mutationAttributes(events, () => {
      document.getElementById('missing')?.setAttribute('href', '#patient-555-12-3456')
    })
    expect(relinked.slice(moved.length)).toEqual([{ href: 'http://localhost:3000/page' }])
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

  // jsdom drops `@font-face` sources and has no constructable stylesheets, so the browser privacy
  // test covers those paths.
  it('uploads no stylesheet image URL from inlined rules, added styles, or CSSOM changes', async () => {
    document.head.innerHTML = '<style>.a{background:url(/users/jane/snapshot.png)}</style>'
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
      document.head.replaceChildren()
    }

    const added = document.createElement('style')
    added.textContent = '.b{background:url(/users/jane/added.png)}'
    document.head.append(added)
    await new Promise((resolve) => {
      setTimeout(resolve, 0)
    })
    added.sheet?.insertRule('.c{background:url(/users/jane/rule.png)}', 0)
    const rule = added.sheet?.cssRules[0]
    if (!(rule instanceof CSSStyleRule)) {
      throw new Error('expected the inserted style rule')
    }
    rule.style.setProperty('background', 'url(/users/jane/declaration.png)')

    const placeholder = `url(${JSON.stringify(MASKED_IMAGE_SOURCE)})`
    const sourcesWithPlaceholder = events
      .filter((event) => collectStrings(event.data).some((text) => text.includes(placeholder)))
      .map((event) => (event.type === EventType.FullSnapshot ? 'snapshot' : (event.data as { source?: unknown }).source))
    expect(sourcesWithPlaceholder).toEqual([
      'snapshot',
      IncrementalSource.Mutation,
      IncrementalSource.StyleSheetRule,
      IncrementalSource.StyleDeclaration,
    ])
    expect(collectStrings(events).filter((text) => text.includes('/users/jane'))).toEqual([])
  })

  it('records a stylesheet reference to an element of the page as its id', () => {
    window.history.replaceState(null, '', '/org/live?token=secret')
    document.head.innerHTML = '<style id="filters">.a{filter:url(#blur)}.b{mask:url(/org/#icon)}</style>'
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
      document.head.replaceChildren()
      window.history.replaceState(null, '', '/')
    }

    const snapshot = events.find((event) => event.type === EventType.FullSnapshot)
    expect(attributesOf(snapshot?.data, 'filters')).toEqual({
      id: 'filters',
      _cssText: '.a { filter: url("#blur"); }.b { mask: url("#icon"); }',
    })
  })
})
