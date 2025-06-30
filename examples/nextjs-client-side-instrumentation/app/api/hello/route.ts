import * as logfire from "@pydantic/logfire-api";

export async function GET() {
  logfire.info("server endpoint");
  return Response.json({ message: "Hello World!" });
}

