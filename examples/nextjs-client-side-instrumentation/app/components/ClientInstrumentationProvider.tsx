import { ZoneContextManager } from "@opentelemetry/context-zone";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { registerInstrumentations } from "@opentelemetry/instrumentation";
import { FetchInstrumentation } from "@opentelemetry/instrumentation-fetch";
import { Resource } from "@opentelemetry/resources";
import {
  RandomIdGenerator,
  SimpleSpanProcessor,
  WebTracerProvider,
} from "@opentelemetry/sdk-trace-web";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import { ReactNode, useEffect } from "react";

// JS port of https://github.com/pydantic/logfire/blob/main/logfire/_internal/ulid.py without the parameters
function ulid(): bigint {
  // Timestamp: first 6 bytes of the ULID (48 bits)
  // Note that it's not important that this timestamp is super precise or unique.
  // It just needs to be roughly monotonically increasing so that the ULID is sortable, at least for our purposes.
  let result = BigInt(Date.now());

  // Randomness: next 10 bytes of the ULID (80 bits)
  const randomness = crypto.getRandomValues(new Uint8Array(10));
  for (const segment of randomness) {
    result <<= BigInt(8);
    result |= BigInt(segment);
  }

  return result;
}

class ULIDGenerator extends RandomIdGenerator {
  override generateTraceId = () => {
    return ulid().toString(16).padStart(32, "0");
  };
}

export default function ClientInstrumentationProvider(
  { children }: { children: ReactNode },
) {
  useEffect(() => {
    const url = new URL(window.location.href);
    url.pathname = "/client-traces";
    const resource = new Resource({
      [ATTR_SERVICE_NAME]: "logfire-frontend",
      [ATTR_SERVICE_VERSION]: "0.0.1",
    });

    const provider = new WebTracerProvider({
      resource,
      idGenerator: new ULIDGenerator(),
      spanProcessors: [
        new SimpleSpanProcessor(
          new OTLPTraceExporter({ url: url.toString() }),
        ),
      ],
    });

    provider.register({
      contextManager: new ZoneContextManager(),
    });

    registerInstrumentations({
      instrumentations: [new FetchInstrumentation()],
    });
  }, []);
  return children;
}
