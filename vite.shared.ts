import { copyFileSync, existsSync, readFileSync } from 'node:fs'

import type { UserConfig } from 'vite-plus'

// Taken from vite-plus rather than hand-written, so the result is exactly what `define` accepts.
// A named interface would not be assignable to its index signature.
export type PackageDefines = NonNullable<UserConfig['define']>

// Resolved from the calling config's own location. The working directory and npm_package_version
// both point at the repository root when the release script builds every package in one go, which
// stamped the private root version into published artifacts.
export function packageDefines(configUrl: string): PackageDefines {
  const { version } = JSON.parse(readFileSync(new URL('./package.json', configUrl), 'utf8')) as { version: string }
  return {
    PACKAGE_TIMESTAMP: String(Date.now()),
    PACKAGE_VERSION: JSON.stringify(version),
  }
}

export function copyCjsDeclarations(names: string[]): void {
  for (const name of names) {
    const source = `dist/${name}.d.ts`
    if (existsSync(source)) {
      copyFileSync(source, `dist/${name}.d.cts`)
    }
  }
}
