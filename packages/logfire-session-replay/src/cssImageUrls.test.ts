import { describe, expect, it } from 'vitest'

import { maskCssImageUrls } from './cssImageUrls'
import { cssElementReference } from './privacy'

const masked = 'url("MASKED")'

function mask(css: string): string {
  return maskCssImageUrls(css, 'MASKED', (url) => cssElementReference(url, 'https://app.test/org/live?tab=1#top'))
}

describe('maskCssImageUrls', () => {
  it('returns the same text when nothing references a URL', () => {
    const css = '.a{color:red}/* rr_split */.b:hover{margin:0}'
    expect(mask(css)).toBe(css)
  })

  it('replaces unquoted, quoted, and spaced url() values with the placeholder', () => {
    expect(mask('.a{background:url(/a.png) no-repeat}')).toBe(`.a{background:${masked} no-repeat}`)
    expect(mask(`.a{background:url('https://cdn.test/a.png?sig=1')}`)).toBe(`.a{background:${masked}}`)
    expect(mask('.a{cursor:url( "a.cur" ) 2 2,auto}')).toBe(`.a{cursor:${masked} 2 2,auto}`)
    expect(mask('.a{--bg:url(a.png);list-style:url(b.png)}')).toBe(`.a{--bg:${masked};list-style:${masked}}`)
  })

  it('finds url() through letter case, escapes, and modifiers', () => {
    expect(mask('.a{background:URL(a.png)}')).toBe(`.a{background:${masked}}`)
    expect(mask('.a{background:u\\72l(a.png)}')).toBe(`.a{background:${masked}}`)
    expect(mask('.a{background:url(a\\)b.png) red}')).toBe(`.a{background:${masked} red}`)
    expect(mask('.a{background:url("a.png" crossorigin(anonymous)) red}')).toBe(`.a{background:${masked} red}`)
  })

  it('replaces the string URLs of image-set() and src()', () => {
    expect(mask('.a{background:image-set("a.png" 1x,url(b.png) 2x)}')).toBe(`.a{background:image-set("MASKED" 1x,${masked} 2x)}`)
    expect(mask(".a{background:-webkit-image-set('a.png' 1x)}")).toBe('.a{background:-webkit-image-set("MASKED" 1x)}')
    expect(mask('.a{background:src("a.png")}')).toBe('.a{background:src("MASKED")}')
  })

  it('keeps strings that do not load a URL', () => {
    const css = '.a{content:"url(a.png)";font-family:"image-set(x)"}'
    expect(mask(css)).toBe(css)
  })

  it('keeps data: URLs and element references, but not fragment routes', () => {
    const css = '.a{background:url("data:image/svg+xml,%3Csvg%3E%3C/svg%3E");mask:url(DATA:image/png;base64,AA==)}.b{filter:url(#blur)}'
    expect(mask(css)).toBe(css)
    expect(mask('.a{clip-path:url("#clip")}')).toBe('.a{clip-path:url("#clip")}')
    expect(mask('.a{filter:url(#/reset?token=secret)}')).toBe(`.a{filter:${masked}}`)
  })

  it('records a reference to an element of the page in its id form', () => {
    expect(mask('.a{filter:url("https://app.test/org/live#blur")}')).toBe('.a{filter:url("#blur")}')
    expect(mask('.a{filter:url(https://app.test/org/live?tab=2#blur)}')).toBe('.a{filter:url("#blur")}')
    // rrweb resolves `url(#blur)` in a `<style>` element against the page directory.
    expect(mask('.a{filter:url("https://app.test/org/#blur")}')).toBe('.a{filter:url("#blur")}')
    expect(mask('.a{background:image-set("https://app.test/org/live#icon" 1x)}')).toBe('.a{background:image-set("#icon" 1x)}')
    expect(mask('.a{mask:url(https://cdn.test/sprite.svg#icon)}')).toBe(`.a{mask:${masked}}`)
    expect(mask('.a{mask:url(https://app.test/org/other#icon)}')).toBe(`.a{mask:${masked}}`)
    expect(mask('.a{mask:url(https://app.test/#icon)}')).toBe(`.a{mask:${masked}}`)
  })

  it('empties comments that could hold a URL among the modifiers of a kept url()', () => {
    expect(mask('@font-face{src:url("a.woff" /* url(secret.png) */ /* ok */)}')).toBe('@font-face{src:url("a.woff" /**/ /* ok */)}')
    expect(mask('.a{background:url("a.png" /* url(secret.png) */)}')).toBe(`.a{background:${masked}}`)
    expect(mask('@font-face{src:url("a.woff" /* url(secret.png)')).toBe(`@font-face{src:${masked}/**/`)
  })

  it('keeps @font-face sources only in the src descriptor of that rule', () => {
    const fontFace = '@font-face{font-family:Inter;SRC:url(/inter.woff2) format("woff2"),url(inter.woff)}'
    expect(mask(fontFace)).toBe(fontFace)
    expect(mask('@supports (display:grid){@font-face{src:url(a.woff)}}')).toBe('@supports (display:grid){@font-face{src:url(a.woff)}}')
    expect(mask('@font-face{src:url(a.woff);background:url(a.png)}')).toBe(`@font-face{src:url(a.woff);background:${masked}}`)
    expect(mask('@font-face{src:url(a.woff)}.a{src:url(a.png)}')).toBe(`@font-face{src:url(a.woff)}.a{src:${masked}}`)
  })

  it('masks a source when it cannot identify the @font-face rule', () => {
    expect(mask('@font-\\66 ace{src:url(a.woff)}')).toBe(`@font-\\66 ace{src:${masked}}`)
    expect(mask('@font-face-x{src:url(a.woff)}')).toBe(`@font-face-x{src:${masked}}`)
  })

  it('keeps @import and @namespace URLs, and masks the rules after them', () => {
    const css = '@import url(theme.css) layer(base);@import "print.css" print;@namespace svg url(http://www.w3.org/2000/svg);'
    expect(mask(css)).toBe(css)
    expect(mask('@import url(theme.css);.a{background:url(a.png)}')).toBe(`@import url(theme.css);.a{background:${masked}}`)
  })

  it('masks URLs inside nested blocks', () => {
    expect(mask('@media (min-width:1px){.a:hover{background:url(a.png)}}')).toBe(`@media (min-width:1px){.a:hover{background:${masked}}}`)
  })

  it('empties a comment that could hold a URL and keeps the rrweb split markers', () => {
    expect(mask('/* url(a.png) */.a{color:red}/* rr_split */.b{}')).toBe('/**/.a{color:red}/* rr_split */.b{}')
  })

  it('masks unterminated URLs and strings', () => {
    expect(mask('.a{background:url(a.png')).toBe(`.a{background:${masked}`)
    expect(mask('.a{background:url("a.png')).toBe(`.a{background:${masked}`)
    expect(mask('.a{background:image-set("a.png\n1x)}')).toBe('.a{background:image-set("MASKED"\n1x)}')
    expect(mask('/* url(a.png)')).toBe('/**/')
  })

  it('ends a keep context at the next semicolon, also after an unclosed parenthesis', () => {
    expect(mask('@font-face{src:local((x);background:url(a.png)}')).toBe(`@font-face{src:local((x);background:${masked}}`)
    expect(mask('@import foo((;.a{background:url(a.png)}')).toBe(`@import foo((;.a{background:${masked}}`)
  })

  it('treats a backslash before a newline as plain text', () => {
    const css = '.a{color:red}\\\n.b{color:blue}'
    expect(mask(css)).toBe(css)
  })
})
