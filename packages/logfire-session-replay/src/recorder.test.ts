/**
 * @vitest-environment jsdom
 */
/* eslint-disable import/first, @typescript-eslint/strict-void-return, no-empty-function */
import type { record as RrwebRecord } from '@rrweb/record'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { RrwebEvent } from './types'

type RrwebRecordFunction = typeof RrwebRecord<RrwebEvent>
type RrwebRecordOptions = NonNullable<Parameters<RrwebRecordFunction>[0]>
type RrwebRecordCall = (...args: Parameters<RrwebRecordFunction>) => ReturnType<RrwebRecordFunction>

const { record, stopFn, mirrorNodes } = vi.hoisted(() => {
  const stopFn = vi.fn<() => void>()
  const mirrorNodes = new Map<number, Node>()
  const record = Object.assign(
    vi.fn<RrwebRecordCall>(() => stopFn),
    {
      addCustomEvent: vi.fn<typeof RrwebRecord.addCustomEvent>(),
      takeFullSnapshot: vi.fn<typeof RrwebRecord.takeFullSnapshot>(),
      mirror: {
        getNode: (id: number) => mirrorNodes.get(id) ?? null,
        getId: (node: Node) => [...mirrorNodes].find(([, candidate]) => candidate === node)?.[0] ?? -1,
      },
    }
  )
  return { record, stopFn, mirrorNodes }
})

vi.mock('@rrweb/record', () => ({ record }))

import { MASKED_IMAGE_SOURCE, startRecording } from './recorder'
import type { RecorderOptions } from './recorder'
import { CustomTag, EventType, IncrementalSource } from './types'

function lastOptions(): RrwebRecordOptions {
  const options = record.mock.calls.at(-1)?.[0]
  if (options === undefined) {
    throw new Error('expected rrweb record options')
  }
  return options
}

function emitFromRrweb(event: RrwebEvent): void {
  const emit = lastOptions().emit
  if (emit === undefined) {
    throw new Error('expected rrweb emit callback')
  }
  emit(event)
}

function startRecordingForTest(
  options: Pick<RecorderOptions, 'emit'> & Partial<Omit<RecorderOptions, 'emit'>>
): ReturnType<typeof startRecording> {
  return startRecording({
    maskAllInputs: true,
    maskAllText: false,
    redactUrlPatterns: [],
    ...options,
  })
}

beforeEach(() => {
  record.mockClear()
  record.mockReturnValue(stopFn)
  stopFn.mockClear()
  record.addCustomEvent.mockClear()
  record.takeFullSnapshot.mockClear()
})

afterEach(() => {
  vi.clearAllMocks()
  mirrorNodes.clear()
})

function element(type: string, attributes: Record<string, unknown>, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 2, tagName: type, attributes, childNodes: [], ...extra }
}

function measuredElement(tagName: string, width: number, height: number, namespace?: string): Element {
  const node = namespace === undefined ? document.createElement(tagName) : document.createElementNS(namespace, tagName)
  node.getBoundingClientRect = () => ({ width, height }) as DOMRect
  return node
}

describe('image masking', () => {
  const svgNamespace = 'http://www.w3.org/2000/svg'

  function record(maskAllImages: boolean, events: RrwebEvent[], options: Partial<RecorderOptions> = {}): RrwebEvent[] {
    const emitted: RrwebEvent[] = []
    startRecordingForTest({ emit: (event) => emitted.push(event), maskAllImages, redactUrlPatterns: [/.+/u], ...options })
    for (const event of events) {
      emitFromRrweb(event)
    }
    return emitted
  }

  it('replaces every image source in a full snapshot and keeps measured dimensions', () => {
    mirrorNodes.set(1, measuredElement('img', 120, 80))
    mirrorNodes.set(4, measuredElement('img', 0, 0))
    mirrorNodes.set(6, measuredElement('image', 50, 50, svgNamespace))
    const snapshot = {
      type: EventType.FullSnapshot,
      data: {
        node: element(
          'div',
          { style: 'background-image: url(/me.png)', class: 'card' },
          {
            id: 9,
            childNodes: [
              element(
                'img',
                { src: '/avatar.png?u=1', srcset: '/a.png 1x, /b.png 2x', sizes: '100vw', width: '120', class: 'avatar' },
                { id: 1 }
              ),
              element(
                'picture',
                {},
                {
                  id: 2,
                  childNodes: [
                    element('source', { srcset: '/hero.avif', type: 'image/avif' }, { id: 3 }),
                    element('img', { src: '/hero.jpg' }, { id: 4 }),
                  ],
                }
              ),
              element(
                'svg',
                { viewBox: '0 0 10 10' },
                {
                  id: 5,
                  isSVG: true,
                  childNodes: [
                    element('image', { href: '/a.svg', 'xlink:href': '/b.svg', width: '10' }, { id: 6, isSVG: true }),
                    element('feImage', { href: '/filter.png' }, { id: 7, isSVG: true }),
                    element('use', { href: '/sprite.svg' }, { id: 8, isSVG: true }),
                  ],
                }
              ),
              element('video', { poster: '/poster.jpg', src: '/movie.mp4' }, { id: 10 }),
              element('input', { type: 'image', src: '/submit.png' }, { id: 11 }),
              element('input', { type: 'text', src: '/ignored.png' }, { id: 12 }),
              element('link', { rel: 'preload', as: 'image', href: '/lcp.png', imagesrcset: '/lcp.png 1x' }, { id: 13 }),
              element('link', { rel: 'stylesheet', href: '/app.css' }, { id: 14 }),
              element('td', { background: '/cell.png' }, { id: 15 }),
              element('a', { href: '/orders' }, { id: 16 }),
              element('img', { src: '' }, { id: 17 }),
            ],
          }
        ),
        initialOffset: { left: 0, top: 0 },
      },
      timestamp: 1,
    } satisfies RrwebEvent

    const [emitted] = record(true, [snapshot])

    expect(emitted).toEqual({
      ...snapshot,
      data: {
        node: element(
          'div',
          { style: '', class: 'card' },
          {
            id: 9,
            childNodes: [
              element(
                'img',
                {
                  src: MASKED_IMAGE_SOURCE,
                  srcset: '',
                  sizes: '100vw',
                  width: '120',
                  class: 'avatar',
                  rr_width: '120px',
                  rr_height: '80px',
                },
                { id: 1 }
              ),
              element(
                'picture',
                {},
                {
                  id: 2,
                  childNodes: [
                    element('source', { srcset: '', type: 'image/avif' }, { id: 3 }),
                    element('img', { src: MASKED_IMAGE_SOURCE }, { id: 4 }),
                  ],
                }
              ),
              element(
                'svg',
                { viewBox: '0 0 10 10' },
                {
                  id: 5,
                  isSVG: true,
                  childNodes: [
                    element('image', { href: MASKED_IMAGE_SOURCE, 'xlink:href': MASKED_IMAGE_SOURCE, width: '10' }, { id: 6, isSVG: true }),
                    element('feImage', { href: MASKED_IMAGE_SOURCE }, { id: 7, isSVG: true }),
                    element('use', { href: 'http://localhost:3000/sprite.svg' }, { id: 8, isSVG: true }),
                  ],
                }
              ),
              element('video', { poster: '', src: 'http://localhost:3000/movie.mp4' }, { id: 10 }),
              element('input', { type: 'image', src: MASKED_IMAGE_SOURCE }, { id: 11 }),
              element('input', { type: 'text', src: 'http://localhost:3000/ignored.png' }, { id: 12 }),
              element('link', { rel: 'preload', as: 'image', href: MASKED_IMAGE_SOURCE, imagesrcset: '' }, { id: 13 }),
              element('link', { rel: 'stylesheet', href: 'http://localhost:3000/app.css' }, { id: 14 }),
              element('td', { background: '' }, { id: 15 }),
              element('a', { href: 'http://localhost:3000/orders' }, { id: 16 }),
              element('img', { src: '' }, { id: 17 }),
            ],
          }
        ),
        initialOffset: { left: 0, top: 0 },
      },
    })
  })

  it('replaces image sources in added nodes and attribute mutations', () => {
    mirrorNodes.set(20, measuredElement('img', 64, 64))
    const liveImage = document.createElement('img')
    mirrorNodes.set(21, liveImage)
    const liveSvgImage = document.createElementNS(svgNamespace, 'image')
    mirrorNodes.set(22, liveSvgImage)
    const liveLink = document.createElement('a')
    mirrorNodes.set(23, liveLink)
    const liveInput = document.createElement('input')
    liveInput.type = 'image'
    mirrorNodes.set(24, liveInput)
    const mutation = {
      type: EventType.IncrementalSnapshot,
      data: {
        source: IncrementalSource.Mutation,
        adds: [{ parentId: 1, nextId: null, node: element('img', { src: '/new.png', srcset: '/new@2x.png 2x' }, { id: 20 }) }],
        attributes: [
          { id: 21, attributes: { src: '/changed.png', srcset: '/changed@2x.png 2x', alt: null } },
          { id: 22, attributes: { href: '/changed.svg', 'xlink:href': '/legacy.svg' } },
          { id: 23, attributes: { href: '/next' } },
          { id: 24, attributes: { src: '/go.png' } },
          { id: 99, attributes: { src: '/unknown.png', href: '/unknown' } },
          { id: 25, attributes: { poster: '/poster.png', style: { 'background-image': 'url(/bg.png)', color: 'red' } } },
        ],
        removes: [],
        texts: [],
      },
      timestamp: 2,
    } satisfies RrwebEvent

    const [emitted] = record(true, [mutation])

    expect(emitted).toEqual({
      ...mutation,
      data: {
        ...mutation.data,
        adds: [
          {
            parentId: 1,
            nextId: null,
            node: element('img', { src: MASKED_IMAGE_SOURCE, srcset: '', rr_width: '64px', rr_height: '64px' }, { id: 20 }),
          },
        ],
        attributes: [
          { id: 21, attributes: { src: MASKED_IMAGE_SOURCE, srcset: '', alt: null } },
          { id: 22, attributes: { href: MASKED_IMAGE_SOURCE, 'xlink:href': MASKED_IMAGE_SOURCE } },
          { id: 23, attributes: { href: 'http://localhost:3000/next' } },
          { id: 24, attributes: { src: MASKED_IMAGE_SOURCE } },
          { id: 99, attributes: { src: MASKED_IMAGE_SOURCE, href: 'http://localhost:3000/unknown' } },
          { id: 25, attributes: { poster: '', style: { 'background-image': '', color: 'red' } } },
        ],
      },
    })
  })

  it('records the size of a masked image that loads after it was recorded', () => {
    const loading = (id: number): Element => {
      const image = measuredElement('img', 0, 0)
      Object.defineProperty(image, 'complete', { value: false })
      mirrorNodes.set(id, image)
      return image
    }
    const sized = (image: Element, width: number, height: number): void => {
      image.getBoundingClientRect = () => ({ width, height }) as DOMRect
    }
    const added = loading(30)
    const changed = loading(31)
    const broken = loading(32)
    const afterStop = loading(33)
    const emitted: RrwebEvent[] = []
    const recorder = startRecordingForTest({
      emit: (event) => {
        emitted.push(event)
      },
      maskAllImages: true,
    })
    emitFromRrweb({
      type: EventType.IncrementalSnapshot,
      data: {
        source: IncrementalSource.Mutation,
        adds: [30, 32, 33].map((id) => ({ parentId: 1, nextId: null, node: element('img', { src: `/${String(id)}.png` }, { id }) })),
        attributes: [{ id: 31, attributes: { src: '/next.png' } }],
      },
      timestamp: 1,
    })
    emitted.length = 0

    sized(added, 300, 200)
    added.dispatchEvent(new Event('load'))
    added.dispatchEvent(new Event('load'))
    sized(changed, 64, 48)
    changed.dispatchEvent(new Event('load'))
    sized(broken, 16, 16)
    broken.dispatchEvent(new Event('error'))
    broken.dispatchEvent(new Event('load'))
    recorder.stop()
    sized(afterStop, 10, 10)
    afterStop.dispatchEvent(new Event('load'))

    expect(emitted.map((event) => (event.data as { attributes: unknown }).attributes)).toEqual([
      [{ id: 30, attributes: { style: { width: '300px', height: '200px' } } }],
      [{ id: 31, attributes: { style: { width: '64px', height: '48px' } } }],
    ])
    expect(emitted.every((event) => event.type === EventType.IncrementalSnapshot)).toBe(true)
  })

  it('removes styles that could load an image even when URL redaction is off', () => {
    const snapshot = {
      type: EventType.FullSnapshot,
      data: { node: element('div', { style: 'background: url(/bg.png)' }, { id: 1 }) },
      timestamp: 1,
    } satisfies RrwebEvent

    const [masked] = record(true, [snapshot], { redactUrlPatterns: [] })
    const [unmasked] = record(false, [snapshot], { redactUrlPatterns: [] })

    expect(masked).toEqual({ ...snapshot, data: { node: element('div', { style: '' }, { id: 1 }) } })
    expect(unmasked).toBe(snapshot)
  })

  it('keeps image sources when image masking is off', () => {
    const snapshot = {
      type: EventType.FullSnapshot,
      data: { node: element('img', { src: '/a.png', srcset: '/a.png 1x' }, { id: 1 }) },
      timestamp: 1,
    } satisfies RrwebEvent

    const [emitted] = record(false, [snapshot], { redactUrlPatterns: [] })

    expect(emitted).toBe(snapshot)
  })
})

describe('startRecording', () => {
  it('passes conservative privacy and performance options to rrweb', () => {
    startRecordingForTest({ emit: () => {}, maskAllInputs: true, maskAllText: true })
    const options = lastOptions()
    expect(options.recordCanvas).toBe(false)
    expect(options.collectFonts).toBe(false)
    expect(options.inlineImages).toBe(false)
    expect(options.recordCrossOriginIframes).toBe(false)
    expect(options.slimDOMOptions).toBe('all')
    expect('maskAllInputs' in options).toBe(false)
    expect(options.maskInputOptions).toEqual({
      color: true,
      date: true,
      'datetime-local': true,
      email: true,
      hidden: true,
      month: true,
      number: true,
      password: true,
      range: true,
      search: true,
      select: true,
      tel: true,
      text: true,
      textarea: true,
      time: true,
      url: true,
      week: true,
    })
    expect(options.maskTextSelector).toBe('*')
    expect(options.sampling).toEqual({
      mousemove: 100,
      mouseInteraction: true,
      scroll: 250,
      media: 800,
      input: 'last',
    })
    const hooks = options.hooks
    expect(hooks?.input).toBeTypeOf('function')
    expect(hooks?.mediaInteaction).toBe(hooks?.input)
    expect(hooks?.mouseInteraction).toBe(hooks?.input)
    expect(hooks?.mousemove).toBe(hooks?.input)
    expect(hooks?.scroll).toBe(hooks?.input)
    expect(hooks?.selection).toBe(hooks?.input)
    expect(hooks?.viewportResize).toBe(hooks?.input)
  })

  it('omits optional selectors and checkoutEveryNms when unset', () => {
    startRecordingForTest({ emit: () => {}, maskAllInputs: false, checkoutEveryNms: 0 })
    const options = lastOptions()
    expect(options.maskAllInputs).toBe(false)
    expect('maskInputOptions' in options).toBe(false)
    expect('maskTextSelector' in options).toBe(false)
    expect('blockSelector' in options).toBe(false)
    expect('checkoutEveryNms' in options).toBe(false)
  })

  it('passes optional selectors and checkoutEveryNms when set', () => {
    startRecordingForTest({
      emit: () => {},
      maskAllInputs: false,
      maskTextSelector: '.secret',
      blockSelector: '.blocked',
      checkoutEveryNms: 120_000,
    })
    expect(lastOptions()).toMatchObject({
      maskTextSelector: '.secret',
      blockSelector: '.blocked',
      checkoutEveryNms: 120_000,
    })
  })

  it('requires maskAllText false before applying a selective text selector', () => {
    startRecordingForTest({ emit: () => {}, maskAllText: true, maskTextSelector: '.secret' })
    expect(lastOptions().maskTextSelector).toBe('*')

    startRecordingForTest({ emit: () => {}, maskAllText: false, maskTextSelector: '.secret' })
    expect(lastOptions().maskTextSelector).toBe('.secret')
  })

  it('reports each distinct rrweb callback error once and tells rrweb to drop it', () => {
    const onError = vi.fn<(error: unknown) => void>()
    startRecordingForTest({ emit: () => {}, onError })
    const errorHandler = lastOptions().errorHandler
    const nodeTypeError = new Error('Permission denied to access property "nodeType"')
    const localNameError = new Error('Permission denied to access property "localName"')

    expect(errorHandler?.(nodeTypeError)).toBe(true)
    expect(errorHandler?.(new Error('Permission denied to access property "nodeType"'))).toBe(true)
    expect(errorHandler?.(localNameError)).toBe(true)

    expect(onError.mock.calls).toEqual([[nodeTypeError], [localNameError]])
  })

  it('stops reporting rrweb callback errors after ten distinct messages', () => {
    const onError = vi.fn<(error: unknown) => void>()
    startRecordingForTest({ emit: () => {}, onError })
    const errorHandler = lastOptions().errorHandler

    for (let index = 0; index < 12; index++) {
      expect(errorHandler?.(new Error(`failure ${String(index)}`))).toBe(true)
    }

    expect(onError).toHaveBeenCalledTimes(10)
  })

  it('forwards rrweb emitted events to the caller', () => {
    const emitted: RrwebEvent[] = []
    startRecordingForTest({ emit: (event) => emitted.push(event), maskAllInputs: true })
    const event = { type: 2, data: { node: {} }, timestamp: 5 } satisfies RrwebEvent
    emitFromRrweb(event)
    expect(emitted).toEqual([event])
  })

  it('sanitizes matching URL attributes in rrweb metadata and DOM snapshots without mutating input', () => {
    const emitted: RrwebEvent[] = []
    startRecordingForTest({ emit: (event) => emitted.push(event), redactUrlPatterns: [/.+/u] })
    const meta = {
      type: EventType.Meta,
      data: { href: 'https://app.example.test/orders?token=secret#details', width: 800 },
      timestamp: 5,
    } satisfies RrwebEvent
    const snapshot = {
      type: EventType.FullSnapshot,
      data: { node: { href: '?token=attribute' } },
      timestamp: 6,
    } satisfies RrwebEvent
    const fullSnapshot = {
      type: EventType.FullSnapshot,
      data: {
        node: {
          attributes: { href: '/orders?token=full#details', title: 'Orders' },
          childNodes: [{ attributes: { src: '/avatar?token=image' } }],
        },
      },
      timestamp: 7,
    } satisfies RrwebEvent
    const mutation = {
      type: EventType.IncrementalSnapshot,
      data: {
        source: IncrementalSource.Mutation,
        adds: [{ node: { attributes: { action: '/checkout?token=add' } } }],
        attributes: [{ attributes: { formaction: '/buy?token=mutation', title: 'Buy' }, id: 1 }],
      },
      timestamp: 8,
    } satisfies RrwebEvent

    emitFromRrweb(meta)
    emitFromRrweb(snapshot)
    emitFromRrweb(fullSnapshot)
    emitFromRrweb(mutation)

    expect(emitted[0]).toEqual({ ...meta, data: { href: 'https://app.example.test/orders', width: 800 } })
    expect(emitted[1]).toBe(snapshot)
    expect(emitted[2]).toEqual({
      ...fullSnapshot,
      data: {
        node: {
          attributes: { href: 'http://localhost:3000/orders', title: 'Orders' },
          childNodes: [{ attributes: { src: 'http://localhost:3000/avatar' } }],
        },
      },
    })
    expect(emitted[3]).toEqual({
      ...mutation,
      data: {
        source: IncrementalSource.Mutation,
        adds: [{ node: { attributes: { action: 'http://localhost:3000/checkout' } } }],
        attributes: [{ attributes: { formaction: 'http://localhost:3000/buy', title: 'Buy' }, id: 1 }],
      },
    })
    expect(meta.data).toEqual({ href: 'https://app.example.test/orders?token=secret#details', width: 800 })
    expect(fullSnapshot.data.node.attributes.href).toBe('/orders?token=full#details')
    expect(mutation.data.adds[0]?.node.attributes.action).toBe('/checkout?token=add')
  })

  it('redacts URLs in error messages, sources, stacks, and console arguments at the custom-event boundary', () => {
    const emitted: RrwebEvent[] = []
    startRecordingForTest({ emit: (event) => emitted.push(event), redactUrlPatterns: [/.+/u] })
    const error = {
      type: EventType.Custom,
      data: {
        tag: CustomTag.Error,
        payload: {
          message: 'GET https://api.example.test/x?token=secret failed',
          source: 'https://app.example.test/app.js?token=secret',
          stack: 'Error: boom\n    at load (https://app.example.test/app.js?token=secret:10:5)',
        },
      },
      timestamp: 9,
    } satisfies RrwebEvent
    const consoleEvent = {
      type: EventType.Custom,
      data: { tag: CustomTag.Console, payload: { level: 'error', args: ['fetch https://api.example.test/x?key=secret failed', '42'] } },
      timestamp: 10,
    } satisfies RrwebEvent
    const network = {
      type: EventType.Custom,
      data: { tag: CustomTag.Network, payload: { url: 'https://api.example.test/kept-as-captured?x=1' } },
      timestamp: 11,
    } satisfies RrwebEvent

    emitFromRrweb(error)
    emitFromRrweb(consoleEvent)
    emitFromRrweb(network)

    expect(emitted[0]).toEqual({
      ...error,
      data: {
        tag: CustomTag.Error,
        payload: {
          message: 'GET https://api.example.test/x failed',
          source: 'https://app.example.test/app.js',
          stack: 'Error: boom\n    at load (https://app.example.test/app.js:10:5)',
        },
      },
    })
    expect(emitted[1]).toEqual({
      ...consoleEvent,
      data: { tag: CustomTag.Console, payload: { level: 'error', args: ['fetch https://api.example.test/x failed', '42'] } },
    })
    expect(emitted[2]).toBe(network)
    expect(error.data.payload.source).toBe('https://app.example.test/app.js?token=secret')
  })

  it('redacts image, media, object, and SVG URLs and removes styles that reference URLs', () => {
    const emitted: RrwebEvent[] = []
    startRecordingForTest({ emit: (event) => emitted.push(event), redactUrlPatterns: [/.+/u] })
    const fullSnapshot = {
      type: EventType.FullSnapshot,
      data: {
        node: {
          attributes: {
            srcset: '/a.png?t=1 1x, /b.png?t=2 2x',
            poster: '/poster.png?t=3',
            data: '/doc.pdf?t=4',
            'xlink:href': '/sprite.svg?t=5#icon',
            rr_src: '/frame?t=6',
            style: 'background: url("/bg.png?t=7")',
          },
        },
      },
      timestamp: 7,
    } satisfies RrwebEvent
    const mutation = {
      type: EventType.IncrementalSnapshot,
      data: {
        source: IncrementalSource.Mutation,
        attributes: [
          {
            id: 1,
            attributes: { style: { 'background-image': 'url(/m.png?t=8)', 'mask-image': ['url(/n.png?t=9)', 'important'], color: 'red' } },
          },
        ],
      },
      timestamp: 8,
    } satisfies RrwebEvent

    emitFromRrweb(fullSnapshot)
    emitFromRrweb(mutation)

    expect(emitted[0]).toEqual({
      ...fullSnapshot,
      data: {
        node: {
          attributes: {
            srcset: 'http://localhost:3000/a.png 1x, http://localhost:3000/b.png 2x',
            poster: 'http://localhost:3000/poster.png',
            data: 'http://localhost:3000/doc.pdf',
            'xlink:href': 'http://localhost:3000/sprite.svg',
            rr_src: 'http://localhost:3000/frame',
            style: '',
          },
        },
      },
    })
    expect(emitted[1]).toEqual({
      ...mutation,
      data: {
        source: IncrementalSource.Mutation,
        attributes: [
          {
            id: 1,
            attributes: {
              style: {
                'background-image': '',
                'mask-image': '',
                color: 'red',
              },
            },
          },
        ],
      },
    })
  })

  it('keeps styles without URL tokens, and all styles when URL redaction is off', () => {
    const emitted: RrwebEvent[] = []
    startRecordingForTest({ emit: (event) => emitted.push(event), redactUrlPatterns: [/.+/u] })
    const plain = {
      type: EventType.FullSnapshot,
      data: { node: { attributes: { style: 'color: red; display: block' } } },
      timestamp: 7,
    } satisfies RrwebEvent
    emitFromRrweb(plain)
    expect(emitted[0]).toBe(plain)

    startRecordingForTest({ emit: (event) => emitted.push(event), redactUrlPatterns: [] })
    const raw = {
      type: EventType.FullSnapshot,
      data: { node: { attributes: { style: 'background: url("/bg.png?t=1")' } } },
      timestamp: 8,
    } satisfies RrwebEvent
    emitFromRrweb(raw)
    expect(emitted[1]).toBe(raw)
  })

  it('removes a style that a URL transform would otherwise miss', () => {
    const emitted: RrwebEvent[] = []
    startRecordingForTest({ emit: (event) => emitted.push(event), transformUrl: (url) => url })
    const event = {
      type: EventType.FullSnapshot,
      data: { node: { attributes: { style: 'background: url(/users/jane/avatar.png)' } } },
      timestamp: 7,
    } satisfies RrwebEvent
    emitFromRrweb(event)
    expect(emitted[0]).toEqual({ ...event, data: { node: { attributes: { style: '' } } } })
  })

  it('applies the URL transform to Meta and DOM attribute URLs', () => {
    const emitted: RrwebEvent[] = []
    startRecordingForTest({
      emit: (event) => emitted.push(event),
      redactUrlPatterns: [/.+/u],
      transformUrl: (url) => url.replace(/\/users\/[^/]+/u, '/users/:email'),
    })
    const meta = {
      type: EventType.Meta,
      data: { href: 'https://app.example.test/users/jane@example.test?tab=1' },
      timestamp: 5,
    } satisfies RrwebEvent
    const fullSnapshot = {
      type: EventType.FullSnapshot,
      data: { node: { attributes: { href: '/users/jane@example.test', srcset: '/users/jane@example.test/avatar.png 1x' } } },
      timestamp: 6,
    } satisfies RrwebEvent

    emitFromRrweb(meta)
    emitFromRrweb(fullSnapshot)

    expect(emitted[0]).toEqual({ ...meta, data: { href: 'https://app.example.test/users/:email' } })
    expect(emitted[1]).toEqual({
      ...fullSnapshot,
      data: {
        node: { attributes: { href: 'http://localhost:3000/users/:email', srcset: 'http://localhost:3000/users/:email/avatar.png 1x' } },
      },
    })
  })

  it('masks text-bearing attributes when all text is masked', () => {
    const emitted: RrwebEvent[] = []
    startRecordingForTest({ emit: (event) => emitted.push(event), maskAllText: true })
    const fullSnapshot = {
      type: EventType.FullSnapshot,
      data: {
        node: {
          attributes: {
            title: 'Jane Doe',
            alt: 'Photo of Jane',
            'aria-label': 'Account jane@example.test',
            placeholder: 'Your email',
            'data-user-email': 'jane@example.test',
            'data-state': 'open',
            'data-theme': 'dark',
            'data-expanded': 'true',
            'data-rr-is-password': 'true',
            class: 'menu open',
          },
          childNodes: [{ attributes: { type: 'submit', value: 'Pay 120 EUR' } }, { attributes: { type: 'text', value: '****' } }],
        },
      },
      timestamp: 7,
    } satisfies RrwebEvent
    const mutation = {
      type: EventType.IncrementalSnapshot,
      data: {
        source: IncrementalSource.Mutation,
        attributes: [{ id: 1, attributes: { title: 'Signed in as Jane', 'data-state': 'closed' } }],
      },
      timestamp: 8,
    } satisfies RrwebEvent

    emitFromRrweb(fullSnapshot)
    emitFromRrweb(mutation)

    expect(emitted[0]).toEqual({
      ...fullSnapshot,
      data: {
        node: {
          attributes: {
            title: '**** ***',
            alt: '***** ** ****',
            'aria-label': '******* *****************',
            placeholder: '**** *****',
            'data-user-email': '*****************',
            'data-state': 'open',
            'data-theme': 'dark',
            'data-expanded': 'true',
            'data-rr-is-password': 'true',
            class: 'menu open',
          },
          childNodes: [{ attributes: { type: 'submit', value: '*** *** ***' } }, { attributes: { type: 'text', value: '****' } }],
        },
      },
    })
    expect(emitted[1]).toEqual({
      ...mutation,
      data: {
        source: IncrementalSource.Mutation,
        attributes: [{ id: 1, attributes: { title: '****** ** ** ****', 'data-state': 'closed' } }],
      },
    })
  })

  it('keeps text-bearing attributes when text masking is off', () => {
    const emitted: RrwebEvent[] = []
    startRecordingForTest({ emit: (event) => emitted.push(event), maskAllText: false })
    const fullSnapshot = {
      type: EventType.FullSnapshot,
      data: { node: { attributes: { title: 'Jane Doe', 'data-user-email': 'jane@example.test', type: 'submit', value: 'Pay' } } },
      timestamp: 7,
    } satisfies RrwebEvent

    emitFromRrweb(fullSnapshot)

    expect(emitted[0]).toBe(fullSnapshot)
  })

  it('bounds error messages and stacks after redacting their URLs', () => {
    const emitted: RrwebEvent[] = []
    startRecordingForTest({ emit: (event) => emitted.push(event), redactUrlPatterns: [/.+/u] })
    const message = `GET https://api.example.test/x?token=secret failed ${'m'.repeat(2000)}`
    const stack = `Error: boom\n${'    at load (https://app.example.test/app.js?token=secret:10:5)\n'.repeat(200)}`
    const error = {
      type: EventType.Custom,
      data: { tag: CustomTag.Error, payload: { message, stack } },
      timestamp: 9,
    } satisfies RrwebEvent

    emitFromRrweb(error)

    const frame = '    at load (https://app.example.test/app.js?token=secret:10:5)\n'
    const keptFrames = Math.floor((8192 - 'Error: boom\n'.length) / frame.length)
    const partialFrame = frame.slice(0, 8192 - 'Error: boom\n'.length - keptFrames * frame.length)
    expect(emitted[0]).toEqual({
      ...error,
      data: {
        tag: CustomTag.Error,
        payload: {
          message: `GET https://api.example.test/x failed ${'m'.repeat(1024 - 'GET https://api.example.test/x?token=secret failed '.length)}...(+${String(message.length - 1024)} chars)`,
          stack: `Error: boom\n${'    at load (https://app.example.test/app.js:10:5)\n'.repeat(keptFrames)}${partialFrame.replace(/\?token=[^:]*/u, '')}...(+${String(stack.length - 8192)} chars)`,
        },
      },
    })
  })

  it('leaves custom events unchanged when no redaction pattern is configured', () => {
    const emitted: RrwebEvent[] = []
    startRecordingForTest({ emit: (event) => emitted.push(event) })
    const error = {
      type: EventType.Custom,
      data: { tag: CustomTag.Error, payload: { message: 'boom', source: 'https://app.example.test/app.js?v=1' } },
      timestamp: 9,
    } satisfies RrwebEvent

    emitFromRrweb(error)

    expect(emitted[0]).toEqual(error)
  })

  it('forwards custom events through rrweb statics', () => {
    const handle = startRecordingForTest({ emit: () => {}, maskAllInputs: true })
    handle.addCustomEvent('logfire.error', { message: 'x' })
    expect(record.addCustomEvent).toHaveBeenCalledWith('logfire.error', { message: 'x' })
  })

  it('runs the activity callback before rrweb emits the interaction', () => {
    const calls: string[] = []
    startRecordingForTest({
      beforeUserActivity: () => calls.push('activity'),
      emit: () => calls.push('emit'),
    })

    lastOptions().hooks?.mouseInteraction?.({ id: 1, type: 2, x: 0, y: 0 })
    emitFromRrweb({ type: EventType.IncrementalSnapshot, data: { source: IncrementalSource.MouseInteraction }, timestamp: 1 })

    expect(calls).toEqual(['activity', 'emit'])
  })

  it('takes a checkout snapshot through the rrweb static', () => {
    const handle = startRecordingForTest({ emit: () => {} })
    handle.takeFullSnapshot()
    expect(record.takeFullSnapshot).toHaveBeenCalledWith(true)
  })

  it('stops the rrweb recorder when a stop function is returned', () => {
    startRecordingForTest({ emit: () => {}, maskAllInputs: true }).stop()
    expect(stopFn).toHaveBeenCalledTimes(1)
  })

  it('treats a missing rrweb stop function as startup failure', () => {
    record.mockReturnValueOnce(undefined)
    expect(() => startRecordingForTest({ emit: () => {}, maskAllInputs: true })).toThrow(
      'logfire session replay: rrweb failed to start recording'
    )
  })
})
