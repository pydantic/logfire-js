import { mayReferenceCssUrl } from './privacy'

// Functions whose string arguments are image URLs, as `url()` is. `src()` also takes a string.
const STRING_URL_FUNCTIONS = new Set(['-webkit-image-set', 'image-set', 'src'])
// The browser puts the fallback of these functions in their place, so a string in a fallback is an
// argument of the function around them.
const SUBSTITUTION_FUNCTIONS = new Set(['attr', 'env', 'var'])
const FONT_FACE_PRELUDE_PATTERN = /^\s*@font-face\s*$/iu
// `@import` and `@namespace` load a stylesheet or name a namespace. Neither loads an image.
const NON_IMAGE_AT_RULE_PATTERN = /^\s*@(?:import|namespace)(?![\w-])/iu
const DATA_URL_PATTERN = /^data:/iu
const COMMENT_PATTERN = /\/\*[\s\S]*?(?:\*\/|$)/gu
const HEX_DIGIT_PATTERN = /[\da-f]/iu
const WHITESPACE_PATTERN = /[\t\n\f\r ]/u

interface Block {
  fontFace: boolean
}

/**
 * Returns the `#id` form of a URL that names an element of the recorded page, such as the target of
 * `filter: url(#blur)`. Returns undefined for any other URL.
 */
export type ElementReference = (url: string) => string | undefined

/**
 * Replace each image URL in stylesheet text with `placeholder`. Image URLs are the values of
 * `url()`, and the strings in `image-set()` and `src()`. The text keeps `@font-face` sources,
 * `@import` and `@namespace` URLs, and `data:` URLs. An element reference such as `url(#gradient)`
 * becomes its `#id` form, which playback resolves in the replayed document.
 * Returns `css` itself when it has no image URL.
 */
export function maskCssImageUrls(css: string, placeholder: string, elementReference: ElementReference): string {
  return mayReferenceCssUrl(css) ? new CssImageUrlScanner(css, placeholder, elementReference).scan() : css
}

// A small CSS tokenizer after CSS Syntax Level 3. It knows strings, comments, escapes, blocks, and
// function nesting, which is enough to find every token that loads a URL. A keep rule applies only
// to a context that it identifies exactly. Text that it cannot classify, such as an unterminated
// `url(` or an escaped at-rule name, is masked.
class CssImageUrlScanner {
  private readonly chunks: string[] = []
  private copiedUntil = 0
  private position = 0
  private readonly blocks: Block[] = []
  private readonly functions: string[] = []
  // The start of the current rule prelude or declaration, after the last `{`, `}`, or `;`.
  private statementStart = 0
  private declarationName: string | undefined
  private readonly css: string
  private readonly placeholder: string
  private readonly elementReference: ElementReference

  constructor(css: string, placeholder: string, elementReference: ElementReference) {
    this.css = css
    this.placeholder = placeholder
    this.elementReference = elementReference
  }

  scan(): string {
    const { css } = this
    while (this.position < css.length) {
      const char = css[this.position] ?? ''
      if (char === '/' && css[this.position + 1] === '*') {
        this.scanComment()
      } else if (char === '"' || char === "'") {
        this.scanString()
      } else if (char === '\\' || isNameStart(char) || (char === '-' && this.startsIdentifierAt(this.position + 1))) {
        this.scanIdentifier()
      } else {
        this.scanPunctuation(char)
        this.position++
      }
    }
    if (this.chunks.length === 0) {
      return css
    }
    this.chunks.push(css.slice(this.copiedUntil))
    return this.chunks.join('')
  }

  private scanPunctuation(char: string): void {
    if (char === '{') {
      const prelude = this.statementText()
      this.blocks.push({ fontFace: FONT_FACE_PRELUDE_PATTERN.test(prelude) })
      this.functions.length = 0
      this.startStatement(this.position + 1)
    } else if (char === '}') {
      this.blocks.pop()
      this.functions.length = 0
      this.startStatement(this.position + 1)
    } else if (char === ';') {
      // An unclosed parenthesis must not carry a `src` or `@import` keep into the next statement.
      this.functions.length = 0
      this.startStatement(this.position + 1)
    } else if (char === ':' && this.functions.length === 0 && this.declarationName === undefined) {
      this.declarationName = this.statementText().trim().toLowerCase()
    } else if (char === '(') {
      this.functions.push('')
    } else if (char === ')') {
      this.functions.pop()
    }
  }

  private enclosingFunction(): string | undefined {
    for (let index = this.functions.length - 1; index >= 0; index--) {
      const name = this.functions[index] ?? ''
      if (!SUBSTITUTION_FUNCTIONS.has(name)) {
        return name
      }
    }
    return undefined
  }

  private startStatement(position: number): void {
    this.statementStart = position
    this.declarationName = undefined
  }

  private statementText(): string {
    return this.css.slice(this.statementStart, this.position).replace(COMMENT_PATTERN, '')
  }

  // A comment loads nothing, but its text is stored, so a comment that could hold a URL is emptied.
  // rrweb's own `/* rr_split */` markers hold none, and playback needs them.
  private scanComment(): void {
    const start = this.position
    const end = this.css.indexOf('*/', start + 2)
    this.position = end === -1 ? this.css.length : end + 2
    if (mayReferenceCssUrl(this.css.slice(start + 2, end === -1 ? this.css.length : end))) {
      this.replace(start, this.position, '/**/')
    }
  }

  private scanString(): void {
    const start = this.position
    const value = this.consumeString()
    const enclosing = this.enclosingFunction()
    if (enclosing === undefined || !STRING_URL_FUNCTIONS.has(enclosing)) {
      return
    }
    const kept = this.keptUrl(value.text, value.terminated)
    if (kept !== value.text) {
      this.replace(start, this.position, JSON.stringify(kept ?? this.placeholder))
    }
  }

  private scanIdentifier(): void {
    const start = this.position
    const name = this.consumeName().toLowerCase()
    // A backslash before a newline is not an escape, so it starts no name.
    if (this.position === start) {
      this.position++
      return
    }
    if (this.css[this.position] !== '(') {
      return
    }
    this.position++
    if (name === 'url') {
      this.scanUrl(start)
    } else {
      this.functions.push(name)
    }
  }

  // `url(` holds either a quoted string followed by optional modifiers, or an unquoted URL.
  private scanUrl(start: number): void {
    this.skipWhitespace()
    const quote = this.css[this.position]
    let value: string
    let terminated: boolean
    const urlComments: [start: number, end: number][] = []
    if (quote === '"' || quote === "'") {
      const string = this.consumeString()
      value = string.text
      terminated = string.terminated && this.skipToClosingParenthesis(urlComments)
    } else {
      const unquoted = this.consumeUnquotedUrl()
      value = trimCssWhitespace(unquoted.text)
      terminated = unquoted.terminated
    }
    const kept = this.keptUrl(value, terminated)
    if (kept !== value) {
      this.replace(start, this.position, `url(${JSON.stringify(kept ?? this.placeholder)})`)
      return
    }
    for (const [commentStart, commentEnd] of urlComments) {
      this.replace(commentStart, commentEnd, '/**/')
    }
  }

  // Returns the URL to record in place of `value`: `value` itself, its `#id` form, or undefined for
  // the placeholder.
  private keptUrl(value: string, terminated: boolean): string | undefined {
    if (!terminated) {
      return undefined
    }
    if (DATA_URL_PATTERN.test(trimUrlWhitespace(value))) {
      return value
    }
    const reference = this.elementReference(value)
    if (reference !== undefined) {
      return reference
    }
    const keeps =
      this.blocks.at(-1)?.fontFace === true ? this.declarationName === 'src' : NON_IMAGE_AT_RULE_PATTERN.test(this.statementText())
    return keeps ? value : undefined
  }

  private consumeString(): { text: string; terminated: boolean } {
    const { css } = this
    const quote = css[this.position]
    this.position++
    let text = ''
    while (this.position < css.length) {
      const char = css[this.position] ?? ''
      if (char === quote) {
        this.position++
        return { text, terminated: true }
      }
      // An unescaped newline ends a string as a bad string, which the browser drops.
      if (char === '\n' || char === '\r' || char === '\f') {
        return { text, terminated: false }
      }
      if (char === '\\') {
        const next = css[this.position + 1]
        if (next === '\n' || next === '\r' || next === '\f') {
          this.position += 1 + this.newlineLength(this.position + 1)
          continue
        }
        text += this.consumeEscape()
        continue
      }
      text += char
      this.position++
    }
    return { text, terminated: false }
  }

  private consumeUnquotedUrl(): { text: string; terminated: boolean } {
    const { css } = this
    let text = ''
    while (this.position < css.length) {
      const char = css[this.position] ?? ''
      if (char === ')') {
        this.position++
        return { text, terminated: true }
      }
      if (char === '\\') {
        text += this.consumeEscape()
        continue
      }
      text += char
      this.position++
    }
    return { text, terminated: false }
  }

  // Skips the modifiers after a quoted `url()` string, with their own strings and parentheses. A kept
  // `url()` is recorded as written, so the comments among its modifiers that could hold a URL are
  // added to `urlComments` for the caller to empty.
  private skipToClosingParenthesis(urlComments: [start: number, end: number][]): boolean {
    const { css } = this
    let depth = 0
    while (this.position < css.length) {
      const char = css[this.position] ?? ''
      if (char === '/' && css[this.position + 1] === '*') {
        const commentStart = this.position
        const end = css.indexOf('*/', commentStart + 2)
        if (end === -1) {
          return false
        }
        this.position = end + 2
        if (mayReferenceCssUrl(css.slice(commentStart + 2, end))) {
          urlComments.push([commentStart, this.position])
        }
        continue
      }
      if (char === '"' || char === "'") {
        if (!this.consumeString().terminated) {
          return false
        }
        continue
      }
      if (char === '\\') {
        this.consumeEscape()
        continue
      }
      this.position++
      if (char === '(') {
        depth++
      } else if (char === ')') {
        if (depth === 0) {
          return true
        }
        depth--
      }
    }
    return false
  }

  private consumeName(): string {
    const { css } = this
    let name = ''
    let runStart = this.position
    while (this.position < css.length) {
      const char = css[this.position] ?? ''
      if (char === '\\') {
        if (isNewline(css[this.position + 1])) {
          break
        }
        name += css.slice(runStart, this.position) + this.consumeEscape()
        runStart = this.position
      } else if (isNameChar(char)) {
        this.position++
      } else {
        break
      }
    }
    return name + css.slice(runStart, this.position)
  }

  // Decodes the escape at the current backslash: up to six hex digits and one whitespace, or one
  // literal character.
  private consumeEscape(): string {
    const { css } = this
    this.position++
    let hex = ''
    while (hex.length < 6 && HEX_DIGIT_PATTERN.test(css[this.position] ?? '')) {
      hex += css[this.position] ?? ''
      this.position++
    }
    if (hex === '') {
      const char = css[this.position] ?? ''
      this.position += char.length
      return char
    }
    if (WHITESPACE_PATTERN.test(css[this.position] ?? '')) {
      this.position += this.newlineLength(this.position) || 1
    }
    const codePoint = Number.parseInt(hex, 16)
    return codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff) ? '�' : String.fromCodePoint(codePoint)
  }

  private startsIdentifierAt(position: number): boolean {
    const char = this.css[position] ?? ''
    return isNameStart(char) || char === '-' || (char === '\\' && !isNewline(this.css[position + 1]))
  }

  // CSS reads CRLF as one newline, so an escape that ends in a newline consumes both characters.
  private newlineLength(position: number): number {
    const char = this.css[position]
    if (char === '\r') {
      return this.css[position + 1] === '\n' ? 2 : 1
    }
    return isNewline(char) ? 1 : 0
  }

  private skipWhitespace(): void {
    while (WHITESPACE_PATTERN.test(this.css[this.position] ?? '')) {
      this.position++
    }
  }

  private replace(start: number, end: number, replacement: string): void {
    this.chunks.push(this.css.slice(this.copiedUntil, start), replacement)
    this.copiedUntil = end
  }
}

// Character code checks, because the scanner runs over every character of a full snapshot.
function isNameStart(char: string): boolean {
  const code = char.charCodeAt(0)
  return (code >= 0x61 && code <= 0x7a) || (code >= 0x41 && code <= 0x5a) || code === 0x5f || code >= 0x80
}

function isNameChar(char: string): boolean {
  const code = char.charCodeAt(0)
  return isNameStart(char) || (code >= 0x30 && code <= 0x39) || code === 0x2d
}

// CSS removes only its own whitespace around an unquoted URL. `String.prototype.trim()` also
// removes Unicode spaces such as U+00A0, which are part of the URL.
function trimCssWhitespace(text: string): string {
  let start = 0
  let end = text.length
  while (start < end && WHITESPACE_PATTERN.test(text[start] ?? '')) {
    start++
  }
  while (end > start && WHITESPACE_PATTERN.test(text[end - 1] ?? '')) {
    end--
  }
  return text.slice(start, end)
}

// The URL parser removes C0 controls and spaces around a URL, and nothing else. So `\a0 data:` is a
// relative path, not a `data:` URL.
function trimUrlWhitespace(text: string): string {
  let start = 0
  let end = text.length
  while (start < end && text.charCodeAt(start) <= 0x20) {
    start++
  }
  while (end > start && text.charCodeAt(end - 1) <= 0x20) {
    end--
  }
  return text.slice(start, end)
}

function isNewline(char: string | undefined): boolean {
  return char === '\n' || char === '\r' || char === '\f'
}
