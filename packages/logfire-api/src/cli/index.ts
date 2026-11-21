#!/usr/bin/env node

import { runNativeCli } from './delegate'

process.exitCode = runNativeCli(process.argv.slice(2), PACKAGE_VERSION)
