/**
 * Server-authoritative online match. Pure TypeScript (no Cloudflare or Phaser imports)
 * so the Durable Object and unit tests share the exact same rules engine.
 */
import {
  autoLanePick,
  BATTLE_TURN_SECONDS,
  bothPicked,
  createRoundPlay,
  createTurnDeadline,
  currentPlayLane,
  GamePhase,
  getFirstPlayerForRound,
  isRoundPlayComplete,
  isTurnExpired,
  Lane,
  LANE_ORDER,
  LANE_REVEAL_PAUSE_MS,
  MatchState,
  Player,
  recordRoundResult,
  resolveCurrentLane,
  RoundPlay,
  RoundResult,
  submitLanePick,
  summarizeRound,
  TOTAL_ROUNDS,
} from '../rules';
import type { MatchView, OnlinePhase } from './protocol';

/** Time for the coin-flip animation before the first lane's clock starts. */
export const FIRST_ROUND_INTRO_MS = 4500;
export const ROUND_INTRO_MS = 2500;
export const SUMMARY_SECONDS = 60;

export interface Seat {
  name: string;
  sessionToken: string;
  accountId: string | null;
  connected: boolean;
}

export interface OnlineMatchData {
  roomCode: string;
  phase: OnlinePhase;
  round: number;
  round1FirstPlayer: Player;
  p1RoundWins: number;
  p2RoundWins: number;
  p1UsedCardIds: string[];
  p2UsedCardIds: string[];
  /** The round being played lane by lane (kept through summary so results stay visible). */
  play: RoundPlay | null;
  turnStartsAt: number | null;
  turnDeadline: number | null;
  roundResults: RoundResult[];
  matchWinner: Player | null;
  ready: Player[];
  summaryDeadline: number | null;
  seats: Partial<Record<Player, Seat>>;
  resultRecorded: boolean;
}

export type JoinResult = { ok: true; player: Player; sessionToken: string; rejoined: boolean } | { ok: false; code: 'ROOM_FULL' };

export class OnlineMatch {
  constructor(public data: OnlineMatchData, private readonly random: () => number = Math.random) {}

  static create(roomCode: string, random: () => number = Math.random): OnlineMatch {
    return new OnlineMatch({
      roomCode,
      phase: 'waiting',
      round: 1,
      round1FirstPlayer: random() < 0.5 ? Player.P1 : Player.P2,
      p1RoundWins: 0,
      p2RoundWins: 0,
      p1UsedCardIds: [],
      p2UsedCardIds: [],
      play: null,
      turnStartsAt: null,
      turnDeadline: null,
      roundResults: [],
      matchWinner: null,
      ready: [],
      summaryDeadline: null,
      seats: {},
      resultRecorded: false,
    }, random);
  }

  // ---------- seats ----------

  /** Join with an existing session token (reconnect) or take the next free seat. */
  join(name: string, accountId: string | null, sessionToken: string | null, newToken: () => string): JoinResult {
    if (sessionToken) {
      for (const player of [Player.P1, Player.P2]) {
        const seat = this.data.seats[player];
        if (seat && seat.sessionToken === sessionToken) {
          seat.connected = true;
          return { ok: true, player, sessionToken, rejoined: true };
        }
      }
    }
    const free = [Player.P1, Player.P2].find(player => !this.data.seats[player]);
    if (!free) return { ok: false, code: 'ROOM_FULL' };
    const token = newToken();
    this.data.seats[free] = { name, accountId, sessionToken: token, connected: true };
    return { ok: true, player: free, sessionToken: token, rejoined: false };
  }

  setConnected(player: Player, connected: boolean): void {
    const seat = this.data.seats[player];
    if (seat) seat.connected = connected;
  }

  isFull(): boolean {
    return Boolean(this.data.seats.P1 && this.data.seats.P2);
  }

  /** Starts round 1 once both seats are filled. Returns true if the match started. */
  startIfReady(now: number): boolean {
    if (this.data.phase !== 'waiting' || !this.isFull()) return false;
    this.startRound(now, FIRST_ROUND_INTRO_MS);
    return true;
  }

  // ---------- phases ----------

  private matchStateMirror(): MatchState {
    return {
      p1UsedCardIds: new Set(this.data.p1UsedCardIds),
      p2UsedCardIds: new Set(this.data.p2UsedCardIds),
      currentRound: this.data.round,
      round1FirstPlayer: this.data.round1FirstPlayer,
      p1RoundWins: this.data.p1RoundWins,
      p2RoundWins: this.data.p2RoundWins,
      roundResults: [...this.data.roundResults],
      matchWinner: this.data.matchWinner,
      phase: GamePhase.Place,
    };
  }

  /** Deal the first lane of a new round; picks open after the intro. */
  private startRound(now: number, introMs: number): void {
    this.data.phase = 'battle';
    this.data.play = createRoundPlay(this.data.round, {
      [Player.P1]: this.data.p1UsedCardIds,
      [Player.P2]: this.data.p2UsedCardIds,
    } as Record<Player, string[]>, this.random);
    this.data.turnStartsAt = now + introMs;
    this.data.turnDeadline = createTurnDeadline(now, introMs, BATTLE_TURN_SECONDS);
    this.data.ready = [];
    this.data.summaryDeadline = null;
  }

  firstPlayer(round = this.data.round): Player {
    return getFirstPlayerForRound(this.data.round1FirstPlayer, round);
  }

  /** Resolve the current lane, then either open the next lane after the pause or end the round. */
  private resolveLane(now: number): void {
    const play = this.data.play!;
    if (!resolveCurrentLane(play, this.random)) return;
    if (isRoundPlayComplete(play)) {
      this.finishRound(now);
    } else {
      this.data.turnStartsAt = now + LANE_REVEAL_PAUSE_MS;
      this.data.turnDeadline = createTurnDeadline(now, LANE_REVEAL_PAUSE_MS, BATTLE_TURN_SECONDS);
    }
  }

  private finishRound(now: number): void {
    const play = this.data.play!;
    const mirror = this.matchStateMirror();
    recordRoundResult(mirror, summarizeRound(play.results, this.firstPlayer()));
    this.data.p1UsedCardIds = [...mirror.p1UsedCardIds];
    this.data.p2UsedCardIds = [...mirror.p2UsedCardIds];
    this.data.p1RoundWins = mirror.p1RoundWins;
    this.data.p2RoundWins = mirror.p2RoundWins;
    this.data.roundResults = mirror.roundResults;
    this.data.matchWinner = mirror.matchWinner;
    this.data.turnStartsAt = null;
    this.data.turnDeadline = null;
    this.data.ready = [];
    if (mirror.phase === GamePhase.MatchEnd) {
      this.data.phase = 'matchEnd';
      this.data.summaryDeadline = null;
    } else {
      this.data.phase = 'summary';
      this.data.summaryDeadline = now + LANE_REVEAL_PAUSE_MS + SUMMARY_SECONDS * 1000;
    }
  }

  // ---------- actions ----------

  /** Lock one of `player`'s two offered cards for the current lane. */
  pick(player: Player, cardId: string, now: number): string | null {
    this.tick(now);
    const play = this.data.play;
    if (this.data.phase !== 'battle' || !play || isRoundPlayComplete(play)) return 'NOT_BATTLE_PHASE';
    const error = submitLanePick(play, player, cardId);
    if (error) return error;
    if (bothPicked(play)) this.resolveLane(now);
    return null;
  }

  ready(player: Player, now: number): string | null {
    this.tick(now);
    if (this.data.phase !== 'summary') return 'NOT_SUMMARY_PHASE';
    if (!this.data.ready.includes(player)) this.data.ready.push(player);
    if (this.data.ready.length === 2) this.nextRound(now);
    return null;
  }

  private nextRound(now: number): void {
    if (this.data.round >= TOTAL_ROUNDS) return;
    this.data.round += 1;
    this.startRound(now, ROUND_INTRO_MS);
  }

  /** Applies every expired deadline. Returns true if anything changed. */
  tick(now: number): boolean {
    let changed = false;
    for (let guard = 0; guard < 20; guard++) {
      const play = this.data.play;
      if (this.data.phase === 'battle' && play && !isRoundPlayComplete(play) && this.data.turnDeadline !== null
        && isTurnExpired(this.data.turnDeadline, now)) {
        autoLanePick(play, Player.P1, this.random);
        autoLanePick(play, Player.P2, this.random);
        this.resolveLane(now);
        changed = true;
        continue;
      }
      if (this.data.phase === 'summary' && this.data.summaryDeadline !== null
        && isTurnExpired(this.data.summaryDeadline, now)) {
        this.nextRound(now);
        changed = true;
        continue;
      }
      break;
    }
    return changed;
  }

  /** Next time the server must wake up to enforce a deadline. */
  nextDeadline(): number | null {
    switch (this.data.phase) {
      case 'battle': return this.data.turnDeadline;
      case 'summary': return this.data.summaryDeadline;
      default: return null;
    }
  }

  // ---------- views ----------

  /**
   * Everything `player` is allowed to see. The opponent's offered cards and current pick are
   * never included; their played cards only appear inside resolved lane results.
   */
  viewFor(player: Player, now: number): MatchView {
    const data = this.data;
    const seats: MatchView['players'] = {};
    for (const p of [Player.P1, Player.P2]) {
      const seat = data.seats[p];
      if (seat) seats[p] = { name: seat.name, connected: seat.connected, isGuest: !seat.accountId };
    }

    let battleView: MatchView['battle'] = null;
    const play = data.play;
    if ((data.phase === 'battle' || data.phase === 'summary' || data.phase === 'matchEnd') && play) {
      const opponent = player === Player.P1 ? Player.P2 : Player.P1;
      const myCards: Partial<Record<Lane, string>> = {};
      play.played[player].forEach((id, index) => { myCards[LANE_ORDER[index]] = id; });
      const live = data.phase === 'battle' && !isRoundPlayComplete(play);
      battleView = {
        lead: this.firstPlayer(),
        laneIndex: play.laneIndex,
        currentLane: live ? currentPlayLane(play) : null,
        myOffer: live ? [...play.offers[player]] : [],
        myPick: live ? play.picks[player] : null,
        opponentPicked: live ? play.picks[opponent] !== null : false,
        myCards,
        revealed: play.results,
        turnStartsAt: live ? data.turnStartsAt : null,
        turnDeadline: live ? data.turnDeadline : null,
      };
    }

    const showLastRound = data.phase === 'summary' || data.phase === 'matchEnd';
    return {
      you: player,
      roomCode: data.roomCode,
      phase: data.phase,
      round: data.round,
      serverNow: now,
      round1FirstPlayer: data.round1FirstPlayer,
      firstPlayer: this.firstPlayer(),
      players: seats,
      score: { [Player.P1]: data.p1RoundWins, [Player.P2]: data.p2RoundWins } as Record<Player, number>,
      usedCardIds: player === Player.P1 ? [...data.p1UsedCardIds] : [...data.p2UsedCardIds],
      battle: battleView,
      lastRound: showLastRound ? data.roundResults[data.roundResults.length - 1] ?? null : null,
      lastRoundNumber: data.roundResults.length,
      matchWinner: data.phase === 'matchEnd' ? data.matchWinner : null,
      ready: [...data.ready],
      summaryDeadline: data.summaryDeadline,
    };
  }

  /** Accounts that finished the match, with their outcome. Call once when phase is matchEnd. */
  outcomes(): { accountId: string; outcome: 'win' | 'loss' | 'draw' }[] {
    if (this.data.phase !== 'matchEnd') return [];
    const list: { accountId: string; outcome: 'win' | 'loss' | 'draw' }[] = [];
    for (const player of [Player.P1, Player.P2]) {
      const accountId = this.data.seats[player]?.accountId;
      if (!accountId) continue;
      const outcome = this.data.matchWinner === null ? 'draw' : this.data.matchWinner === player ? 'win' : 'loss';
      list.push({ accountId, outcome });
    }
    return list;
  }
}
