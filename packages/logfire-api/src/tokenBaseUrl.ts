export interface RegionData {
  baseUrl: string
  gcpRegion: string
}

const US_REGION: RegionData = {
  baseUrl: 'https://logfire-us.pydantic.dev',
  gcpRegion: 'us-east4',
}

const EU_REGION: RegionData = {
  baseUrl: 'https://logfire-eu.pydantic.dev',
  gcpRegion: 'europe-west4',
}

export const LOGFIRE_REGIONS: Record<string, RegionData> = {
  eu: EU_REGION,
  stagingeu: {
    baseUrl: 'https://logfire-eu.pydantic.info',
    gcpRegion: 'europe-west4',
  },
  stagingus: {
    baseUrl: 'https://logfire-us.pydantic.info',
    gcpRegion: 'us-east4',
  },
  us: US_REGION,
}

export const LOGFIRE_PUBLIC_REGIONS: Record<'us' | 'eu', RegionData> = {
  us: US_REGION,
  eu: EU_REGION,
}

export const PYDANTIC_LOGFIRE_TOKEN_PATTERN: RegExp =
  /^(?<safePart>pylf_v(?<version>[0-9]+)_(?<region>[a-z]+)_(?:(?<organizationId>[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_)?)(?<token>[a-zA-Z0-9]+)$/u

export function removeTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url
}

export function getBaseUrlFromToken(token: string | undefined): string {
  let regionKey = 'us'
  if (token !== undefined && token !== '') {
    const match = PYDANTIC_LOGFIRE_TOKEN_PATTERN.exec(token)
    if (match) {
      const region = match.groups?.['region']
      if (region !== undefined && Object.hasOwn(LOGFIRE_REGIONS, region)) {
        regionKey = region
      }
    }
  }
  const regionData = LOGFIRE_REGIONS[regionKey]
  if (!regionData) {
    throw new Error(`Unknown region in token: ${regionKey}. Valid regions are: ${Object.keys(LOGFIRE_REGIONS).join(', ')}`)
  }
  return regionData.baseUrl
}

export function resolveLogfireBaseUrl(env: Record<string, string | undefined>, passedUrl: string | undefined, token: string): string {
  return removeTrailingSlash(passedUrl ?? env['LOGFIRE_BASE_URL'] ?? getBaseUrlFromToken(token))
}
