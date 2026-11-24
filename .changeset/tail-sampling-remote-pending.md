---
'logfire': patch
---

Send pending spans under tail sampling for every span whose trace is not buffered. Tail sampling does not buffer a trace continued from a remote parent, such as a request carrying `traceparent` from a browser or another service. It passed the spans of such a trace to the exporter but not to its pending-span processor, so a long request and the spans inside it did not show in the Logfire live view until they ended. They now get their pending spans when they start, as spans of a kept trace do. A span that starts after its kept trace's root ended now gets one too.
