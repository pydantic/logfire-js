---
'logfire': patch
---

Warn when a Logfire token names a region this version does not recognise. The region was silently ignored and the US endpoint used, so a token minted for a newer region shipped its data to the wrong place with no signal. Tokens with a known region, tokens minted before regions existed, and values that are not Logfire tokens are unaffected.
