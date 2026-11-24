/**
 * Server-authoritative online match. Pure TypeScript (no Cloudflare or Phaser imports)
 * so the Durable Object and unit tests share the exact same rules engine.
 */
import {
  autoCompletePick,
  BATTLE_TURN_SECONDS,
  bothReady,
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
  isPlayerReady,
  partnerOptions,
  submitMainPick,
  submitPartnerPicks,
  summarizeRound,
  TOTAL_ROUNDS,
} from '../rules';
import type { MatchView, OnlinePhase } from './protocol';

/** Time for the coin-flip animation before the first lane's clock starts. */
export const FIRST_ROUND_INTRO_MS = 4500;
export const ROUND_INTRO_MS = 2500;
export const SUMMARY_SECONDS = 60;
/** How long both players have to agree on a rematch before the room closes. */
export const REMATCH_SECONDS = 60;

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
  /** Player who left mid-match (forfeit); missing in rooms saved before this field existed. */
  forfeitedBy?: Player | null;
  /** Players who asked for a rematch after the match ended (optional: older saved rooms lack it). */
  rematch?: Player[];
  /** Players who went back to the lobby after the match ended. */
  leftAfterMatch?: Player[];
  /** When the rematch offer expires (null when none is open). */
  rematchDeadline?: number | null;
  /** The rematch offer expired: the room is closing. */
  rematchClosed?: boolean;
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
      forfeitedBy: null,
      rematch: [],
      leftAfterMatch: [],
      rematchDeadline: null,
      rematchClosed: false,
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

  /** Deal both 10-card hands for a new round; picks open after the intro. */
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
    if (!resolveCurrentLane(play)) return;
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
      this.openRematch(now);
    } else {
      this.data.phase = 'summary';
      this.data.summaryDeadline = now + LANE_REVEAL_PAUSE_MS + SUMMARY_SECONDS * 1000;
    }
  }

  // ---------- actions ----------

  /** Lock one of `player`'s two cards for the current lane as the MAIN card. */
  pick(player: Player, cardId: string, now: number): string | null {
    this.tick(now);
    const play = this.data.play;
    if (this.data.phase !== 'battle' || !play || isRoundPlayComplete(play)) return 'NOT_BATTLE_PHASE';
    const error = submitMainPick(play, player, cardId);
    if (error) return error;
    if (bothReady(play)) this.resolveLane(now);
    return null;
  }

  /** Choose `player`'s synergy partners (any subset of the options, may be empty) for the locked main card. */
  partner(player: Player, cardIds: readonly string[], now: number): string | null {
    this.tick(now);
    const play = this.data.play;
    if (this.data.phase !== 'battle' || !play || isRoundPlayComplete(play)) return 'NOT_BATTLE_PHASE';
    const error = submitPartnerPicks(play, player, cardIds);
    if (error) return error;
    if (bothReady(play)) this.resolveLane(now);
    return null;
  }

  ready(player: Player, now: number): string | null {
    this.tick(now);
    if (this.data.phase !== 'summary') return 'NOT_SUMMARY_PHASE';
    if (!this.data.ready.includes(player)) this.data.ready.push(player);
    if (this.data.ready.length === 2) this.nextRound(now);
    return null;
  }

  /** After a finished match: `player` wants to play again. When both ask, a fresh Bo3 starts in this room. */
  rematch(player: Player, now: number): string | null {
    this.tick(now);
    const data = this.data;
    if (data.phase !== 'matchEnd' || data.forfeitedBy || data.rematchDeadline == null) return 'NO_REMATCH';
    if (data.rematchClosed) return 'REMATCH_EXPIRED';
    const opponent = player === Player.P1 ? Player.P2 : Player.P1;
    if (this.opponentGone(opponent)) return 'OPPONENT_LEFT';
    const list = data.rematch ?? (data.rematch = []);
    if (!list.includes(player)) list.push(player);
    if (list.length === 2) this.restartMatch(now);
    return null;
  }

  private openRematch(now: number): void {
    this.data.rematch = [];
    this.data.leftAfterMatch = [];
    this.data.rematchDeadline = now + REMATCH_SECONDS * 1000;
    this.data.rematchClosed = false;
  }

  /** The opponent went back to the lobby after the match, or is currently disconnected. */
  private opponentGone(opponent: Player): boolean {
    const seat = this.data.seats[opponent];
    return !seat || !seat.connected || (this.data.leftAfterMatch ?? []).includes(opponent);
  }

  /** New Bo3 with the same players: new coin toss, empty Fearless lists, fresh hands. */
  private restartMatch(now: number): void {
    const data = this.data;
    data.round = 1;
    data.round1FirstPlayer = this.random() < 0.5 ? Player.P1 : Player.P2;
    data.p1RoundWins = 0;
    data.p2RoundWins = 0;
    data.p1UsedCardIds = [];
    data.p2UsedCardIds = [];
    data.play = null;
    data.roundResults = [];
    data.matchWinner = null;
    data.resultRecorded = false;
    data.forfeitedBy = null;
    data.rematch = [];
    data.leftAfterMatch = [];
    data.rematchDeadline = null;
    data.rematchClosed = false;
    this.startRound(now, FIRST_ROUND_INTRO_MS);
  }

  /**
   * `player` leaves the room. While waiting, their seat is freed so someone else can join.
   * Mid-match (battle or summary) it is a forfeit: the match ends at once and the other
   * player wins. After the match it only withdraws them from the rematch offer.
   */
  leave(player: Player, now: number): string | null {
    this.tick(now);
    const data = this.data;
    if (data.phase === 'waiting') {
      delete data.seats[player];
      return null;
    }
    if (data.phase === 'matchEnd') {
      const left = data.leftAfterMatch ?? (data.leftAfterMatch = []);
      if (!left.includes(player)) left.push(player);
      data.rematch = (data.rematch ?? []).filter(item => item !== player);
      return null;
    }
    data.phase = 'matchEnd';
    data.matchWinner = player === Player.P1 ? Player.P2 : Player.P1;
    data.forfeitedBy = player;
    data.turnStartsAt = null;
    data.turnDeadline = null;
    data.summaryDeadline = null;
    data.ready = [];
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
        autoCompletePick(play, Player.P1, this.random);
        autoCompletePick(play, Player.P2, this.random);
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
      if (this.data.phase === 'matchEnd' && !this.data.rematchClosed && this.data.rematchDeadline != null
        && isTurnExpired(this.data.rematchDeadline, now)) {
        this.data.rematchClosed = true;
        this.data.rematch = [];
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
      case 'matchEnd': return this.data.rematchClosed ? null : this.data.rematchDeadline ?? null;
      default: return null;
    }
  }

  // ---------- views ----------

  /**
   * Everything `player` is allowed to see. The opponent's hand, current main card and partner
   * are never included; their cards only appear inside resolved lane results.
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
        myHand: play.hands[player].map(ids => [...ids]),
        myMain: live ? play.mains[player] : null,
        myPartners: live ? [...(play.partners[player] ?? [])] : [],
        needPartner: live && play.mains[player] !== null && !play.partnerDone[player],
        myPartnerOptions: live && play.mains[player] !== null
          ? partnerOptions(play, player, play.mains[player]!).map(link => link.card.id) : [],
        myRed: [...play.red[player]],
        opponentLocked: live ? isPlayerReady(play, opponent) : false,
        // Open candidates: the opponent's two cards for this lane, in deal order (never reordered by their pick).
        opponentCandidates: live ? [...play.hands[opponent][play.laneIndex]] : [],
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
      forfeitedBy: data.phase === 'matchEnd' ? data.forfeitedBy ?? null : null,
      rematch: this.rematchViewFor(player),
    };
  }

  private rematchViewFor(player: Player): MatchView['rematch'] {
    const data = this.data;
    if (data.phase !== 'matchEnd' || data.forfeitedBy || data.rematchDeadline == null) return null;
    const opponent = player === Player.P1 ? Player.P2 : Player.P1;
    const list = data.rematch ?? [];
    return {
      you: list.includes(player),
      opponent: list.includes(opponent),
      opponentLeft: this.opponentGone(opponent),
      deadline: data.rematchClosed ? null : data.rematchDeadline,
      closed: Boolean(data.rematchClosed),
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
