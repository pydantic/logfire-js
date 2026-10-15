---
'@pydantic/logfire-node': patch
---

Stop sending duplicate pending spans for spans that finish before their export batch goes out. The OTLP exporter now drops a pending span when its final span is in the same batch, matching the Python SDK. Short spans no longer count twice toward ingestion.
