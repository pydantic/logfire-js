import { existsSync, lstatSync } from 'node:fs'
import { join } from 'node:path'

import type { CliContext } from '../context'
import { defaultDataDir, projectCredentialsPath, readTokenPath, removeProjectCredentials } from '../credentials'
import { LogfireCliError } from '../errors'
import { writeLine } from '../output'
import { readRequiredValue } from '../args'

export async function runCleanCommand(args: string[], context: CliContext): Promise<void> {
  const options = parseCleanArgs(args)
  const dataDir = options.dataDir ?? defaultDataDir(context.cwd)

  if (options.logs) {
    writeLine(context.stderr, 'No JavaScript Logfire CLI log files are created; --logs has nothing to remove.')
  }

  if (!existsSync(dataDir)) {
    throw new LogfireCliError(`No Logfire data found in ${dataDir}`)
  }
  // `lstatSync`, not `statSync`: the data directory lives inside the user's repository, so
  // a symlink can arrive by being committed to it. `statSync` follows symlinks, so it
  // would report a symlinked `.logfire` as an ordinary directory, and `removeProjectCredentials`
  // below would then list and delete through it -- exactly the risk `ensureDataDir` already
  // guards against on the write path.
  const dataDirStat = lstatSync(dataDir)
  if (dataDirStat.isSymbolicLink()) {
    throw new LogfireCliError(`${dataDir} is a symlink; refusing to clean through it.`)
  }
  if (!dataDirStat.isDirectory()) {
    throw new LogfireCliError(`No Logfire data found in ${dataDir}`)
  }

  const files = [join(dataDir, '.gitignore'), projectCredentialsPath(dataDir), readTokenPath(dataDir)].filter((path) => existsSync(path))
  const confirmed = await context.prompt.confirm(`The following files will be deleted:\n${files.join('\n')}\nAre you sure?`, false)
  if (confirmed) {
    removeProjectCredentials(dataDir)
    writeLine(context.stderr, 'Cleaned Logfire data.')
  } else {
    writeLine(context.stderr, 'Clean aborted.')
  }
}

interface CleanOptions {
  dataDir?: string
  logs: boolean
}

function parseCleanArgs(args: string[]): CleanOptions {
  const options: CleanOptions = { logs: false }
  for (let index = 0; index < args.length; index++) {
    const arg = args[index] ?? ''
    if (arg === '--data-dir') {
      options.dataDir = readRequiredValue(args, ++index, '--data-dir')
    } else if (arg.startsWith('--data-dir=')) {
      options.dataDir = arg.slice('--data-dir='.length)
    } else if (arg === '--logs') {
      options.logs = true
    } else {
      throw new LogfireCliError(`Unexpected argument ${arg}`)
    }
  }
  return options
}
