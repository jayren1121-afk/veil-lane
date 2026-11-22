import { generateRoomCode, normalizeRoomCode, sanitizeNickname } from '../../src/game/online/roomCode';
import type { Env } from './env';
import { TokenError, verifyGoogleIdToken } from './googleToken';

export { MatchRoom } from './MatchRoom';
export { Accounts } from './Accounts';

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;
const PAGES_ORIGIN = /^https:\/\/([a-z0-9-]+\.)*[a-z0-9-]+\.pages\.dev$/;

export function isAllowedOrigin(origin: string | null, extra = ''): boolean {
  if (!origin) return false;
  if (LOCAL_ORIGIN.test(origin) || PAGES_ORIGIN.test(origin)) return true;
  return extra.split(',').map(item => item.trim()).filter(Boolean).includes(origin);
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const origin = request.headers.get('Origin');
  if (!isAllowedOrigin(origin, env.ALLOWED_ORIGINS)) return {};
  return {
    'Access-Control-Allow-Origin': origin!,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function json(request: Request, env: Env, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(request, env) },
  });
}

function accounts(env: Env) {
  return env.ACCOUNTS.get(env.ACCOUNTS.idFromName('global'));
}

function bearer(request: Request): string {
  const header = request.headers.get('Authorization') ?? '';
  return header.startsWith('Bearer ') ? header.slice(7).trim() : '';
}

function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? 'local';
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    return body && typeof body === 'object' ? body as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request, env) });
    }

    if (path === '/api/health') {
      return json(request, env, { ok: true, googleSignIn: Boolean(env.GOOGLE_CLIENT_ID) });
    }

    // ----- rooms -----
    if (path === '/api/rooms' && request.method === 'POST') {
      if (!await accounts(env).rateLimit(`room:${clientIp(request)}`, 30, 60)) {
        return json(request, env, { error: 'RATE_LIMITED' }, 429);
      }
      for (let attempt = 0; attempt < 8; attempt++) {
        const code = generateRoomCode();
        const stub = env.MATCH_ROOM.get(env.MATCH_ROOM.idFromName(code));
        if (await stub.init(code)) return json(request, env, { code });
      }
      return json(request, env, { error: 'NO_FREE_CODE' }, 503);
    }

    const wsMatch = /^\/api\/rooms\/([^/]+)\/ws$/.exec(path);
    if (wsMatch && request.method === 'GET') {
      const code = normalizeRoomCode(decodeURIComponent(wsMatch[1]));
      if (!code) return json(request, env, { error: 'BAD_ROOM_CODE' }, 400);
      if (request.headers.get('Upgrade') !== 'websocket') return json(request, env, { error: 'EXPECTED_WEBSOCKET' }, 426);

      const authToken = url.searchParams.get('auth') ?? '';
      const account = authToken ? await accounts(env).accountForSession(authToken) : null;
      // Identity headers are set here only; anything the client sent with these names is replaced.
      const headers = new Headers(request.headers);
      headers.set('X-Veil-Account', account?.id ?? '');
      headers.set('X-Veil-Name', account ? account.nickname : sanitizeNickname(url.searchParams.get('name'), 'Guest'));
      const forwardUrl = new URL(request.url);
      forwardUrl.searchParams.delete('auth');
      const stub = env.MATCH_ROOM.get(env.MATCH_ROOM.idFromName(code));
      return stub.fetch(new Request(forwardUrl.toString(), { headers }));
    }

    // ----- Google sign-in & accounts -----
    if (path === '/api/auth/google' && request.method === 'POST') {
      if (!env.GOOGLE_CLIENT_ID) return json(request, env, { error: 'GOOGLE_SIGN_IN_DISABLED' }, 503);
      if (!await accounts(env).rateLimit(`login:${clientIp(request)}`, 10, 60)) {
        return json(request, env, { error: 'RATE_LIMITED' }, 429);
      }
      const body = await readJson(request);
      const credential = typeof body.credential === 'string' ? body.credential : '';
      if (!credential || credential.length > 4096) return json(request, env, { error: 'MISSING_CREDENTIAL' }, 400);
      try {
        const claims = await verifyGoogleIdToken(credential, { clientId: env.GOOGLE_CLIENT_ID });
        const suggested = claims.given_name || claims.name || 'Player';
        const result = await accounts(env).loginWithGoogle(claims.sub, String(suggested));
        return json(request, env, result);
      } catch (err) {
        const code = err instanceof TokenError ? err.code : 'VERIFY_FAILED';
        return json(request, env, { error: code }, 401);
      }
    }

    if (path === '/api/me' && request.method === 'GET') {
      const account = await accounts(env).accountForSession(bearer(request));
      return account ? json(request, env, { account }) : json(request, env, { error: 'UNAUTHORIZED' }, 401);
    }

    if (path === '/api/me/nickname' && request.method === 'POST') {
      const body = await readJson(request);
      const account = await accounts(env).setNickname(bearer(request), String(body.nickname ?? ''));
      return account ? json(request, env, { account }) : json(request, env, { error: 'UNAUTHORIZED' }, 401);
    }

    if (path === '/api/auth/logout' && request.method === 'POST') {
      await accounts(env).logout(bearer(request));
      return json(request, env, { ok: true });
    }

    return json(request, env, { error: 'NOT_FOUND' }, 404);
  },
} satisfies ExportedHandler<Env>;
