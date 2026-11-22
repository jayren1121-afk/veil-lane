import { sanitizeNickname } from '../game/online/roomCode';
import { httpBase } from './config';

export interface Account {
  id: string;
  nickname: string;
  wins: number;
  losses: number;
  draws: number;
}

const SESSION_KEY = 'veil-lane-session';
const GUEST_KEY = 'veil-lane-guest-name';

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

let cachedAccount: Account | null = null;

export function getSessionToken(): string {
  return storage()?.getItem(SESSION_KEY) ?? '';
}

function setSessionToken(token: string): void {
  if (token) storage()?.setItem(SESSION_KEY, token);
  else storage()?.removeItem(SESSION_KEY);
}

export function getGuestName(): string {
  return storage()?.getItem(GUEST_KEY) ?? '';
}

export function setGuestName(name: string): string {
  const clean = sanitizeNickname(name, '');
  if (clean) storage()?.setItem(GUEST_KEY, clean);
  return clean;
}

export function getAccount(): Account | null {
  return cachedAccount;
}

/** Display name used in the lobby / match: account nickname, else guest nickname. */
export function currentDisplayName(): string {
  return cachedAccount?.nickname ?? getGuestName();
}

export function hasIdentity(): boolean {
  return Boolean(cachedAccount || getGuestName());
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body) headers.set('Content-Type', 'application/json');
  const token = getSessionToken();
  if (token) headers.set('Authorization', `Bearer ${token}`);
  const response = await fetch(`${httpBase()}${path}`, { ...init, headers });
  const body = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? `HTTP_${response.status}`);
  return body;
}

/** Restores the signed-in account from the stored session token (if any). */
export async function refreshAccount(): Promise<Account | null> {
  if (!getSessionToken()) {
    cachedAccount = null;
    return null;
  }
  try {
    const { account } = await api<{ account: Account }>('/api/me');
    cachedAccount = account;
  } catch (err) {
    if (err instanceof Error && err.message === 'UNAUTHORIZED') setSessionToken('');
    cachedAccount = null;
  }
  return cachedAccount;
}

/** Exchanges a Google ID token (from the GIS button) for our own session token. */
export async function signInWithGoogle(credential: string): Promise<Account> {
  const { token, account } = await api<{ token: string; account: Account }>('/api/auth/google', {
    method: 'POST',
    body: JSON.stringify({ credential }),
  });
  setSessionToken(token);
  cachedAccount = account;
  return account;
}

export async function updateNickname(nickname: string): Promise<Account> {
  const { account } = await api<{ account: Account }>('/api/me/nickname', {
    method: 'POST',
    body: JSON.stringify({ nickname }),
  });
  cachedAccount = account;
  return account;
}

export async function signOut(): Promise<void> {
  try {
    await api('/api/auth/logout', { method: 'POST' });
  } catch {
    // Logging out locally is enough if the server is unreachable.
  }
  setSessionToken('');
  cachedAccount = null;
  try {
    (window as unknown as { google?: { accounts?: { id?: { disableAutoSelect?: () => void } } } })
      .google?.accounts?.id?.disableAutoSelect?.();
  } catch {
    // ignore
  }
}
