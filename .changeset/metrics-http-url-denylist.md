---
'@pydantic/logfire-browser': patch
---

Keep `http.url` out of Web Vital metric attributes. The low-cardinality guard already dropped `url.full`, but not `http.url`, which is the pre-stable name for the same value and still what the fetch and XHR instrumentations emit, so an attribute callback returning it put a full URL including any query string onto a metric label.
