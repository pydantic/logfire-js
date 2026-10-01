import { describe, expect, it } from 'vite-plus/test'

import { PageRouteHistory } from './pageRoutes'

describe('PageRouteHistory', () => {
  it('keeps the first defined route observed for the document page', () => {
    const history = new PageRouteHistory()

    history.observe('/projects/123', undefined, 0)
    history.observe('/projects/123', '/projects/:id', 10)
    history.observe('/projects/123', '/settings', 20)
    history.observe('/settings', '/settings', 30)

    expect(history.documentRoute('/projects/123')).toBe('/projects/:id')
    expect(history.documentRoute('/settings')).toBeUndefined()
  })

  it('omits the document route when no route was observed for the document page', () => {
    const history = new PageRouteHistory()

    history.observe('/projects/123', undefined, 0)
    history.observe('/settings', '/settings', 10)

    expect(history.documentRoute('/projects/123')).toBeUndefined()
  })

  it('matches a soft navigation to the page that became current after it started', () => {
    const history = new PageRouteHistory()

    history.observe('/a', '/a/first', 0)
    history.observe('/b', '/b', 100)
    history.observe('/a', '/a/second', 200)

    expect(history.softNavigationRoute('/b', 90)).toBe('/b')
    expect(history.softNavigationRoute('/a', 190)).toBe('/a/second')
  })

  it('matches a same-URL soft navigation to the page that was already current', () => {
    const history = new PageRouteHistory()

    history.observe('/a', '/a', 0)
    history.observe('/b', '/b', 100)

    expect(history.softNavigationRoute('/b', 150)).toBe('/b')
  })

  it('omits a soft-navigation route when its page was never observed', () => {
    const history = new PageRouteHistory()

    history.observe('/a', '/a', 0)
    history.observe('/c', '/c', 200)

    expect(history.softNavigationRoute('/b', 100)).toBeUndefined()
  })

  it('keeps the document page after older soft-navigation pages are evicted', () => {
    const history = new PageRouteHistory()

    history.observe('/document', '/document', 0)
    for (let index = 1; index <= 60; index++) {
      history.observe(`/page-${index.toString()}`, `/page-${index.toString()}`, index * 10)
    }

    expect(history.documentRoute('/document')).toBe('/document')
    expect(history.softNavigationRoute('/page-1', 5)).toBeUndefined()
    expect(history.softNavigationRoute('/page-60', 595)).toBe('/page-60')
  })
})
