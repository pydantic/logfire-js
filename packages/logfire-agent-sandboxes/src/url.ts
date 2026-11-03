/** Converts a Logfire HTTP(S) base URL into the agent sandboxes WebSocket URL. */
export function agentSandboxesUrl(baseUrl: string): string {
  const url = new URL(baseUrl)
  if (url.protocol === 'https:') {
    url.protocol = 'wss:'
  } else if (url.protocol === 'http:') {
    url.protocol = 'ws:'
  }
  url.pathname = `${url.pathname.replace(/\/+$/u, '')}/monty-ws/`
  return url.toString()
}
