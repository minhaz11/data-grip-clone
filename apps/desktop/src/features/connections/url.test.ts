import { describe, expect, it } from 'vitest';
import { NEW_DRAFT } from './model';
import { formatUrl, parseUrl, stripPassword, type UrlFields } from './url';

const base: UrlFields = { ...NEW_DRAFT };

describe('connection URLs', () => {
  it('round-trips every field, including special characters', () => {
    const fields: UrlFields = {
      ...base,
      host: 'db.example.test',
      port: 6543,
      database: 'my db/ü%',
      username: 'ann@corp:x',
      sslMode: 'verify-full',
      connectTimeoutSecs: 30,
      tlsCaFile: '/etc/ssl/ca & roots.pem',
      tlsCertFile: '/home/ann/client.pem',
      tlsKeyFile: '/home/ann/client.key',
    };
    const url = formatUrl(fields);
    expect(url).not.toContain(' ');
    const parsed = parseUrl(url);
    expect(parsed.password).toBeNull();
    expect(parsed.ignored).toEqual([]);
    expect({ ...base, ...parsed.fields }).toEqual(fields);
  });

  it('brackets IPv6 hosts and reads them back', () => {
    const fields: UrlFields = { ...base, host: '::1', port: 5433, database: 'app' };
    const url = formatUrl(fields);
    expect(url).toBe('postgresql://postgres@[::1]:5433/app');
    expect(parseUrl(url).fields).toMatchObject({ host: '::1', port: 5433, database: 'app' });
    expect(parseUrl('postgres://[fe80::1%25en0]/x').fields.host).toBe('fe80::1%en0');
    const zoned: UrlFields = { ...base, host: 'fe80::1%en0' };
    expect(parseUrl(formatUrl(zoned)).fields.host).toBe('fe80::1%en0');
  });

  it('leaves defaults out of the URL', () => {
    expect(formatUrl(base)).toBe('postgresql://postgres@localhost/postgres');
  });

  it('takes the password out (userinfo or parameter) without keeping it', () => {
    const a = parseUrl('postgresql://bob:p%40ss%3Aw0rd@h/db');
    expect(a.password).toBe('p@ss:w0rd');
    expect(a.fields.username).toBe('bob');
    const b = parseUrl('jdbc:postgresql://h:5432/db?user=bob&password=s3cret&sslmode=require');
    expect(b.password).toBe('s3cret');
    expect(b.fields).toMatchObject({ username: 'bob', sslMode: 'require', port: 5432 });
    expect(stripPassword('postgresql://bob:secret@h/db')).toBe('postgresql://bob@h/db');
    expect(stripPassword('postgresql://h/db?password=x&sslmode=require')).toBe(
      'postgresql://h/db?sslmode=require',
    );
    expect(stripPassword('postgresql://h/db?sslmode=require&password=x')).toBe(
      'postgresql://h/db?sslmode=require',
    );
  });

  it('reports unknown parameters and rejects broken input', () => {
    expect(parseUrl('postgresql://h/db?application_name=x').ignored).toEqual(['application_name']);
    expect(() => parseUrl('mysql://h/db')).toThrow(/postgresql:\/\//);
    expect(() => parseUrl('postgresql://h:99999/db')).toThrow(/port/);
    expect(() => parseUrl('postgresql://a,b/db')).toThrow(/Several hosts/);
    expect(() => parseUrl('postgresql://[::1/db')).toThrow(/IPv6/);
    expect(() => parseUrl('postgresql://h/db?sslmode=maybe')).toThrow(/sslmode/);
    expect(() => parseUrl('postgresql://h/%E0%A4%A')).toThrow(/%-escape/);
  });
});
