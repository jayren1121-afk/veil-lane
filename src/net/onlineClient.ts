import type { ClientMessage, MatchView, ServerMessage } from '../game/online/protocol';
import { normalizeRoomCode } from '../game/online/roomCode';
import { httpBase, wsBase } from './config';
import { currentDisplayName, getSessionToken } from './identity';

export type ConnectionStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

type StateListener = (state: MatchView) => void;
type EventListener = (event: OnlineEvent) => void;

export type OnlineEvent =
  | { kind: 'status'; status: ConnectionStatus }
  | { kind: 'error'; code: string };

const ROOM_SESSION_PREFIX = 'veil-lane-room-';
const MAX_RECONNECT_ATTEMPTS = 8;

function sessionStore(): Storage | null {
  try {
    return typeof sessionStorage === 'undefined' ? null : sessionStorage;
  } catch {
    return null;
  }
}

/** Asks the Worker for a fresh 4-character room code. */
export async function createRoom(): Promise<string> {
  const response = await fetch(`${httpBase()}/api/rooms`, { method: 'POST' });
  const body = await response.json().catch(() => ({})) as { code?: string; error?: string };
  if (!response.ok || !body.code) throw new Error(body.error ?? `HTTP_${response.status}`);
  return body.code;
}

/**
 * WebSocket client for one room. Keeps the latest server view, estimates the server clock offset,
 * and reconnects automatically with the per-room session token (kept in sessionStorage).
 */
export class OnlineClient {
  state: MatchView | null = null;
  status: ConnectionStatus = 'idle';
  /** serverNow - Date.now(), measured on every state message. */
  clockOffset = 0;
  private ws: WebSocket | null = null;
  private readonly stateListeners = new Set<StateListener>();
  private readonly eventListeners = new Set<EventListener>();
  private attempts = 0;
  private closedByUser = false;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(public readonly roomCode: string) {}

  get sessionKey(): string {
    return `${ROOM_SESSION_PREFIX}${this.roomCode}`;
  }

  serverNow(): number {
    return Date.now() + this.clockOffset;
  }

  connect(): void {
    this.closedByUser = false;
    this.setStatus(this.attempts > 0 ? 'reconnecting' : 'connecting');
    const params = new URLSearchParams({ name: currentDisplayName() || 'Guest' });
    const session = sessionStore()?.getItem(this.sessionKey);
    if (session) params.set('session', session);
    const auth = getSessionToken();
    if (auth) params.set('auth', auth);
    const ws = new WebSocket(`${wsBase()}/api/rooms/${this.roomCode}/ws?${params}`);
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.attempts = 0;
      this.setStatus('open');
      this.pingTimer = setInterval(() => this.send({ type: 'ping' }), 20000);
    });
    ws.addEventListener('message', event => this.handleMessage(String(event.data)));
    ws.addEventListener('close', event => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      if (this.ws !== ws) return;
      const fatal = event.code === 4004 || event.code === 4009 || event.code === 4000 || event.code === 4001;
      if (this.closedByUser || fatal || this.attempts >= MAX_RECONNECT_ATTEMPTS) {
        this.setStatus('closed');
        return;
      }
      this.attempts += 1;
      this.setStatus('reconnecting');
      this.reconnectTimer = setTimeout(() => this.connect(), Math.min(8000, 500 * 2 ** this.attempts));
    });
  }

  private handleMessage(raw: string): void {
    let message: ServerMessage;
    try {
      message = JSON.parse(raw) as ServerMessage;
    } catch {
      return;
    }
    switch (message.type) {
      case 'welcome':
        sessionStore()?.setItem(this.sessionKey, message.sessionToken);
        break;
      case 'state':
        this.clockOffset = message.state.serverNow - Date.now();
        this.state = message.state;
        this.stateListeners.forEach(listener => listener(message.state));
        break;
      case 'pong':
        this.clockOffset = message.serverNow - Date.now();
        break;
      case 'error':
        this.eventListeners.forEach(listener => listener({ kind: 'error', code: message.code }));
        break;
    }
  }

  send(message: ClientMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(message));
  }

  onState(listener: StateListener): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  onEvent(listener: EventListener): () => void {
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  close(): void {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.ws?.close(1000, 'bye');
    this.ws = null;
    this.setStatus('closed');
  }

  private setStatus(status: ConnectionStatus): void {
    this.status = status;
    this.eventListeners.forEach(listener => listener({ kind: 'status', status }));
  }
}

// ----- app-wide online session -----

let active: OnlineClient | null = null;
let pendingInviteCode: string | null = null;

export function getOnlineClient(): OnlineClient | null {
  return active;
}

export function startOnline(roomCode: string): OnlineClient {
  active?.close();
  active = new OnlineClient(roomCode);
  active.connect();
  return active;
}

/** Leave the room for good: tells the server (frees a waiting seat / forfeits mid-match), then closes. */
export function leaveOnline(): void {
  active?.send({ type: 'leave' });
  active?.close();
  active = null;
}

/** Reads `?room=XXXX` from the page URL once (invite links). */
export function consumeInviteCode(): string | null {
  if (pendingInviteCode) {
    const code = pendingInviteCode;
    pendingInviteCode = null;
    return code;
  }
  return null;
}

export function captureInviteFromUrl(): void {
  if (typeof window === 'undefined') return;
  const params = new URLSearchParams(window.location.search);
  const code = normalizeRoomCode(params.get('room'));
  if (code) {
    pendingInviteCode = code;
    params.delete('room');
    const query = params.toString();
    window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${window.location.hash}`);
  }
}

export function peekInviteCode(): string | null {
  return pendingInviteCode;
}

export function inviteLink(code: string): string {
  return `${window.location.origin}${window.location.pathname}?room=${code}`;
}
