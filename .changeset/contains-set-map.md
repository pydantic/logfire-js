---
'logfire': patch
---

Check Set members and Map keys in the `Contains` evaluator. A task returning a `Set` or `Map` produced a failing assertion whose reason read `Output {}`, because both fell through to the object branch and were checked for property names.
