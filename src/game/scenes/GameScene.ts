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
  getScoreString,
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
} from '../rules';
import { CARDS } from '../data/cards';
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

const COLUMN_X = [190, 360, 530, 700, 870];
const SLOT_W = 96;
const SLOT_H = 126;
const TOP_Y = 142;
const BOTTOM_Y = 352;
const TOP_SCORE_Y = 222;
const BOTTOM_SCORE_Y = 272;
const LANE_LABEL_Y = 247;
const HAND_Y = 590;
const HAND_W = 80;
const HAND_H = 110;
const HAND_DX = 41;
const SIDE_X = 1070;
/** Hot-seat: if the next player does not tap "show my cards", reveal them anyway after this. */
const HANDOFF_AUTO_MS = 10000;
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
  container: Phaser.GameObjects.Container;
  border: Phaser.GameObjects.Rectangle;
  red: boolean;
}

/**
 * Lane-by-lane battle. Each round both players hold a 10-card hand (2 cards per lane). Each
 * lane they secretly play one of that lane's two cards as MAIN and choose one synergy partner
 * from the rest of their hand; both mains flip together, the chosen partners fly in with their
 * tier %, and the lane winner is shown. Used for both local hot-seat and online play.
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
  private scoreTexts = new Map<string, Phaser.GameObjects.Text>();
  private laneHighlights = new Map<Lane, Phaser.GameObjects.Rectangle>();
  private handObjects: Phaser.GameObjects.GameObject[] = [];
  private handCards: HandCardView[] = [];
  private glowObjects: Phaser.GameObjects.GameObject[] = [];
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
  /** Board slots (row:lane) whose main card was already used as a synergy partner this round. */
  private usedPartnerSlots = new Set<string>();

  // local hot-seat
  private state!: MatchState;
  private play: RoundPlay | null = null;
  private picker: Player | null = null;
  private lastPicker: Player | null = null;
  private localDeadline: number | null = null;
  private handoffTimer: Phaser.Time.TimerEvent | null = null;
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
    this.laneHighlights = new Map();
    this.handObjects = [];
    this.handCards = [];
    this.glowObjects = [];
    this.selectedId = null;
    this.busy = false;
    this.confirmButton = null;
    this.confirmText = null;
    this.shownResults = 0;
    this.handMode = 'hidden';
    this.usedPartnerSlots = new Set();
    this.play = null;
    this.picker = null;
    this.lastPicker = null;
    this.localDeadline = null;
    this.handoffTimer = null;
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
    this.renderHand(this.lead, 'hidden');
    if (this.needCoin && this.currentRound === 1) {
      playCoinFlip(this, this.state.round1FirstPlayer, () => this.nextLocalPick());
    } else {
      this.nextLocalPick();
    }
  }

  // ---------- labels ----------

  private label(player: Player): string {
    return this.view ? sideLabel(this.view, player) : player;
  }

  private rowOf(player: Player): Row {
    return player === this.bottomPlayer ? 'bottom' : 'top';
  }

  private key(row: Row, lane: Lane): string {
    return `${row}:${lane}`;
  }

  private rowY(row: Row): number {
    return row === 'top' ? TOP_Y : BOTTOM_Y;
  }

  private columnX(lane: Lane): number {
    return COLUMN_X[LANE_ORDER.indexOf(lane)];
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
    this.scoreText = this.add.text(1172, 24, getScoreString(this.state), {
      fontSize: '16px', fontFamily: 'Arial', color: COLORS.text, fontStyle: 'bold',
    }).setOrigin(1, 0.5).setDepth(10);
    this.progressText = this.add.text(1172, 49, t('game.progress', { played: 0 }), {
      fontSize: '13px', fontFamily: 'Arial', color: COLORS.gold,
    }).setOrigin(1, 0.5).setDepth(10);

    const topPlayer = otherPlayer(this.bottomPlayer);
    this.add.text(70, TOP_Y, this.label(topPlayer), {
      fontSize: '15px', fontFamily: 'Arial', color: this.playerColor(topPlayer), fontStyle: 'bold', align: 'center',
      wordWrap: { width: 110 },
    }).setOrigin(0.5).setDepth(6);
    this.add.text(70, BOTTOM_Y, this.label(this.bottomPlayer), {
      fontSize: '15px', fontFamily: 'Arial', color: this.playerColor(this.bottomPlayer), fontStyle: 'bold', align: 'center',
      wordWrap: { width: 110 },
    }).setOrigin(0.5).setDepth(6);

    const panelY = (TOP_Y + BOTTOM_Y) / 2;
    const panelH = BOTTOM_Y - TOP_Y + SLOT_H + 24;
    LANE_ORDER.forEach((lane, index) => {
      const x = COLUMN_X[index];
      const highlight = this.add.rectangle(x, panelY, 154, panelH + 4, hexToInt(COLORS.gold), 0)
        .setRounded(10).setStrokeStyle(2, hexToInt(COLORS.gold), 0).setDepth(1);
      this.laneHighlights.set(lane, highlight);
      addPanel(this, x, panelY, 150, panelH, 0x0b1c2e).setDepth(1).setAlpha(0.7);
      this.add.rectangle(x, LANE_LABEL_Y, 128, 24, 0x091725, 0.92).setRounded(7)
        .setStrokeStyle(1, hexToInt(laneColor(lane)), 0.9).setDepth(5);
      this.add.text(x, LANE_LABEL_Y, `${lane} · +${ORDER_BONUS[index]}%`, {
        fontSize: '12px', fontFamily: 'Arial', color: laneColor(lane), fontStyle: 'bold',
      }).setOrigin(0.5).setDepth(6);
      for (const row of ['top', 'bottom'] as Row[]) {
        this.setEmptySlot(row, lane);
        const score = this.add.text(x, row === 'top' ? TOP_SCORE_Y : BOTTOM_SCORE_Y, '', {
          fontSize: '15px', fontFamily: 'Arial', color: COLORS.text, fontStyle: 'bold',
        }).setOrigin(0.5).setDepth(30);
        this.scoreTexts.set(this.key(row, lane), score);
      }
    });

    this.promptText = this.add.text(530, 446, '', {
      fontSize: '19px', fontFamily: 'Arial', color: COLORS.title, fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(20);
    glowText(this.promptText);
    this.bonusText = this.add.text(530, 469, '', {
      fontSize: '12px', fontFamily: 'Arial', color: COLORS.muted, align: 'center', wordWrap: { width: 760 },
    }).setOrigin(0.5, 0).setDepth(20);
    addPanel(this, 530, HAND_Y + 8, 880, HAND_H + 92, 0x0b1c2e).setDepth(1).setAlpha(0.55);
    this.handTitle = this.add.text(530, HAND_Y + HAND_H / 2 + 32, '', {
      fontSize: '12px', fontFamily: 'Arial', color: COLORS.muted, fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(20);
    this.choiceText = this.add.text(530, 730, '', {
      fontSize: '15px', fontFamily: 'Arial', color: COLORS.gold, fontStyle: 'bold', align: 'center',
    }).setOrigin(0.5).setDepth(20);
    this.statusText = this.add.text(SIDE_X, 690, '', {
      fontSize: '13px', fontFamily: 'Arial', color: COLORS.muted, align: 'center', wordWrap: { width: 220 },
    }).setOrigin(0.5).setDepth(60);
  }

  private clearSlot(row: Row, lane: Lane) {
    const existing = this.slots.get(this.key(row, lane));
    existing?.container.destroy();
    this.slots.delete(this.key(row, lane));
  }

  private setEmptySlot(row: Row, lane: Lane) {
    this.clearSlot(row, lane);
    const container = this.add.container(this.columnX(lane), this.rowY(row)).setDepth(8);
    container.add(this.add.rectangle(0, 0, SLOT_W, SLOT_H, 0x0a1828, 0.8).setRounded(8)
      .setStrokeStyle(1, hexToInt(laneColor(lane)), 0.35));
    container.add(this.add.text(0, 0, t('game.pending'), {
      fontSize: '11px', fontFamily: 'Arial', color: COLORS.muted,
    }).setOrigin(0.5));
    this.slots.set(this.key(row, lane), { container, border: null, kind: 'empty', cardId: null });
  }

  private setBackSlot(row: Row, lane: Lane) {
    if (this.slots.get(this.key(row, lane))?.kind === 'back') return;
    this.clearSlot(row, lane);
    const back = createCardBack(this, lane, SLOT_W, SLOT_H);
    back.container.setPosition(this.columnX(lane), this.rowY(row)).setDepth(8).setScale(0.6);
    this.tweens.add({ targets: back.container, scale: 1, duration: 220, ease: 'Back.Out' });
    this.slots.set(this.key(row, lane), { container: back.container, border: back.border, kind: 'back', cardId: null });
  }

  private setFaceSlot(row: Row, lane: Lane, card: Card): CardView {
    this.clearSlot(row, lane);
    const face = createCardFace(this, card, lane, SLOT_W, SLOT_H, { nameFontSize: '10px' });
    face.container.setPosition(this.columnX(lane), this.rowY(row)).setDepth(9);
    this.slots.set(this.key(row, lane), { container: face.container, border: face.border, kind: 'face', cardId: card.id });
    return face;
  }

  private highlightLane(lane: Lane | null) {
    for (const [itemLane, rect] of this.laneHighlights) {
      const on = itemLane === lane;
      rect.setFillStyle(hexToInt(COLORS.gold), on ? 0.06 : 0).setStrokeStyle(2, hexToInt(COLORS.gold), on ? 0.8 : 0);
    }
  }

  private updateHeader() {
    this.scoreText.setText(getScoreString(this.state));
    this.progressText.setText(t('game.progress', { played: this.shownResults }));
  }

  /** Mark a board main card that just served as a partner: red edge + red tint + small tag. */
  private markUsedPartner(row: Row, lane: Lane) {
    const key = this.key(row, lane);
    const slot = this.slots.get(key);
    if (!slot || slot.kind !== 'face' || this.usedPartnerSlots.has(key)) return;
    this.usedPartnerSlots.add(key);
    slot.container.add(this.add.rectangle(0, 0, SLOT_W, SLOT_H, hexToInt(USED_PARTNER_RED), 0.2).setRounded(7));
    slot.container.add(this.add.text(0, -SLOT_H / 2 + 30, t('game.partnerUsed'), {
      fontSize: '10px', fontFamily: 'Arial', color: '#ffffff', fontStyle: 'bold',
      backgroundColor: USED_PARTNER_RED, padding: { x: 4, y: 1 },
    }).setOrigin(0.5));
    if (slot.border) {
      slot.container.bringToTop(slot.border);
      slot.border.setStrokeStyle(3, hexToInt(USED_PARTNER_RED), 1);
    }
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
    for (const view of this.handCards) this.restoreHandBorder(view);
  }

  private restoreHandBorder(view: HandCardView) {
    if (!view.border.active) return;
    if (view.red) view.border.setStrokeStyle(3, hexToInt(USED_PARTNER_RED), 1);
    else view.border.setStrokeStyle(2, hexToInt(laneColor(LANE_ORDER[view.laneIndex])), 0.95);
  }

  private handY(view: HandCardView): number {
    return view.container.y;
  }

  /** Light up partner cards in the hand: gold edge, pulsing glow and their tier %. */
  private showGlow(links: LaneSynergyLink[]) {
    this.clearGlow();
    for (const link of links) {
      const view = this.handCards.find(item => item.id === link.card.id);
      if (!view) continue;
      const y = this.handY(view);
      const glow = this.add.rectangle(view.x, y, HAND_W + 14, HAND_H + 14, hexToInt(COLORS.gold), 0.14)
        .setRounded(10).setStrokeStyle(5, hexToInt(COLORS.gold), 0.95).setDepth(18);
      this.tweens.add({ targets: glow, alpha: { from: 0.5, to: 1 }, duration: 650, yoyo: true, repeat: -1, ease: 'Sine.InOut' });
      const badge = this.add.text(view.x, y - HAND_H / 2 - 9, `+${this.pct(link.bonus)}%`, {
        fontSize: '14px', fontFamily: 'Arial', color: '#1a1200', fontStyle: 'bold',
        backgroundColor: COLORS.gold, padding: { x: 6, y: 1 },
      }).setOrigin(0.5).setDepth(28);
      view.border.setStrokeStyle(4, hexToInt(COLORS.gold), 1);
      this.glowObjects.push(glow, badge);
    }
  }

  /**
   * Draw `player`'s 10-card hand: 2 cards under each lane column. Played mains get a tag,
   * red cards (already used as a partner this round) a red tint. `mode` decides what is clickable.
   */
  private renderHand(player: Player, mode: HandMode) {
    this.clearHand();
    this.handMode = mode;
    this.handOwner = player;
    const laneIndex = this.laneIndexNow();
    const hand = this.handOf(player);
    const red = this.redOf(player);
    const played = this.playedOf(player);
    const main = this.mainOf(player);
    this.handTitle.setText(mode === 'hidden' ? t('game.handHidden') : t('game.handLabel', { player: this.label(player) }));

    LANE_ORDER.forEach((lane, index) => {
      const ids = mode === 'hidden' ? [null, null] : hand[index] ?? [];
      ids.forEach((id, slot) => {
        const x = COLUMN_X[index] + (slot === 0 ? -HAND_DX : HAND_DX);
        const current = index === laneIndex;
        const card = id ? cardById(id) : undefined;
        if (!id || !card) {
          const back = createCardBack(this, lane, HAND_W, HAND_H);
          back.container.setPosition(x, HAND_Y).setDepth(20);
          this.handObjects.push(back.container);
          return;
        }
        const face = createCardFace(this, card, lane, HAND_W, HAND_H, { nameFontSize: '9px' });
        const lifted = (mode === 'main' && current) || id === main;
        face.container.setPosition(x, lifted ? HAND_Y - 10 : HAND_Y).setDepth(20);
        const isRed = red.has(id);
        if (isRed) {
          face.container.add(this.add.rectangle(0, 0, HAND_W, HAND_H, hexToInt(USED_PARTNER_RED), 0.28).setRounded(7));
          face.container.add(this.add.text(0, -HAND_H / 2 + 28, t('game.partnerUsed'), {
            fontSize: '9px', fontFamily: 'Arial', color: '#ffffff', fontStyle: 'bold',
            backgroundColor: USED_PARTNER_RED, padding: { x: 3, y: 1 },
          }).setOrigin(0.5));
          face.container.bringToTop(face.border);
        }
        const wasPlayed = played[index] === id || id === main;
        const skipped = index < laneIndex && played[index] !== id;
        if (wasPlayed || skipped) {
          face.container.add(this.add.text(0, HAND_H / 2 - 37, wasPlayed ? t('game.mainTag') : t('game.notPlayed'), {
            fontSize: '9px', fontFamily: 'Arial', color: wasPlayed ? '#06210f' : '#d8e2ec', fontStyle: 'bold',
            backgroundColor: wasPlayed ? COLORS.win : '#3a4a5c', padding: { x: 3, y: 1 },
          }).setOrigin(0.5));
        }
        const view: HandCardView = { id, laneIndex: index, x, container: face.container, border: face.border, red: isRed };
        this.restoreHandBorder(view);
        if (mode === 'main' && current) face.border.setStrokeStyle(3, 0xffffff, 1);
        this.handCards.push(view);
        this.handObjects.push(face.container);
      });
      this.handObjects.push(this.add.text(COLUMN_X[index], HAND_Y + HAND_H / 2 + 13, lane, {
        fontSize: '11px', fontFamily: 'Arial', color: index === laneIndex ? COLORS.gold : laneColor(lane), fontStyle: 'bold',
      }).setOrigin(0.5).setDepth(20));
    });

    if (mode === 'main') this.bindMainChoices(player);
    if (mode === 'partner') this.bindPartnerChoices(player);
  }

  private addHit(view: HandCardView, onOver: () => void, onOut: () => void, onDown: () => void) {
    const hit = this.add.rectangle(view.x, this.handY(view), HAND_W + 8, HAND_H + 8, 0xffffff, 0)
      .setDepth(26).setInteractive({ useHandCursor: true });
    hit.on('pointerover', onOver);
    hit.on('pointerout', onOut);
    hit.on('pointerdown', onDown);
    this.handObjects.push(hit);
  }

  /** Main step: the current lane's two cards are clickable; hovering shows which hand cards would partner. */
  private bindMainChoices(player: Player) {
    const laneIndex = this.laneIndexNow();
    for (const view of this.handCards.filter(item => item.laneIndex === laneIndex)) {
      const options = this.optionsFor(player, view.id);
      const best = options[0];
      const tag = this.add.text(view.x, this.handY(view) - HAND_H / 2 - 9,
        best ? t('game.synergyBadge', { bonus: this.pct(best.bonus) }) : t('game.noSynergy'), {
          fontSize: '11px', fontFamily: 'Arial', color: best ? '#1a1200' : COLORS.muted, fontStyle: 'bold',
          backgroundColor: best ? COLORS.gold : '#0b1c2e', padding: { x: 4, y: 1 },
        }).setOrigin(0.5).setDepth(27);
      this.handObjects.push(tag);
      this.addHit(view,
        () => { if (!this.selectedId) this.showGlow(options); },
        () => { if (!this.selectedId) this.clearGlow(); },
        () => this.onMainClick(player, view, options));
    }
  }

  private onMainClick(player: Player, view: HandCardView, options: LaneSynergyLink[]) {
    if (this.busy) return;
    if (this.selectedId === view.id) {
      this.confirmChoice();
      return;
    }
    this.selectedId = view.id;
    const laneIndex = this.laneIndexNow();
    for (const item of this.handCards.filter(card => card.laneIndex === laneIndex)) {
      this.tweens.add({ targets: item.container, y: item.id === view.id ? HAND_Y - 22 : HAND_Y - 10, duration: 160 });
    }
    this.showGlow(options);
    const card = cardById(view.id)!;
    this.choiceText.setText(options.length === 0
      ? t('game.choiceMainOnly', { card: card.name })
      : options.length === 1
        ? t('game.choiceMainAuto', { card: card.name, partner: options[0].card.name, bonus: this.pct(options[0].bonus) })
        : t('game.choiceMainMany', { card: card.name, count: options.length }));
    this.statusText.setText(t('game.selected', { card: card.name }));
    this.showConfirm(t('game.confirmPlay'));
    void player;
  }

  /** Partner step: only the glowing (eligible) cards are clickable; exactly one counts. */
  private bindPartnerChoices(player: Player) {
    const main = this.mainOf(player);
    if (!main) return;
    const options = this.optionsFor(player, main);
    this.showGlow(options);
    for (const link of options) {
      const view = this.handCards.find(item => item.id === link.card.id);
      if (!view) continue;
      this.addHit(view,
        () => { if (this.selectedId !== view.id) this.tweens.add({ targets: view.container, y: HAND_Y - 6, duration: 120 }); },
        () => { if (this.selectedId !== view.id) this.tweens.add({ targets: view.container, y: HAND_Y, duration: 120 }); },
        () => this.onPartnerClick(view, link));
    }
    this.choiceText.setText(t('game.choicePartnerStep', { card: cardById(main)?.name ?? main, count: options.length }));
  }

  private onPartnerClick(view: HandCardView, link: LaneSynergyLink) {
    if (this.busy) return;
    if (this.selectedId === view.id) {
      this.confirmChoice();
      return;
    }
    const previous = this.handCards.find(item => item.id === this.selectedId);
    if (previous) this.tweens.add({ targets: previous.container, y: HAND_Y, duration: 120 });
    this.selectedId = view.id;
    this.tweens.add({ targets: view.container, y: HAND_Y - 16, duration: 150 });
    this.choiceText.setText(t('game.choicePartner', { partner: link.card.name, bonus: this.pct(link.bonus) }));
    this.statusText.setText(t('game.selectedPartner', { card: link.card.name, bonus: this.pct(link.bonus) }));
    this.showConfirm(t('game.confirmPartner'));
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
    if (!id || this.busy) return;
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
      this.promptText.setText(t('game.pickPrompt', { player: this.label(player), lane }));
      this.bonusText.setText(`${t('game.orderBonus', { bonus: ORDER_BONUS[laneIndex] })}　·　${t('game.pickHint')}`);
    }
  }

  // ---------- local hot-seat ----------

  /** Pick order alternates per lane (A,B then B,A) so the device changes hands only once per lane. */
  private localPickOrder(laneIndex: number): Player[] {
    const other = otherPlayer(this.lead);
    return laneIndex % 2 === 0 ? [this.lead, other] : [other, this.lead];
  }

  private nextLocalPick() {
    const play = this.play;
    if (!play || this.busy) return;
    const lane = currentPlayLane(play);
    if (!lane) return;
    const next = this.localPickOrder(play.laneIndex).find(player => !isPlayerReady(play, player)) ?? null;
    if (!next) return;
    this.picker = next;
    this.highlightLane(lane);
    if (this.lastPicker !== null && this.lastPicker !== next) this.showHandoff(next);
    else this.startLocalTurn(next);
  }

  private showHandoff(player: Player) {
    this.renderHand(player, 'hidden');
    this.localDeadline = null;
    this.promptText.setText(t('game.handoff', { player, other: otherPlayer(player) }));
    this.bonusText.setText('');
    const button = addButton(this, 530, HAND_Y, 320, 56, 0x1d4a63).setDepth(40);
    const text = this.add.text(530, HAND_Y, t('game.handoffButton', { player }), {
      fontSize: '18px', fontFamily: 'Arial', color: COLORS.title, fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(41);
    this.handObjects.push(button, text);
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      this.handoffTimer?.remove();
      this.handoffTimer = null;
      this.startLocalTurn(player);
    };
    button.on('pointerdown', go);
    this.handoffTimer = this.time.delayedCall(HANDOFF_AUTO_MS, go);
  }

  private startLocalTurn(player: Player) {
    if (!this.play) return;
    this.renderHand(player, 'main');
    this.showPrompt(player);
    this.statusText.setText('');
    // One 20s clock covers both the main card and the partner choice.
    this.localDeadline = createTurnDeadline(Date.now());
  }

  private localChoose(stage: 'main' | 'partner', cardId: string) {
    const play = this.play;
    const player = this.picker;
    if (!play || !player || this.busy) return;
    const error = stage === 'main' ? submitMainPick(play, player, cardId) : submitPartnerPick(play, player, cardId);
    if (error) return;
    if (stage === 'main') {
      this.setBackSlot(this.rowOf(player), currentPlayLane(play)!);
      if (!play.partnerDone[player]) {
        this.renderHand(player, 'partner');
        this.showPrompt(player);
        this.statusText.setText('');
        return;
      }
      const partner = play.partners[player];
      this.statusText.setText(partner
        ? t('game.autoPartner', { card: cardById(partner)?.name ?? partner })
        : t('game.noPartner'));
    } else {
      this.statusText.setText('');
    }
    this.finishLocalTurn(player);
  }

  private localTimeout() {
    const play = this.play;
    const player = this.picker;
    if (!play || !player || this.busy) return;
    if (!autoCompletePick(play, player, this.random)) return;
    this.setBackSlot(this.rowOf(player), currentPlayLane(play)!);
    const main = cardById(play.mains[player]!)?.name ?? '';
    const partner = play.partners[player];
    this.statusText.setText(partner
      ? t('game.autoPickedPartner', { card: main, partner: cardById(partner)?.name ?? partner })
      : t('game.autoPicked', { card: main }));
    this.finishLocalTurn(player);
  }

  private finishLocalTurn(player: Player) {
    const play = this.play!;
    this.localDeadline = null;
    this.lastPicker = player;
    this.picker = null;
    if (!bothReady(play)) {
      this.renderHand(player, 'hidden');
      this.time.delayedCall(350, () => this.nextLocalPick());
      return;
    }
    this.renderHand(player, 'hidden');
    const result = resolveCurrentLane(play);
    if (!result) return;
    this.animateLane(result, () => {
      if (isRoundPlayComplete(play)) this.finishLocalRound();
      else this.nextLocalPick();
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
    if (!view || !battle || this.busy || this.leavingOnline) return;
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
    if (battle.opponentLocked) this.setBackSlot('top', lane);
    const stage: HandMode = battle.myMain === null ? 'main' : battle.needPartner ? 'partner' : 'view';
    const pending = this.pendingKey === `${battle.laneIndex}:${stage}` && Date.now() < this.pendingUntil;
    if (battle.myMain) this.setBackSlot('bottom', lane);
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
    this.pendingUntil = Date.now() + 3000;
    this.pendingKey = `${this.view.battle.laneIndex}:${stage}`;
    this.statusText.setText('');
    this.refreshOnline();
    // If the server rejected the choice, the refresh after the pending window shows the hand again.
    this.time.delayedCall(3100, () => {
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
    this.turnTimer.update(this.localDeadline - now, `${this.picker ?? ''} ${t('timer.caption')}`);
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
    const x = this.columnX(lane);
    this.promptText.setText(t('game.dueling', { lane }));
    this.bonusText.setText('');
    this.choiceText.setText('');

    const sides = [
      { player: Player.P1, row: this.rowOf(Player.P1), card: result.p1Card, winRate: result.p1WinRate, link: result.p1Synergy.links[0] ?? null, total: result.p1Total },
      { player: Player.P2, row: this.rowOf(Player.P2), card: result.p2Card, winRate: result.p2WinRate, link: result.p2Synergy.links[0] ?? null, total: result.p2Total },
    ];

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
      const score = this.scoreTexts.get(this.key(side.row, lane))!;
      score.setText(`${((side.winRate + result.orderBonus) * 100).toFixed(1)}%`).setColor(COLORS.text);
    }

    // 2) Each side's chosen partner pops out and flies in beside its main card with its tier %.
    const anyPartner = sides.some(side => side.link);
    for (const side of sides) {
      if (!side.link) continue;
      const link = side.link;
      const totalAfter = side.winRate + result.orderBonus + link.bonus;
      this.time.delayedCall(FLIP_MS, () => this.popPartner(side.row, lane, link, totalAfter, faces.get(side.row)!));
    }

    // 3) Lane winner.
    const winnerAt = FLIP_MS + (anyPartner ? PARTNER_MS : 150);
    this.time.delayedCall(winnerAt, () => {
      for (const side of sides) {
        const score = this.scoreTexts.get(this.key(side.row, lane))!;
        const won = result.laneWinner === side.player;
        const lost = result.laneWinner !== null && !won;
        score.setText(`${(side.total * 100).toFixed(1)}%`)
          .setColor(won ? COLORS.win : lost ? COLORS.lose : COLORS.gold);
        const face = faces.get(side.row)!;
        if (won) {
          face.border.setStrokeStyle(4, hexToInt(COLORS.win), 1);
          const tag = this.add.text(x + SLOT_W / 2 - 4, this.rowY(side.row) - SLOT_H / 2 + 4, 'WIN', {
            fontSize: '14px', fontFamily: 'Arial', color: '#06210f', fontStyle: 'bold',
            backgroundColor: COLORS.win, padding: { x: 6, y: 2 },
          }).setOrigin(0.5).setDepth(35).setScale(0);
          this.tweens.add({ targets: tag, scale: 1, duration: 260, ease: 'Back.Out' });
        } else if (lost) {
          face.container.setAlpha(0.72);
        }
      }
      this.shownResults += 1;
      this.updateHeader();
      const winner = result.laneWinner;
      this.promptText.setText(winner
        ? t('game.laneWinner', { lane, player: this.label(winner) })
        : t('game.laneDraw', { lane }));
      this.time.delayedCall(1000, () => {
        this.busy = false;
        onDone();
      });
    });
  }

  /** Where a partner card flies in from: its hand card if visible, its board slot if it was played, else off-board. */
  private partnerOrigin(row: Row, link: LaneSynergyLink): { x: number; y: number } {
    if (row === 'bottom' && this.handMode !== 'hidden') {
      const view = this.handCards.find(item => item.id === link.card.id);
      if (view) return { x: view.x, y: this.handY(view) };
    }
    const slot = this.slots.get(this.key(row, link.lane));
    if (slot?.cardId === link.card.id) return { x: this.columnX(link.lane), y: this.rowY(row) };
    return { x: this.columnX(link.lane), y: row === 'top' ? -SLOT_H : HAND_Y };
  }

  private popPartner(row: Row, lane: Lane, link: LaneSynergyLink, totalAfter: number, target: CardView) {
    const from = this.partnerOrigin(row, link);
    const toX = this.columnX(lane);
    const toY = this.rowY(row);
    const bonusLabel = `+${this.pct(link.bonus)}%`;
    const boardSlot = this.slots.get(this.key(row, link.lane));
    const partnerOnBoard = boardSlot?.cardId === link.card.id ? boardSlot : null;
    if (partnerOnBoard) {
      this.tweens.add({ targets: partnerOnBoard.container, scale: 1.12, duration: 180, yoyo: true, ease: 'Sine.Out' });
      partnerOnBoard.border?.setStrokeStyle(4, hexToInt(COLORS.gold), 1);
    }
    const handCard = row === 'bottom' ? this.handCards.find(item => item.id === link.card.id) : undefined;
    if (handCard) this.tweens.add({ targets: handCard.container, scale: 1.12, duration: 180, yoyo: true });

    // A copy of the partner pops out and docks beside the main card with its tier %.
    const copy = createCardFace(this, link.card, link.lane, SLOT_W, SLOT_H, { nameFontSize: '10px' });
    copy.border.setStrokeStyle(4, hexToInt(COLORS.gold), 1);
    copy.container.setPosition(from.x, from.y).setDepth(50).setScale(0.6);
    copy.container.addAt(this.add.rectangle(0, 0, SLOT_W + 14, SLOT_H + 14, hexToInt(COLORS.gold), 0.18)
      .setRounded(10).setStrokeStyle(5, hexToInt(COLORS.gold), 0.9), 0);
    copy.container.add(this.add.text(0, -SLOT_H / 2 - 12, bonusLabel, {
      fontSize: '22px', fontFamily: 'Arial', color: '#1a1200', fontStyle: 'bold',
      backgroundColor: COLORS.gold, padding: { x: 8, y: 2 },
    }).setOrigin(0.5));
    const dockX = toX + (lane === LANE_ORDER[LANE_ORDER.length - 1] ? -1 : 1) * (SLOT_W * 0.5 + 34);
    const dockY = toY + (row === 'top' ? 34 : -34);

    this.tweens.add({
      targets: copy.container,
      x: dockX,
      y: dockY,
      scale: 0.72,
      duration: 520,
      ease: 'Back.Out',
      onComplete: () => {
        target.border.setStrokeStyle(4, hexToInt(COLORS.gold), 1);
        this.tweens.add({ targets: target.container, scale: 1.08, duration: 140, yoyo: true });
        const score = this.scoreTexts.get(this.key(row, lane));
        score?.setText(`${(totalAfter * 100).toFixed(1)}%`).setColor(COLORS.gold);
        if (score) this.tweens.add({ targets: score, scale: 1.3, duration: 140, yoyo: true });
        const floating = this.add.text(toX, toY, `✦ ${bonusLabel}`, {
          fontSize: '24px', fontFamily: 'Arial', color: COLORS.gold, fontStyle: 'bold',
        }).setOrigin(0.5).setDepth(60);
        glowText(floating);
        this.tweens.add({ targets: floating, y: toY - 46, alpha: 0, duration: 900, onComplete: () => floating.destroy() });
        // The partner is now red for the rest of the round.
        if (partnerOnBoard) this.time.delayedCall(500, () => this.markUsedPartner(row, link.lane));
        this.tweens.add({ targets: copy.container, alpha: 0, delay: 1500, duration: 450, onComplete: () => copy.container.destroy() });
      },
    });
  }
}
