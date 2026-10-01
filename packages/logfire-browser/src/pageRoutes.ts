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
  private readonly pages: ObservedPage[] = []

  observe(key: string, route: string | undefined, at: number): void {
    let page = this.pages.at(-1)
    if (page?.key !== key) {
      page = { key, route: undefined, startedAt: at }
      this.pages.push(page)
      this.documentPage ??= page
      if (this.pages.length > MAX_TRACKED_PAGES) {
        this.pages.shift()
      }
    }
    page.route ??= route
  }

  documentRoute(key: string): string | undefined {
    return this.documentPage?.key === key ? this.documentPage.route : undefined
  }

  softNavigationRoute(key: string, startTime: number): string | undefined {
    // The navigation's URL became current after it started, so its page is the
    // first one observed from then on. A same-URL navigation creates no new
    // page, which leaves the page that was already current.
    const nextIndex = this.pages.findIndex((page) => page.startedAt >= startTime)
    const next = nextIndex === -1 ? undefined : this.pages[nextIndex]
    if (next?.key === key) {
      return next.route
    }
    const previous = this.pages[(nextIndex === -1 ? this.pages.length : nextIndex) - 1]
    return previous?.key === key ? previous.route : undefined
  }
}
