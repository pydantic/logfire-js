import { NextRequest, NextResponse } from "next/server";

export function middleware(request: NextRequest) {
  const url = request.nextUrl.clone();

  if (url.pathname === "/client-traces") {
    const requestHeaders = new Headers(request.headers);
    requestHeaders.set("Authorization", process.env.LOGFIRE_TOKEN!);

    return NextResponse.rewrite(
      new URL(process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT!),
      {
        headers: requestHeaders,
      },
    );
  }
}

export const config = {
  matcher: "/client-traces/:path*",
};
