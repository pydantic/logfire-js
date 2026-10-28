---
'@pydantic/logfire-session-replay': minor
'@pydantic/logfire-browser': minor
---

Give session replay more control over the URLs and page text it records.

The new `transformUrl` option rewrites each replay page, navigation, network, and DOM attribute URL after query and fragment removal, so applications can replace tokens or email addresses in paths. The rewritten URLs are also the ones replay search shows. `@pydantic/logfire-browser` forwards the option from `sessionReplay`.

URL redaction now also covers the `srcset`, `imagesrcset`, `poster`, `data`, `xlink:href`, `background`, and `cite` attributes and `url()` in inline styles. URLs with an opaque scheme, such as `mailto:`, `tel:`, `data:`, and `blob:`, now keep only the scheme instead of their content.

`maskAllInputs` now masks hidden input values. `maskAllText` now masks the text-bearing attributes `title`, `alt`, `aria-label`, `placeholder`, and similar, button labels set through `value`, and `data-*` attributes, except common UI state and theme attributes such as `data-state` and `data-theme` and the values `true` and `false`. Replay error messages and stacks are limited to 1,024 and 8,192 characters.
