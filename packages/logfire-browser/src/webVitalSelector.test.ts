/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { generateStableSelector, getSelector, isGeneratedId } from './webVitalSelector'

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

describe('isGeneratedId', () => {
  it.each([
    ':r1:',
    ':R1mcq:',
    ':R1mcqH1:',
    '«r1»',
    '«R1mcq»',
    '_r_1_',
    '_R_1mcq_',
    'radix-:r1:',
    'radix-«r1»',
    'radix-_r_1_',
    ':r1:-form-item',
    'headlessui-menu-button-:r1:',
    'react-aria-:r1:',
    'radix-1',
    'headlessui-menu-button-12',
    'react-aria-1',
    'react-aria123-4',
  ])('detects %s', (id) => {
    expect(isGeneratedId(id)).toBe(true)
  })

  it.each([
    'app',
    'step-2',
    'r1',
    'form:results:0',
    'a:root:b',
    ':rows:',
    'user_r_and_d_team',
    'for_r_1_x',
    'radix',
    'radix-menu',
    'my-radix-1',
    'item:12',
    '',
  ])('keeps %s', (id) => {
    expect(isGeneratedId(id)).toBe(false)
  })

  it('keeps a value that is not a string', () => {
    expect(isGeneratedId(document.createElement('input'))).toBe(false)
  })
})

describe('generateStableSelector', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('skips a generated id on the target and stops at the next id', () => {
    render('<main id="app"><div class="list"><button id=":r1:" class="wide primary" data-test="target"></button></div></main>')

    expect(generateStableSelector(element('target'))).toBe('#app>div.list>button.primary.wide')
  })

  it('skips each generated id on the way to the document', () => {
    render('<div id="radix-:r1:"><div id="_r_2_" class="card"><p data-test="target"></p></div></div>')

    expect(generateStableSelector(element('target'))).toBe('html>body>div>div.card>p')
  })

  it('names a text node as web-vitals does', () => {
    render('<div id=":r1:"><p data-test="target">text</p></div>')

    expect(generateStableSelector(element('target').firstChild)).toBe('html>body>div>p>TEXT')
  })

  it('stops before the part that takes the selector to 100 characters', () => {
    render(`<section class="${'s'.repeat(80)}"><div id=":r1:" class="${'c'.repeat(40)}"><p data-test="target"></p></div></section>`)

    expect(generateStableSelector(element('target'))).toBe(`div.${'c'.repeat(40)}>p`)
  })

  it('returns a first part that is longer than the limit', () => {
    render(`<div id=":r1:" class="${'c'.repeat(120)}" data-test="target"></div>`)

    expect(generateStableSelector(element('target'))).toBe(`div.${'c'.repeat(120)}`)
  })

  it('returns the selector for an element outside the document', () => {
    const parent = document.createElement('div')
    parent.id = ':r1:'
    const child = parent.appendChild(document.createElement('span'))

    expect(generateStableSelector(child)).toBe('div>span')
  })

  it.each([
    ['no id', '<div class="card"><p data-test="target"></p></div>'],
    ['a stable id', '<div id="app"><p data-test="target"></p></div>'],
    ['a generated id above a stable id', '<div id=":r1:"><div id="app"><p data-test="target"></p></div></div>'],
    [
      'a generated id above the 100 character limit',
      `<div id=":r1:"><div class="${'c'.repeat(98)}"><p data-test="target"></p></div></div>`,
    ],
  ])('returns undefined for a selector with %s', (_, html) => {
    render(html)

    expect(generateStableSelector(element('target'))).toBeUndefined()
  })

  it('returns undefined for a missing node and the document', () => {
    expect(generateStableSelector(null)).toBeUndefined()
    expect(generateStableSelector(document)).toBeUndefined()
  })
})

describe('getSelector', () => {
  afterEach(() => {
    document.body.innerHTML = ''
  })

  it('returns the same selector as web-vitals', async () => {
    // web-vitals does not export getSelector, so the test loads the source file to detect a change in a new version.
    const library = await import('../node_modules/web-vitals/src/lib/getSelector')
    render(`
      <main id="app">
        <div id=":r1:" class="b a"><p class="title" data-test="generated">text</p></div>
        <section class="${'s'.repeat(95)}"><span data-test="long"></span></section>
        <form><input name="id" /><button data-test="clobbered"></button></form>
      </main>
    `)
    const nodes = [
      element('generated'),
      element('generated').firstChild,
      element('long'),
      element('clobbered'),
      document.body,
      document,
      document.createElement('div'),
      null,
    ]

    expect(nodes.map((node) => getSelector(node))).toEqual(nodes.map((node) => library.getSelector(node)))
    expect(getSelector(element('generated'))).toBe('#:r1:>p.title')
  })

  it('skips generated ids on request', () => {
    render('<main id="app"><div id=":r1:" class="b a"><p class="title" data-test="target"></p></div></main>')

    expect(getSelector(element('target'), true)).toBe('#app>div.a.b>p.title')
  })
})
