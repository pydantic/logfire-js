export class PlatformAPIError extends Error {
  override name: string = 'PlatformAPIError'
}

export class PlatformHTTPError extends PlatformAPIError {
  override name: string = 'PlatformHTTPError'
  detail: unknown
  status: number
  statusText: string

  constructor(status: number, statusText: string, detail: unknown) {
    super(
      `Logfire platform API request failed with ${status.toString()}${statusText === '' ? '' : ` ${statusText}`}: ${formatDetail(detail)}`
    )
    this.detail = detail
    this.status = status
    this.statusText = statusText
  }
}

export class PlatformTransportError extends PlatformAPIError {
  override name: string = 'PlatformTransportError'
}

export class PlatformConfigurationError extends PlatformAPIError {
  override name: string = 'PlatformConfigurationError'
}

export class PlatformTimeoutError extends PlatformTransportError {
  override name: string = 'PlatformTimeoutError'
}

export class PlatformJSONError extends PlatformTransportError {
  override name: string = 'PlatformJSONError'
}

function formatDetail(detail: unknown): string {
  if (typeof detail === 'string') {
    return detail
  }
  try {
    return JSON.stringify(detail)
  } catch {
    return String(detail)
  }
}
