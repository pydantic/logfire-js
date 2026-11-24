---
'@pydantic/logfire-session-replay': minor
---

Mask image URLs in stylesheets when `maskAllImages` is on. Before, a replay recorded with the privacy defaults kept every `background-image: url(...)` and other image URL from `<style>` elements, inlined linked stylesheets, and CSSOM changes, so a recording could still hold avatar or signed-object URLs. The recorder now replaces each `url()` value, and each string in `image-set()` and `src()`, with the gray placeholder that masked images use, and keeps the rest of the rule. This covers full snapshots, added nodes, text and attribute mutations, `insertRule()`, `replace()`, `replaceSync()`, `style.setProperty()`, and adopted stylesheets. Stylesheets keep `@font-face` sources, `@import` and `@namespace` URLs, and `data:` URLs. A reference to an element of the page, such as `url(#blur)`, is recorded as `#blur`.

**Behavior change:** with the default `maskAllText: true`, CSS background images and other stylesheet images now show as gray placeholders in replays. Set `maskAllImages: false` to record them again.
