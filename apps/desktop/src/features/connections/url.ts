import type { ConnectionDraft, SslMode } from '../../ipc/types';

/** The draft fields a connection URL carries. */
export type UrlFields = Pick<
  ConnectionDraft,
  | 'host'
  | 'port'
  | 'database'
  | 'username'
  | 'sslMode'
  | 'connectTimeoutSecs'
  | 'tlsCaFile'
  | 'tlsCertFile'
  | 'tlsKeyFile'
>;

export interface ParsedUrl {
  fields: Partial<UrlFields>;
  /** A password found in the URL. The caller moves it to the password field; URLs never keep one. */
  password: string | null;
  /** Query parameters Quarry does not use. */
  ignored: string[];
}

const SSL_MODES: SslMode[] = ['disable', 'prefer', 'require', 'verify-ca', 'verify-full'];
const DEFAULT_PORT = 5432;
const DEFAULT_TIMEOUT = 10;

const enc = (s: string) => encodeURIComponent(s);

function decode(s: string, what: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    throw new Error(`The ${what} has a broken %-escape.`);
  }
}

/** `postgresql://user@host:port/database?…`, without a password (it never belongs in the URL). */
export function formatUrl(d: UrlFields): string {
  // IPv6 in brackets; a zone id's `%` is escaped so it reads back.
  const host = d.host.includes(':') ? `[${d.host.replace(/%/g, '%25')}]` : enc(d.host);
  const user = d.username ? `${enc(d.username)}@` : '';
  const port = d.port === DEFAULT_PORT ? '' : `:${d.port}`;
  const params: [string, string][] = [];
  if (d.sslMode !== 'prefer') {
    params.push(['sslmode', d.sslMode]);
  }
  if (d.connectTimeoutSecs !== DEFAULT_TIMEOUT) {
    params.push(['connect_timeout', String(d.connectTimeoutSecs)]);
  }
  if (d.tlsCaFile) {
    params.push(['sslrootcert', d.tlsCaFile]);
  }
  if (d.tlsCertFile) {
    params.push(['sslcert', d.tlsCertFile]);
  }
  if (d.tlsKeyFile) {
    params.push(['sslkey', d.tlsKeyFile]);
  }
  const query = params.length ? `?${params.map(([k, v]) => `${k}=${enc(v)}`).join('&')}` : '';
  return `postgresql://${user}${host}${port}/${enc(d.database)}${query}`;
}

/**
 * Parses a libpq-style URL (`postgresql://`, `postgres://`, or with a `jdbc:` prefix). Throws an
 * `Error` with a user-facing message when the text is not a usable URL.
 */
export function parseUrl(text: string): ParsedUrl {
  const m = /^(?:jdbc:)?postgres(?:ql)?:\/\/([^/?#]*)(?:\/([^?#]*))?(?:\?([^#]*))?(?:#.*)?$/i.exec(
    text.trim(),
  );
  if (!m) {
    throw new Error('Enter a URL like postgresql://user@host:5432/database.');
  }
  const [, authority = '', path, query] = m;
  const fields: Partial<UrlFields> = {};
  let password: string | null = null;
  const ignored: string[] = [];

  const at = authority.lastIndexOf('@');
  const userinfo = at >= 0 ? authority.slice(0, at) : null;
  const hostport = at >= 0 ? authority.slice(at + 1) : authority;
  if (userinfo !== null) {
    const colon = userinfo.indexOf(':');
    const user = colon >= 0 ? userinfo.slice(0, colon) : userinfo;
    if (user) {
      fields.username = decode(user, 'user name');
    }
    if (colon >= 0) {
      password = decode(userinfo.slice(colon + 1), 'password');
    }
  }

  if (hostport.includes(',')) {
    throw new Error('Several hosts in one URL are not supported. Use one host.');
  }
  let host = hostport;
  let port: string | undefined;
  if (hostport.startsWith('[')) {
    const close = hostport.indexOf(']');
    if (close < 0) {
      throw new Error('The IPv6 address is missing its closing "]".');
    }
    host = hostport.slice(1, close);
    const rest = hostport.slice(close + 1);
    if (rest && !rest.startsWith(':')) {
      throw new Error('Unexpected text after the IPv6 address.');
    }
    port = rest ? rest.slice(1) : undefined;
  } else {
    const colon = hostport.lastIndexOf(':');
    if (colon >= 0) {
      host = hostport.slice(0, colon);
      port = hostport.slice(colon + 1);
    }
  }
  if (host) {
    fields.host = decode(host, 'host');
  }
  if (port !== undefined && port !== '') {
    fields.port = parsePort(port);
  }

  if (path !== undefined) {
    fields.database = decode(path, 'database name');
  }

  for (const pair of (query ?? '').split('&').filter(Boolean)) {
    const eq = pair.indexOf('=');
    const key = decode(eq >= 0 ? pair.slice(0, eq) : pair, 'parameter');
    const value = decode((eq >= 0 ? pair.slice(eq + 1) : '').replace(/\+/g, ' '), key);
    switch (key) {
      case 'sslmode':
        if (!SSL_MODES.includes(value as SslMode)) {
          throw new Error(`sslmode must be one of ${SSL_MODES.join(', ')}.`);
        }
        fields.sslMode = value as SslMode;
        break;
      case 'connect_timeout': {
        const n = Number(value);
        if (!Number.isInteger(n) || n < 1 || n > 300) {
          throw new Error('connect_timeout must be between 1 and 300 seconds.');
        }
        fields.connectTimeoutSecs = n;
        break;
      }
      case 'sslrootcert':
        fields.tlsCaFile = value || null;
        break;
      case 'sslcert':
        fields.tlsCertFile = value || null;
        break;
      case 'sslkey':
        fields.tlsKeyFile = value || null;
        break;
      case 'user':
        fields.username = value;
        break;
      case 'password':
        password = value;
        break;
      case 'dbname':
        fields.database = value;
        break;
      case 'host':
        fields.host = value;
        break;
      case 'port':
        fields.port = parsePort(value);
        break;
      default:
        ignored.push(key);
    }
  }
  return { fields, password, ignored };
}

function parsePort(text: string): number {
  const n = Number(text);
  if (!/^\d+$/.test(text) || n < 1 || n > 65535) {
    throw new Error('The port must be between 1 and 65535.');
  }
  return n;
}

/** The URL text without its password, if it had one (for showing what the user pasted). */
export function stripPassword(text: string): string {
  const url = text.replace(/^((?:jdbc:)?postgres(?:ql)?:\/\/[^:@/?#]*):[^@/?#]*@/i, '$1@');
  const q = url.indexOf('?');
  if (q < 0) {
    return url;
  }
  const hash = url.indexOf('#', q);
  const end = hash < 0 ? url.length : hash;
  const kept = url
    .slice(q + 1, end)
    .split('&')
    .filter((p) => p && !/^password(=|$)/i.test(p));
  return `${url.slice(0, q)}${kept.length ? `?${kept.join('&')}` : ''}${url.slice(end)}`;
}
