---
'logfire': patch
---

Keep scrubbing off the Agent Control config hint. The `agent_control_config_hint` span's `baseline`, `variable_name`, `agent_name`, `service_name`, `environment` and `service_version` attributes are now safe keys, so an instruction block reading "Order tools are authoritative for status and refunds" is reported as written rather than as `[Scrubbed due to 'auth']`. The baseline is the document a managed config is created from, and `agent_control.baseline_sha256` and `agent_control.baseline_bytes` are taken over it before it is exported, so a redaction inside it corrupted the document and broke both; an agent named `auth_router` reported a `variable_name` that named no variable at all.
