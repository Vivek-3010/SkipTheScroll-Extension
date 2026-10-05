/**
 * Error type that carries an HTTP status, a stable machine code and an optional
 * user-facing hint. Thrown by services/utils and rendered by the error handler.
 */
export class ApiError extends Error {
  constructor(status, code, message, hint) {
    super(message)
    this.name = 'ApiError'
    this.status = Number.isFinite(status) ? status : 500
    this.code = code || 'INTERNAL_ERROR'
    this.hint = hint || null
    this.expose = true
  }
}

export function isApiError(err) {
  return err instanceof ApiError || (err && err.name === 'ApiError' && typeof err.code === 'string')
}
