---
'logfire': patch
---

Require zod 4.6.6 or later. Earlier versions validate every element of an oversized constrained collection before checking its bounds, so a large input can exhaust memory ([GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)).
