import { beforeAll, describe, expect, it } from 'vitest';
import {
  GoogleClaims,
  Jwks,
  TokenError,
  validateGoogleClaims,
  verifyGoogleIdToken,
} from '../worker/src/googleToken';

const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const NOW = 1_800_000_000;

function b64url(data: Uint8Array | string): string {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

let keyPair: CryptoKeyPair;
let otherKeyPair: CryptoKeyPair;
let jwks: Jwks;

async function makeKeyPair() {
  return crypto.subtle.generateKey(
    { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
    true,
    ['sign', 'verify'],
  ) as Promise<CryptoKeyPair>;
}

async function sign(claims: Partial<GoogleClaims>, options: { kid?: string; alg?: string; key?: CryptoKey } = {}) {
  const header = b64url(JSON.stringify({ alg: options.alg ?? 'RS256', kid: options.kid ?? 'test-kid', typ: 'JWT' }));
  const payload = b64url(JSON.stringify(claims));
  const signature = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', options.key ?? keyPair.privateKey,
    new TextEncoder().encode(`${header}.${payload}`));
  return `${header}.${payload}.${b64url(new Uint8Array(signature))}`;
}

function goodClaims(overrides: Partial<GoogleClaims> = {}): GoogleClaims {
  return {
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    sub: '1234567890',
    iat: NOW - 10,
    exp: NOW + 3600,
    given_name: 'Tai',
    ...overrides,
  };
}

const verify = (token: string) => verifyGoogleIdToken(token, { clientId: CLIENT_ID, nowSeconds: NOW, getJwks: async () => jwks });

async function expectCode(promise: Promise<unknown>, code: string) {
  await expect(promise).rejects.toBeInstanceOf(TokenError);
  await expect(promise).rejects.toMatchObject({ code });
}

beforeAll(async () => {
  keyPair = await makeKeyPair();
  otherKeyPair = await makeKeyPair();
  const publicJwk = await crypto.subtle.exportKey('jwk', keyPair.publicKey);
  jwks = { keys: [{ ...publicJwk, kid: 'test-kid', alg: 'RS256', use: 'sig' } as JsonWebKey & { kid: string }] };
});

describe('Google ID token claim validation', () => {
  it('accepts valid claims (both issuer spellings, aud array)', () => {
    expect(validateGoogleClaims(goodClaims(), CLIENT_ID, NOW).sub).toBe('1234567890');
    expect(() => validateGoogleClaims(goodClaims({ iss: 'accounts.google.com' }), CLIENT_ID, NOW)).not.toThrow();
    expect(() => validateGoogleClaims(goodClaims({ aud: ['other', CLIENT_ID] }), CLIENT_ID, NOW)).not.toThrow();
  });

  it('rejects wrong issuer, audience, expiry, future iat and missing sub', () => {
    const cases: [Partial<GoogleClaims>, string][] = [
      [{ iss: 'https://evil.example.com' }, 'BAD_ISSUER'],
      [{ aud: 'someone-else.apps.googleusercontent.com' }, 'BAD_AUDIENCE'],
      [{ exp: NOW - 120 }, 'EXPIRED'],
      [{ iat: NOW + 600 }, 'ISSUED_IN_FUTURE'],
      [{ sub: '' }, 'NO_SUBJECT'],
    ];
    for (const [override, code] of cases) {
      expect(() => validateGoogleClaims(goodClaims(override), CLIENT_ID, NOW)).toThrowError(code);
    }
  });

  it('tolerates small clock skew on exp', () => {
    expect(() => validateGoogleClaims(goodClaims({ exp: NOW - 30 }), CLIENT_ID, NOW)).not.toThrow();
  });

  it('refuses to work without a configured client ID', () => {
    expect(() => validateGoogleClaims(goodClaims(), '', NOW)).toThrowError('NO_CLIENT_ID');
  });
});

describe('Google ID token signature verification', () => {
  it('verifies a token signed by a key in the JWKS', async () => {
    const claims = await verify(await sign(goodClaims()));
    expect(claims.sub).toBe('1234567890');
    expect(claims.given_name).toBe('Tai');
  });

  it('rejects a token signed by a different key', async () => {
    await expectCode(verify(await sign(goodClaims(), { key: otherKeyPair.privateKey })), 'BAD_SIGNATURE');
  });

  it('rejects a tampered payload', async () => {
    const token = await sign(goodClaims());
    const [header, , signature] = token.split('.');
    const forged = b64url(JSON.stringify(goodClaims({ sub: 'attacker' })));
    await expectCode(verify(`${header}.${forged}.${signature}`), 'BAD_SIGNATURE');
  });

  it('rejects unknown key ids, non-RS256 algorithms and malformed tokens', async () => {
    await expectCode(verify(await sign(goodClaims(), { kid: 'missing' })), 'UNKNOWN_KEY');
    const noneHeader = b64url(JSON.stringify({ alg: 'none', kid: 'test-kid' }));
    await expectCode(verify(`${noneHeader}.${b64url(JSON.stringify(goodClaims()))}.`), 'BAD_ALGORITHM');
    await expectCode(verify('not-a-jwt'), 'MALFORMED');
  });

  it('checks claims after the signature (wrong audience, expired)', async () => {
    await expectCode(verify(await sign(goodClaims({ aud: 'other-client' }))), 'BAD_AUDIENCE');
    await expectCode(verify(await sign(goodClaims({ exp: NOW - 3600 }))), 'EXPIRED');
  });
});
