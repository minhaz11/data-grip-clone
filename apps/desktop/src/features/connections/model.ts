import type { ConnectionDraft, ConnectionProfile, Environment, Folder } from '../../ipc/types';
import { useConnections } from './connectionsStore';

export const ENVIRONMENTS: { value: Environment; label: string; color: string | null }[] = [
  { value: 'none', label: 'None', color: null },
  { value: 'development', label: 'Development', color: '#3f9d5a' },
  { value: 'testing', label: 'Testing', color: '#7a5fc8' },
  { value: 'staging', label: 'Staging', color: '#d98a1f' },
  { value: 'production', label: 'Production', color: '#c43a3a' },
];

/** WCAG relative luminance of a `#rrggbb` color, or `null` if it cannot be parsed. */
function luminance(hex: string): number | null {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (!m) {
    return null;
  }
  const [r, g, b] = m.slice(1).map((h) => {
    const c = parseInt(h, 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * Black or white, whichever contrasts more with `background`. One of them always reaches at least
 * 4.58:1 (WCAG AA), so badges stay legible on any color the user picks.
 */
export function readableTextOn(background: string): '#000000' | '#ffffff' {
  const l = luminance(background);
  if (l === null) {
    return '#ffffff';
  }
  return (l + 0.05) / 0.05 > 1.05 / (l + 0.05) ? '#000000' : '#ffffff';
}

/**
 * Explicit color wins; then the folder's color (inherited); then the environment's default.
 * `null` means no marker.
 */
export function effectiveColor(
  c: Pick<ConnectionDraft, 'color' | 'environment'> & Partial<Pick<ConnectionDraft, 'folderId'>>,
  folders: Folder[] = useConnections.getState().folders,
): string | null {
  const folder = c.folderId ? folders.find((f) => f.id === c.folderId) : undefined;
  return (
    c.color ?? folder?.color ?? ENVIRONMENTS.find((e) => e.value === c.environment)?.color ?? null
  );
}

/** The editable part of a saved profile. */
export function draftOf(p: ConnectionProfile): ConnectionDraft {
  const { id: _id, passwordSaved: _p, sortOrder: _s, createdAt: _c, updatedAt: _u, ...draft } = p;
  return draft;
}

export const NEW_DRAFT: ConnectionDraft = {
  name: '',
  engine: 'postgresql',
  host: 'localhost',
  port: 5432,
  database: 'postgres',
  username: 'postgres',
  sslMode: 'prefer',
  connectTimeoutSecs: 10,
  readOnly: false,
  environment: 'development',
  color: null,
  saveMode: 'forever',
  txMode: 'auto',
  isolation: 'read_committed',
  historyEnabled: true,
  folderId: null,
  sshProfileId: null,
  tlsCaFile: null,
  tlsCertFile: null,
  tlsKeyFile: null,
  keepaliveSecs: 0,
  autoDisconnectMins: 0,
  startupSql: '',
  schemaNames: [],
  schemaPattern: '',
  urlOnly: false,
};

export type DraftErrors = Partial<Record<keyof ConnectionDraft, string>>;

/** Client-side mirror of `ConnectionDraft::normalized` so errors show before a round trip. */
export function validateDraft(d: ConnectionDraft): DraftErrors {
  const errors: DraftErrors = {};
  if (!d.name.trim()) {
    errors.name = 'Name is required.';
  } else if (d.name.trim().length > 100) {
    errors.name = 'Name must be at most 100 characters.';
  }
  if (!d.host.trim() || /\s/.test(d.host.trim())) {
    errors.host = 'Host must be a hostname or IP address without spaces.';
  }
  if (!Number.isInteger(d.port) || d.port < 1 || d.port > 65535) {
    errors.port = 'Port must be between 1 and 65535.';
  }
  if (!d.username.trim()) {
    errors.username = 'User is required.';
  }
  if (
    !Number.isInteger(d.connectTimeoutSecs) ||
    d.connectTimeoutSecs < 1 ||
    d.connectTimeoutSecs > 300
  ) {
    errors.connectTimeoutSecs = 'Connect timeout must be between 1 and 300 seconds.';
  }
  if (!Number.isInteger(d.keepaliveSecs) || d.keepaliveSecs < 0 || d.keepaliveSecs > 3600) {
    errors.keepaliveSecs = 'Keep-alive must be between 0 and 3600 seconds.';
  }
  if (
    !Number.isInteger(d.autoDisconnectMins) ||
    d.autoDisconnectMins < 0 ||
    d.autoDisconnectMins > 1440
  ) {
    errors.autoDisconnectMins = 'Auto-disconnect must be between 0 and 1440 minutes.';
  }
  for (const key of ['tlsCaFile', 'tlsCertFile', 'tlsKeyFile'] as const) {
    const path = d[key]?.trim();
    if (path && !isAbsolutePath(path)) {
      errors[key] = 'Use an absolute file path.';
    }
  }
  if (!!d.tlsCertFile?.trim() !== !!d.tlsKeyFile?.trim()) {
    errors.tlsKeyFile = 'A client certificate and its key file go together: choose both.';
  }
  return errors;
}

/** POSIX (`/…`) or Windows (`C:\…`, `\\server\…`) absolute path. */
export function isAbsolutePath(p: string): boolean {
  return /^(\/|[A-Za-z]:[\\/]|\\\\)/.test(p);
}

/** Which dialog tab shows the field an error belongs to. */
export function tabOfError(key: keyof ConnectionDraft): 'general' | 'tls' | 'options' {
  if (key === 'tlsCaFile' || key === 'tlsCertFile' || key === 'tlsKeyFile') {
    return 'tls';
  }
  if (key === 'connectTimeoutSecs' || key === 'keepaliveSecs' || key === 'autoDisconnectMins') {
    return 'options';
  }
  return 'general';
}

/** "N of M schemas" when a scope is set and the total is known. */
export function scopeLabel(
  d: Pick<ConnectionDraft, 'schemaNames' | 'schemaPattern'>,
  shown: number | null,
  total: number | null,
): string | null {
  if (d.schemaNames.length === 0 && !d.schemaPattern.trim()) {
    return null;
  }
  if (shown === null || total === null) {
    return 'schema scope set';
  }
  return `${shown} of ${total} schemas`;
}

export function endpointLabel(d: Pick<ConnectionDraft, 'host' | 'port' | 'database'>): string {
  return `${d.host}:${d.port}${d.database ? `/${d.database}` : ''}`;
}
