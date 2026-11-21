/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { generateComponentTarget, generateDefaultTarget, generateStableDefaultTarget, splitWebVitalTarget } from './webVitalTarget'

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

describe('generateDefaultTarget', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('adds the web-vitals selector to a component name', () => {
    render('<div data-logfire-component="Card"><div id=":r1:"><p class="title" data-test="target"></p></div></div>')

    expect(generateDefaultTarget(element('target'))).toBe('component:Card\n#:r1:>p.title')
  })

  it('replaces a line break in a name, which would be read as the separator', () => {
    render('<div data-test="target"></div>')
    element('target').setAttribute('data-logfire-component', 'Card\nList')

    expect(generateDefaultTarget(element('target'))).toBe('component:Card List\nhtml>body>div')
  })

  it('returns undefined for an element with no named ancestor', () => {
    render('<div id=":r1:"><p data-test="target"></p></div>')

    expect(generateDefaultTarget(element('target'))).toBeUndefined()
  })
})

describe('generateStableDefaultTarget', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('adds the selector with no generated id to a component name', () => {
    render('<main id="app"><div data-logfire-component="Card"><div id=":r1:"><p class="title" data-test="target"></p></div></div></main>')

    expect(generateStableDefaultTarget(element('target'))).toBe('component:Card\n#app>div>div>p.title')
  })

  it('returns the selector with no generated id for an element with no named ancestor', () => {
    render('<main id="app"><div id=":r1:" class="card"><p data-test="target"></p></div></main>')

    expect(generateStableDefaultTarget(element('target'))).toBe('#app>div.card>p')
  })

  it('returns undefined when the selector holds no generated id', () => {
    render('<main id="app"><p data-test="target"></p></main>')

    expect(generateStableDefaultTarget(element('target'))).toBeUndefined()
  })
})

describe('splitWebVitalTarget', () => {
  it.each([
    ['a component name with a selector', 'component:Card\ndiv>p', { selector: 'div>p', target: 'component:Card' }],
    ['a component name alone', 'component:Card', { target: 'component:Card' }],
    ['a selector', '#app>p', { target: '#app>p' }],
    ['a custom target that holds the separator', 'custom\ntarget', { target: 'custom\ntarget' }],
    ['a missing target', undefined, { target: undefined }],
    ['a target that is not a string', 12, { target: 12 }],
  ])('splits %s', (_, value, expected) => {
    expect(splitWebVitalTarget(value)).toEqual(expected)
  })
})
