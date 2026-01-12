import * as logfire from 'logfire'

/** Add your relevant code here for the issue to reproduce */
export default async function Home() {
  return logfire.span('Info parent span', {}, { level: logfire.Level.Info }, async () => {
    logfire.info('child span')
    return <div>Hello</div>
  })
}
