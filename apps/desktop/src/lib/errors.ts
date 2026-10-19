import type { AppError, ConnectErrorKind } from '../ipc/types';

/** Normalizes anything thrown by a backend call into an AppError. */
export function toAppError(e: unknown): AppError {
  if (e && typeof e === 'object' && 'message' in e) {
    const o = e as Partial<AppError>;
    return {
      kind: o.kind ?? 'error',
      message: String(o.message),
      hint: o.hint,
      sqlstate: o.sqlstate,
      connectKind: o.connectKind,
    };
  }
  return { kind: 'error', message: String(e) };
}

export const CONNECT_ERROR_TITLES: Record<ConnectErrorKind, string> = {
  dns: 'Host not found',
  refused: 'Connection refused',
  timeout: 'Connection timed out',
  auth: 'Authentication failed',
  password_required: 'Password required',
  database_missing: 'Database not found',
  tls: 'TLS/SSL error',
  server_unavailable: 'Server unavailable',
  other: 'Connection failed',
};

export function errorTitle(e: AppError): string {
  return e.connectKind ? CONNECT_ERROR_TITLES[e.connectKind] : 'Error';
}

/** Plain-text report for "Copy details" (never contains secrets: the backend omits them). */
export function errorDetails(e: AppError): string {
  return [
    errorTitle(e),
    e.message,
    e.hint && `Hint: ${e.hint}`,
    e.sqlstate && `SQLSTATE: ${e.sqlstate}`,
  ]
    .filter(Boolean)
    .join('\n');
}
