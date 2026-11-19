import { Monty } from '@pydantic/monty'
import { afterAll, beforeAll, describe, expect, test } from 'vitest'

import { codeMode } from './codeMode'
import { CountingSandboxes, runCode } from './testing'

let pool: Monty

beforeAll(async () => {
  pool = await Monty.create({ maxProcesses: 2 })
})

afterAll(async () => {
  await pool.close()
})

const NO_CLOCK_LINE =
  '- **No filesystem, environment, or clock**: `pathlib.Path` I/O, `os.getenv`/`os.environ`, ' +
  '`datetime.datetime.now()`, `datetime.date.today()`, and `time.time()` are unavailable here ' +
  '(no filesystem mount or OS handler is configured). `os` and `pathlib` import successfully, but ' +
  'their I/O operations are not supported in this configuration. `time.sleep` and `asyncio.sleep` really wait.'

const CLOCK_LINE =
  '- **No filesystem or environment**: `pathlib.Path` I/O and `os.getenv`/`os.environ` are unavailable here ' +
  '(no filesystem mount or OS handler is configured). `os` and `pathlib` import successfully, but their I/O ' +
  'operations are not supported in this configuration. `datetime.datetime.now()`, `datetime.date.today()`, ' +
  'and `time.time()` read the clock configured for this sandbox. `time.sleep` and `asyncio.sleep` really wait.'

function descriptionLines(description: unknown): string[] {
  return (typeof description === 'string' ? description : '').split('\n').filter((line) => line.startsWith('- **No filesystem'))
}

describe('osPolicy', () => {
  test('defaults to no clock or randomness, with sleeps on the host', async () => {
    const counted = new CountingSandboxes(pool)
    await using code = codeMode({ tools: {}, sandboxes: counted })

    expect(descriptionLines(code.tools.run_code.description)).toEqual([NO_CLOCK_LINE])
    await runCode(code, { code: '1' })
    expect(counted.checkouts[0]?.osPolicy).toEqual({ datetime: 'call_host', sleep: 'call_host', randomStart: 'call_host' })
    expect(counted.checkouts[0]?.limits?.maxTotalSleepSecs).toBeUndefined()
  })

  test('gives code the configured clock and random seeding', async () => {
    const counted = new CountingSandboxes(pool)
    const osPolicy = { datetime: new Date('2020-05-01T12:00:00Z'), randomStart: { seed: 7n } }
    await using code = codeMode({ tools: {}, sandboxes: counted, osPolicy })

    expect(descriptionLines(code.tools.run_code.description)).toEqual([CLOCK_LINE])
    expect(await runCode(code, { code: 'import datetime\ndatetime.datetime.now().isoformat()' })).toBe('2020-05-01T12:00:00')
    const draw = 'import random\nrandom.randint(0, 1_000_000)'
    const first = await runCode(code, { code: draw })
    await using again = codeMode({ tools: {}, sandboxes: new CountingSandboxes(pool), osPolicy })
    expect(await runCode(again, { code: draw })).toBe(first)
    expect(counted.checkouts[0]?.osPolicy).toEqual({ datetime: osPolicy.datetime, sleep: 'call_host', randomStart: { seed: 7n } })
  })

  test("says sleeps return at once with sleep: 'zero'", async () => {
    await using code = codeMode({ tools: {}, sandboxes: new CountingSandboxes(pool), osPolicy: { sleep: 'zero' } })

    expect(descriptionLines(code.tools.run_code.description)).toEqual([
      NO_CLOCK_LINE.replace(
        '`time.sleep` and `asyncio.sleep` really wait.',
        '`time.sleep` and `asyncio.sleep` return at once without waiting.'
      ),
    ])
    const started = Date.now()
    expect(await runCode(code, { code: 'import time\ntime.sleep(60)\n1' })).toBe(1)
    expect(Date.now() - started).toBeLessThan(5000)
  })

  test("caps total sandbox sleep at the snippet timeout with sleep: 'system'", async () => {
    const counted = new CountingSandboxes(pool)
    await using code = codeMode({ tools: {}, sandboxes: counted, osPolicy: { sleep: 'system' }, limits: { timeout: 4000 } })

    expect(await runCode(code, { code: 'import time\ntime.sleep(0.01)\n1' })).toBe(1)
    expect(counted.checkouts[0]?.limits?.maxTotalSleepSecs).toBe(4)
  })
})
