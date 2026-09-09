/**
 * Test-only entry point: reset the process-wide state this package keeps.
 *
 * Two guards make Agent Control quiet in production and awkward in a test suite. Warnings are
 * emitted once per process per message, and a baseline is published once per process per variable.
 * Both are deliberate -- a config resolved on every run would otherwise bury its own signal, and a
 * failed publish would otherwise retry forever -- and both mean the second test to exercise a path
 * sees nothing happen.
 *
 * So these are exported, from their own subpath rather than the index. An adapter's suite needs them
 * in a `beforeEach`; an adapter's *runtime* has no business calling either, and a separate entry
 * point is what says so in a way a reviewer can see at the import line.
 *
 * ```ts
 * import { resetAgentControl } from '@pydantic/logfire-node/agent-control/testing'
 *
 * beforeEach(resetAgentControl);
 * ```
 */

import { resetProcessState } from './control'
import { resetWarnings } from './warnings'

export { resetProcessState } from './control'
export { resetWarnings } from './warnings'

/**
 * Reset every once-per-process guard at once.
 *
 * The two are almost always wanted together -- a test that asserts a publish happens needs the
 * publish guard cleared, and a test that asserts what was warned needs the warning memory cleared --
 * so this is the one to reach for, and the individual resets are there for a suite that wants to
 * hold one guard across several tests on purpose.
 */
export function resetAgentControl(): void {
  resetWarnings()
  resetProcessState()
}
