---
'logfire': patch
---

Match Python's `format(value, 'g')` when rendering numeric evaluation values in the `gen_ai.evaluation.result` log body. Values between 1e-6 and 1e-4 now use scientific notation as Python does instead of long fixed-point decimals, a value whose sixth significant digit rounds away no longer emits a stray trailing decimal point (for example `-10515.` for `-10515.04`), and rounding now runs on the binary double with half-to-even ties, so `1 / 512` renders as `0.00195312`, `0.1234555` as `0.123455`, and `Number.MIN_VALUE` as `4.94066e-324`.
