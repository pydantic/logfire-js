import { execFile as execFileCallback } from 'node:child_process'
import { resolve } from 'node:path'

import type { TestInfo } from '@playwright/test'

export const repositoryRoot = resolve(import.meta.dirname, '../../..')

export async function runVerifier(path: string, scenario: string, testInfo: TestInfo): Promise<void> {
  const { stderr, stdout } = await new Promise<{ stderr: string; stdout: string }>((resolve, reject) => {
    execFileCallback(process.execPath, [path, scenario], { cwd: repositoryRoot, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error !== null) {
        reject(new Error(error.message, { cause: error }))
        return
      }
      resolve({ stderr, stdout })
    })
  })
  await testInfo.attach(`${scenario}-verification`, {
    body: Buffer.from(`${stdout}${stderr}`),
    contentType: 'text/plain',
  })
}
