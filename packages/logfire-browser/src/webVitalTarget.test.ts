/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { generateComponentTarget } from './webVitalTarget'

function render(html: string): void {
  document.body.innerHTML = html
}

function element(id: string): Element {
  const found = document.querySelector(`[data-test="${id}"]`)
  if (found === null) {
    throw new Error(`expected element ${id}`)
  }
  return found
}

describe('generateComponentTarget', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('names an element that carries the attribute', () => {
    render('<section data-logfire-component="Hero" data-test="target"></section>')

    expect(generateComponentTarget(element('target'))).toBe('component:Hero')
  })

  it('names an element after its nearest named ancestor', () => {
    render(`
      <main data-logfire-component="Page">
        <div data-logfire-component="MessageList">
          <div id=":r1:" class="card wide"><p class="title" data-test="target">text</p></div>
        </div>
      </main>
    `)

    expect(generateComponentTarget(element('target'))).toBe('component:MessageList')
  })

  it('names a text node after the ancestor of its parent element', () => {
    render('<div data-logfire-component="Banner"><p data-test="target">text</p></div>')

    expect(generateComponentTarget(element('target').firstChild)).toBe('component:Banner')
  })

  it('skips an empty attribute and uses the next named ancestor', () => {
    render('<div data-logfire-component="Card"><div data-logfire-component=""><p data-test="target"></p></div></div>')

    expect(generateComponentTarget(element('target'))).toBe('component:Card')
  })

  it('trims the name and limits the target to 100 characters', () => {
    render(`<div data-logfire-component="  ${'n'.repeat(200)}  " data-test="target"></div>`)

    expect(generateComponentTarget(element('target'))).toBe(`component:${'n'.repeat(90)}`)
  })

  it.each([
    ['an element with no named ancestor', '<div id="app"><p data-test="target"></p></div>'],
    ['a blank name', '<div data-logfire-component="   "><p data-test="target"></p></div>'],
  ])('returns undefined for %s', (_, html) => {
    render(html)

    expect(generateComponentTarget(element('target'))).toBeUndefined()
  })

  it('returns undefined for a missing node, the document, and a detached text node', () => {
    expect(generateComponentTarget(null)).toBeUndefined()
    expect(generateComponentTarget(document)).toBeUndefined()
    expect(generateComponentTarget(document.createTextNode('text'))).toBeUndefined()
  })

  it('returns undefined when the lookup throws', () => {
    const node = {
      closest: () => {
        throw new Error('lookup failed')
      },
      nodeType: 1,
    }

    expect(generateComponentTarget(node as unknown as Node)).toBeUndefined()
  })
})
