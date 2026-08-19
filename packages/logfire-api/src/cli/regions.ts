import { LOGFIRE_PUBLIC_REGIONS, removeTrailingSlash } from '../tokenBaseUrl'
import { LogfireCliError } from './errors'
import { NoAnswerAvailableError } from './interactivePrompt'
import type { Prompt } from './interactivePrompt'

export type CliRegion = keyof typeof LOGFIRE_PUBLIC_REGIONS

export function resolveSelectedBaseUrl(baseUrl: string | undefined, region: string | undefined): string | undefined {
  if (baseUrl !== undefined) {
    if (baseUrl.trim() === '') {
      throw new LogfireCliError('The --base-url value cannot be empty.')
    }
    return removeTrailingSlash(baseUrl)
  }
  if (region === undefined) {
    return undefined
  }
  if (!isCliRegion(region)) {
    throw new LogfireCliError(`Unknown Logfire region "${region}". Valid regions are: ${Object.keys(LOGFIRE_PUBLIC_REGIONS).join(', ')}`)
  }
  return LOGFIRE_PUBLIC_REGIONS[region].baseUrl
}

export async function promptForRegion(prompt: Prompt): Promise<string> {
  const entries = Object.entries(LOGFIRE_PUBLIC_REGIONS)
  const choices = entries.map((_, index) => String(index + 1))
  const choicesText = entries
    .map(([region, data], index) => `${String(index + 1)}. ${region.toUpperCase()} (GCP region: ${data.gcpRegion})`)
    .join('\n')
  let selected: string
  try {
    selected = await prompt.choice(
      `Logfire is available in multiple data regions. Please select one:\n${choicesText}\nSelected region`,
      choices
    )
  } catch (error) {
    if (!(error instanceof NoAnswerAvailableError)) {
      throw error
    }
    // Which region holds your data is not ours to guess, so it stays a required choice --
    // but it is answerable ahead of time, and saying so beats hanging on a prompt nobody
    // can reply to. Each suggestion is its own runnable line, because `--region us|eu` is
    // a shell pipeline if you paste it.
    const lines = [
      'Logfire is available in multiple data regions and no region was selected.',
      'Re-run in an interactive terminal to choose, or pass one:',
      '',
      ...entries.map(([region]) => `  logfire --region ${region} auth`),
    ]
    throw new LogfireCliError(lines.join('\n'))
  }
  const selectedRegion = entries[Number(selected) - 1]?.[1]
  if (selectedRegion === undefined) {
    throw new LogfireCliError('Invalid Logfire region selection.')
  }
  return selectedRegion.baseUrl
}

export function isCliRegion(region: string): region is CliRegion {
  return Object.hasOwn(LOGFIRE_PUBLIC_REGIONS, region)
}
