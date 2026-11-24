import Phaser from 'phaser';
import {
  autoCompletePick,
  bothReady,
  Card,
  cardById,
  createMatchState,
  createRoundPlay,
  createTurnDeadline,
  currentPlayLane,
  eligiblePartners,
  getFirstPlayer,
  handToPlacements,
  isPlayerReady,
  isRoundPlayComplete,
  isTurnExpired,
  Lane,
  LANE_ORDER,
  LaneRevealResult,
  LaneSynergyLink,
  MatchState,
  ORDER_BONUS,
  otherPlayer,
  Player,
  recordRoundResult,
  resolveCurrentLane,
  RoundPlay,
  seededRandom,
  submitMainPick,
  submitPartnerPick,
  summarizeRound,
  cpuTakeTurn,
  cpuThinkDelay,
} from '../rules';
import { CARDS, getLaneWinRate } from '../data/cards';
import { CARD_BACK_KEY, cardArtPath, cardBackPath } from '../data/art';
import { t } from '../i18n';
import { createCardBack, createCardFace, CardView } from './cardView';
import { setupSceneMusic } from './musicToggle';
import type { MatchView } from '../online/protocol';
import type { OnlineClient } from '../../net/onlineClient';
import { bindOnlineScene, mirrorMatchState, opponentName, sideLabel } from './onlineScene';
import { TurnTimerView } from './turnTimer';
import { playCoinFlip } from './coinFlip';
import { addButton, addPanel, COLORS, drawBackground, glowText, hexToInt, laneColor } from './theme';

/** One table position per side: the current lane's card, opponent above, you below. */
const BOARD_X = 530;
const SLOT_W = 128;
const SLOT_H = 168;
const TOP_Y = 150;
const BOTTOM_Y = 372;
/** Middle line between the two slots: lane name + order bonus, and the 5-dot lane record. */
const MID_Y = 261;
const SCORE_X = BOARD_X + SLOT_W / 2 + 78;
const DOCK_X = BOARD_X - SLOT_W / 2 - 66;
const NAME_X = 230;
const STRIP_X = 740;
const STRIP_GAP = 30;
const LANE_KEYS = {
  [Lane.Top]: 'lane.top', [Lane.Jungle]: 'lane.jungle', [Lane.Mid]: 'lane.mid', [Lane.Bot]: 'lane.bot', [Lane.Support]: 'lane.support',
} as const;
/** Held hand: cards fanned along an arc at the bottom of the screen, tilted like cards in a hand. */
const HAND_CENTER_X = 530;
const HAND_Y = 648;
const HAND_W = 112;
const HAND_H = 150;
const HAND_SPACING_MAX = 118;
const HAND_SPAN = 860;
const HAND_TILT_DEG = 3.2;
const HAND_TILT_MAX = 14;
const HAND_ARC = 2.4;
const HAND_LIFT = 44;
const CURRENT_LIFT = 22;
/** Opponent's held cards: face-down, peeking in from the top edge. */
const OPP_HAND_Y = -6;
const OPP_HAND_W = 54;
const OPP_HAND_H = 72;
const SIDE_X = 1070;
/** Offline mode: you are P1 at the bottom, the computer is P2 at the top. */
const HUMAN = Player.P1;
const CPU = Player.P2;
const FLIP_MS = 700;
const PARTNER_MS = 1300;
const USED_PARTNER_RED = '#e0474c';

type Row = 'top' | 'bottom';
/** main = choose this lane's main card; partner = choose one synergy partner; view = look only; hidden = card backs. */
type HandMode = 'main' | 'partner' | 'view' | 'hidden';

interface SlotView {
  container: Phaser.GameObjects.Container;
  border: Phaser.GameObjects.Rectangle | null;
  kind: 'empty' | 'back' | 'face';
  cardId: string | null;
}

interface HandCardView {
  id: string;
  laneIndex: number;
  x: number;
  baseY: number;
  baseRotation: number;
  depth: number;
  container: Phaser.GameObjects.Container;
  border: Phaser.GameObjects.Rectangle;
  /** Floating info label above the card: win rate, synergy %, red / unplayed tags. */
  info: Phaser.GameObjects.Text;
  red: boolean;
  current: boolean;
  /** Already played as a main card this round (stays in hand, dimmed, still usable as a partner). */
  played: boolean;
}

/**
 * Lane-by-lane battle. Each round both players hold a 10-card hand (2 cards per lane). Each
 * lane they secretly play one of that lane's two cards as MAIN and choose one synergy partner
 * from the rest of their hand; both mains flip together, the chosen partners fly in with their
 * tier %, and the lane winner is shown. Used for both vs-CPU and online play.
 */
export class GameScene extends Phaser.Scene {
  constructor() {
    super({ key: 'GameScene' });
  }

  // shared
  private currentRound = 1;
  private bottomPlayer: Player = Player.P1;
  private lead: Player = Player.P1;
  private slots = new Map<string, SlotView>();
  private scoreTexts = new Map<Row, Phaser.GameObjects.Text>();
  private laneTitle!: Phaser.GameObjects.Text;
  private laneTitleBox!: Phaser.GameObjects.Rectangle;
  private stripDots: Phaser.GameObjects.Arc[] = [];
  private stripText!: Phaser.GameObjects.Text;
  /** Objects shown for the lane being resolved (WIN tags, docked partners); swept away afterwards. */
  private laneFx: Phaser.GameObjects.GameObject[] = [];
  private handObjects: Phaser.GameObjects.GameObject[] = [];
  private handCards: HandCardView[] = [];
  private glowObjects: Phaser.GameObjects.GameObject[] = [];
  private oppHandObjects: Phaser.GameObjects.GameObject[] = [];
  private partnerLinks: LaneSynergyLink[] = [];
  /** Cards currently flying from the hand to the table. */
  private flying = 0;
  /** Online: main card sent but not yet confirmed (kept out of the held hand). */
  private pendingMain: string | null = null;
  private oppPlayedKey = '';
  private selectedId: string | null = null;
  private busy = false;
  private turnTimer!: TurnTimerView;
  private statusText!: Phaser.GameObjects.Text;
  private promptText!: Phaser.GameObjects.Text;
  private bonusText!: Phaser.GameObjects.Text;
  private choiceText!: Phaser.GameObjects.Text;
  private handTitle!: Phaser.GameObjects.Text;
  private scoreText!: Phaser.GameObjects.Text;
  private progressText!: Phaser.GameObjects.Text;
  private confirmButton: Phaser.GameObjects.Rectangle | null = null;
  private confirmText: Phaser.GameObjects.Text | null = null;
  private shownResults = 0;
  private handMode: HandMode = 'hidden';
  private handOwner: Player = Player.P1;

  // vs CPU
  private state!: MatchState;
  private play: RoundPlay | null = null;
  private picker: Player | null = null;
  /** The CPU's own random source (separate from the deal so ?seed=N deals stay repeatable). */
  private cpuRandom: () => number = Math.random;
  private cpuLanding = false;
  private localDeadline: number | null = null;
  private needCoin = false;
  private random: () => number = Math.random;

  // online
  private initOnline = false;
  private showCoin = false;
  private online: OnlineClient | null = null;
  private view: MatchView | null = null;
  private leavingOnline = false;
  private pendingUntil = 0;
  private pendingKey = '';
  private renderedKey = '';

  init(data: { online?: boolean; showCoin?: boolean; matchState?: MatchState; round?: number }) {
    this.slots = new Map();
    this.scoreTexts = new Map();
    this.stripDots = [];
    this.laneFx = [];
    this.handObjects = [];
    this.handCards = [];
    this.glowObjects = [];
    this.oppHandObjects = [];
    this.partnerLinks = [];
    this.flying = 0;
    this.pendingMain = null;
    this.oppPlayedKey = '';
    this.selectedId = null;
    this.busy = false;
    this.confirmButton = null;
    this.confirmText = null;
    this.shownResults = 0;
    this.handMode = 'hidden';
    this.play = null;
    this.picker = null;
    this.cpuLanding = false;
    this.localDeadline = null;
    this.online = null;
    this.view = null;
    this.leavingOnline = false;
    this.pendingUntil = 0;
    this.pendingKey = '';
    this.renderedKey = '';
    this.initOnline = Boolean(data?.online);
    this.showCoin = Boolean(data?.showCoin);
    if (this.initOnline) return;
    this.needCoin = !data?.matchState;
    // Optional ?seed=N makes local deals reproducible (handy for demos and recordings).
    const seed = GameScene.urlSeed();
    this.state = data?.matchState ?? createMatchState(seed);
    this.currentRound = data?.round ?? this.state.currentRound;
    this.random = seed === undefined ? Math.random : seededRandom(seed * 7 + this.currentRound);
    this.cpuRandom = seed === undefined ? Math.random : seededRandom(seed * 13 + this.currentRound + 1000);
  }

  private static urlSeed(): number | undefined {
    if (typeof window === 'undefined') return undefined;
    const raw = new URLSearchParams(window.location.search).get('seed');
    const seed = raw === null ? NaN : Number(raw);
    return Number.isInteger(seed) && seed >= 0 ? seed : undefined;
  }

  preload() {
    for (const card of CARDS) {
      if (!this.textures.exists(card.id)) this.load.image(card.id, cardArtPath(card.id));
    }
    if (!this.textures.exists(CARD_BACK_KEY)) this.load.image(CARD_BACK_KEY, cardBackPath());
  }

  create() {
    setupSceneMusic(this);
    drawBackground(this);
    if (this.initOnline) {
      const client = bindOnlineScene(this, view => this.onOnlineState(view));
      if (!client?.state?.battle) {
        this.scene.start('LobbyScene');
        return;
      }
      this.online = client;
      this.view = client.state;
      this.state = mirrorMatchState(client.state);
      this.currentRound = client.state.round;
      this.lead = client.state.battle!.lead;
      this.bottomPlayer = client.state.you;
    } else {
      this.lead = getFirstPlayer(this.state, this.currentRound);
      this.bottomPlayer = Player.P1;
    }
    this.createBoard();
    this.turnTimer = new TurnTimerView(this, SIDE_X, 440);
    this.time.addEvent({ delay: 200, loop: true, callback: () => this.updateTimer() });

    if (this.online) {
      const view = this.view!;
      if (this.showCoin && view.round === 1 && view.battle!.revealed.length === 0) {
        playCoinFlip(this, view.round1FirstPlayer, () => undefined);
      }
      this.refreshOnline();
      return;
    }
    this.play = createRoundPlay(this.currentRound, {
      [Player.P1]: this.state.p1UsedCardIds,
      [Player.P2]: this.state.p2UsedCardIds,
    } as Record<Player, Set<string>>, this.random);
    this.renderHand(HUMAN, 'view');
    if (this.needCoin && this.currentRound === 1) {
      playCoinFlip(this, this.state.round1FirstPlayer, () => this.startLane(), this.label(this.state.round1FirstPlayer));
    } else {
      this.startLane();
    }
  }

  // ---------- labels ----------

  private label(player: Player): string {
    if (this.view) return sideLabel(this.view, player);
    return player === HUMAN ? t('game.you') : t('game.cpu');
  }

  private rowOf(player: Player): Row {
    return player === this.bottomPlayer ? 'bottom' : 'top';
  }

  private rowY(row: Row): number {
    return row === 'top' ? TOP_Y : BOTTOM_Y;
  }

  private laneName(lane: Lane): string {
    return t(LANE_KEYS[lane]);
  }

  private scoreLine(): string {
    return `${this.label(Player.P1)} ${this.state.p1RoundWins} - ${this.state.p2RoundWins} ${this.label(Player.P2)}`;
  }

  private playerColor(player: Player): string {
    return player === Player.P1 ? COLORS.p1 : COLORS.p2;
  }

  private pct(value: number): string {
    return `${Math.round(value * 100)}`;
  }

  // ---------- hand data (local play or own online view) ----------

  private handOf(player: Player): string[][] {
    if (this.play) return this.play.hands[player];
    const battle = this.view?.battle;
    return battle && player === this.view!.you ? battle.myHand : [];
  }

  private redOf(player: Player): Set<string> {
    if (this.play) return new Set(this.play.red[player]);
    const battle = this.view?.battle;
    return new Set(battle && player === this.view!.you ? battle.myRed : []);
  }

  private playedOf(player: Player): string[] {
    if (this.play) return this.play.played[player];
    const battle = this.view?.battle;
    if (!battle || player !== this.view!.you) return [];
    return LANE_ORDER.map(lane => battle.myCards[lane]).filter((id): id is string => Boolean(id));
  }

  private laneIndexNow(): number {
    if (this.play) return this.play.laneIndex;
    return this.view?.battle?.laneIndex ?? LANE_ORDER.length;
  }

  private mainOf(player: Player): string | null {
    if (this.play) return this.play.mains[player];
    return this.view?.battle?.myMain ?? null;
  }

  /** Partner options for `mainId` as `player`'s main in the current lane: hand cards, not red, best first. */
  private optionsFor(player: Player, mainId: string): LaneSynergyLink[] {
    const lane = LANE_ORDER[this.laneIndexNow()];
    const main = cardById(mainId);
    if (!lane || !main) return [];
    return eligiblePartners(main, lane, handToPlacements(this.handOf(player)), this.redOf(player));
  }

  // ---------- board ----------

  private createBoard() {
    this.add.text(28, 22, t('game.title', { round: this.currentRound }), {
      fontSize: '20px', fontFamily: 'Arial', color: COLORS.title, fontStyle: 'bold',
    }).setOrigin(0, 0.5).setDepth(10);
    this.add.text(28, 48, t('game.lead', { player: this.label(this.lead) }), {
      fontSize: '13px', fontFamily: 'Arial', color: COLORS.muted,
    }).setOrigin(0, 0.5).setDepth(10);
    this.scoreText = this.add.text(1172, 24, this.scoreLine(), {
      fontSize: '16px', fontFamily: 'Arial', color: COLORS.text, fontStyle: 'bold',
    }).setOrigin(1, 0.5).setDepth(10);
    this.progressText = this.add.text(1172, 49, t('game.progress', { played: 0 }), {
      fontSize: '13px', fontFamily: 'Arial', color: COLORS.gold,
    }).setOrigin(1, 0.5).setDepth(10);

    // One table: a single slot per side for the current lane.
    addPanel(this, BOARD_X + 20, MID_Y, 700, BOTTOM_Y - TOP_Y + SLOT_H + 30, 0x0b1c2e).setDepth(1).setAlpha(0.7);
    const topPlayer = otherPlayer(this.bottomPlayer);
    this.add.text(NAME_X, TOP_Y, this.label(topPlayer), {
      fontSize: '18px', fontFamily: 'Arial', color: this.playerColor(topPlayer), fontStyle: 'bold', align: 'center',
      wordWrap: { width: 130 },
    }).setOrigin(0.5).setDepth(6);
    this.add.text(NAME_X, BOTTOM_Y, this.label(this.bottomPlayer), {
      fontSize: '18px', fontFamily: 'Arial', color: this.playerColor(this.bottomPlayer), fontStyle: 'bold', align: 'center',
      wordWrap: { width: 130 },
    }).setOrigin(0.5).setDepth(6);
    this.laneTitleBox = this.add.rectangle(BOARD_X, MID_Y, 230, 32, 0x091725, 0.95).setRounded(8)
      .setStrokeStyle(2, hexToInt(COLORS.gold), 0.9).setDepth(5);
    this.laneTitle = this.add.text(BOARD_X, MID_Y, '', {
      fontSize: '16px', fontFamily: 'Arial', color: COLORS.gold, fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(6);
    LANE_ORDER.forEach((lane, index) => {
      const dot = this.add.circle(STRIP_X + index * STRIP_GAP, MID_Y, 10, 0x0a1828, 1)
        .setStrokeStyle(2, hexToInt(laneColor(lane)), 0.6).setDepth(6);
      this.add.text(STRIP_X + index * STRIP_GAP, MID_Y, `${index + 1}`, {
        fontSize: '11px', fontFamily: 'Arial', color: COLORS.text, fontStyle: 'bold',
      }).setOrigin(0.5).setDepth(7);
      this.stripDots.push(dot);
    });
    this.stripText = this.add.text(STRIP_X + 2 * STRIP_GAP, MID_Y + 22, '', {
      fontSize: '12px', fontFamily: 'Arial', color: COLORS.muted, fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(6);
    for (const row of ['top', 'bottom'] as Row[]) {
      this.setEmptySlot(row);
      const score = this.add.text(SCORE_X, this.rowY(row), '', {
        fontSize: '24px', fontFamily: 'Arial', color: COLORS.text, fontStyle: 'bold',
      }).setOrigin(0.5).setDepth(30);
      glowText(score);
      this.scoreTexts.set(row, score);
    }
    this.highlightLane(null);

    this.promptText = this.add.text(530, 487, '', {
      fontSize: '19px', fontFamily: 'Arial', color: COLORS.title, fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(20);
    glowText(this.promptText);
    this.bonusText = this.add.text(530, 504, '', {
      fontSize: '12px', fontFamily: 'Arial', color: COLORS.muted, align: 'center', wordWrap: { width: 760 },
    }).setOrigin(0.5, 0).setDepth(20);
    this.handTitle = this.add.text(28, 540, '', {
      fontSize: '13px', fontFamily: 'Arial', color: COLORS.muted, fontStyle: 'bold', wordWrap: { width: 80 },
    }).setOrigin(0, 0.5).setDepth(20);
    this.choiceText = this.add.text(SIDE_X, 530, '', {
      fontSize: '13px', fontFamily: 'Arial', color: COLORS.gold, fontStyle: 'bold', align: 'center', wordWrap: { width: 220 },
    }).setOrigin(0.5).setDepth(20);
    this.statusText = this.add.text(SIDE_X, 700, '', {
      fontSize: '13px', fontFamily: 'Arial', color: COLORS.muted, align: 'center', wordWrap: { width: 220 },
    }).setOrigin(0.5).setDepth(60);
  }

  private clearSlot(row: Row) {
    const existing = this.slots.get(row);
    existing?.container.destroy();
    this.slots.delete(row);
  }

  private setEmptySlot(row: Row) {
    this.clearSlot(row);
    const container = this.add.container(BOARD_X, this.rowY(row)).setDepth(8);
    container.add(this.add.rectangle(0, 0, SLOT_W, SLOT_H, 0x0a1828, 0.8).setRounded(10)
      .setStrokeStyle(2, hexToInt(COLORS.cyan), 0.3));
    container.add(this.add.text(0, 0, t('game.pending'), {
      fontSize: '14px', fontFamily: 'Arial', color: COLORS.muted,
    }).setOrigin(0.5));
    this.slots.set(row, { container, border: null, kind: 'empty', cardId: null });
  }

  private setBackSlot(row: Row, lane: Lane) {
    // Never cover a card that has already flipped (a late hand-to-table flight landing after the reveal).
    const kind = this.slots.get(row)?.kind;
    if (kind === 'back' || kind === 'face') return;
    this.clearSlot(row);
    const back = createCardBack(this, lane, SLOT_W, SLOT_H);
    back.container.setPosition(BOARD_X, this.rowY(row)).setDepth(8).setScale(0.6);
    this.tweens.add({ targets: back.container, scale: 1, duration: 220, ease: 'Back.Out' });
    this.slots.set(row, { container: back.container, border: back.border, kind: 'back', cardId: null });
  }

  private setFaceSlot(row: Row, lane: Lane, card: Card): CardView {
    this.clearSlot(row);
    const face = createCardFace(this, card, lane, SLOT_W, SLOT_H, { nameFontSize: '13px' });
    face.container.setPosition(BOARD_X, this.rowY(row)).setDepth(9);
    this.slots.set(row, { container: face.container, border: face.border, kind: 'face', cardId: card.id });
    return face;
  }

  /** Lane title on the table ("上路 1/5 · +5%") for the current lane, or blank between rounds. */
  private highlightLane(lane: Lane | null) {
    const index = lane ? LANE_ORDER.indexOf(lane) : -1;
    if (!lane || index < 0) {
      this.laneTitle.setText('');
      this.laneTitleBox.setVisible(false);
    } else {
      this.laneTitle.setText(t('game.laneTitle', { lane: this.laneName(lane), number: index + 1, bonus: ORDER_BONUS[index] }))
        .setColor(laneColor(lane));
      this.laneTitleBox.setVisible(true).setStrokeStyle(2, hexToInt(laneColor(lane)), 0.9);
    }
    this.updateStrip(index);
  }

  /** 5-dot lane record: green = you won, red = lost, gold = draw, ringed = current lane. */
  private updateStrip(current = this.laneIndexNow()) {
    const results = (this.play ? this.play.results : this.view?.battle?.revealed ?? []).slice(0, this.shownResults);
    let mine = 0;
    let theirs = 0;
    this.stripDots.forEach((dot, index) => {
      const lane = LANE_ORDER[index];
      const result = results[index];
      if (result) {
        const won = result.laneWinner === this.bottomPlayer;
        const draw = result.laneWinner === null;
        if (won) mine += 1;
        else if (!draw) theirs += 1;
        dot.setFillStyle(hexToInt(draw ? COLORS.gold : won ? COLORS.win : COLORS.lose), 0.9)
          .setStrokeStyle(2, 0xffffff, 0.5).setScale(1);
      } else if (index === current) {
        dot.setFillStyle(0x0a1828, 1).setStrokeStyle(3, hexToInt(COLORS.gold), 1).setScale(1.2);
      } else {
        dot.setFillStyle(0x0a1828, 1).setStrokeStyle(2, hexToInt(laneColor(lane)), 0.6).setScale(1);
      }
    });
    this.stripText.setText(results.length > 0
      ? t('game.laneRecord', { you: this.label(this.bottomPlayer), mine, theirs, them: this.label(otherPlayer(this.bottomPlayer)) })
      : '');
  }

  private updateHeader() {
    this.scoreText.setText(this.scoreLine());
    this.progressText.setText(t('game.progress', { played: this.shownResults }));
    this.updateStrip();
  }

  // ---------- hand ----------

  private clearHand() {
    this.handObjects.forEach(object => object.destroy());
    this.handObjects = [];
    this.handCards = [];
    this.clearGlow();
    this.selectedId = null;
    this.destroyConfirm();
    this.choiceText?.setText('');
  }

  private clearGlow() {
    this.glowObjects.forEach(object => object.destroy());
    this.glowObjects = [];
    for (const view of this.handCards) {
      this.restoreHandBorder(view);
      this.setInfo(view, null);
    }
  }

  private restoreHandBorder(view: HandCardView) {
    if (!view.border.active) return;
    if (view.red) view.border.setStrokeStyle(3, hexToInt(USED_PARTNER_RED), 1);
    else if (view.current && this.handMode === 'main') view.border.setStrokeStyle(3, 0xffffff, 1);
    else view.border.setStrokeStyle(2, hexToInt(laneColor(LANE_ORDER[view.laneIndex])), 0.95);
  }

  /**
   * The floating label above a held card: lane win rate, plus the synergy % when it would
   * partner the hovered/locked main card, a red "used" tag, or "unplayed" for a passed lane.
   */
  private setInfo(view: HandCardView, bonus: number | null) {
    if (!view.info.active) return;
    const card = cardById(view.id);
    const lane = LANE_ORDER[view.laneIndex];
    const lines = [t('game.infoWinRate', { rate: card && lane ? (getLaneWinRate(card, lane) * 100).toFixed(1) : '-' })];
    let color: string = COLORS.text;
    let background: string = '#0b1c2ee6';
    if (bonus !== null) {
      lines.push(t('game.synergyBadge', { bonus: this.pct(bonus) }));
      color = '#1a1200';
      background = COLORS.gold;
    } else if (view.red) {
      lines.push(t('game.partnerUsed'));
      color = '#ffffff';
      background = USED_PARTNER_RED;
    } else if (view.played) {
      lines.push(t('game.playedTag'));
      color = '#9fb3c8';
    } else if (view.laneIndex < this.laneIndexNow()) {
      lines.push(t('game.notPlayed'));
      color = '#d8e2ec';
    }
    view.info.setText(lines.join('\n')).setColor(color).setBackgroundColor(background);
  }

  /** Fan positions for `count` held cards: spread along an arc, outer cards lower and tilted outward. */
  private fanSlot(index: number, count: number): { x: number; y: number; rotation: number } {
    const spacing = Math.min(HAND_SPACING_MAX, HAND_SPAN / Math.max(count, 1));
    const offset = index - (count - 1) / 2;
    const degrees = Phaser.Math.Clamp(offset * HAND_TILT_DEG, -HAND_TILT_MAX, HAND_TILT_MAX);
    return {
      x: HAND_CENTER_X + offset * spacing,
      y: HAND_Y + HAND_ARC * offset * offset,
      rotation: Phaser.Math.DegToRad(degrees),
    };
  }

  /** Raise a held card like picking it up: lift, straighten, enlarge, bring to the front. */
  private liftCard(view: HandCardView, scale: number, ease = 'Sine.Out') {
    view.container.setDepth(70);
    this.tweens.add({ targets: view.container, y: view.baseY - HAND_LIFT, rotation: 0, scale, duration: 200, ease });
  }

  private settleCard(view: HandCardView) {
    view.container.setDepth(view.depth);
    this.tweens.add({
      targets: view.container,
      y: view.baseY - (view.current && this.handMode === 'main' ? CURRENT_LIFT : 0),
      rotation: view.baseRotation,
      scale: 1,
      duration: 180,
      ease: 'Sine.Out',
    });
  }

  /** Light up partner cards in the hand (played ones included): gold edge, pulsing glow and their tier %. */
  private showGlow(links: LaneSynergyLink[]) {
    this.clearGlow();
    for (const link of links) {
      const view = this.handCards.find(item => item.id === link.card.id);
      if (view) {
        const glow = this.add.rectangle(0, 0, HAND_W + 14, HAND_H + 14, hexToInt(COLORS.gold), 0.16)
          .setRounded(10).setStrokeStyle(5, hexToInt(COLORS.gold), 0.95);
        view.container.addAt(glow, 0);
        this.tweens.add({ targets: glow, alpha: { from: 0.5, to: 1 }, duration: 650, yoyo: true, repeat: -1, ease: 'Sine.InOut' });
        view.border.setStrokeStyle(4, hexToInt(COLORS.gold), 1);
        this.setInfo(view, link.bonus);
        this.glowObjects.push(glow);
      }
    }
  }

  /** Face-down cards the top player is still holding, fanned upside down along the top edge. */
  private renderOpponentHand() {
    const topPlayer = otherPlayer(this.bottomPlayer);
    let count: number;
    if (this.play) {
      count = 10 - this.play.played[topPlayer].length - (this.play.mains[topPlayer] ? 1 : 0);
    } else {
      const battle = this.view?.battle;
      count = battle ? 10 - battle.revealed.length - (battle.opponentLocked && battle.currentLane ? 1 : 0) : 0;
    }
    this.oppHandObjects.forEach(object => object.destroy());
    this.oppHandObjects = [];
    for (let index = 0; index < count; index++) {
      const offset = index - (count - 1) / 2;
      const back = createCardBack(this, LANE_ORDER[Math.min(4, Math.floor(index / 2))], OPP_HAND_W, OPP_HAND_H);
      back.container.setPosition(HAND_CENTER_X + offset * 36, OPP_HAND_Y - 1.2 * offset * offset)
        .setRotation(Phaser.Math.DegToRad(-offset * 3)).setDepth(3);
      this.oppHandObjects.push(back.container);
    }
  }

  /**
   * Draw `player`'s hand fanned at the bottom. Cards already played as main this round stay in
   * the hand, dimmed with a small "played" tag (they can still be partners). The current lane's two cards stand raised; `mode` decides
   * what is clickable. Each card has a floating info label above it.
   */
  private renderHand(player: Player, mode: HandMode) {
    this.clearHand();
    this.handMode = mode;
    this.handOwner = player;
    const laneIndex = this.laneIndexNow();
    const hand = this.handOf(player);
    const red = this.redOf(player);
    const played = new Set(this.playedOf(player));
    const main = this.mainOf(player);
    this.handTitle.setText(mode === 'hidden' ? t('game.handHidden') : t('game.handLabel', { player: this.label(player) }));

    const held: { id: string | null; laneIndex: number }[] = [];
    LANE_ORDER.forEach((_, index) => {
      const ids = hand[index] ?? [];
      for (const id of ids) if (id !== main && id !== this.pendingMain) held.push({ id: mode === 'hidden' ? null : id, laneIndex: index });
    });
    if (mode === 'hidden' && held.length === 0) for (let i = 0; i < 10 - played.size; i++) held.push({ id: null, laneIndex: 0 });

    held.forEach((item, index) => {
      const pos = this.fanSlot(index, held.length);
      const lane = LANE_ORDER[item.laneIndex];
      const card = item.id ? cardById(item.id) : undefined;
      if (!item.id || !card) {
        const back = createCardBack(this, lane, HAND_W, HAND_H);
        back.container.setPosition(pos.x, pos.y).setRotation(pos.rotation).setDepth(20 + index);
        this.handObjects.push(back.container);
        return;
      }
      const current = item.laneIndex === laneIndex;
      const face = createCardFace(this, card, lane, HAND_W, HAND_H, { nameFontSize: '10px' });
      const lift = current && mode === 'main' ? CURRENT_LIFT : 0;
      face.container.setPosition(pos.x, pos.y - lift).setRotation(pos.rotation).setDepth(20 + index);
      const isRed = red.has(item.id);
      const isPlayed = played.has(item.id);
      if (isPlayed) {
        face.container.add(this.add.rectangle(0, 0, HAND_W, HAND_H, 0x05101c, 0.5).setRounded(7));
        face.container.bringToTop(face.border);
      }
      if (isRed) {
        face.container.add(this.add.rectangle(0, 0, HAND_W, HAND_H, hexToInt(USED_PARTNER_RED), 0.26).setRounded(7));
        face.container.bringToTop(face.border);
      }
      const info = this.add.text(0, -HAND_H / 2 - 6, '', {
        fontSize: '10px', fontFamily: 'Arial', fontStyle: 'bold', align: 'center', padding: { x: 4, y: 1 }, lineSpacing: 0,
      }).setOrigin(0.5, 1);
      face.container.add(info);
      const view: HandCardView = {
        id: item.id, laneIndex: item.laneIndex, x: pos.x, baseY: pos.y, baseRotation: pos.rotation, depth: 20 + index,
        container: face.container, border: face.border, info, red: isRed, current, played: isPlayed,
      };
      this.restoreHandBorder(view);
      this.setInfo(view, null);
      this.handCards.push(view);
      this.handObjects.push(face.container);
    });

    // Static hit zones at the resting fan positions (tilted with the card) so a lifted card doesn't flicker.
    for (const view of mode === 'hidden' ? [] : this.handCards) {
      const hit = this.add.rectangle(view.x, view.baseY - (view.current && mode === 'main' ? CURRENT_LIFT : 0),
        HAND_W, HAND_H + 8, 0xffffff, 0).setRotation(view.baseRotation).setDepth(40 + view.depth)
        .setInteractive({ useHandCursor: mode === 'main' || mode === 'partner' });
      this.handObjects.push(hit);
      hit.on('pointerover', () => this.onHandHover(view, true));
      hit.on('pointerout', () => this.onHandHover(view, false));
      hit.on('pointerdown', () => this.onHandDown(view));
    }
    if (mode === 'partner') this.bindPartnerChoices(player);
    this.renderOpponentHand();
  }

  /** Hover: any held card lifts like the old held hand; the current lane's cards also preview their partners. */
  private onHandHover(view: HandCardView, over: boolean) {
    if (this.busy || this.handMode === 'hidden') return;
    if (this.handMode === 'partner' && !this.partnerLinks.some(link => link.card.id === view.id)) return;
    if (over) {
      if (this.selectedId !== view.id) this.liftCard(view, 1.05);
      if (this.handMode === 'main' && view.current && !this.selectedId) this.showGlow(this.optionsFor(this.handOwner, view.id));
      return;
    }
    if (this.selectedId !== view.id) this.settleCard(view);
    if (this.handMode === 'main' && view.current && !this.selectedId) this.clearGlow();
  }

  private onHandDown(view: HandCardView) {
    if (this.busy) return;
    if (this.handMode === 'main' && view.current) this.onMainClick(view);
    if (this.handMode === 'partner') {
      const link = this.partnerLinks.find(item => item.card.id === view.id);
      if (link) this.onPartnerClick(view.id, link);
    }
  }

  private onMainClick(view: HandCardView) {
    const player = this.handOwner;
    if (this.selectedId === view.id) {
      this.confirmChoice();
      return;
    }
    const previous = this.handCards.find(item => item.id === this.selectedId);
    this.selectedId = view.id;
    if (previous) this.settleCard(previous);
    this.liftCard(view, 1.08, 'Back.Out');
    const options = this.optionsFor(player, view.id);
    this.showGlow(options);
    const card = cardById(view.id)!;
    this.choiceText.setText(options.length === 0
      ? t('game.choiceMainOnly', { card: card.name })
      : options.length === 1
        ? t('game.choiceMainAuto', { card: card.name, partner: options[0].card.name, bonus: this.pct(options[0].bonus) })
        : t('game.choiceMainMany', { card: card.name, count: options.length }));
    this.statusText.setText(t('game.selected', { card: card.name }));
    this.showConfirm(t('game.confirmPlay'));
  }

  /** Partner step: only the glowing (eligible) hand cards are clickable; exactly one counts. */
  private bindPartnerChoices(player: Player) {
    const main = this.mainOf(player);
    if (!main) return;
    this.partnerLinks = this.optionsFor(player, main);
    this.showGlow(this.partnerLinks);
    this.choiceText.setText(t('game.choicePartnerStep', { card: cardById(main)?.name ?? main, count: this.partnerLinks.length }));
  }

  private onPartnerClick(id: string, link: LaneSynergyLink) {
    if (this.busy) return;
    if (this.selectedId === id) {
      this.confirmChoice();
      return;
    }
    const previous = this.handCards.find(item => item.id === this.selectedId);
    this.selectedId = id;
    if (previous) this.settleCard(previous);
    const view = this.handCards.find(item => item.id === id);
    if (view) this.liftCard(view, 1.08, 'Back.Out');
    this.choiceText.setText(t('game.choicePartner', { partner: link.card.name, bonus: this.pct(link.bonus) }));
    this.statusText.setText(t('game.selectedPartner', { card: link.card.name, bonus: this.pct(link.bonus) }));
    this.showConfirm(t('game.confirmPartner'));
  }

  /**
   * Play a held card onto the table: it leaves the hand, flies (straightening and shrinking)
   * to the table slot and turns face-down there. Calls `onLanded` when it has settled.
   */
  private playFromHand(player: Player, cardId: string, onLanded: () => void) {
    const view = this.handCards.find(item => item.id === cardId);
    const lane = LANE_ORDER[this.laneIndexNow()];
    const row = this.rowOf(player);
    if (!view || !lane) {
      if (lane) this.setBackSlot(row, lane);
      onLanded();
      return;
    }
    const card = cardById(cardId)!;
    const flying = createCardFace(this, card, lane, HAND_W, HAND_H, { nameFontSize: '10px' });
    flying.container.setPosition(view.container.x, view.container.y).setRotation(view.container.rotation)
      .setScale(view.container.scale).setDepth(80);
    view.container.setVisible(false);
    this.flying += 1;
    this.tweens.add({
      targets: flying.container,
      x: BOARD_X,
      y: this.rowY(row),
      rotation: 0,
      scale: SLOT_W / HAND_W,
      duration: 520,
      ease: 'Cubic.InOut',
      onComplete: () => {
        this.tweens.add({
          targets: flying.container, scaleX: 0, duration: 140, ease: 'Sine.In',
          onComplete: () => {
            flying.container.destroy();
            this.flying -= 1;
            this.setBackSlot(row, lane);
            onLanded();
          },
        });
      },
    });
  }

  /** The opponent's face-down card slides from their held cards at the top edge to their table slot. */
  private opponentPlays(lane: Lane, onLanded?: () => void) {
    const row: Row = 'top';
    if (this.slots.get(row)?.kind === 'back') {
      onLanded?.();
      return;
    }
    const from = this.oppHandObjects.length > 0
      ? this.oppHandObjects[Math.floor(this.oppHandObjects.length / 2)] as Phaser.GameObjects.Container
      : null;
    const back = createCardBack(this, lane, OPP_HAND_W, OPP_HAND_H);
    back.container.setPosition(from?.x ?? HAND_CENTER_X, from?.y ?? OPP_HAND_Y).setDepth(80);
    from?.destroy();
    if (from) this.oppHandObjects = this.oppHandObjects.filter(item => item !== from);
    this.tweens.add({
      targets: back.container,
      x: BOARD_X,
      y: this.rowY(row),
      scale: SLOT_W / OPP_HAND_W,
      duration: 480,
      ease: 'Cubic.InOut',
      onComplete: () => {
        back.container.destroy();
        this.setBackSlot(row, lane);
        this.renderOpponentHand();
        onLanded?.();
      },
    });
  }

  private showConfirm(label: string) {
    this.destroyConfirm();
    const button = addButton(this, SIDE_X, 590, 214, 48, 0x17334a).setDepth(70);
    const text = this.add.text(SIDE_X, 590, label, {
      fontSize: '16px', fontFamily: 'Arial', color: COLORS.title, fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(71);
    button.on('pointerover', () => button.setFillStyle(0x24536a, 0.96));
    button.on('pointerout', () => button.setFillStyle(0x17334a, COLORS.panelAlpha));
    button.on('pointerdown', () => this.confirmChoice());
    this.confirmButton = button;
    this.confirmText = text;
  }

  private destroyConfirm() {
    this.confirmButton?.destroy();
    this.confirmText?.destroy();
    this.confirmButton = null;
    this.confirmText = null;
  }

  private confirmChoice() {
    const id = this.selectedId;
    if (!id || this.busy || this.flying > 0) return;
    const stage = this.handMode;
    if (stage !== 'main' && stage !== 'partner') return;
    if (this.online) this.sendOnline(stage, id);
    else this.localChoose(stage, id);
  }

  private showPrompt(player: Player) {
    const laneIndex = this.laneIndexNow();
    const lane = LANE_ORDER[laneIndex];
    if (!lane) return;
    if (this.handMode === 'partner') {
      const main = this.mainOf(player);
      this.promptText.setText(t('game.partnerPrompt', { player: this.label(player), card: cardById(main ?? '')?.name ?? '' }));
      this.bonusText.setText(t('game.partnerHint'));
    } else {
      this.promptText.setText(t('game.pickPrompt', { player: this.label(player), lane: this.laneName(lane) }));
      this.bonusText.setText(`${t('game.orderBonus', { bonus: ORDER_BONUS[laneIndex] })}　·　${t('game.pickHint')}`);
    }
  }

  // ---------- vs CPU ----------

  /** Open the current lane: the player picks with the 20s clock while the CPU "thinks". */
  private startLane() {
    const play = this.play;
    if (!play || this.busy) return;
    const lane = currentPlayLane(play);
    if (!lane) return;
    this.picker = HUMAN;
    this.cpuLanding = false;
    this.highlightLane(lane);
    this.renderHand(HUMAN, 'main');
    this.showPrompt(HUMAN);
    this.statusText.setText(t('game.opponentThinking', { name: this.label(CPU) }));
    // One 20s clock covers both the main card and the partner choice.
    this.localDeadline = createTurnDeadline(Date.now());
    this.time.delayedCall(cpuThinkDelay(this.cpuRandom), () => this.cpuMove(play));
  }

  /** The CPU locks its main card and partner from its own hand only, then its card slides down face-down. */
  private cpuMove(play: RoundPlay) {
    if (play !== this.play || isRoundPlayComplete(play) || isPlayerReady(play, CPU)) return;
    const lane = currentPlayLane(play)!;
    if (!cpuTakeTurn(play, CPU, this.cpuRandom)) autoCompletePick(play, CPU, this.cpuRandom);
    this.cpuLanding = true;
    if (this.picker === HUMAN) this.statusText.setText(t('game.opponentLocked', { name: this.label(CPU) }));
    this.opponentPlays(lane, () => {
      this.cpuLanding = false;
      this.tryResolveLocal();
    });
  }

  private localChoose(stage: 'main' | 'partner', cardId: string) {
    const play = this.play;
    const player = this.picker;
    if (!play || !player || this.busy) return;
    const error = stage === 'main' ? submitMainPick(play, player, cardId) : submitPartnerPick(play, player, cardId);
    if (error) return;
    if (stage === 'main') {
      this.destroyConfirm();
      this.clearGlow();
      this.playFromHand(player, cardId, () => this.afterLocalMain(player));
      return;
    }
    this.statusText.setText('');
    this.finishLocalTurn(player);
  }

  /** The main card has landed face-down: open the partner step, or finish the turn. */
  private afterLocalMain(player: Player) {
    const play = this.play;
    if (!play) return;
    if (!play.partnerDone[player]) {
      this.renderHand(player, 'partner');
      this.showPrompt(player);
      return;
    }
    const partner = play.partners[player];
    this.statusText.setText(partner
      ? t('game.autoPartner', { card: cardById(partner)?.name ?? partner })
      : t('game.noPartner'));
    this.finishLocalTurn(player);
  }

  private localTimeout() {
    const play = this.play;
    const player = this.picker;
    if (!play || !player || this.busy) return;
    const hadMain = play.mains[player] !== null;
    if (!autoCompletePick(play, player, this.random)) return;
    const mainId = play.mains[player]!;
    const main = cardById(mainId)?.name ?? '';
    const partner = play.partners[player];
    this.statusText.setText(partner
      ? t('game.autoPickedPartner', { card: main, partner: cardById(partner)?.name ?? partner })
      : t('game.autoPicked', { card: main }));
    this.destroyConfirm();
    this.clearGlow();
    if (hadMain) this.finishLocalTurn(player);
    else this.playFromHand(player, mainId, () => this.finishLocalTurn(player));
  }

  private finishLocalTurn(player: Player) {
    const play = this.play!;
    this.localDeadline = null;
    this.picker = null;
    this.renderHand(player, 'view');
    if (!isPlayerReady(play, CPU)) {
      this.promptText.setText(t('game.locked', { name: this.label(CPU) }));
      this.bonusText.setText('');
    }
    this.tryResolveLocal();
  }

  /** Once both cards are down (and nothing is still flying), flip the lane. */
  private tryResolveLocal() {
    const play = this.play;
    if (!play || this.busy || this.flying > 0 || this.cpuLanding || this.picker !== null || !bothReady(play)) return;
    const result = resolveCurrentLane(play);
    if (!result) return;
    this.animateLane(result, () => {
      if (isRoundPlayComplete(play)) this.finishLocalRound();
      else this.startLane();
    });
  }

  private finishLocalRound() {
    const play = this.play!;
    const result = summarizeRound(play.results, this.lead);
    recordRoundResult(this.state, result);
    this.updateHeader();
    this.promptText.setText(t('game.roundComplete'));
    this.highlightLane(null);
    this.time.delayedCall(900, () => {
      this.scene.start('SummaryScene', { state: this.state, result, roundNumber: this.currentRound });
    });
  }

  // ---------- online ----------

  private onOnlineState(view: MatchView) {
    if (this.leavingOnline) return;
    if (view.phase === 'waiting') {
      this.leavingOnline = true;
      this.scene.start('LobbyScene');
      return;
    }
    if (view.phase === 'battle' && view.round !== this.currentRound) {
      this.leavingOnline = true;
      this.scene.restart({ online: true });
      return;
    }
    const keepBattle = this.view?.battle;
    this.view = view.battle ? view : { ...view, battle: keepBattle ?? null };
    this.state = mirrorMatchState(view);
    this.refreshOnline();
  }

  private refreshOnline() {
    const view = this.view;
    const battle = view?.battle;
    // Wait for our own card to land before flipping the lane (playFromHand calls back here).
    if (!view || !battle || this.busy || this.flying > 0 || this.leavingOnline) return;
    if (this.shownResults < battle.revealed.length) {
      const result = battle.revealed[this.shownResults];
      this.renderedKey = '';
      this.animateLane(result, () => this.refreshOnline());
      return;
    }
    if (view.phase === 'summary' || view.phase === 'matchEnd') {
      this.leavingOnline = true;
      this.clearHand();
      this.promptText.setText(t('game.roundComplete'));
      this.time.delayedCall(900, () => this.scene.start('SummaryScene', { online: true }));
      return;
    }
    const lane = battle.currentLane;
    if (!lane) return;
    this.highlightLane(lane);
    const laneKey = `${view.round}:${battle.laneIndex}`;
    if (battle.opponentLocked && this.oppPlayedKey !== laneKey) {
      this.oppPlayedKey = laneKey;
      this.opponentPlays(lane);
    }
    const stage: HandMode = battle.myMain === null ? 'main' : battle.needPartner ? 'partner' : 'view';
    const pending = this.pendingKey === `${battle.laneIndex}:${stage}` && Date.now() < this.pendingUntil;
    if (battle.myMain && this.flying === 0) this.setBackSlot('bottom', lane);
    if (battle.myMain) this.pendingMain = null;
    const mode: HandMode = pending ? 'view' : stage;
    const renderKey = `${battle.laneIndex}:${mode}:${battle.myRed.length}`;
    if (this.renderedKey !== renderKey) {
      this.renderedKey = renderKey;
      this.renderHand(view.you, mode);
    }
    if (mode === 'view') {
      this.promptText.setText(battle.opponentLocked
        ? t('game.opponentLocked', { name: opponentName(view) })
        : t('game.locked', { name: opponentName(view) }));
      const partner = battle.myPartner ? cardById(battle.myPartner) : undefined;
      this.bonusText.setText(battle.myMain
        ? t('game.lockedChoice', { card: cardById(battle.myMain)?.name ?? '', partner: partner?.name ?? t('game.noSynergy') })
        : '');
      return;
    }
    this.showPrompt(view.you);
    this.statusText.setText(battle.opponentLocked
      ? t('game.opponentLocked', { name: opponentName(view) })
      : t('game.opponentThinking', { name: opponentName(view) }));
  }

  private sendOnline(stage: 'main' | 'partner', cardId: string) {
    if (!this.online || !this.view?.battle) return;
    this.online.send({ type: stage === 'main' ? 'pick' : 'partner', cardId });
    if (stage === 'main') {
      this.destroyConfirm();
      this.clearGlow();
      this.pendingMain = cardId;
      this.playFromHand(this.view.you, cardId, () => this.refreshOnline());
      // Close the gap the played card left in the fan (the copy keeps flying to the table).
      this.renderHand(this.view.you, 'view');
    }
    this.pendingUntil = Date.now() + 3000;
    this.pendingKey = `${this.view.battle.laneIndex}:${stage}`;
    this.statusText.setText('');
    this.refreshOnline();
    // If the server rejected the choice, the refresh after the pending window shows the hand again.
    this.time.delayedCall(3100, () => {
      if (this.view?.battle && !this.view.battle.myMain) this.pendingMain = null;
      this.renderedKey = '';
      this.refreshOnline();
    });
  }

  // ---------- timer ----------

  private updateTimer() {
    if (!this.turnTimer) return;
    if (this.online) {
      const battle = this.view?.battle;
      const now = this.online.serverNow();
      if (!battle || this.view?.phase !== 'battle' || battle.turnDeadline === null || this.busy
        || (battle.turnStartsAt !== null && now < battle.turnStartsAt)) {
        this.turnTimer.hide();
        return;
      }
      const mine = battle.myMain === null || battle.needPartner;
      this.turnTimer.update(battle.turnDeadline - now, mine
        ? t('online.yourTurnPlay')
        : t('online.waitingOpponentPlay', { name: opponentName(this.view!) }));
      return;
    }
    if (this.localDeadline === null || this.busy) {
      this.turnTimer.hide();
      return;
    }
    const now = Date.now();
    this.turnTimer.update(this.localDeadline - now, t('online.yourTurnPlay'));
    if (isTurnExpired(this.localDeadline, now)) {
      this.localDeadline = null;
      this.localTimeout();
    }
  }

  // ---------- lane reveal + partner pop ----------

  private animateLane(result: LaneRevealResult, onDone: () => void) {
    this.busy = true;
    this.destroyConfirm();
    this.clearGlow();
    this.turnTimer.hide();
    this.highlightLane(result.lane);
    const lane = result.lane;
    const x = BOARD_X;
    this.promptText.setText(t('game.dueling', { lane: this.laneName(lane) }));
    this.bonusText.setText('');
    this.choiceText.setText('');

    const sides = [
      { player: Player.P1, row: this.rowOf(Player.P1), card: result.p1Card, winRate: result.p1WinRate, link: result.p1Synergy.links[0] ?? null, total: result.p1Total },
      { player: Player.P2, row: this.rowOf(Player.P2), card: result.p2Card, winRate: result.p2WinRate, link: result.p2Synergy.links[0] ?? null, total: result.p2Total },
    ];
    // Reconnects can skip the face-down step: make sure the opponent's card isn't still flying in.
    if (this.slots.get('top')?.kind === 'empty') this.setBackSlot('top', lane);

    // 1) Both main cards were face-down; they flip together.
    const faces = new Map<Row, CardView>();
    for (const side of sides) {
      const face = this.setFaceSlot(side.row, lane, side.card);
      face.container.setScale(0, 1);
      this.tweens.add({ targets: face.container, scaleX: 1, duration: 220, ease: 'Sine.Out' });
      faces.set(side.row, face);
      const flash = this.add.rectangle(x, this.rowY(side.row), SLOT_W + 8, SLOT_H + 8, 0xffffff, 0.6)
        .setBlendMode(Phaser.BlendModes.ADD).setDepth(40);
      this.tweens.add({ targets: flash, alpha: 0, duration: 280, onComplete: () => flash.destroy() });
      const score = this.scoreTexts.get(side.row)!;
      score.setAlpha(1).setText(`${((side.winRate + result.orderBonus) * 100).toFixed(1)}%`).setColor(COLORS.text);
    }

    // 2) Each side's chosen partner pops out and flies in beside its main card with its tier %.
    const anyPartner = sides.some(side => side.link);
    for (const side of sides) {
      if (!side.link) continue;
      const link = side.link;
      const totalAfter = side.winRate + result.orderBonus + link.bonus;
      this.time.delayedCall(FLIP_MS, () => this.popPartner(side.row, link, totalAfter, faces.get(side.row)!));
    }

    // 3) Lane winner.
    const winnerAt = FLIP_MS + (anyPartner ? PARTNER_MS : 150);
    this.time.delayedCall(winnerAt, () => {
      for (const side of sides) {
        const score = this.scoreTexts.get(side.row)!;
        const won = result.laneWinner === side.player;
        const lost = result.laneWinner !== null && !won;
        score.setText(`${(side.total * 100).toFixed(1)}%`)
          .setColor(won ? COLORS.win : lost ? COLORS.lose : COLORS.gold);
        const face = faces.get(side.row)!;
        if (won) {
          face.border.setStrokeStyle(5, hexToInt(COLORS.win), 1);
          const tag = this.add.text(x + SLOT_W / 2 - 6, this.rowY(side.row) - SLOT_H / 2 + 6, 'WIN', {
            fontSize: '18px', fontFamily: 'Arial', color: '#06210f', fontStyle: 'bold',
            backgroundColor: COLORS.win, padding: { x: 7, y: 2 },
          }).setOrigin(0.5).setDepth(35).setScale(0);
          this.tweens.add({ targets: tag, scale: 1, duration: 260, ease: 'Back.Out' });
          this.laneFx.push(tag);
        } else if (lost) {
          face.container.setAlpha(0.72);
        }
      }
      this.shownResults += 1;
      this.updateHeader();
      const winner = result.laneWinner;
      this.promptText.setText(winner
        ? t('game.laneWinner', { lane: this.laneName(lane), player: this.label(winner) })
        : t('game.laneDraw', { lane: this.laneName(lane) }));
      // 4) Hold the result, then sweep the table clear for the next lane.
      this.time.delayedCall(1300, () => this.sweepTable(() => {
        this.busy = false;
        onDone();
      }));
    });
  }

  /** Fade and slide the resolved lane's cards off the table, then put the empty slots back. */
  private sweepTable(onDone: () => void) {
    const targets: Phaser.GameObjects.GameObject[] = [...this.laneFx];
    for (const row of ['top', 'bottom'] as Row[]) {
      const slot = this.slots.get(row);
      if (slot) targets.push(slot.container);
      targets.push(this.scoreTexts.get(row)!);
    }
    for (const target of targets) this.tweens.killTweensOf(target);
    this.tweens.add({
      targets,
      alpha: 0,
      x: `+=${90}`,
      duration: 360,
      ease: 'Sine.In',
      onComplete: () => {
        this.laneFx.forEach(object => object.destroy());
        this.laneFx = [];
        for (const row of ['top', 'bottom'] as Row[]) {
          this.setEmptySlot(row);
          this.scoreTexts.get(row)!.setText('').setAlpha(1).setX(SCORE_X).setScale(1);
        }
        onDone();
      },
    });
  }

  /** Where a partner card flies in from: its card in your hand, otherwise the opponent's hand at the top edge. */
  private partnerOrigin(row: Row, link: LaneSynergyLink): { x: number; y: number } {
    if (row === 'bottom' && this.handMode !== 'hidden') {
      const view = this.handCards.find(item => item.id === link.card.id);
      if (view) return { x: view.container.x, y: view.container.y };
    }
    return { x: BOARD_X, y: row === 'top' ? -SLOT_H / 2 : HAND_Y };
  }

  private popPartner(row: Row, link: LaneSynergyLink, totalAfter: number, target: CardView) {
    if (!this.scene.isActive()) return;
    const from = this.partnerOrigin(row, link);
    const toX = BOARD_X;
    const toY = this.rowY(row);
    const bonusLabel = `+${this.pct(link.bonus)}%`;
    const handCard = row === 'bottom' ? this.handCards.find(item => item.id === link.card.id) : undefined;
    if (handCard) this.tweens.add({ targets: handCard.container, scale: 1.12, duration: 180, yoyo: true });

    // A copy of the partner pops out and docks beside the main card with its tier %.
    const copy = createCardFace(this, link.card, link.lane, SLOT_W, SLOT_H, { nameFontSize: '13px' });
    copy.border.setStrokeStyle(4, hexToInt(COLORS.gold), 1);
    copy.container.setPosition(from.x, from.y).setDepth(50).setScale(0.5);
    copy.container.addAt(this.add.rectangle(0, 0, SLOT_W + 14, SLOT_H + 14, hexToInt(COLORS.gold), 0.18)
      .setRounded(10).setStrokeStyle(5, hexToInt(COLORS.gold), 0.9), 0);
    copy.container.add(this.add.text(0, -SLOT_H / 2 - 14, bonusLabel, {
      fontSize: '24px', fontFamily: 'Arial', color: '#1a1200', fontStyle: 'bold',
      backgroundColor: COLORS.gold, padding: { x: 8, y: 2 },
    }).setOrigin(0.5));
    this.laneFx.push(copy.container);
    const dockY = toY + (row === 'top' ? 12 : -12);

    this.tweens.add({
      targets: copy.container,
      x: DOCK_X,
      y: dockY,
      scale: 0.72,
      duration: 520,
      ease: 'Back.Out',
      onComplete: () => {
        if (!target.container.active) return;
        target.border.setStrokeStyle(4, hexToInt(COLORS.gold), 1);
        this.tweens.add({ targets: target.container, scale: 1.08, duration: 140, yoyo: true });
        const score = this.scoreTexts.get(row);
        score?.setText(`${(totalAfter * 100).toFixed(1)}%`).setColor(COLORS.gold);
        if (score) this.tweens.add({ targets: score, scale: 1.3, duration: 140, yoyo: true });
        const floating = this.add.text(toX, toY, `✦ ${bonusLabel}`, {
          fontSize: '28px', fontFamily: 'Arial', color: COLORS.gold, fontStyle: 'bold',
        }).setOrigin(0.5).setDepth(60);
        glowText(floating);
        this.tweens.add({ targets: floating, y: toY - 52, alpha: 0, duration: 900, onComplete: () => floating.destroy() });
        // The partner is now red for the rest of the round: show it on the hand card right away.
        if (handCard?.info.active) {
          handCard.red = true;
          handCard.container.add(this.add.rectangle(0, 0, HAND_W, HAND_H, hexToInt(USED_PARTNER_RED), 0.26).setRounded(7));
          handCard.container.bringToTop(handCard.border);
          handCard.container.bringToTop(handCard.info);
          this.restoreHandBorder(handCard);
          this.setInfo(handCard, null);
        }
      },
    });
  }
}
