---
'logfire': patch
---

Compare the contents of Dates, RegExps, Sets and Maps in the `Equals` and `EqualsExpected` evaluators. `deepEqual` only compared own enumerable keys, and those types keep their contents in internal slots, so any two of them matched each other and a wrong `Date` passed as equal to the expected one.
