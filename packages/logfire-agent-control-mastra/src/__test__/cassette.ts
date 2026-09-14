/**
 * Record-and-replay for the provider requests the live tests make.
 *
 * The rest of this suite drives Mastra against mock models, which proves what this adapter hands the
 * framework. It cannot prove what a provider does with it: whether a rewritten instruction changes
 * the answer, whether a renamed tool is the name a real model calls back with, whether a setting the
 * table claims is editable is one the provider accepts. Those are questions only a real request
 * answers, and a recording is how the answer stays answered in CI.
 *
 * ## Why this rather than a recording library
 *
 * `nock` records the response as the bytes that came off the socket, which for every provider here
 * means a gzip stream stored as hex. A cassette nobody can read is a cassette nobody can check for a
 * leaked key, and the request body is the assertion material in half of these tests. So the seam is
 * `globalThis.fetch` -- which is what every AI SDK provider calls, whatever transport it wraps -- and
 * a cassette is decoded JSON, greppable and diffable.
 *
 * ## What is stored, and what is not
 *
 * Request headers are never written: that is where `authorization`, `x-api-key` and `api-key` live,
 * and the way to keep them out of a file is not to have a list of them. The URL keeps its path and
 * loses any credential-bearing query parameter, because Google's client puts the key there. Response
 * headers are narrowed to `content-type`, which is the only one replay needs and which leaves
 * `set-cookie` and the per-organization headers out.
 *
 * ## Recording
 *
 * ```bash
 * RECORD_CASSETTES=1 node --env-file=.env node_modules/.bin/vp test -- -t "against a real provider"
 * ```
 *
 * A cassette is replayed in order: request `n` of the test gets response `n` of the file, and a
 * request whose method or URL is not the recorded one fails the test rather than reaching the
 * network, so a change that alters the calls an agent makes shows up as drift instead of a bill.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { getProviderConfig } from '@mastra/core/llm'
import { onTestFinished } from 'vite-plus/test'

/** Where the cassettes live, resolved from this file so the cwd a runner picks cannot matter. */
const CASSETTE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'cassettes')

/** Query parameters that carry a credential, which are dropped from a recorded URL. */
const CREDENTIAL_PARAMS = ['key', 'api_key', 'access_token']

/** One request as it is recorded, which is also what a test reads to assert what went out. */
export interface RecordedRequest {
  method: string
  url: string
  /** The parsed JSON body, or `null` for a request that sent none. */
  body: unknown
}

/** One response as it is recorded. `body` is parsed JSON for a JSON response and text otherwise. */
interface RecordedResponse {
  status: number
  contentType: string
  body: unknown
}

interface Interaction {
  request: RecordedRequest
  response: RecordedResponse
}

/** What a live test holds on to: the requests it actually made, in order. */
export interface Wire {
  /** Every request the run sent, whether it was recorded now or replayed from the file. */
  readonly requests: readonly RecordedRequest[]
  /** The body of request `index`, as the object the provider was sent. */
  request: (index: number) => Record<string, unknown>
}

/** Whether this run is recording against the real providers rather than replaying. */
function recording(): boolean {
  return process.env['RECORD_CASSETTES'] !== undefined && process.env['RECORD_CASSETTES'] !== ''
}

/**
 * Install a cassette for the current test, and take it out again when the test finishes.
 *
 * Replaying is the default and needs no credentials; `RECORD_CASSETTES=1` passes the requests
 * through to the real provider and writes what came back.
 *
 * `provider` is the Mastra registry name of the provider the test drives, and it is needed because
 * the router resolves its credential *before* it builds a request: with no key in the environment it
 * throws rather than calling `fetch`, and there would be nothing for a cassette to answer. So in
 * replay a placeholder is put in the environment for the duration of the test -- only where the
 * variable is unset, and never in record mode, where the real one is what a recording needs.
 */
export function useCassette(name: string, provider: string): Wire {
  const path = join(CASSETTE_DIR, `${name}.json`)
  if (!recording()) {
    stubCredentials(provider)
  }
  const requests: RecordedRequest[] = []
  const recorded: Interaction[] = []
  const stored = recording() ? [] : (JSON.parse(readFileSync(path, 'utf8')) as Interaction[])
  const original = globalThis.fetch

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input as RequestInfo, init)
    const body = await readJson(request.clone())
    const index = requests.length
    requests.push({ method: request.method, url: scrubUrl(request.url), body })
    if (!recording()) {
      return replay(name, stored, index, requests[index] as RecordedRequest)
    }
    const response = await original(request)
    const text = await response.clone().text()
    const contentType = response.headers.get('content-type') ?? 'application/json'
    recorded.push({
      request: requests[index] as RecordedRequest,
      response: { status: response.status, contentType, body: parse(text, contentType) },
    })
    return response
  }

  onTestFinished(() => {
    globalThis.fetch = original
    if (recording()) {
      mkdirSync(CASSETTE_DIR, { recursive: true })
      writeFileSync(path, `${JSON.stringify(recorded, null, 2)}\n`)
    } else if (requests.length !== stored.length) {
      throw new Error(
        `Cassette '${name}' holds ${String(stored.length)} interactions but the test made ` +
          `${String(requests.length)} requests; re-record it with RECORD_CASSETTES=1.`
      )
    }
  })

  return {
    requests,
    request: (index: number): Record<string, unknown> => requests[index]?.body as Record<string, unknown>,
  }
}

/** The stored response for request `index`, or an explanation of how the request drifted. */
function replay(name: string, stored: readonly Interaction[], index: number, request: RecordedRequest): Response {
  const interaction = stored[index]
  if (interaction === undefined) {
    throw new Error(
      `Cassette '${name}' has no interaction ${String(index)}; the test made more requests than were ` +
        'recorded. Re-record it with RECORD_CASSETTES=1.'
    )
  }
  if (interaction.request.method !== request.method || interaction.request.url !== request.url) {
    throw new Error(
      `Cassette '${name}' interaction ${String(index)} recorded ${interaction.request.method} ` +
        `${interaction.request.url}, but the test sent ${request.method} ${request.url}.`
    )
  }
  const { status, contentType, body } = interaction.response
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  return new Response(text, { status, headers: { 'content-type': contentType } })
}

/** A request's body as JSON, or `null` where it sent none. Every provider here posts JSON. */
async function readJson(request: Request): Promise<unknown> {
  const text = await request.text()
  return text === '' ? null : (JSON.parse(text) as unknown)
}

/** A response body as the value to store: parsed for JSON, the text itself for anything else. */
function parse(text: string, contentType: string): unknown {
  return contentType.includes('json') ? (JSON.parse(text) as unknown) : text
}

/** A URL with any credential-bearing query parameter removed. */
function scrubUrl(url: string): string {
  const parsed = new URL(url)
  for (const param of CREDENTIAL_PARAMS) {
    parsed.searchParams.delete(param)
  }
  return parsed.toString()
}

/**
 * Put a placeholder in the environment for a provider's key, for the duration of the test.
 *
 * A variable that already holds something is left alone: replay never reaches the network, so a
 * developer's real key is neither needed nor used, and overwriting it would only make the two runs
 * differ for no reason.
 */
function stubCredentials(provider: string): void {
  const configured = getProviderConfig(provider)?.apiKeyEnvVar
  const names = typeof configured === 'string' ? [configured] : (configured ?? [])
  const restore: (() => void)[] = []
  for (const name of names) {
    if (process.env[name] !== undefined) {
      continue
    }
    process.env[name] = 'cassette-replay-placeholder'
    restore.push(() => {
      Reflect.deleteProperty(process.env, name)
    })
  }
  onTestFinished(() => {
    for (const undo of restore) {
      undo()
    }
  })
}
