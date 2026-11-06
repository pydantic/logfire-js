---
'logfire': patch
---

Stop a throwing tail sampling callback from failing the application code that started or ended the span. The error goes to `diag.error` and that span makes no sampling decision.
