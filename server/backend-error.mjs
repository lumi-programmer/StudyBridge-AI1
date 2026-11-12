// The platform error type the application factory expects, plus the wrapper
// the deployed Function's errorResponse provides: a thrown BackendError becomes
// a status + code body, never a stack trace.
export class BackendError extends Error {
  constructor(code, status) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export function errorResponse(error, requestId) {
  const status = Number.isInteger(error?.status) ? error.status : 500;
  const body = { error: error?.code || 'internal_error', hint: error?.hint || null };
  if (requestId) body.request_id = requestId;
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}
