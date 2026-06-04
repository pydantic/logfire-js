import { requestDeviceCode, pollForToken } from '../client'
import type { CliContext, GlobalOptions } from '../context'
import { defaultAuthFilePath, UserTokenCollection } from '../credentials'
import { promptForRegion } from '../regions'
import { writeLine } from '../output'

export async function runAuthCommand(args: string[], globalOptions: GlobalOptions, context: CliContext): Promise<void> {
  if (args[0] === 'logout') {
    runLogout(globalOptions, context)
    return
  }

  const authFile = globalOptions.authFile ?? defaultAuthFilePath(context.homeDir)
  const tokens = new UserTokenCollection(authFile)
  let baseUrl = globalOptions.baseUrl
  if (tokens.isLoggedIn(baseUrl)) {
    writeLine(context.stderr, `You are already logged in. (Your credentials are stored in ${authFile})`)
    writeLine(context.stderr, 'If you would like to log in using a different account, use the --region argument:')
    writeLine(context.stderr, 'logfire --region <region> auth')
    return
  }

  writeLine(context.stderr)
  writeLine(context.stderr, 'Welcome to Logfire!')
  writeLine(context.stderr, 'Before you can send data to Logfire, we need to authenticate you.')
  writeLine(context.stderr)

  baseUrl = baseUrl ?? (await promptForRegion(context.prompt))

  const deviceCode = await requestDeviceCode({ baseUrl, fetch: context.fetch })
  const frontendHost = new URL(deviceCode.frontend_auth_url).host
  await context.prompt.waitForEnter(`Press Enter to open ${frontendHost} in your browser...`)

  await context.openBrowser(deviceCode.frontend_auth_url)
  writeLine(context.stderr, `Please open ${deviceCode.frontend_auth_url} in your browser to authenticate if it hasn't already.`)
  writeLine(context.stderr, 'Waiting for you to authenticate with Logfire...')

  tokens.addToken(baseUrl, await pollForToken({ baseUrl, deviceCode: deviceCode.device_code, fetch: context.fetch }))
  writeLine(context.stderr, 'Successfully authenticated!')
  writeLine(context.stderr)
  writeLine(context.stderr, `Your Logfire credentials are stored in ${authFile}`)
}

function runLogout(globalOptions: GlobalOptions, context: CliContext): void {
  const authFile = globalOptions.authFile ?? defaultAuthFilePath(context.homeDir)
  const tokens = new UserTokenCollection(authFile)
  const removed = tokens.logout(globalOptions.baseUrl)
  for (const url of removed) {
    writeLine(context.stderr, `Successfully logged out from ${url}`)
  }
  writeLine(context.stderr)
  writeLine(context.stderr, `Your Logfire credentials have been removed from ${authFile}`)
}
