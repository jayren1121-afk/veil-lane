/**
 * Server-authoritative online match. Pure TypeScript (no Cloudflare or Phaser imports)
 * so the Durable Object and unit tests share the exact same rules engine.
 */
import {
  applyDraftFearless,
  autoPickRemaining,
  BATTLE_TURN_SECONDS,
  createDraftState,
  createRevealState,
  createTurnDeadline,
  DraftState,
  GamePhase,
  getCurrentDraftLane,
  getCurrentDraftPlayer,
  getDraftCandidates,
  getFirstPlayerForRound,
  isDraftComplete,
  isRevealComplete,
  isTurnExpired,
  Lane,
  LANE_ORDER,
  LANE_REVEAL_PAUSE_MS,
  LaneRevealResult,
  MatchState,
  pickCard,
  pickRandomLane,
  Placement,
  Player,
  resolveLaneDuel,
  resolveRound,
  revealLane,
  RevealState,
  RoundResult,
  TOTAL_ROUNDS,
} from '../rules';
import { CARDS } from '../data/cards';
import type { MatchView, OnlinePhase } from './protocol';

/** Time for the coin-flip animation before the first draft clock starts. */
export const FIRST_DRAFT_INTRO_MS = 4500;
export const DRAFT_INTRO_MS = 1500;
export const BATTLE_INTRO_MS = 2500;
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
  draft: DraftState | null;
  /** When the current player's draft clock started (after the intro). */
  draftClockStartedAt: number | null;
  draftDeadline: number | null;
  reveal: RevealState | null;
  laneResults: LaneRevealResult[];
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

const CARD_BY_ID = new Map(CARDS.map(card => [card.id, card]));

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
      draft: null,
      draftClockStartedAt: null,
      draftDeadline: null,
      reveal: null,
      laneResults: [],
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
    this.startDraft(now, FIRST_DRAFT_INTRO_MS);
    return true;
  }

  // ---------- phases ----------

  private matchStateMirror(): MatchState {
    return {
      p1Hand: [],
      p2Hand: [],
      p1UsedCardIds: new Set(this.data.p1UsedCardIds),
      p2UsedCardIds: new Set(this.data.p2UsedCardIds),
      currentRound: this.data.round,
      round1FirstPlayer: this.data.round1FirstPlayer,
      p1RoundWins: this.data.p1RoundWins,
      p2RoundWins: this.data.p2RoundWins,
      roundResults: [...this.data.roundResults],
      matchWinner: this.data.matchWinner,
      phase: GamePhase.Draft,
    };
  }

  private startDraft(now: number, introMs: number): void {
    this.data.phase = 'draft';
    this.data.draft = createDraftState(this.data.round);
    this.data.draftClockStartedAt = now + introMs;
    this.refreshDraftDeadline();
    this.data.reveal = null;
    this.data.laneResults = [];
    this.data.turnStartsAt = null;
    this.data.turnDeadline = null;
    this.data.ready = [];
    this.data.summaryDeadline = null;
  }

  private startBattle(now: number): void {
    const draft = this.data.draft!;
    const mirror = this.matchStateMirror();
    applyDraftFearless(draft, mirror);
    this.data.p1UsedCardIds = [...mirror.p1UsedCardIds];
    this.data.p2UsedCardIds = [...mirror.p2UsedCardIds];
    this.data.phase = 'battle';
    this.data.draftClockStartedAt = null;
    this.data.draftDeadline = null;
    this.data.reveal = createRevealState(this.firstPlayer());
    this.data.laneResults = [];
    this.data.turnStartsAt = now + BATTLE_INTRO_MS;
    this.data.turnDeadline = createTurnDeadline(now, BATTLE_INTRO_MS, BATTLE_TURN_SECONDS);
  }

  firstPlayer(round = this.data.round): Player {
    return getFirstPlayerForRound(this.data.round1FirstPlayer, round);
  }

  placements(player: Player): Placement[] {
    const draft = this.data.draft;
    if (!draft) return [];
    const result: Placement[] = [];
    for (const lane of LANE_ORDER) {
      const slot = draft.slots.find(item => item.lane === lane && item.player === player);
      const card = slot?.cardId ? CARD_BY_ID.get(slot.cardId) : undefined;
      if (card) result.push({ card, lane });
    }
    return result;
  }

  private finishRound(now: number): void {
    const mirror = this.matchStateMirror();
    resolveRound(this.placements(Player.P1), this.placements(Player.P2), mirror, this.data.reveal!.revealOrder);
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

  pick(player: Player, cardId: string, now: number): string | null {
    this.tick(now);
    const draft = this.data.draft;
    if (this.data.phase !== 'draft' || !draft) return 'NOT_DRAFT_PHASE';
    if (getCurrentDraftPlayer(draft) !== player) return 'NOT_YOUR_TURN';
    this.spendDraftClock(now);
    const error = pickCard(draft, this.matchStateMirror(), cardId);
    if (error) return 'INVALID_PICK';
    this.data.draftClockStartedAt = now;
    this.refreshDraftDeadline();
    if (isDraftComplete(draft)) this.startBattle(now);
    return null;
  }

  play(player: Player, lane: Lane, now: number): string | null {
    this.tick(now);
    if (this.data.phase !== 'battle' || !this.data.reveal) return 'NOT_BATTLE_PHASE';
    if (this.data.reveal.firstPlayer !== player) return 'NOT_YOUR_TURN';
    if (this.data.turnStartsAt !== null && now < this.data.turnStartsAt - 250) return 'TOO_EARLY';
    return this.openLane(lane, now) ? null : 'INVALID_LANE';
  }

  private openLane(lane: Lane, now: number): boolean {
    const reveal = this.data.reveal!;
    const next = revealLane(reveal, lane);
    if (!next) return false;
    const p1 = this.placements(Player.P1).find(item => item.lane === lane);
    const p2 = this.placements(Player.P2).find(item => item.lane === lane);
    if (!p1 || !p2) return false;
    const orderIndex = reveal.revealOrder.length;
    this.data.reveal = next;
    this.data.laneResults.push(resolveLaneDuel(p1.card, p2.card, lane, orderIndex));
    if (isRevealComplete(next)) {
      this.finishRound(now);
    } else {
      this.data.turnStartsAt = now + LANE_REVEAL_PAUSE_MS;
      this.data.turnDeadline = createTurnDeadline(now, LANE_REVEAL_PAUSE_MS, BATTLE_TURN_SECONDS);
    }
    return true;
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
    this.startDraft(now, DRAFT_INTRO_MS);
  }

  /** Deduct elapsed time from the current player's bank and move the clock start to `now`. */
  private spendDraftClock(now: number): void {
    const draft = this.data.draft;
    const player = draft ? getCurrentDraftPlayer(draft) : null;
    const started = this.data.draftClockStartedAt;
    if (!draft || !player || started === null || now <= started) return;
    draft.timeRemainingMs[player] = Math.max(0, draft.timeRemainingMs[player] - (now - started));
    this.data.draftClockStartedAt = now;
    this.refreshDraftDeadline();
  }

  private refreshDraftDeadline(): void {
    const draft = this.data.draft;
    const player = draft ? getCurrentDraftPlayer(draft) : null;
    if (!draft || !player || this.data.draftClockStartedAt === null) {
      this.data.draftDeadline = null;
      return;
    }
    this.data.draftDeadline = this.data.draftClockStartedAt + draft.timeRemainingMs[player];
  }

  /** Snapshot of both banks at `now`, with the current player's elapsed time already subtracted. */
  private draftBanksAt(now: number): Record<Player, number> {
    const draft = this.data.draft!;
    const remaining: Record<Player, number> = {
      [Player.P1]: draft.timeRemainingMs[Player.P1],
      [Player.P2]: draft.timeRemainingMs[Player.P2],
    };
    const player = getCurrentDraftPlayer(draft);
    const started = this.data.draftClockStartedAt;
    if (player && started !== null && now > started) {
      remaining[player] = Math.max(0, remaining[player] - (now - started));
    }
    return remaining;
  }

  /** Applies every expired deadline. Returns true if anything changed. */
  tick(now: number): boolean {
    let changed = false;
    for (let guard = 0; guard < 20; guard++) {
      if (this.data.phase === 'draft' && this.data.draft && this.data.draftDeadline !== null
        && isTurnExpired(this.data.draftDeadline, now)) {
        const timedOut = getCurrentDraftPlayer(this.data.draft);
        if (timedOut) {
          this.data.draft.timeRemainingMs[timedOut] = 0;
          autoPickRemaining(this.data.draft, this.matchStateMirror(), timedOut);
        }
        this.data.draftClockStartedAt = now;
        this.refreshDraftDeadline();
        if (isDraftComplete(this.data.draft)) this.startBattle(now);
        changed = true;
        continue;
      }
      if (this.data.phase === 'battle' && this.data.reveal && this.data.turnDeadline !== null
        && isTurnExpired(this.data.turnDeadline, now)) {
        const lane = pickRandomLane(this.data.reveal, this.random);
        if (lane && this.openLane(lane, now)) {
          changed = true;
          continue;
        }
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
      case 'draft': return this.data.draftDeadline;
      case 'battle': return this.data.turnDeadline;
      case 'summary': return this.data.summaryDeadline;
      default: return null;
    }
  }

  // ---------- views ----------

  /** Everything `player` is allowed to see. Opponent picks stay hidden until their lane is opened. */
  viewFor(player: Player, now: number): MatchView {
    const data = this.data;
    const seats: MatchView['players'] = {};
    for (const p of [Player.P1, Player.P2]) {
      const seat = data.seats[p];
      if (seat) seats[p] = { name: seat.name, connected: seat.connected, isGuest: !seat.accountId };
    }

    let draftView: MatchView['draft'] = null;
    if (data.phase === 'draft' && data.draft) {
      const draft = data.draft;
      const myPicks: Partial<Record<Lane, string>> = {};
      const opponentLocked: Lane[] = [];
      for (const slot of draft.slots) {
        if (!slot.cardId) continue;
        if (slot.player === player) myPicks[slot.lane] = slot.cardId;
        else opponentLocked.push(slot.lane);
      }
      const currentPlayer = getCurrentDraftPlayer(draft);
      const currentLane = getCurrentDraftLane(draft);
      const candidates = currentPlayer === player && currentLane
        ? getDraftCandidates(player, currentLane, draft, this.matchStateMirror()).map(card => card.id)
        : [];
      const timeRemainingMs = this.draftBanksAt(now);
      draftView = {
        currentIndex: draft.currentIndex,
        totalSlots: draft.slots.length,
        currentPlayer,
        currentLane,
        deadline: data.draftDeadline ?? now,
        timeRemainingMs,
        myPicks,
        opponentLocked,
        candidates,
      };
    }

    let battleView: MatchView['battle'] = null;
    if ((data.phase === 'battle' || data.phase === 'summary' || data.phase === 'matchEnd') && data.reveal && data.draft) {
      const myCards: Partial<Record<Lane, string>> = {};
      for (const item of this.placements(player)) myCards[item.lane] = item.card.id;
      const opened = new Set(data.reveal.revealOrder);
      battleView = {
        lead: data.reveal.firstPlayer,
        myCards,
        opponentHidden: LANE_ORDER.filter(lane => !opened.has(lane)),
        revealed: data.laneResults,
        turnStartsAt: data.phase === 'battle' ? data.turnStartsAt : null,
        turnDeadline: data.phase === 'battle' ? data.turnDeadline : null,
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
      draft: draftView,
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
