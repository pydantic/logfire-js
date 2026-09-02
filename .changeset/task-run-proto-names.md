---
'logfire': patch
---

Keep a task-run attribute or metric whose name is an `Object.prototype` member. Metric names are sliced off span attribute keys in `extractMetrics`, so a provider's usage payload chooses them. A name of `__proto__` was dropped entirely, and one like `toString` read the inherited function back, turning the metric into a string and reporting a non-numeric mean in the averages block.
