---
'logfire': patch
---

Match structured attributes in span queries. `hasAttributes` compared the span attribute with `===`, so a query for an object or an array never matched: OTel carries an object as the JSON string `serializeAttributes` wrote, and an array as a real array, and neither is `===` a fresh query value. `HasMatchingSpan` and `SpanTree.any`/`find`/`first` now compare structurally and decode a JSON string attribute first, the way pydantic-evals does.
