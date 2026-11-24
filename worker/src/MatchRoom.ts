import { DurableObject } from 'cloudflare:workers';
import { OnlineMatch, OnlineMatchData } from '../../src/game/online/match';
import type { ClientMessage, ServerMessage } from '../../src/game/online/protocol';
import { sanitizeNickname } from '../../src/game/online/roomCode';
import { Player } from '../../src/game/rules/types';
import type { Env } from './env';
import { randomToken } from './session';

/** Idle rooms are wiped after this long without any connected player. */
const IDLE_CLEANUP_MS = 2 * 60 * 60 * 1000;
/** After an expired rematch offer, give clients a moment to show it, then close the room. */
const REMATCH_CLOSE_MS = 8000;

interface SocketAttachment {
  player: Player;
}

/**
 * One Durable Object per 4-character room. Holds the authoritative match and talks to both
 * players over hibernatable WebSockets; timers are enforced with a single storage alarm.
 */
export class MatchRoom extends DurableObject<Env> {
  private match: OnlineMatch | null = null;
  private cleanupAt: number | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const data = await ctx.storage.get<OnlineMatchData>('match');
      // Rooms saved by an older rules version (before lane-by-lane play) cannot be resumed.
      this.match = data && 'play' in data && (data.play === null || 'hands' in data.play) ? new OnlineMatch(data) : null;
      this.cleanupAt = (await ctx.storage.get<number>('cleanupAt')) ?? null;
    });
  }

  /** Called once by the Worker when a code is handed out. Returns false if the code is taken. */
  async init(code: string): Promise<boolean> {
    if (this.match) return false;
    this.match = OnlineMatch.create(code);
    this.cleanupAt = Date.now() + IDLE_CLEANUP_MS;
    await this.persist();
    return true;
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Expected WebSocket', { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    const url = new URL(request.url);

    if (!this.match) {
      server.accept();
      this.sendTo(server, { type: 'error', code: 'ROOM_NOT_FOUND', message: 'Room not found' });
      server.close(4004, 'Room not found');
      return new Response(null, { status: 101, webSocket: client });
    }

    const accountId = request.headers.get('X-Veil-Account') || null;
    const name = sanitizeNickname(request.headers.get('X-Veil-Name'), 'Guest');
    const joined = this.match.join(name, accountId, url.searchParams.get('session'), () => randomToken(18));
    if (!joined.ok) {
      server.accept();
      this.sendTo(server, { type: 'error', code: 'ROOM_FULL', message: 'Room is full' });
      server.close(4009, 'Room full');
      return new Response(null, { status: 101, webSocket: client });
    }

    // Drop any older socket for the same seat (e.g. a stale tab) before accepting the new one.
    for (const old of this.ctx.getWebSockets(joined.player)) {
      try { old.close(4001, 'Replaced by a new connection'); } catch { /* already closed */ }
    }
    this.ctx.acceptWebSocket(server, [joined.player]);
    server.serializeAttachment({ player: joined.player } satisfies SocketAttachment);

    const now = Date.now();
    this.match.tick(now);
    this.match.startIfReady(now);
    this.cleanupAt = null;
    this.sendTo(server, {
      type: 'welcome', you: joined.player, sessionToken: joined.sessionToken, roomCode: this.match.data.roomCode,
    });
    await this.commit(now);
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (!this.match || typeof raw !== 'string' || raw.length > 2000) return;
    const attachment = ws.deserializeAttachment() as SocketAttachment | null;
    if (!attachment) return;
    let message: ClientMessage;
    try {
      message = JSON.parse(raw) as ClientMessage;
    } catch {
      return;
    }
    const now = Date.now();
    let error: string | null = null;
    switch (message.type) {
      case 'ping':
        this.sendTo(ws, { type: 'pong', serverNow: now });
        return;
      case 'pick':
        error = typeof message.cardId === 'string' ? this.match.pick(attachment.player, message.cardId, now) : 'BAD_MESSAGE';
        break;
      case 'partner':
        {
          const ids = (message as { cardIds?: unknown }).cardIds;
          error = Array.isArray(ids) && ids.length <= 10 && ids.every(id => typeof id === 'string')
            ? this.match.partner(attachment.player, ids as string[], now)
            : 'BAD_MESSAGE';
        }
        break;
      case 'ready':
        error = this.match.ready(attachment.player, now);
        break;
      case 'rematch':
        error = this.match.rematch(attachment.player, now);
        break;
      case 'leave':
        error = this.match.leave(attachment.player, now);
        break;
      default:
        error = 'BAD_MESSAGE';
    }
    if (error) this.sendTo(ws, { type: 'error', code: error, message: error });
    await this.commit(now);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.handleDisconnect(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.handleDisconnect(ws);
  }

  private async handleDisconnect(ws: WebSocket): Promise<void> {
    if (!this.match) return;
    const attachment = ws.deserializeAttachment() as SocketAttachment | null;
    if (!attachment) return;
    const stillOpen = this.ctx.getWebSockets(attachment.player)
      .some(socket => socket !== ws && socket.readyState === WebSocket.OPEN);
    if (!stillOpen) this.match.setConnected(attachment.player, false);
    const anyone = this.ctx.getWebSockets().some(socket => socket !== ws && socket.readyState === WebSocket.OPEN);
    if (!anyone) this.cleanupAt = Date.now() + IDLE_CLEANUP_MS;
    await this.commit(Date.now());
  }

  async alarm(): Promise<void> {
    const now = Date.now();
    if (this.cleanupAt !== null && now >= this.cleanupAt) {
      for (const socket of this.ctx.getWebSockets()) {
        try { socket.close(4000, 'Room expired'); } catch { /* ignore */ }
      }
      this.match = null;
      this.cleanupAt = null;
      await this.ctx.storage.deleteAlarm();
      await this.ctx.storage.deleteAll();
      return;
    }
    if (this.match) {
      this.match.tick(now);
      await this.commit(now);
    }
  }

  /** Persist, record finished-match stats once, broadcast and re-arm the alarm. */
  private async commit(now: number): Promise<void> {
    if (!this.match) return;
    if (this.match.data.phase === 'matchEnd' && !this.match.data.resultRecorded) {
      this.match.data.resultRecorded = true;
      const outcomes = this.match.outcomes();
      if (outcomes.length > 0) {
        try {
          await this.env.ACCOUNTS.get(this.env.ACCOUNTS.idFromName('global')).recordMatch(outcomes);
        } catch (err) {
          console.error('recordMatch failed', err instanceof Error ? err.message : 'unknown');
        }
      }
      if (this.cleanupAt === null) this.cleanupAt = now + IDLE_CLEANUP_MS;
    }
    const data = this.match.data;
    if (data.phase === 'matchEnd' && data.rematchClosed) {
      // Rematch offer expired: close the room shortly so both players return to the lobby.
      const closeAt = now + REMATCH_CLOSE_MS;
      if (this.cleanupAt === null || this.cleanupAt > closeAt) this.cleanupAt = closeAt;
    } else if (data.phase === 'battle' && this.cleanupAt !== null
      && this.ctx.getWebSockets().some(socket => socket.readyState === WebSocket.OPEN)) {
      // A rematch started: the room is in use again.
      this.cleanupAt = null;
    }
    await this.persist();
    this.broadcast(now);
    const times = [this.match.nextDeadline(), this.cleanupAt].filter((value): value is number => value !== null);
    if (times.length > 0) await this.ctx.storage.setAlarm(Math.max(now + 50, Math.min(...times)));
    else await this.ctx.storage.deleteAlarm();
  }

  private async persist(): Promise<void> {
    await this.ctx.storage.put('match', this.match?.data ?? null);
    await this.ctx.storage.put('cleanupAt', this.cleanupAt);
  }

  private broadcast(now: number): void {
    if (!this.match) return;
    for (const socket of this.ctx.getWebSockets()) {
      const attachment = socket.deserializeAttachment() as SocketAttachment | null;
      if (!attachment) continue;
      this.sendTo(socket, { type: 'state', state: this.match.viewFor(attachment.player, now) });
    }
  }

  private sendTo(socket: WebSocket, message: ServerMessage): void {
    try {
      socket.send(JSON.stringify(message));
    } catch {
      // Socket already closed; the client will reconnect and receive a fresh state.
    }
  }
}
