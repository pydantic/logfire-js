import { record } from '@rrweb/record'

import { cutText, mayReferenceCssUrl, redactSrcset, redactUrl, redactUrlsInText, truncationSuffix } from './privacy'
import type { UrlTransform } from './privacy'
import { markSdkInternalError } from './sdkInternalError'
import { CustomTag, EventType, IncrementalSource } from './types'
import type { RrwebEvent } from './types'

// rrweb stores an iframe `src` as `rr_src` when it does not record the frame's document.
const URL_ATTRIBUTE_NAMES = new Set(['action', 'background', 'cite', 'data', 'formaction', 'href', 'poster', 'rr_src', 'src', 'xlink:href'])
const SRCSET_ATTRIBUTE_NAMES = new Set(['imagesrcset', 'srcset'])
const TEXT_ATTRIBUTE_NAMES = new Set([
  'alt',
  'aria-description',
  'aria-label',
  'aria-placeholder',
  'aria-roledescription',
  'aria-valuetext',
  'label',
  'placeholder',
  'title',
])
// UI libraries and themes select styles through these attributes, so masking them would make
// playback show a different state or theme than the user saw.
const UI_STATE_DATA_ATTRIBUTE_NAMES = new Set([
  'data-active',
  'data-align',
  'data-bs-theme',
  'data-checked',
  'data-disabled',
  'data-headlessui-state',
  'data-highlighted',
  'data-orientation',
  'data-placement',
  'data-popper-placement',
  'data-selected',
  'data-side',
  'data-size',
  'data-slot',
  'data-state',
  'data-theme',
  'data-variant',
])
// Flag values such as `data-expanded="true"` carry no personal data and are matched by selectors.
const FLAG_DATA_ATTRIBUTE_VALUES = new Set(['', 'false', 'true'])
const TEXT_VALUE_INPUT_TYPES = new Set(['button', 'reset', 'submit'])
// Attributes that only ever load an image, whatever element carries them.
const IMAGE_ONLY_ATTRIBUTE_NAMES = new Set(['background', 'imagesrcset', 'poster', 'srcset'])
// A 1x1 gray PNG. It stretches to whatever size the element's attributes, CSS, or measured size give
// it, and stays a single pixel when nothing sizes it, like an image that never loaded. A `data:` URL
// loads nothing from the network during playback.
export const MASKED_IMAGE_SOURCE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR42mO4cuUGAAUAAoG6haGKAAAAAElFTkSuQmCC'
const SVG_NAMESPACE = 'http://www.w3.org/2000/svg'
// rrweb's serialized node type for an element.
const SERIALIZED_ELEMENT_NODE_TYPE = 2
const MAX_ERROR_MESSAGE_LENGTH = 1024
const MAX_ERROR_STACK_LENGTH = 8192
// One inaccessible node can make rrweb throw on every mutation, so each distinct message is reported
// once, and a page that keeps producing new messages stops being reported after this many.
const MAX_REPORTED_RECORDER_ERRORS = 10
// rrweb's `maskAllInputs` map, plus hidden inputs, whose values often carry tokens and ids.
const MASK_ALL_INPUT_OPTIONS = {
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
}
type RrwebRecordOptions = NonNullable<Parameters<typeof record<RrwebEvent>>[0]>

export interface RecorderHandle {
  stop(): void
  addCustomEvent(tag: string, payload: unknown): void
  takeFullSnapshot(): void
}

export interface RecorderOptions {
  emit: (event: RrwebEvent) => void
  beforeUserActivity?: () => void
  maskAllText: boolean
  maskAllInputs: boolean
  /** Replace image sources with a placeholder. Defaults to false. */
  maskAllImages?: boolean
  maskTextSelector?: string
  blockSelector?: string
  checkoutEveryNms?: number
  redactUrlPatterns: RegExp[]
  transformUrl?: UrlTransform | undefined
  onError?: ((error: unknown) => void) | undefined
}

interface SanitizeOptions {
  maskTextAttributes: boolean
  maskImages: boolean
  patterns: RegExp[]
  transformUrl: UrlTransform | undefined
  /** The live node that rrweb recorded under a serialized id. */
  findNode: (id: number) => Node | undefined
  /** Record the rendered size of a masked image once it loads. */
  sizeOnLoad: (image: Element) => void
}

/** What image masking needs to know about the element that carries a set of attributes. */
interface ElementContext {
  tagName: string
  isSVG: boolean
  getAttribute: (name: string) => string | undefined
  /** The live element, used to measure a masked image. */
  findNode: () => Element | undefined
  /** Whether the attributes describe a whole serialized element rather than an attribute mutation. */
  serialized: boolean
}

export function startRecording(options: RecorderOptions): RecorderHandle {
  const beforeUserActivity = () => {
    options.beforeUserActivity?.()
  }
  const sanitizeOptions: SanitizeOptions = {
    maskTextAttributes: options.maskAllText,
    maskImages: options.maskAllImages ?? false,
    patterns: options.redactUrlPatterns,
    transformUrl: options.transformUrl,
    findNode: (id) => {
      try {
        return record.mirror.getNode(id) ?? undefined
      } catch {
        return undefined
      }
    },
    sizeOnLoad: (image) => {
      sizeOnLoad(image)
    },
  }
  // A masked image that loads after it was recorded, such as a lazy image or one a script adds, has
  // no size to record until then. Its size reaches playback as a style mutation once it loads.
  const pendingImages = new Map<Element, () => void>()
  let recording = true
  const sizeOnLoad = (image: Element): void => {
    if (pendingImages.has(image)) {
      return
    }
    const finish = (event: Event): void => {
      image.removeEventListener('load', finish)
      image.removeEventListener('error', finish)
      pendingImages.delete(image)
      if (recording && event.type === 'load') {
        emitImageSize(image)
      }
    }
    image.addEventListener('load', finish)
    image.addEventListener('error', finish)
    pendingImages.set(image, () => {
      image.removeEventListener('load', finish)
      image.removeEventListener('error', finish)
    })
  }
  const emitImageSize = (image: Element): void => {
    try {
      const id = record.mirror.getId(image)
      const { width, height } = image.getBoundingClientRect()
      if (id < 0 || width <= 0 || height <= 0) {
        return
      }
      options.emit({
        type: EventType.IncrementalSnapshot,
        timestamp: Date.now(),
        data: {
          source: IncrementalSource.Mutation,
          texts: [],
          attributes: [{ id, attributes: { style: { width: `${String(width)}px`, height: `${String(height)}px` } } }],
          removes: [],
          adds: [],
        },
      })
    } catch (error) {
      options.onError?.(error)
    }
  }
  const reportedErrors = new Set<string>()
  const recordOptions: RrwebRecordOptions = {
    emit: (event) => {
      options.emit(sanitizeRecorderEvent(event, sanitizeOptions))
    },
    // rrweb catches errors in its observer callbacks only when an error handler is registered.
    // Without one, they reach the page's global error handler. Firefox throws `Permission denied to
    // access property "nodeType"` when rrweb reads a node that the page script cannot access, such
    // as one a browser extension inserted. Returning `true` makes rrweb drop the error and keep
    // recording.
    errorHandler: (error) => {
      if (reportedErrors.size < MAX_REPORTED_RECORDER_ERRORS) {
        const message = errorMessage(error)
        if (!reportedErrors.has(message)) {
          reportedErrors.add(message)
          options.onError?.(error)
        }
      }
      return true
    },
    recordCanvas: false,
    collectFonts: false,
    inlineImages: false,
    recordCrossOriginIframes: false,
    slimDOMOptions: 'all',
    hooks: {
      input: beforeUserActivity,
      mediaInteaction: beforeUserActivity,
      mouseInteraction: beforeUserActivity,
      mousemove: beforeUserActivity,
      scroll: beforeUserActivity,
      selection: beforeUserActivity,
      viewportResize: beforeUserActivity,
    },
    sampling: {
      mousemove: 100,
      mouseInteraction: true,
      scroll: 250,
      media: 800,
      input: 'last',
    },
  }

  if (options.maskAllInputs) {
    recordOptions.maskInputOptions = MASK_ALL_INPUT_OPTIONS
  } else {
    recordOptions.maskAllInputs = false
  }
  if (options.maskAllText) {
    recordOptions.maskTextSelector = '*'
  } else if (options.maskTextSelector !== undefined && options.maskTextSelector.length > 0) {
    recordOptions.maskTextSelector = options.maskTextSelector
  }
  if (options.blockSelector !== undefined && options.blockSelector.length > 0) {
    recordOptions.blockSelector = options.blockSelector
  }
  if (options.checkoutEveryNms !== undefined && options.checkoutEveryNms > 0) {
    recordOptions.checkoutEveryNms = options.checkoutEveryNms
  }

  const stop = record(recordOptions)
  if (stop === undefined) {
    throw markSdkInternalError(new Error('logfire session replay: rrweb failed to start recording'))
  }

  return {
    stop: () => {
      recording = false
      for (const removeListeners of pendingImages.values()) {
        removeListeners()
      }
      pendingImages.clear()
      stop()
    },
    addCustomEvent: (tag, payload) => {
      record.addCustomEvent(tag, payload)
    },
    takeFullSnapshot: () => {
      record.takeFullSnapshot(true)
    },
  }
}

function errorMessage(error: unknown): string {
  try {
    return error instanceof Error ? error.message : String(error)
  } catch {
    return ''
  }
}

function sanitizeRecorderEvent(event: RrwebEvent, options: SanitizeOptions): RrwebEvent {
  if (typeof event.data !== 'object' || event.data === null) {
    return event
  }

  const data = event.data as Record<string, unknown>
  if (event.type === EventType.Custom) {
    return sanitizeCustomEvent(event, data, options.patterns)
  }
  if (event.type === EventType.Meta) {
    if (typeof data['href'] !== 'string') {
      return event
    }

    const href = redactUrl(data['href'], options.patterns, window.location.href, options.transformUrl)
    return href === data['href'] ? event : { ...event, data: { ...data, href } }
  }

  if (
    event.type !== EventType.FullSnapshot &&
    (event.type !== EventType.IncrementalSnapshot || data['source'] !== IncrementalSource.Mutation)
  ) {
    return event
  }

  const sanitizedData = sanitizeSnapshotValue(data, options)
  return sanitizedData === data ? event : { ...event, data: sanitizedData }
}

// Network and navigation payloads are redacted where they are captured. Error and console payloads
// carry URLs inside free text (messages, stacks, arguments), so they are redacted here, where every
// custom event passes.
function sanitizeCustomEvent(event: RrwebEvent, data: Record<string, unknown>, patterns: RegExp[]): RrwebEvent {
  const payload = data['payload']
  if (typeof payload !== 'object' || payload === null) {
    return event
  }
  const fields = payload as Record<string, unknown>
  const baseUrl = window.location.href
  let sanitized: Record<string, unknown>
  if (data['tag'] === CustomTag.Error) {
    sanitized = { ...fields }
    if (typeof fields['message'] === 'string') {
      sanitized['message'] = boundText(fields['message'], MAX_ERROR_MESSAGE_LENGTH, (text) => redactUrlsInText(text, patterns, baseUrl))
    }
    if (typeof fields['source'] === 'string') {
      sanitized['source'] = redactUrl(fields['source'], patterns, baseUrl)
    }
    if (typeof fields['stack'] === 'string') {
      sanitized['stack'] = boundText(fields['stack'], MAX_ERROR_STACK_LENGTH, (text) =>
        redactUrlsInText(text, patterns, baseUrl, { stackTrace: true })
      )
    }
  } else if (data['tag'] === CustomTag.Console && Array.isArray(fields['args'])) {
    sanitized = {
      ...fields,
      args: fields['args'].map((arg: unknown) => (typeof arg === 'string' ? redactUrlsInText(arg, patterns, baseUrl) : arg)),
    }
  } else {
    return event
  }
  return { ...event, data: { ...data, payload: sanitized } }
}

// The text is cut before redaction, which bounds the work on an oversized message, and the marker is
// added after it, so redaction never reads the marker as part of a URL that the cut ended.
function boundText(text: string, maxLength: number, redact: (text: string) => string): string {
  const [kept, dropped] = cutText(text, maxLength)
  return `${redact(kept)}${truncationSuffix(dropped)}`
}

function sanitizeSnapshotValue(value: unknown, options: SanitizeOptions): unknown {
  if (Array.isArray(value)) {
    let changed = false
    const sanitized: unknown[] = []
    for (const item of value) {
      const next = sanitizeSnapshotValue(item, options)
      if (next !== item) {
        changed = true
      }
      sanitized.push(next)
    }
    return changed ? sanitized : value
  }

  if (typeof value !== 'object' || value === null) {
    return value
  }

  const node = value as Record<string, unknown>
  let changed = false
  const sanitized: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(node)) {
    const next =
      key === 'attributes' && !Array.isArray(item)
        ? sanitizeAttributes(item, options, options.maskImages ? describeElement(node, item, options) : undefined)
        : sanitizeSnapshotValue(item, options)
    if (next !== item) {
      changed = true
    }
    sanitized[key] = next
  }
  return changed ? sanitized : value
}

function sanitizeAttributes(value: unknown, options: SanitizeOptions, element: ElementContext | undefined): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return value
  }

  const attributes = value as Record<string, unknown>
  const masksValue =
    options.maskTextAttributes && typeof attributes['type'] === 'string' && TEXT_VALUE_INPUT_TYPES.has(attributes['type'].toLowerCase())
  let changed = false
  let maskedImageSource = false
  const sanitized: Record<string, unknown> = {}
  for (const [name, attributeValue] of Object.entries(attributes)) {
    const lowerName = name.toLowerCase()
    let next: unknown
    if (element !== undefined && typeof attributeValue === 'string' && attributeValue.length > 0 && loadsImage(element, lowerName)) {
      next = IMAGE_ONLY_ATTRIBUTE_NAMES.has(lowerName) ? '' : MASKED_IMAGE_SOURCE
      maskedImageSource ||= lowerName === 'src'
    } else if (masksValue && lowerName === 'value') {
      next = maskText(attributeValue)
    } else {
      next = sanitizeAttribute(lowerName, attributeValue, options)
    }
    if (next !== attributeValue) {
      changed = true
    }
    sanitized[name] = next
  }
  if (maskedImageSource && element !== undefined) {
    changed = sizeMaskedImage(sanitized, element, options) || changed
  }
  return changed ? sanitized : value
}

function sanitizeAttribute(name: string, value: unknown, options: SanitizeOptions): unknown {
  const redact = (url: string) => redactUrl(url, options.patterns, window.location.href, options.transformUrl)
  if (name === 'style') {
    // `redactUrlPatterns: []` without a transform keeps raw URLs, so styles are kept too, unless
    // images are masked: a style URL can load a background image.
    return options.maskImages || options.patterns.length > 0 || options.transformUrl !== undefined ? sanitizeStyle(value) : value
  }
  if (typeof value !== 'string') {
    return value
  }
  if (URL_ATTRIBUTE_NAMES.has(name)) {
    return redact(value)
  }
  if (SRCSET_ATTRIBUTE_NAMES.has(name)) {
    return redactSrcset(value, redact)
  }
  if (options.maskTextAttributes && isTextAttribute(name, value)) {
    return maskText(value)
  }
  return value
}

function describeElement(node: Record<string, unknown>, attributes: unknown, options: SanitizeOptions): ElementContext | undefined {
  const id = node['id']
  const findNode = (): Element | undefined => {
    const live = typeof id === 'number' ? options.findNode(id) : undefined
    return live?.nodeType === 1 ? (live as Element) : undefined
  }
  if (node['type'] === SERIALIZED_ELEMENT_NODE_TYPE && typeof node['tagName'] === 'string') {
    const serializedAttributes = attributes as Record<string, unknown>
    return {
      tagName: node['tagName'].toLowerCase(),
      isSVG: node['isSVG'] === true,
      getAttribute: (name) => {
        const attributeValue = serializedAttributes[name]
        return typeof attributeValue === 'string' ? attributeValue : undefined
      },
      findNode,
      serialized: true,
    }
  }
  const liveElement = findNode()
  if (liveElement !== undefined) {
    return {
      tagName: liveElement.localName.toLowerCase(),
      isSVG: liveElement.namespaceURI === SVG_NAMESPACE,
      getAttribute: (name) => liveElement.getAttribute(name) ?? undefined,
      findNode: () => liveElement,
      serialized: false,
    }
  }
  // An attribute mutation whose element rrweb no longer maps. Its `src` is masked, because it may
  // load an image.
  return { tagName: '', isSVG: false, getAttribute: () => undefined, findNode: () => undefined, serialized: false }
}

function loadsImage(element: ElementContext, name: string): boolean {
  if (IMAGE_ONLY_ATTRIBUTE_NAMES.has(name)) {
    return true
  }
  const { tagName } = element
  if (name === 'src') {
    return tagName === 'img' || tagName === '' || (tagName === 'input' && element.getAttribute('type')?.toLowerCase() === 'image')
  }
  if (name === 'href' || name === 'xlink:href') {
    return (
      (element.isSVG && (tagName === 'image' || tagName === 'feimage')) ||
      (tagName === 'link' && element.getAttribute('as')?.toLowerCase() === 'image')
    )
  }
  return false
}

// A masked image keeps the size it had when it was recorded. rrweb playback applies `rr_width` and
// `rr_height` as inline styles, as for a blocked element, but only on a newly serialized element:
// playback writes an attribute mutation verbatim. An image without a size yet, or one whose `src`
// changes, is sized once it loads.
function sizeMaskedImage(attributes: Record<string, unknown>, element: ElementContext, options: SanitizeOptions): boolean {
  const node = element.isSVG || 'rr_width' in attributes ? undefined : element.findNode()
  if (node === undefined) {
    return false
  }
  try {
    if (element.serialized) {
      const { width, height } = node.getBoundingClientRect()
      if (width > 0 && height > 0) {
        attributes['rr_width'] = `${String(width)}px`
        attributes['rr_height'] = `${String(height)}px`
        return true
      }
    }
    if (node.localName === 'img' && !(node as HTMLImageElement).complete) {
      options.sizeOnLoad(node)
    }
  } catch {
    // A node that the page cannot measure keeps the size playback gives it.
  }
  return false
}

function isTextAttribute(name: string, value: string): boolean {
  if (TEXT_ATTRIBUTE_NAMES.has(name)) {
    return true
  }
  // `data-rr-*` attributes are rrweb's own markers, which playback reads.
  return (
    name.startsWith('data-') &&
    !name.startsWith('data-rr-') &&
    !UI_STATE_DATA_ATTRIBUTE_NAMES.has(name) &&
    !FLAG_DATA_ATTRIBUTE_VALUES.has(value)
  )
}

// CSS escapes and strings make URLs in a style hard to find reliably, so a style that could
// reference one is removed whole. rrweb records a full snapshot's style as text and a mutation's
// style as a map of changed properties, where a value with a priority is a `[value, priority]` pair.
function sanitizeStyle(value: unknown): unknown {
  if (typeof value === 'string') {
    return mayReferenceCssUrl(value) ? '' : value
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return value
  }
  let changed = false
  const sanitized: Record<string, unknown> = {}
  for (const [property, propertyValue] of Object.entries(value as Record<string, unknown>)) {
    const propertyText = Array.isArray(propertyValue) ? (propertyValue as unknown[])[0] : propertyValue
    const next = typeof propertyText === 'string' && mayReferenceCssUrl(propertyText) ? '' : propertyValue
    if (next !== propertyValue) {
      changed = true
    }
    sanitized[property] = next
  }
  return changed ? sanitized : value
}

// Matches rrweb's text masking, which keeps whitespace so masked layout stays close to the original.
function maskText(value: unknown): unknown {
  return typeof value === 'string' ? value.replace(/\S/gu, '*') : value
}
