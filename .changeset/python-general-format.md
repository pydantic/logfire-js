---
'logfire': patch
---

Match Python's `format(value, 'g')` when rendering numeric evaluation values in the `gen_ai.evaluation.result` log body. Values between 1e-6 and 1e-4 now use scientific notation as Python does instead of long fixed-point decimals, a value whose sixth significant digit rounds away no longer emits a stray trailing decimal point (for example `-10515.` for `-10515.04`), and ties now round half to even as Python does rather than away from zero, so `1 / 512` renders as `0.00195312`.
