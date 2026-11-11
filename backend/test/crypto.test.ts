import { describe, expect, it } from 'vitest';
import { decrypt, encrypt, signToken, verifyToken } from '../src/lib/crypto.js';

describe('encryption', () => {
  it('round-trips and never repeats the same output', () => {
    const a = encrypt('secret-value');
    const b = encrypt('secret-value');
    expect(a).not.toBe(b);
    expect(a).not.toContain('secret-value');
    expect(decrypt(a)).toBe('secret-value');
  });

  it('detects tampering', () => {
    const parts = encrypt('secret-value').split('.');
    parts[3] = Buffer.from('tampered-data').toString('base64url');
    expect(() => decrypt(parts.join('.'))).toThrow();
  });
});

describe('signed links', () => {
  it('accepts a good token and rejects a changed one', () => {
    const { token } = signToken({ r: 'run1' }, 60);
    expect(verifyToken<{ r: string }>(token)?.r).toBe('run1');
    const [body, sig] = token.split('.');
    const forged = `${Buffer.from(JSON.stringify({ r: 'run2', exp: 9999999999 })).toString('base64url')}.${sig}`;
    expect(verifyToken(forged)).toBeNull();
    expect(verifyToken(`${body}.AAAA`)).toBeNull();
  });

  it('rejects an expired token', () => {
    const { token } = signToken({ r: 'x' }, -10);
    expect(verifyToken(token)).toBeNull();
  });
});
