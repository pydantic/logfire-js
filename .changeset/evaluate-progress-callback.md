---
'logfire': patch
---

Stop a throwing `progress` callback from discarding an entire `Dataset.evaluate()` run. The callback ran unguarded inside the `Promise.all` over cases, so one throw rejected `evaluate()` and lost the results of every case that had already finished, along with the report evaluators, analyses, averages and the experiment span's closing attributes. An async callback was worse: its rejection escaped as an unhandled rejection, which terminates the process under Node's default. Progress reporting is now best effort for both, and logs the failure instead.
