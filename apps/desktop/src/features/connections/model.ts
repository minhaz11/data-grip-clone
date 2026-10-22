import type { ConnectionDraft, Environment } from '../../ipc/types';

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

/** Explicit color wins; otherwise the environment's default; `null` means no marker. */
export function effectiveColor(c: Pick<ConnectionDraft, 'color' | 'environment'>): string | null {
  return c.color ?? ENVIRONMENTS.find((e) => e.value === c.environment)?.color ?? null;
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
};

export type DraftErrors = Partial<Record<keyof ConnectionDraft, string>>;

/** Client-side mirror of `ConnectionDraft::normalized` so errors show before a round trip. */
export function validateDraft(d: ConnectionDraft): DraftErrors {
  const errors: DraftErrors = {};
  if (!d.name.trim()) errors.name = 'Name is required.';
  else if (d.name.trim().length > 100) errors.name = 'Name must be at most 100 characters.';
  if (!d.host.trim() || /\s/.test(d.host.trim()))
    errors.host = 'Host must be a hostname or IP address without spaces.';
  if (!Number.isInteger(d.port) || d.port < 1 || d.port > 65535)
    errors.port = 'Port must be between 1 and 65535.';
  if (!d.username.trim()) errors.username = 'User is required.';
  if (
    !Number.isInteger(d.connectTimeoutSecs) ||
    d.connectTimeoutSecs < 1 ||
    d.connectTimeoutSecs > 300
  )
    errors.connectTimeoutSecs = 'Connect timeout must be between 1 and 300 seconds.';
  return errors;
}

export function endpointLabel(d: Pick<ConnectionDraft, 'host' | 'port' | 'database'>): string {
  return `${d.host}:${d.port}${d.database ? `/${d.database}` : ''}`;
}
