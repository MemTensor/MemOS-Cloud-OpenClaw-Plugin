export type MemosClientErrorKind =
  | 'credential'
  | 'http'
  | 'business'
  | 'response'
  | 'network'
  | 'timeout'
  | 'aborted'

export interface MemosClientErrorOptions {
  kind: MemosClientErrorKind
  retryable?: boolean
  status?: number
  cause?: unknown
}
export class MemosClientError extends Error {
  readonly kind: MemosClientErrorKind
  readonly retryable: boolean
  readonly status?: number

  constructor(message: string, options: MemosClientErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'MemosClientError'
    this.kind = options.kind
    this.retryable = options.retryable ?? false
    if (options.status !== undefined) this.status = options.status
  }
}
