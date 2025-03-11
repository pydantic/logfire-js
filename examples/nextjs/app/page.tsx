import * as logfire from '@pydantic/logfire-api'

/** Add your relevant code here for the issue to reproduce */
export default async function Home() {
  return logfire.startActiveSpan(logfire.Level.Info, 'Info parent span', {}, {}, async () => {
    logfire.info('child span');
    return <div>Hello</div>;
  })
}
