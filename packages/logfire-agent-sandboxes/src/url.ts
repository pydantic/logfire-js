/**
 * Validates explicit and derived Agent Sandboxes URLs for `agentSandboxes`.
 *
 * The client opens its gRPC session stream at the root of this URL, so the URL keeps no path.
 */
export function agentSandboxesUrl(baseUrl: string): string {
  const url = baseUrl.replace(/\/+$/u, '')
  if (!URL.canParse(url) || !/^https?:\/\/[^/\\?#\s]+$/iu.test(url)) {
    throw new Error(
      'Agent Sandboxes URL must use http://<host> or https://<host> with no path, query or fragment. ' +
        'Remove the old /monty-ws/ path from `url` or LOGFIRE_BASE_URL.'
    )
  }
  return url
}
