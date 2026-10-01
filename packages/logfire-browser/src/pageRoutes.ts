// A long single-page session can visit many URLs. Soft-navigation Web Vitals
// finalize at the next navigation, so only recent pages are looked up. The
// document page is kept separately because its metrics can report at page hide.
const MAX_TRACKED_PAGES = 50

interface ObservedPage {
  key: string
  route: string | undefined
  startedAt: number
}

/**
 * Remembers the first route observed while each page was current, so Web
 * Vitals that report after a later navigation keep the route of their own page.
 * Pages are observed lazily (on span starts and Web Vital reports), so a page
 * is only known once something observed it while its URL was current.
 */
export class PageRouteHistory {
  private documentPage: ObservedPage | undefined
  private observedAnyPage = false
  private readonly pages: ObservedPage[] = []

  /**
   * `leftDocument` is called only for the first observed page. When a soft
   * navigation had already started, that page is not the initial document.
   */
  observe(key: string, route: string | undefined, at: number, leftDocument: () => boolean = () => false): void {
    let page = this.pages.at(-1)
    if (page?.key !== key) {
      page = { key, route: undefined, startedAt: at }
      this.pages.push(page)
      if (!this.observedAnyPage) {
        this.observedAnyPage = true
        this.documentPage = leftDocument() ? undefined : page
      }
      if (this.pages.length > MAX_TRACKED_PAGES) {
        this.pages.shift()
      }
    }
    page.route ??= route
  }

  documentRoute(key: string): string | undefined {
    return this.documentPage?.key === key ? this.documentPage.route : undefined
  }

  /**
   * `nextStartTime` is when the following soft navigation started, if one did.
   * Pages observed from then on belong to that later navigation.
   */
  softNavigationRoute(key: string, startTime: number, nextStartTime: number = Number.POSITIVE_INFINITY): string | undefined {
    // The navigation's URL became current after it started, possibly through
    // an intermediate redirect URL, so its page is the first one with its key
    // observed during the navigation. A same-URL navigation creates no new
    // page, which leaves the page that was already current.
    const firstIndex = this.pages.findIndex((page) => page.startedAt >= startTime)
    const during = firstIndex === -1 ? [] : this.pages.slice(firstIndex)
    const match = during.find((page) => page.startedAt < nextStartTime && page.key === key)
    if (match !== undefined) {
      return match.route
    }
    const previous = this.pages[(firstIndex === -1 ? this.pages.length : firstIndex) - 1]
    return previous?.key === key ? previous.route : undefined
  }
}
