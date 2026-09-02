---
'logfire': patch
---

Record a `CaseLifecycle` constructor error as a case failure instead of rejecting the whole experiment. The lifecycle was instantiated before the case span and outside the try that turns a case error into a `ReportCaseFailure`, so one throwing constructor made `Dataset.evaluate` reject and every completed case's results were lost.
