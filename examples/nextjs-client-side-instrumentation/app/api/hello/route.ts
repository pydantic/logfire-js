import * as logfire from "@pydantic/logfire-api";

export async function GET() {
  logfire.info("server span");
  return Response.json({ message: "Hello World!" });
}

