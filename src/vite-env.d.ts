/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Backend URL (Cloudflare Worker), e.g. https://veil-lane-server.<you>.workers.dev. ws(s):// also accepted. */
  readonly VITE_WS_URL?: string;
  /** Google OAuth Web client ID. Leave unset to hide "Sign in with Google" (guest only). */
  readonly VITE_GOOGLE_CLIENT_ID?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
