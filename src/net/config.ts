const DEFAULT_SERVER = 'http://localhost:8787';

function rawServerUrl(): string {
  const value = (import.meta.env?.VITE_WS_URL ?? '').trim();
  return (value || DEFAULT_SERVER).replace(/\/+$/, '');
}

/** HTTP(S) base for REST calls, derived from VITE_WS_URL. */
export function httpBase(): string {
  return rawServerUrl().replace(/^ws(s?):\/\//, 'http$1://');
}

/** WS(S) base for the match socket, derived from VITE_WS_URL. */
export function wsBase(): string {
  return rawServerUrl().replace(/^http(s?):\/\//, 'ws$1://');
}

export function googleClientId(): string {
  return (import.meta.env?.VITE_GOOGLE_CLIENT_ID ?? '').trim();
}
