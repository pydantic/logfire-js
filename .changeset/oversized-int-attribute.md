---
'logfire': patch
---

Send an integer attribute outside signed 64-bit range as its exact decimal string. Every integral number is encoded as an OTLP `intValue`, so a larger one claimed a width the field does not have. Python's `prepare_otlp_attribute` converts the same values to strings.
