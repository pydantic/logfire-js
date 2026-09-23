#!/usr/bin/env node

import { runCli } from './delegate'

if (!runCli()) {
  process.exitCode = 1
}
