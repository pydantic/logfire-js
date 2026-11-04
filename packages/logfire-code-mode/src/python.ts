// Python's rules for the pieces of a stub that are copied from schema values, so that the output matches what
// pydantic-ai renders for the same JSON.

// `keyword.kwlist`. Soft keywords such as `match` and `type` are valid identifiers.
const KEYWORDS: ReadonlySet<string> = new Set([
  'False',
  'None',
  'True',
  'and',
  'as',
  'assert',
  'async',
  'await',
  'break',
  'class',
  'continue',
  'def',
  'del',
  'elif',
  'else',
  'except',
  'finally',
  'for',
  'from',
  'global',
  'if',
  'import',
  'in',
  'is',
  'lambda',
  'nonlocal',
  'not',
  'or',
  'pass',
  'raise',
  'return',
  'try',
  'while',
  'with',
  'yield',
])

export function pyIsKeyword(name: string): boolean {
  return KEYWORDS.has(name)
}

/** `str.isidentifier()`. Keywords count as identifiers, as in Python. */
export function pyIsIdentifier(name: string): boolean {
  return /^[\p{XID_Start}_]\p{XID_Continue}*$/u.test(name)
}

/** `repr()` of a value parsed from JSON. */
export function pyRepr(value: unknown): string {
  if (value === null || value === undefined) {
    return 'None'
  }
  if (typeof value === 'boolean') {
    return value ? 'True' : 'False'
  }
  if (typeof value === 'number') {
    return reprNumber(value)
  }
  if (typeof value === 'string') {
    return reprString(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map(pyRepr).join(', ')}]`
  }
  if (typeof value === 'object') {
    return `{${Object.entries(value)
      .map(([k, v]) => `${reprString(k)}: ${pyRepr(v)}`)
      .join(', ')}}`
  }
  // JSON has no other values. A bigint is the one non-JSON type that still has a Python form.
  return typeof value === 'bigint' ? value.toString() : 'None'
}

// JSON written by JS has no `.0` on whole numbers, so Python reads them as int. Anything else is a float,
// whose repr uses the same shortest digits as JS but switches to exponent form at different points.
function reprNumber(n: number): string {
  const json = JSON.stringify(n)
  if (/^-?\d+$/u.test(json)) {
    return json
  }
  const [mantissa = '', exponentText = '0'] = n.toExponential().split('e')
  const exponent = Number(exponentText)
  const negative = mantissa.startsWith('-')
  const digits = mantissa.replace(/[-.]/gu, '')
  const sign = negative ? '-' : ''
  if (exponent < -4 || exponent >= 16) {
    const fraction = digits.length > 1 ? `.${digits.slice(1)}` : ''
    const expSign = exponent < 0 ? '-' : '+'
    return `${sign}${digits[0] ?? ''}${fraction}e${expSign}${String(Math.abs(exponent)).padStart(2, '0')}`
  }
  if (exponent < 0) {
    return `${sign}0.${'0'.repeat(-exponent - 1)}${digits}`
  }
  const whole = digits.slice(0, exponent + 1).padEnd(exponent + 1, '0')
  const fraction = digits.slice(exponent + 1)
  return `${sign}${whole}.${fraction || '0'}`
}

const NON_PRINTABLE = /[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Cn}\p{Zl}\p{Zp}\p{Zs}]/u

function reprString(s: string): string {
  const quote = s.includes("'") && !s.includes('"') ? '"' : "'"
  let out = quote
  for (const char of s) {
    if (char === quote || char === '\\') {
      out += `\\${char}`
    } else if (char === '\t') {
      out += '\\t'
    } else if (char === '\n') {
      out += '\\n'
    } else if (char === '\r') {
      out += '\\r'
    } else if (char !== ' ' && NON_PRINTABLE.test(char)) {
      const code = char.codePointAt(0) ?? 0
      out +=
        code < 0x100
          ? `\\x${code.toString(16).padStart(2, '0')}`
          : code < 0x10000
            ? `\\u${code.toString(16).padStart(4, '0')}`
            : `\\U${code.toString(16).padStart(8, '0')}`
    } else {
      out += char
    }
  }
  return out + quote
}
