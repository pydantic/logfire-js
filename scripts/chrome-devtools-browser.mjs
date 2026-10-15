import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const require = createRequire(import.meta.url)
const POLL_INTERVAL_MS = 250
const DEFAULT_TIMEOUT_MS = 60_000

/**
 * Starts one headless Chrome through the pinned Chrome DevTools MCP server.
 * Each page opens in its own named browser context, so pages share no cookies
 * or storage. The profile is temporary, and usage statistics and CrUX lookups
 * are off, so no URL leaves the machine.
 */
export async function startChromeDevTools() {
  const server = join(dirname(require.resolve('chrome-devtools-mcp/package.json')), 'build/src/bin/chrome-devtools-mcp.js')
  const transport = new StdioClientTransport({
    args: [server, '--headless', '--isolated', '--no-usage-statistics', '--no-performance-crux'],
    command: process.execPath,
    stderr: 'pipe',
  })
  let serverOutput = ''
  transport.stderr?.on('data', (chunk) => {
    serverOutput = (serverOutput + chunk.toString()).slice(-4_000)
  })
  const client = new Client({ name: 'logfire-browser-release-artifacts', version: '1.0.0' })
  await client.connect(transport)

  async function call(tool, arguments_) {
    const result = await client.callTool({ arguments: arguments_, name: tool })
    const text = result.content
      .filter((item) => item.type === 'text')
      .map((item) => item.text)
      .join('\n')
    if (result.isError === true) {
      throw new Error(`chrome-devtools-mcp ${tool} failed: ${text}\n${serverOutput}`)
    }
    return text
  }

  return {
    async close() {
      await client.close()
    },

    async openPage(context, url) {
      const pages = await call('new_page', { isolatedContext: context, timeout: DEFAULT_TIMEOUT_MS, url })
      const line = pages.split('\n').find((candidate) => candidate.endsWith(` isolatedContext=${context}`))
      const pageId = Number(/^(\d+):/u.exec(line ?? '')?.[1])
      if (!Number.isInteger(pageId)) {
        throw new Error(`chrome-devtools-mcp did not list the page for ${context}:\n${pages}`)
      }

      async function evaluate(fn) {
        const output = await call('evaluate_script', { function: fn, pageId, waitForStableDom: false })
        const json = /```json\n([\s\S]*)\n```/u.exec(output)?.[1]
        // A function that returns nothing is reported as the text `undefined`.
        return json === undefined || json === 'undefined' ? undefined : JSON.parse(json)
      }

      return {
        async close() {
          await call('close_page', { pageId })
        },
        evaluate,
        // Polls instead of using wait_for, which only waits for page text.
        async waitFor(expression, timeoutMs = DEFAULT_TIMEOUT_MS) {
          const deadline = Date.now() + timeoutMs
          while ((await evaluate(`() => Boolean(${expression})`)) !== true) {
            if (Date.now() > deadline) {
              throw new Error(`timed out after ${String(timeoutMs)}ms waiting for ${expression} in ${context}`)
            }
            await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
          }
        },
      }
    },
  }
}
