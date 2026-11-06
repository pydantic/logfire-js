/**
 * Converts a Logfire HTTP(S) base URL into the agent sandboxes server URL.
 *
 * The client opens its gRPC session stream at the root of this URL, so the URL keeps no path.
 */
export function agentSandboxesUrl(baseUrl: string): string {
  return baseUrl.replace(/\/+$/u, '')
}
