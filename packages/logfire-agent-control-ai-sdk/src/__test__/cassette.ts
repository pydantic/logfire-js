/**
 * A `fetch` that records a real provider round trip once and replays it forever after.
 *
 * The live tests exist because every "the provider honours this" claim in the README was read off
 * source rather than observed. Settling one needs a real request to a real model -- and CI has no
 * credentials and no business making one, so the request is recorded to a file and replayed from it.
 *
 * # Why this rather than a recording library
 *
 * The repository has no HTTP recorder today, and the two candidates for adding one both intercept
 * globally: `nock` patches Node's http stack and `msw` installs a service worker equivalent. Every
 * `@ai-sdk/*` provider factory takes a `fetch` of its own, which is a seam the provider already
 * supports and which no other test in the process can be affected by -- so the recorder is that
 * function, in about a hundred lines, with no dependency and nothing global. Vitest needs no
 * configuration for it, which is the same standard the core landed under: match the repository as it
 * stands rather than introduce tooling for one package.
 *
 * # Recording
 *
 * ```
 * node scripts/record-live-cassettes.mjs --env-file <path to a .env with provider keys>
 * ```
 *
 * Recording rewrites every cassette in `cassettes/`. Without `LOGFIRE_CASSETTE_MODE=record` the
 * tests replay, need no credentials, and make no network call -- an unmatched request throws rather
 * than falling through to the network.
 *
 * # What is stored
 *
 * Request headers are *allow-listed* to `content-type`, rather than scrubbed by a list of the auth
 * headers we happen to know about: `authorization`, `x-api-key`, `api-key`, and `x-goog-api-key` are
 * four spellings across four providers and the fifth provider's is the one that would leak. The URL
 * is normalized the same way at record and replay time, so a key passed as a query parameter is
 * dropped from both and still matches.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CASSETTES = join(dirname(fileURLToPath(import.meta.url)), 'cassettes')

/** Whether this run talks to real providers and rewrites the cassettes. */
export const RECORDING: boolean = process.env['LOGFIRE_CASSETTE_MODE'] === 'record'

/** The API key to give a provider factory, which is a placeholder unless we are recording. */
export function apiKey(variable: string): string {
  const key = process.env[variable]
  if (!RECORDING) {
    return 'cassette-replay'
  }
  if (key === undefined || key === '') {
    throw new Error(`Recording needs ${variable} in the environment; pass an --env-file that defines it.`)
  }
  return key
}

/** One request and the response it got, as stored. */
interface Interaction {
  method: string
  url: string
  /** The request body, as sent. Parsed JSON where it was JSON, so a cassette diff is readable. */
  request: unknown
  status: number
  /** The response body: parsed JSON, or the raw text for a stream. */
  response: unknown
  /** Set for a streamed response, whose body is text this has to hand back verbatim. */
  stream?: boolean
}

/** A recorded conversation with one provider, and the requests it captured. */
export interface Cassette {
  /** The `fetch` to hand a provider factory. */
  fetch: typeof fetch
  /** The request bodies, in order, so a test can assert on what the provider was actually sent. */
  requests: () => unknown[]
}

/**
 * The URL a request is stored and looked up under.
 *
 * Query parameters that carry a credential are dropped, at both record and replay time, so the two
 * still match. `alt=sse` and the like are kept, because they are what tells a streamed request from
 * a non-streamed one at the same path.
 */
function normalizeUrl(input: string): string {
  const url = new URL(input)
  for (const name of [...url.searchParams.keys()]) {
    if (/key|token|secret/iu.test(name)) {
      url.searchParams.delete(name)
    }
  }
  return url.toString()
}

function parseBody(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return text
  }
}

async function requestBody(input: RequestInfo | URL, init: RequestInit | undefined): Promise<string> {
  if (init?.body !== undefined && init.body !== null) {
    return typeof init.body === 'string' ? init.body : await new Response(init.body).text()
  }
  return input instanceof Request ? await input.clone().text() : ''
}

/**
 * The cassette named `name`, as a `fetch` plus the request bodies it saw.
 *
 * Replay is ordinal: the n-th request of a test is answered by the n-th interaction of its cassette,
 * and a mismatched method or URL fails rather than answering with the wrong turn's response. That is
 * strict on purpose -- these tests exist to prove what reaches a provider, and a recorder that
 * quietly matched a different request would prove nothing.
 */
export function cassette(name: string): Cassette {
  const path = join(CASSETTES, `${name}.json`)
  const recorded: Interaction[] = RECORDING ? [] : (JSON.parse(readFileSync(path, 'utf8')) as { interactions: Interaction[] }).interactions
  const seen: unknown[] = []
  let index = 0

  const impl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = normalizeUrl(input instanceof Request ? input.url : String(input))
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase()
    const body = await requestBody(input, init)
    seen.push(parseBody(body))

    if (RECORDING) {
      const response = await fetch(input, init)
      const text = await response.text()
      const stream = (response.headers.get('content-type') ?? '').includes('event-stream')
      recorded.push({
        method,
        url,
        request: parseBody(body),
        status: response.status,
        response: stream ? text : parseBody(text),
        ...(stream ? { stream: true } : {}),
      })
      mkdirSync(CASSETTES, { recursive: true })
      writeFileSync(path, `${JSON.stringify({ interactions: recorded }, null, 2)}\n`)
      return new Response(text, {
        status: response.status,
        headers: { 'content-type': response.headers.get('content-type') ?? 'application/json' },
      })
    }

    const interaction = recorded[index]
    index += 1
    if (interaction === undefined) {
      throw new Error(`Cassette '${name}' has no interaction ${String(index)}; re-record it.`)
    }
    if (interaction.method !== method || interaction.url !== url) {
      throw new Error(
        `Cassette '${name}' interaction ${String(index)} recorded ${interaction.method} ${interaction.url}, ` +
          `but this run sent ${method} ${url}; re-record it.`
      )
    }
    const text = interaction.stream === true ? String(interaction.response) : JSON.stringify(interaction.response)
    return new Response(text, {
      status: interaction.status,
      headers: { 'content-type': interaction.stream === true ? 'text/event-stream' : 'application/json' },
    })
  }

  return { fetch: impl as typeof fetch, requests: () => seen }
}
