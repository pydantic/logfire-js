---
'@pydantic/logfire-browser': minor
---

Stop losing the older spans of a page that unloads soon after it loads. The document-hide flush sends the newest spans first in a small keepalive request, and it now starts the request for the older spans in the same task. Before, it waited for the first response, which an unloading page never receives, so the older spans were never sent. On a page that redirects at once, such as a redirect to a login page, that dropped almost every span except the newest. The flush now needs two free export slots, so an exporter with `concurrencyLimit: 1` rejects the second request.

Add `forceFlush()`, which exports the buffered spans of the active configuration at once. Call it after a record that must arrive even if the page unloads soon after, such as the start of a page-load measurement.
