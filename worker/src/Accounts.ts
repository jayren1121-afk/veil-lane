import { DurableObject } from 'cloudflare:workers';
import { sanitizeNickname } from '../../src/game/online/roomCode';
import type { Env } from './env';
import { randomToken, sha256Hex } from './session';

export const SESSION_DAYS = 30;

export interface PublicAccount {
  id: string;
  nickname: string;
  wins: number;
  losses: number;
  draws: number;
}

interface AccountRow {
  id: string;
  nickname: string;
  wins: number;
  losses: number;
  draws: number;
  [key: string]: SqlStorageValue;
}

/**
 * Singleton SQLite Durable Object holding Google-linked accounts, sessions and rate limits.
 * Stores only the Google `sub` (as an internal id), a nickname and win/loss counts. No email.
 */
export class Accounts extends DurableObject<Env> {
  private readonly sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        nickname TEXT NOT NULL,
        wins INTEGER NOT NULL DEFAULT 0,
        losses INTEGER NOT NULL DEFAULT 0,
        draws INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        account_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS rate_limits (
        key TEXT PRIMARY KEY,
        window_start INTEGER NOT NULL,
        count INTEGER NOT NULL
      );
    `);
  }

  private account(id: string): PublicAccount | null {
    const row = this.sql.exec<AccountRow>('SELECT id, nickname, wins, losses, draws FROM accounts WHERE id = ?', id)
      .toArray()[0];
    return row ? { id: row.id, nickname: row.nickname, wins: row.wins, losses: row.losses, draws: row.draws } : null;
  }

  /** Creates the account on first sign-in (nickname from the Google first name) and opens a session. */
  async loginWithGoogle(sub: string, suggestedName: string): Promise<{ token: string; account: PublicAccount }> {
    const id = `g:${sub}`;
    if (!this.account(id)) {
      this.sql.exec('INSERT INTO accounts (id, nickname, created_at) VALUES (?, ?, ?)',
        id, sanitizeNickname(suggestedName, 'Player'), Date.now());
    }
    const token = randomToken();
    const now = Date.now();
    this.sql.exec('DELETE FROM sessions WHERE expires_at < ?', now);
    this.sql.exec('INSERT INTO sessions (token_hash, account_id, expires_at) VALUES (?, ?, ?)',
      await sha256Hex(token), id, now + SESSION_DAYS * 86400_000);
    return { token, account: this.account(id)! };
  }

  async accountForSession(token: string): Promise<PublicAccount | null> {
    if (!token) return null;
    const row = this.sql.exec<{ account_id: string; expires_at: number }>(
      'SELECT account_id, expires_at FROM sessions WHERE token_hash = ?', await sha256Hex(token)).toArray()[0];
    if (!row || row.expires_at < Date.now()) return null;
    return this.account(row.account_id);
  }

  async setNickname(token: string, nickname: string): Promise<PublicAccount | null> {
    const account = await this.accountForSession(token);
    if (!account) return null;
    this.sql.exec('UPDATE accounts SET nickname = ? WHERE id = ?', sanitizeNickname(nickname, account.nickname), account.id);
    return this.account(account.id);
  }

  async logout(token: string): Promise<void> {
    if (token) this.sql.exec('DELETE FROM sessions WHERE token_hash = ?', await sha256Hex(token));
  }

  async recordMatch(outcomes: { accountId: string; outcome: 'win' | 'loss' | 'draw' }[]): Promise<void> {
    for (const { accountId, outcome } of outcomes) {
      const column = outcome === 'win' ? 'wins' : outcome === 'loss' ? 'losses' : 'draws';
      this.sql.exec(`UPDATE accounts SET ${column} = ${column} + 1 WHERE id = ?`, accountId);
    }
  }

  /** Fixed-window limiter. Returns false when `key` exceeded `limit` hits in `windowSeconds`. */
  async rateLimit(key: string, limit: number, windowSeconds: number): Promise<boolean> {
    const now = Date.now();
    const row = this.sql.exec<{ window_start: number; count: number }>(
      'SELECT window_start, count FROM rate_limits WHERE key = ?', key).toArray()[0];
    if (!row || now - row.window_start >= windowSeconds * 1000) {
      this.sql.exec('INSERT OR REPLACE INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)', key, now);
      if (Math.random() < 0.02) this.sql.exec('DELETE FROM rate_limits WHERE window_start < ?', now - 86400_000);
      return true;
    }
    if (row.count >= limit) return false;
    this.sql.exec('UPDATE rate_limits SET count = count + 1 WHERE key = ?', key);
    return true;
  }
}
