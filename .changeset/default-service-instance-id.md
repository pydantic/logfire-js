---
'@pydantic/logfire-node': patch
---

Generate a default `service.instance.id` resource attribute, matching Python Logfire's `fallback_resource_attributes`. The value is a random UUID as 32 lowercase hex characters, stays stable for the lifetime of one `configure()` call, and is shared by traces, metrics, and logs. It is applied at the lowest precedence, so both the `resourceAttributes` option and `OTEL_RESOURCE_ATTRIBUTES` still override it.
