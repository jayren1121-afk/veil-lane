import { googleClientId } from './config';

const GIS_SRC = 'https://accounts.google.com/gsi/client';

interface GoogleId {
  initialize(options: { client_id: string; callback: (response: { credential: string }) => void; ux_mode?: string }): void;
  renderButton(element: HTMLElement, options: Record<string, unknown>): void;
}

let loader: Promise<GoogleId> | null = null;

export function isGoogleSignInEnabled(): boolean {
  return Boolean(googleClientId());
}

function loadGis(): Promise<GoogleId> {
  if (loader) return loader;
  loader = new Promise((resolve, reject) => {
    const ready = () => {
      const id = (window as unknown as { google?: { accounts?: { id?: GoogleId } } }).google?.accounts?.id;
      if (id) resolve(id);
      else reject(new Error('GIS_UNAVAILABLE'));
    };
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${GIS_SRC}"]`);
    if (existing) {
      existing.addEventListener('load', ready);
      if ((window as unknown as { google?: unknown }).google) ready();
      return;
    }
    const script = document.createElement('script');
    script.src = GIS_SRC;
    script.async = true;
    script.defer = true;
    script.onload = ready;
    script.onerror = () => {
      loader = null;
      reject(new Error('GIS_LOAD_FAILED'));
    };
    document.head.appendChild(script);
  });
  return loader;
}

/** Renders the official "Sign in with Google" button into `element`; calls back with the ID token. */
export async function renderGoogleButton(element: HTMLElement, onCredential: (credential: string) => void): Promise<void> {
  const clientId = googleClientId();
  if (!clientId) return;
  const id = await loadGis();
  id.initialize({ client_id: clientId, callback: response => onCredential(response.credential) });
  id.renderButton(element, { theme: 'filled_blue', size: 'large', shape: 'pill', text: 'signin_with', width: 300 });
}
