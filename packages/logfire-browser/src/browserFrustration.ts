import type { Attributes, Tracer } from '@opentelemetry/api'
import { diag, ROOT_CONTEXT } from '@opentelemetry/api'
import type { BrowserSessionManager } from './browserSession'
import type { BrowserSessionReplayState } from './sessionReplay'
import { snapshotBrowserSpanAttributes } from './BrowserSessionSpanProcessor'
import { INTERACTION_CONTEXT } from './interactionContext'
import { observeFrustrationNavigations } from './frustrationNavigation'
import { InteractionFrustrationDetector } from './interactionFrustration'
import type { BrowserFrustrationOptions, FrustrationSignal } from './interactionFrustration'

interface StartOptions extends BrowserFrustrationOptions {
  sessionManager: BrowserSessionManager
  replayState: BrowserSessionReplayState
  tracer: Tracer
}

/** Optional browser observers. No DOM content or arbitrary element attributes are exported. */
export function startBrowserFrustration(options: StartOptions): () => void {
  const selectors = [...(options.ignoreSelectors ?? [])]
  // Validate before installing listeners.
  for (const selector of selectors) {
    document.querySelector(selector)
  }
  let active = true
  let nextTarget = 0
  let nextInteraction = 0
  let emitted = 0
  let sessionId = options.sessionManager.getSession().id
  let page = location.href
  const targets = new WeakMap<Element, number>()
  const observedRoots = new Set<Document | ShadowRoot>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let scheduledDeadline: number | undefined
  let hadSelection = false
  let lastClickedTarget: Element | undefined
  const emit = (signal: FrustrationSignal) => {
    if (!active || emitted >= 50) {
      return
    }
    emitted++
    try {
      const span = options.tracer.startSpan(
        `browser.${signal.kind}`,
        { startTime: signal.click.timestamp },
        ROOT_CONTEXT.setValue(INTERACTION_CONTEXT, signal.click.attributes)
      )
      span.setAttributes({
        'logfire.span_type': 'log',
        'logfire.msg':
          signal.kind === 'dead_click'
            ? 'No response observed after click'
            : signal.kind === 'slow_click'
              ? 'Slow response after click'
              : 'Repeated clicks detected',
        'logfire.interaction.kind': signal.kind,
        'logfire.interaction.detector_version': 1,
        'logfire.interaction.click_count': signal.count,
        'logfire.interaction.delay_ms': signal.delay,
        'logfire.interaction.detected_at': Date.now(),
        'logfire.interaction.response': signal.response ?? (signal.kind === 'rage_click' ? 'not_assessed' : 'none_observed'),
      })
      span.end(signal.click.timestamp)
    } catch (error) {
      diag.error('logfire-browser: frustration reporting failed', error)
    }
  }
  const detector = new InteractionFrustrationDetector(options, emit)
  const reset = () => {
    detector.reset()
    stopObservation()
  }
  const validContext = () => {
    if (!active || document.visibilityState !== 'visible') {
      return false
    }
    const current = options.sessionManager.getSession().id
    if (current !== sessionId || location.href !== page) {
      reset()
      if (current !== sessionId) {
        emitted = 0
      }
      sessionId = current
      page = location.href
    }
    return active
  }
  const response = (event: Event | MutationRecord[]) => {
    if (!active) {
      return
    }
    try {
      const now = performance.now()
      if (validContext() && hasTimelyObservation(now)) {
        detector.response(now, Array.isArray(event) ? 'dom_change' : event.type)
        scheduleDeadline()
      } else {
        reset()
      }
    } catch (error) {
      reset()
      diag.error('logfire-browser: frustration response observation failed', error)
    }
  }
  const click = (event: MouseEvent) => {
    try {
      if (
        !active ||
        !event.isTrusted ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.shiftKey ||
        !validContext()
      ) {
        return
      }
      const now = performance.now()
      if (!hasTimelyObservation(now)) {
        reset()
      }
      const path = event.composedPath().filter((node): node is Element => node instanceof Element)
      if (emitted >= 50) {
        return
      }
      if (
        path.some(
          (node) =>
            selectors.some((selector) => node.matches(selector)) ||
            node.matches(
              '[data-logfire-ignore-frustration],[aria-disabled="true"],input:not([type="button"]):not([type="submit"]),textarea,[contenteditable]:not([contenteditable="false"]),canvas,video,audio'
            )
        )
      ) {
        return
      }
      const target = path.find((node) => node.matches('button,a,input[type="button"],input[type="submit"],[role="button"],[role="link"]'))
      if (target === undefined || target.matches(':disabled,[aria-disabled="true"],a[download],a[target]:not([target="_self"])')) {
        return
      }
      const id = targets.get(target) ?? ++nextTarget
      targets.set(target, id)
      const session = options.sessionManager.touch()
      if (session.id !== sessionId) {
        reset()
        sessionId = session.id
        emitted = 0
      }
      const attributes: Attributes = {
        ...snapshotBrowserSpanAttributes(options.sessionManager, options.replayState, session),
        'logfire.interaction.target_tag': target.tagName.toLowerCase(),
        'logfire.interaction.id': `${session.id}:${String(Date.now())}:${String(++nextInteraction)}`,
      }
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- reset and session callbacks can deactivate mid-click.
      if (!active) {
        return
      }
      if (observer !== undefined && !observeClickRoots(event)) {
        return
      }
      lastClickedTarget = observer === undefined ? undefined : target
      detector.click({ target: id, x: event.clientX, y: event.clientY, now, timestamp: Date.now(), attributes })
      if (emitted >= 50) {
        reset()
      } else {
        scheduleDeadline()
      }
    } catch (error) {
      reset()
      diag.error('logfire-browser: frustration observation failed', error)
    }
  }
  const userIntent = (event: Event) => {
    if (
      !active ||
      !event.isTrusted ||
      (event.type === 'pointerdown' && lastClickedTarget !== undefined && event.composedPath().includes(lastClickedTarget))
    ) {
      return
    }
    // A new gesture can focus, scroll, or mutate the page before its click fires.
    // It cannot establish that the preceding action received application feedback.
    detector.cancelPending()
    stopObservation()
  }
  const intentEvents = ['pointerdown', 'keydown', 'wheel'] as const
  const selectionResponse = (event: Event) => {
    const hasSelection = document.getSelection()?.isCollapsed === false
    // Chromium can move a collapsed caret on an ordinary button click. That is not feedback.
    if (hadSelection || hasSelection) {
      response(event)
    }
    hadSelection = hasSelection
  }
  const responseEvents = ['input', 'change', 'scroll', 'focusin'] as const
  const resetEvents = [
    [document, 'visibilitychange'],
    [window, 'pagehide'],
    [window, 'blur'],
    [window, 'popstate'],
    [window, 'hashchange'],
  ] as const
  // Construct before installing listeners; observe only while clicks await a response.
  const observer = options.deadClicks === true ? new MutationObserver(response) : undefined
  function hasTimelyObservation(now: number): boolean {
    const deadline = detector.nextDeadline
    // Any callback can win the event-loop race after a stall, not just our timeout.
    return deadline === undefined || now - deadline <= 2000
  }
  function stopObservation(): void {
    // Release timers before calling wrapped DOM APIs, any of which can fail independently.
    if (timer !== undefined) {
      clearTimeout(timer)
      timer = undefined
    }
    scheduledDeadline = undefined
    lastClickedTarget = undefined
    release(() => observer?.disconnect())
    for (const root of observedRoots) {
      for (const name of responseEvents) {
        release(() => {
          root.removeEventListener(name, response, true)
        })
      }
    }
    observedRoots.clear()
    release(() => {
      document.removeEventListener('selectionchange', selectionResponse)
    })
  }

  function release(cleanup: () => void): void {
    try {
      cleanup()
    } catch (error) {
      // Do not admit new clicks with uncertain observer ownership after failed teardown.
      active = false
      diag.error('logfire-browser: frustration cleanup failed', error)
    }
  }

  function observeClickRoots(event: Event): boolean {
    const roots = new Set<Document | ShadowRoot>([document])
    for (const node of event.composedPath()) {
      if (node instanceof ShadowRoot) {
        roots.add(node)
      }
    }
    // Bound retained roots even on pages creating a new web component for every interaction.
    if ([...roots].filter((root) => !observedRoots.has(root)).length + observedRoots.size > 64) {
      reset()
    }
    if (roots.size > 64 || !active) {
      return false
    }
    if (observedRoots.size === 0) {
      hadSelection = document.getSelection()?.isCollapsed === false
      document.addEventListener('selectionchange', selectionResponse)
    }
    for (const root of roots) {
      if (!observedRoots.has(root)) {
        observedRoots.add(root)
        // Scroll is not composed: document capture cannot see feedback inside a shadow root.
        for (const name of responseEvents) {
          root.addEventListener(name, response, true)
        }
        // Must happen in capture phase, before the application mutates the clicked shadow tree.
        observer?.observe(root, { subtree: true, childList: true, attributes: true, characterData: true })
      }
    }
    return true
  }

  function scheduleDeadline(): void {
    if (observer === undefined || !active) {
      return
    }
    const deadline = detector.nextDeadline
    if (deadline === undefined) {
      stopObservation()
      return
    }
    if (timer !== undefined && scheduledDeadline === deadline) {
      return
    }
    if (timer !== undefined) {
      clearTimeout(timer)
    }
    scheduledDeadline = deadline
    timer = setTimeout(
      () => {
        timer = undefined
        scheduledDeadline = undefined
        try {
          const now = performance.now()
          // A severely delayed callback cannot establish a complete observation window.
          if (!validContext() || !hasTimelyObservation(now)) {
            reset()
            return
          }
          detector.advance(now)
          scheduleDeadline()
        } catch (error) {
          reset()
          diag.error('logfire-browser: frustration deadline failed', error)
        }
      },
      Math.max(0, deadline - performance.now())
    )
  }

  let stopNavigations: (() => void) | undefined
  let unsubscribeSession: (() => void) | undefined
  const stop = () => {
    active = false
    reset()
    release(() => unsubscribeSession?.())
    release(() => stopNavigations?.())
    release(() => {
      document.removeEventListener('click', click, true)
    })
    for (const name of intentEvents) {
      release(() => {
        document.removeEventListener(name, userIntent, true)
      })
    }
    for (const [target, name] of resetEvents) {
      release(() => {
        target.removeEventListener(name, reset)
      })
    }
  }
  try {
    stopNavigations = observeFrustrationNavigations(reset)
    unsubscribeSession = options.sessionManager.onSessionChange((session) => {
      if (session.id !== sessionId) {
        reset()
        sessionId = session.id
        emitted = 0
      }
    })
    document.addEventListener('click', click, true)
    if (observer !== undefined) {
      for (const name of intentEvents) {
        document.addEventListener(name, userIntent, { capture: true, passive: true })
      }
    }
    for (const [target, name] of resetEvents) {
      target.addEventListener(name, reset)
    }
  } catch (error) {
    stop()
    throw error
  }
  return stop
}
