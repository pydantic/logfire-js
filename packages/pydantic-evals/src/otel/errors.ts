export class SpanTreeRecordingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SpanTreeRecordingError'
  }
}
