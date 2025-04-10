#!/usr/bin/env sh
OTEL_DENO=true \
  OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://logfire-api.pydantic.dev/v1/traces \
  OTEL_EXPORTER_OTLP_HEADERS='Authorization=your-token' \
  deno run --unstable-otel --allow-net main.ts
