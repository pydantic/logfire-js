---
'@pydantic/logfire-session-replay': minor
'@pydantic/logfire-browser': minor
---

Mask images in session replays by default, so a replay no longer records the URLs of the images a user saw, and playback no longer loads those images from their original hosts. The new `maskAllImages` option follows `maskAllText` unless it is set explicitly. Before upload, the recorder replaces image sources with a gray placeholder in full snapshots and DOM changes: `img` and `input type="image"` sources, `srcset`, `<picture>` sources, SVG `<image>` links, video posters, `background` attributes, and image preload links. A masked image has the natural size of the image it replaces, including one that loads after it was recorded, so playback lays it out as the page did. Inline styles that could reference a URL, such as CSS backgrounds, are removed even with `redactUrlPatterns: []`. Stylesheets, video and audio sources, `<object>`, and `<embed>` are not covered.

**Behavior change:** with the default `maskAllText: true`, replays now show placeholders where images were. To record image URLs again while text stays masked, set `maskAllImages: false`. Recordings made with `maskAllText: false` are unchanged unless `maskAllImages: true` is set.
