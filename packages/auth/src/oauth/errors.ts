/**
 * An OAuth protocol error (RFC 6749 §5.2), carried to the wire as
 * `{ error, error_description }`.
 */
export class OAuthError extends Error {
  constructor(
    readonly error: string,
    readonly description: string,
    readonly status = 400,
  ) {
    super(description)
    this.name = 'OAuthError'
  }

  toJSON() {
    return { error: this.error, error_description: this.description }
  }
}
