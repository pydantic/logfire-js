---
'logfire': patch
---

Send a number OTLP cannot represent as a string: a non-finite number nested inside an attribute (it previously reached the wire as `null`, indistinguishable from an actual null; a top-level one was already sent as a string), and a top-level integer outside signed 64-bit range (it previously claimed an OTLP `intValue` width the field does not have). Both match Python's `prepare_otlp_attribute`; an oversized integer is printed in its exact decimal form and warns once per process.
