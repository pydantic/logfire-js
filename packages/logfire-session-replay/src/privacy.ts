export function matchesUrlPatterns(url: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => new RegExp(pattern.source, pattern.flags).test(url))
}

/** Rewrites a URL after query and fragment removal, for example to replace tokens in its path. */
export type UrlTransform = (url: string) => string

export function redactUrl(url: string, patterns: readonly RegExp[], baseUrl: string, transformUrl?: UrlTransform): string {
  const redacted = matchesUrlPatterns(url, patterns) ? stripQueryAndFragment(url, baseUrl) : url
  return transformUrl === undefined ? redacted : applyUrlTransform(redacted, transformUrl)
}

// A failing transform keeps the built-in result, so a bug in it never restores a stripped query.
function applyUrlTransform(url: string, transformUrl: UrlTransform): string {
  try {
    const transformed = transformUrl(url)
    return typeof transformed === 'string' ? transformed : url
  } catch {
    return url
  }
}

function stripQueryAndFragment(url: string, baseUrl: string): string {
  try {
    const parsed = new URL(url, baseUrl)
    // Opaque URLs such as `mailto:` and `data:` hold their content in the path, and a `blob:` path
    // repeats its origin, so only the scheme is kept.
    if (parsed.origin === 'null' || parsed.protocol === 'blob:') {
      return parsed.protocol
    }
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    const [withoutQuery = url] = url.split('?')
    const [withoutHash = withoutQuery] = withoutQuery.split('#')
    return withoutHash
  }
}

// Runs to the next whitespace because a query string can contain parentheses and apostrophes.
const TEXT_URL_PATTERN = /https?:\/\/[^\s"<>`]+/giu
// Stack frames append `:line:column` to the script URL, and Chrome wraps the location in parentheses.
const LOCATION_SUFFIX_PATTERN = /:\d+:\d+\)?$/u
// Text such as `?next=https://...` holds a URL inside another URL's match.
const EMBEDDED_URL_BOUNDARY_PATTERN = /(?=https?:\/\/)/iu
// A V8 frame line starts with `at`; Firefox and Safari frames put `@` right before the URL.
const V8_FRAME_LINE_PATTERN = /^\s*at\s/u

// The location is kept only on a stack-frame line, so digits that end a query value elsewhere,
// such as in a message, are not restored after the query is removed.
function urlTextSuffix(match: string, isFrame: boolean): string {
  const location = isFrame ? LOCATION_SUFFIX_PATTERN.exec(match)?.[0] : undefined
  return location ?? closingPunctuation(match)
}

// Closing parentheses and quotes around a URL in prose are kept as punctuation. Scanned backwards
// rather than with an unanchored regex, which retries a long run from every position.
function closingPunctuation(match: string): string {
  let start = match.length
  while (start > 0 && (match[start - 1] === ')' || match[start - 1] === "'")) {
    start--
  }
  return match.slice(start)
}

// Each embedded URL is tested on its own, so a pattern anchored to the start of a private URL still
// matches it. Removing the outer query and fragment also removes the embedded URL they carry.
function redactTextUrl(url: string, patterns: readonly RegExp[], baseUrl: string): string {
  const matches =
    matchesUrlPatterns(url, patterns) || url.split(EMBEDDED_URL_BOUNDARY_PATTERN).some((embedded) => matchesUrlPatterns(embedded, patterns))
  return matches ? stripQueryAndFragment(url, baseUrl) : url
}

/** Redact each HTTP URL inside free text, such as a stack trace, that matches `patterns`. */
export function redactUrlsInText(
  text: string,
  patterns: readonly RegExp[],
  baseUrl: string,
  // Only text known to be a stack trace keeps `:line:column` after a frame URL. Elsewhere, such as in
  // console arguments, a line that merely looks like a frame must not restore digits from a query.
  { stackTrace = false }: { stackTrace?: boolean } = {}
): string {
  if (patterns.length === 0) {
    return text
  }
  // Line by line, so deciding whether a URL sits in a stack frame never rescans earlier text.
  return text
    .split('\n')
    .map((line) => {
      const isV8Frame = stackTrace && V8_FRAME_LINE_PATTERN.test(line)
      return line.replace(TEXT_URL_PATTERN, (match: string, offset: number) => {
        const suffix = urlTextSuffix(match, isV8Frame || (stackTrace && line[offset - 1] === '@'))
        return `${redactTextUrl(match.slice(0, match.length - suffix.length), patterns, baseUrl)}${suffix}`
      })
    })
    .join('\n')
}

/** Apply `redact` to each image candidate URL in a `srcset` value, keeping the descriptors. */
export function redactSrcset(value: string, redact: (url: string) => string): string {
  // Follows the HTML srcset grammar: a URL runs to whitespace, trailing commas end its candidate, and
  // otherwise descriptors run to the next comma. A comma inside a URL therefore stays in that URL.
  let result = ''
  let position = 0
  while (position < value.length) {
    const separatorStart = position
    while (position < value.length && /[\s,]/u.test(value[position] ?? '')) {
      position++
    }
    result += value.slice(separatorStart, position)
    if (position >= value.length) {
      break
    }
    const urlStart = position
    while (position < value.length && !/\s/u.test(value[position] ?? '')) {
      position++
    }
    let urlEnd = position
    while (urlEnd > urlStart && value[urlEnd - 1] === ',') {
      urlEnd--
    }
    result += redact(value.slice(urlStart, urlEnd)) + value.slice(urlEnd, position)
    if (urlEnd < position) {
      continue
    }
    const descriptorStart = position
    while (position < value.length && value[position] !== ',') {
      position++
    }
    result += value.slice(descriptorStart, position)
  }
  return result
}

const CSS_ESCAPE_PATTERN = /\\(?:([0-9a-f]{1,6})[ \t\n]?|([\s\S]))/giu
const CSS_URL_SPECIAL_CHARACTER_PATTERN = /[\\"'()\s]/gu

/** Apply `redact` to each `url()` in CSS text, such as an inline `style` attribute. */
export function redactCssUrls(value: string, redact: (url: string) => string): string {
  // A single forward scan rather than a regex, because text with an unclosed `url(` made a
  // backtracking pattern take seconds on a page's main thread.
  // Searched in the original text, because lowercasing can change its length and shift offsets.
  const urlFunction = /url\(/giu
  let result = ''
  let copied = 0
  let match = urlFunction.exec(value)
  while (match !== null) {
    const position = match.index
    const token = scanCssUrl(value, position + match[0].length)
    if (token.url.length > 0) {
      const redacted = escapeCssUrl(redact(unescapeCss(token.url)))
      result += `${value.slice(copied, position)}url(${token.quote}${redacted}${token.quote}${token.closed ? ')' : ''}`
      copied = token.end
    }
    urlFunction.lastIndex = Math.max(token.end, position + 1)
    match = urlFunction.exec(value)
  }
  return copied === 0 ? value : result + value.slice(copied)
}

interface CssUrlToken {
  closed: boolean
  end: number
  quote: string
  url: string
}

// Follows the CSS tokenizer: a backslash escapes the next character, and a URL or string that
// reaches the end of the text still counts, because the browser loads it.
function scanCssUrl(value: string, start: number): CssUrlToken {
  let position = start
  while (position < value.length && /\s/u.test(value[position] ?? '')) {
    position++
  }
  const quote = value[position] === '"' || value[position] === "'" ? (value[position] ?? '') : ''
  if (quote !== '') {
    position++
  }
  const urlStart = position
  while (position < value.length) {
    const character = value[position]
    if (character === '\\') {
      position += 2
    } else if (quote === '' ? character === ')' : character === quote) {
      break
    } else {
      position++
    }
  }
  const urlEnd = Math.min(position, value.length)
  const url = quote === '' ? value.slice(urlStart, urlEnd).trimEnd() : value.slice(urlStart, urlEnd)
  if (quote !== '' && position < value.length) {
    position++
    while (position < value.length && /\s/u.test(value[position] ?? '')) {
      position++
    }
  }
  const closed = value[position] === ')'
  return { closed, end: closed ? position + 1 : Math.min(position, value.length), quote, url }
}

function unescapeCss(value: string): string {
  return value.replace(CSS_ESCAPE_PATTERN, (_match, hex: string | undefined, character: string | undefined) => {
    if (hex === undefined) {
      return character === '\n' ? '' : (character ?? '')
    }
    const codePoint = Number.parseInt(hex, 16)
    return codePoint === 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)
      ? '\ufffd'
      : String.fromCodePoint(codePoint)
  })
}

function escapeCssUrl(value: string): string {
  return value.replace(CSS_URL_SPECIAL_CHARACTER_PATTERN, (character) =>
    /\s/u.test(character) ? `\\${character.codePointAt(0)?.toString(16) ?? '20'} ` : `\\${character}`
  )
}

/**
 * Cut `text` to at most `maxLength` UTF-16 code units and return the kept text with the number of
 * code units dropped.
 */
export function cutText(text: string, maxLength: number): [kept: string, dropped: number] {
  if (text.length <= maxLength) {
    return [text, 0]
  }
  // Cutting between the halves of a surrogate pair leaves a lone surrogate, which has no UTF-8
  // encoding once the text is sent. Drop the whole character instead.
  const lastCode = text.charCodeAt(maxLength - 1)
  const end = lastCode >= 0xd800 && lastCode <= 0xdbff ? maxLength - 1 : maxLength
  return [text.slice(0, end), text.length - end]
}

export function truncationSuffix(dropped: number): string {
  return dropped === 0 ? '' : `...(+${String(dropped)} chars)`
}

export function truncateText(text: string, maxLength: number): string {
  const [kept, dropped] = cutText(text, maxLength)
  return `${kept}${truncationSuffix(dropped)}`
}
