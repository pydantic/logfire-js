import { RandomIdGenerator } from '@opentelemetry/sdk-trace-base'

export class ULIDGenerator extends RandomIdGenerator {
  override generateTraceId = () => {
    const id = ulid().toString(16).padStart(32, '0')
    return id
  }
}

// JS port of https://github.com/pydantic/logfire/blob/main/logfire/_internal/ulid.py without the parameters
function ulid(): bigint {
  // Timestamp: first 6 bytes of the ULID (48 bits)
  // Note that it's not important that this timestamp is super precise or unique.
  // It just needs to be roughly monotonically increasing so that the ULID is sortable, at least for our purposes.
  let result = BigInt(Date.now())

  // Randomness: next 10 bytes of the ULID (80 bits)
  const randomness = crypto.getRandomValues(new Uint8Array(10))
  for (const segment of randomness) {
    result <<= BigInt(8)
    result |= BigInt(segment)
  }

  return result
}
