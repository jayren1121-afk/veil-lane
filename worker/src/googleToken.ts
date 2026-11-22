/**
 * Verifies a Google Identity Services ID token (JWT, RS256) with WebCrypto only.
 * Works in Cloudflare Workers and Node 20+ (globalThis.crypto.subtle).
 */
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
export const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];
/** Allowed clock skew in seconds. */
export const CLOCK_SKEW_SECONDS = 60;

export interface GoogleClaims {
  iss: string;
  aud: string | string[];
  sub: string;
  exp: number;
  iat?: number;
  nbf?: number;
  name?: string;
  given_name?: string;
  email?: string;
  email_verified?: boolean;
  [key: string]: unknown;
}

export interface JsonWebKeyWithKid extends JsonWebKey {
  kid?: string;
}

export interface Jwks {
  keys: JsonWebKeyWithKid[];
}

export class TokenError extends Error {
  constructor(public readonly code: string, message = code) {
    super(message);
    this.name = 'TokenError';
  }
}

export function base64UrlToBytes(input: string): Uint8Array {
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((input.length + 3) % 4);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function decodeJsonPart<T>(part: string, code: string): T {
  try {
    return JSON.parse(new TextDecoder().decode(base64UrlToBytes(part))) as T;
  } catch {
    throw new TokenError(code);
  }
}

/** Checks iss / aud / exp / iat / nbf / sub. Throws TokenError on the first problem. */
export function validateGoogleClaims(claims: GoogleClaims, clientId: string, nowSeconds: number): GoogleClaims {
  if (!clientId) throw new TokenError('NO_CLIENT_ID');
  if (!GOOGLE_ISSUERS.includes(claims.iss)) throw new TokenError('BAD_ISSUER');
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audiences.includes(clientId)) throw new TokenError('BAD_AUDIENCE');
  if (typeof claims.exp !== 'number' || claims.exp + CLOCK_SKEW_SECONDS <= nowSeconds) throw new TokenError('EXPIRED');
  if (typeof claims.iat === 'number' && claims.iat - CLOCK_SKEW_SECONDS > nowSeconds) throw new TokenError('ISSUED_IN_FUTURE');
  if (typeof claims.nbf === 'number' && claims.nbf - CLOCK_SKEW_SECONDS > nowSeconds) throw new TokenError('NOT_YET_VALID');
  if (typeof claims.sub !== 'string' || claims.sub.length === 0) throw new TokenError('NO_SUBJECT');
  return claims;
}

export interface VerifyOptions {
  clientId: string;
  nowSeconds?: number;
  getJwks?: () => Promise<Jwks>;
}

let jwksCache: { jwks: Jwks; expiresAt: number } | null = null;

export async function fetchGoogleJwks(): Promise<Jwks> {
  const now = Date.now();
  if (jwksCache && jwksCache.expiresAt > now) return jwksCache.jwks;
  const response = await fetch(GOOGLE_JWKS_URL);
  if (!response.ok) throw new TokenError('JWKS_UNAVAILABLE');
  const jwks = await response.json() as Jwks;
  const maxAge = /max-age=(\d+)/.exec(response.headers.get('cache-control') ?? '')?.[1];
  jwksCache = { jwks, expiresAt: now + Math.min(Number(maxAge ?? 3600), 86400) * 1000 };
  return jwks;
}

/** Verifies signature (RS256 with the key named by `kid`) and the standard claims. */
export async function verifyGoogleIdToken(token: string, options: VerifyOptions): Promise<GoogleClaims> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new TokenError('MALFORMED');
  const [headerPart, payloadPart, signaturePart] = parts;
  const header = decodeJsonPart<{ alg?: string; kid?: string }>(headerPart, 'MALFORMED');
  if (header.alg !== 'RS256') throw new TokenError('BAD_ALGORITHM');
  const jwks = await (options.getJwks ?? fetchGoogleJwks)();
  const jwk = jwks.keys.find(key => key.kid === header.kid);
  if (!jwk) throw new TokenError('UNKNOWN_KEY');
  const key = await crypto.subtle.importKey(
    'jwk',
    { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['verify'],
  );
  const signed = new TextEncoder().encode(`${headerPart}.${payloadPart}`);
  const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, base64UrlToBytes(signaturePart), signed);
  if (!valid) throw new TokenError('BAD_SIGNATURE');
  const claims = decodeJsonPart<GoogleClaims>(payloadPart, 'MALFORMED');
  return validateGoogleClaims(claims, options.clientId, options.nowSeconds ?? Math.floor(Date.now() / 1000));
}
