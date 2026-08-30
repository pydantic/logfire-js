---
'logfire': patch
---

Report a non-JSON device-auth response instead of crashing with a parse error. A proxy or captive portal answering `200` with an HTML page made `logfire auth` fail with `SyntaxError: Unexpected token '<'`. `requestDeviceCode` now says the response was not JSON, and the poll treats an unparseable body the same way it already treats a rejected request, by retrying and giving up on the fourth failure.
