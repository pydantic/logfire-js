import * as logfire from 'logfire'

export async function GET() {
  logfire.info('server endpoint')
  return Response.json({ message: 'Hello World!' })
}
