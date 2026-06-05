import { LogfireApiClient } from './client'
import type { CliContext, GlobalOptions } from './context'
import { defaultAuthFilePath, UserTokenCollection } from './credentials'

export async function createAuthenticatedClient(globalOptions: GlobalOptions, context: CliContext): Promise<LogfireApiClient> {
  const authFile = globalOptions.authFile ?? defaultAuthFilePath(context.homeDir)
  const token = await new UserTokenCollection(authFile).getToken(globalOptions.baseUrl, context.prompt)
  return new LogfireApiClient({ fetch: context.fetch, userToken: token })
}
