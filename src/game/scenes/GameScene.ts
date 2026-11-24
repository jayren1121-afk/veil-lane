import Phaser from 'phaser';
import {
  autoLanePick,
  bothPicked,
  Card,
  cardById,
  computeLaneSynergy,
  createMatchState,
  createRoundPlay,
  createTurnDeadline,
  currentPlayLane,
  getFirstPlayer,
  getScoreString,
  isRoundPlayComplete,
  isTurnExpired,
  Lane,
  LANE_ORDER,
  LaneRevealResult,
  LaneSynergy,
  LaneSynergyLink,
  MatchState,
  ORDER_BONUS,
  otherPlayer,
  Placement,
  Player,
  recordRoundResult,
  resolveCurrentLane,
  RoundPlay,
  seededRandom,
  submitLanePick,
  summarizeRound,
  usedSynergyPartners,
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
const SLOT_W = 104;
const SLOT_H = 138;
const TOP_Y = 158;
const BOTTOM_Y = 384;
const TOP_SCORE_Y = 244;
const BOTTOM_SCORE_Y = 298;
const LANE_LABEL_Y = 271;
const OFFER_X = [420, 640];
const OFFER_Y = 642;
const OFFER_W = 150;
const OFFER_H = 200;
const SIDE_X = 1070;
/** Hot-seat: if the next player does not tap "show my cards", reveal them anyway after this. */
const HANDOFF_AUTO_MS = 10000;
const SYNERGY_STEP_MS = 800;
const USED_PARTNER_RED = '#e0474c';

type Row = 'top' | 'bottom';

interface SlotView {
  container: Phaser.GameObjects.Container;
  border: Phaser.GameObjects.Rectangle | null;
  kind: 'empty' | 'back' | 'face';
}

/**
 * Lane-by-lane battle. Each lane both players get their own two random cards and secretly
 * play one; then the lane flips, synergy partners pop out with their tier bonus, and the
 * lane winner is shown. Used for both local hot-seat and online play.
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
  private laneLabels = new Map<Lane, Phaser.GameObjects.Text>();
  private laneHighlights = new Map<Lane, Phaser.GameObjects.Rectangle>();
  private offerObjects: Phaser.GameObjects.GameObject[] = [];
  private selectedCardId: string | null = null;
  private busy = false;
  private turnTimer!: TurnTimerView;
  private statusText!: Phaser.GameObjects.Text;
  private promptText!: Phaser.GameObjects.Text;
  private bonusText!: Phaser.GameObjects.Text;
  private scoreText!: Phaser.GameObjects.Text;
  private progressText!: Phaser.GameObjects.Text;
  private confirmButton: Phaser.GameObjects.Rectangle | null = null;
  private confirmText: Phaser.GameObjects.Text | null = null;
  private shownResults = 0;
  /** Board slots (row:lane) whose card was already used as a synergy partner this round. */
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
  private pickPendingUntil = 0;
  private pickPendingLane = -1;
  private renderedOfferLane = -1;

  init(data: { online?: boolean; showCoin?: boolean; matchState?: MatchState; round?: number }) {
    this.slots = new Map();
    this.scoreTexts = new Map();
    this.laneLabels = new Map();
    this.laneHighlights = new Map();
    this.offerObjects = [];
    this.selectedCardId = null;
    this.busy = false;
    this.confirmButton = null;
    this.confirmText = null;
    this.shownResults = 0;
    this.usedPartnerSlots = new Set();
    this.play = null;
    this.picker = null;
    this.lastPicker = null;
    this.localDeadline = null;
    this.handoffTimer = null;
    this.online = null;
    this.view = null;
    this.leavingOnline = false;
    this.pickPendingUntil = 0;
    this.pickPendingLane = -1;
    this.renderedOfferLane = -1;
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
    this.turnTimer = new TurnTimerView(this, SIDE_X, 470);
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

    LANE_ORDER.forEach((lane, index) => {
      const x = COLUMN_X[index];
      const highlight = this.add.rectangle(x, 271, 154, 404, hexToInt(COLORS.gold), 0)
        .setRounded(10).setStrokeStyle(2, hexToInt(COLORS.gold), 0).setDepth(1);
      this.laneHighlights.set(lane, highlight);
      addPanel(this, x, 271, 150, 400, 0x0b1c2e).setDepth(1).setAlpha(0.7);
      this.add.rectangle(x, LANE_LABEL_Y, 128, 26, 0x091725, 0.92).setRounded(7)
        .setStrokeStyle(1, hexToInt(laneColor(lane)), 0.9).setDepth(5);
      const label = this.add.text(x, LANE_LABEL_Y, `${lane} · +${ORDER_BONUS[index]}%`, {
        fontSize: '12px', fontFamily: 'Arial', color: laneColor(lane), fontStyle: 'bold',
      }).setOrigin(0.5).setDepth(6);
      this.laneLabels.set(lane, label);
      for (const row of ['top', 'bottom'] as Row[]) {
        this.setEmptySlot(row, lane);
        const score = this.add.text(x, row === 'top' ? TOP_SCORE_Y : BOTTOM_SCORE_Y, '', {
          fontSize: '15px', fontFamily: 'Arial', color: COLORS.text, fontStyle: 'bold',
        }).setOrigin(0.5).setDepth(30);
        this.scoreTexts.set(this.key(row, lane), score);
      }
    });

    this.promptText = this.add.text(530, 488, '', {
      fontSize: '20px', fontFamily: 'Arial', color: COLORS.title, fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(20);
    glowText(this.promptText);
    this.bonusText = this.add.text(530, 511, '', {
      fontSize: '12px', fontFamily: 'Arial', color: COLORS.muted, align: 'center', wordWrap: { width: 720 },
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
    this.slots.set(this.key(row, lane), { container, border: null, kind: 'empty' });
  }

  private setBackSlot(row: Row, lane: Lane) {
    if (this.slots.get(this.key(row, lane))?.kind === 'back') return;
    this.clearSlot(row, lane);
    const back = createCardBack(this, lane, SLOT_W, SLOT_H);
    back.container.setPosition(this.columnX(lane), this.rowY(row)).setDepth(8).setScale(0.6);
    this.tweens.add({ targets: back.container, scale: 1, duration: 220, ease: 'Back.Out' });
    this.slots.set(this.key(row, lane), { container: back.container, border: back.border, kind: 'back' });
  }

  private setFaceSlot(row: Row, lane: Lane, card: Card): CardView {
    this.clearSlot(row, lane);
    const face = createCardFace(this, card, lane, SLOT_W, SLOT_H, { nameFontSize: '10px' });
    face.container.setPosition(this.columnX(lane), this.rowY(row)).setDepth(9);
    this.slots.set(this.key(row, lane), { container: face.container, border: face.border, kind: 'face' });
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

  // ---------- offers ----------

  private clearOffers() {
    this.offerObjects.forEach(object => object.destroy());
    this.offerObjects = [];
    this.selectedCardId = null;
    this.destroyConfirm();
    this.setPartnerHighlight([], false, this.bottomPlayer);
    this.setPartnerHighlight([], false, otherPlayer(this.bottomPlayer));
  }

  /** My played cards this round, as placements (from what has been shown on the board). */
  private playedFor(player: Player): Placement[] {
    if (this.play) {
      return this.play.played[player].map((id, index) => ({ card: cardById(id)!, lane: LANE_ORDER[index] }))
        .filter(item => item.card);
    }
    const battle = this.view?.battle;
    if (!battle || player !== this.view!.you) return [];
    const result: Placement[] = [];
    for (const lane of LANE_ORDER) {
      const id = battle.myCards[lane];
      const card = id ? cardById(id) : undefined;
      if (card) result.push({ card, lane });
    }
    return result;
  }

  /** Cards that already served as this player's synergy partner this round (not eligible again). */
  private usedPartnersFor(player: Player): Set<string> {
    const results = this.play ? this.play.results : this.view?.battle?.revealed ?? [];
    return usedSynergyPartners(results, player);
  }

  private pct(value: number): string {
    return `${Math.round(value * 100)}`;
  }

  private renderOffers(player: Player, lane: Lane, offer: string[]) {
    this.clearOffers();
    this.highlightLane(lane);
    const index = LANE_ORDER.indexOf(lane);
    this.promptText.setText(t('game.pickPrompt', { player: this.label(player), lane }));
    this.bonusText.setText(`${t('game.orderBonus', { bonus: ORDER_BONUS[index] })}　·　${t('game.pickHint')}`);
    const played = this.playedFor(player);
    const usedPartners = this.usedPartnersFor(player);
    offer.forEach((id, offerIndex) => {
      const card = cardById(id);
      if (!card) return;
      const synergy = computeLaneSynergy(card, lane, played, undefined, usedPartners);
      const x = OFFER_X[offerIndex] ?? OFFER_X[0];
      const glowing = synergy.bonus > 0;
      if (glowing) {
        const glow = this.add.rectangle(x, OFFER_Y, OFFER_W + 18, OFFER_H + 18, hexToInt(COLORS.gold), 0.12)
          .setRounded(12).setStrokeStyle(6, hexToInt(COLORS.gold), 0.95).setDepth(18);
        this.tweens.add({ targets: glow, alpha: { from: 0.55, to: 1 }, scale: { from: 0.98, to: 1.03 },
          duration: 700, yoyo: true, repeat: -1, ease: 'Sine.InOut' });
        this.offerObjects.push(glow);
      }
      const face = createCardFace(this, card, lane, OFFER_W, OFFER_H, { nameFontSize: '13px' });
      face.container.setPosition(x, OFFER_Y).setDepth(20);
      if (glowing) face.border.setStrokeStyle(4, hexToInt(COLORS.gold), 1);
      this.offerObjects.push(face.container);
      if (glowing) {
        const badge = this.add.text(x, OFFER_Y - OFFER_H / 2 - 4, t('game.synergyBadge', { bonus: this.pct(synergy.bonus) }), {
          fontSize: '15px', fontFamily: 'Arial', color: '#1a1200', fontStyle: 'bold',
          backgroundColor: COLORS.gold, padding: { x: 8, y: 3 },
        }).setOrigin(0.5).setDepth(24);
        this.offerObjects.push(badge);
      }
      const spent = computeLaneSynergy(card, lane, played).links
        .filter(link => usedPartners.has(link.card.id));
      const lines = synergy.links.map(link => `✦ ${link.card.name} +${this.pct(link.bonus)}%`);
      if (lines.length === 0 && spent.length === 0) lines.push(t('game.noSynergy'));
      const detail = this.add.text(x, OFFER_Y + OFFER_H / 2 + 16, lines.join('\n'), {
        fontSize: '12px', fontFamily: 'Arial', color: glowing ? COLORS.gold : COLORS.muted, align: 'center', lineSpacing: 1,
        fontStyle: glowing ? 'bold' : 'normal',
      }).setOrigin(0.5, 0).setDepth(24);
      this.offerObjects.push(detail);
      if (spent.length > 0) {
        const spentText = this.add.text(x, detail.y + detail.height + 2,
          spent.map(link => t('game.partnerSpent', { name: link.card.name })).join('\n'), {
            fontSize: '11px', fontFamily: 'Arial', color: USED_PARTNER_RED, align: 'center',
          }).setOrigin(0.5, 0).setDepth(24);
        this.offerObjects.push(spentText);
      }

      const hit = this.add.rectangle(x, OFFER_Y, OFFER_W + 10, OFFER_H + 10, 0xffffff, 0)
        .setDepth(26).setInteractive({ useHandCursor: true });
      this.offerObjects.push(hit);
      hit.on('pointerover', () => {
        if (this.selectedCardId !== id) this.tweens.add({ targets: face.container, y: OFFER_Y - 8, scale: 1.03, duration: 150 });
        this.setPartnerHighlight(synergy.links, true, player);
      });
      hit.on('pointerout', () => {
        if (this.selectedCardId !== id) this.tweens.add({ targets: face.container, y: OFFER_Y, scale: 1, duration: 150 });
        this.setPartnerHighlight(synergy.links, false, player);
      });
      hit.on('pointerdown', () => this.onOfferClick(id, face, card));
      face.container.setData('offerId', id);
    });
  }

  /** While hovering an offer, light up the already-played cards it would synergize with. */
  private setPartnerHighlight(links: LaneSynergyLink[], on: boolean, player: Player) {
    const row = this.rowOf(player);
    for (const lane of LANE_ORDER) {
      const slot = this.slots.get(this.key(row, lane));
      if (!slot || slot.kind !== 'face' || !slot.border) continue;
      const lit = on && links.some(link => link.lane === lane);
      if (lit) slot.border.setStrokeStyle(4, hexToInt(COLORS.gold), 1);
      else this.restoreSlotBorder(row, lane);
    }
  }

  /** Default edge for a board card: red once it has been used as a partner this round. */
  private restoreSlotBorder(row: Row, lane: Lane) {
    const slot = this.slots.get(this.key(row, lane));
    if (!slot?.border || !slot.border.active) return;
    if (this.usedPartnerSlots.has(this.key(row, lane))) slot.border.setStrokeStyle(3, hexToInt(USED_PARTNER_RED), 1);
    else slot.border.setStrokeStyle(2, hexToInt(laneColor(lane)), 0.95);
  }

  /** Mark a board card as spent for synergy this round: red edge + red tint + small tag. */
  private markUsedPartner(row: Row, lane: Lane) {
    const key = this.key(row, lane);
    const slot = this.slots.get(key);
    if (!slot || slot.kind !== 'face') return;
    if (!this.usedPartnerSlots.has(key)) {
      this.usedPartnerSlots.add(key);
      slot.container.add(this.add.rectangle(0, 0, SLOT_W, SLOT_H, hexToInt(USED_PARTNER_RED), 0.2).setRounded(7));
      slot.container.add(this.add.text(0, -SLOT_H / 2 + 30, t('game.partnerUsed'), {
        fontSize: '10px', fontFamily: 'Arial', color: '#ffffff', fontStyle: 'bold',
        backgroundColor: USED_PARTNER_RED, padding: { x: 4, y: 1 },
      }).setOrigin(0.5));
      if (slot.border) slot.container.bringToTop(slot.border);
    }
    this.restoreSlotBorder(row, lane);
  }

  private onOfferClick(id: string, face: CardView, card: Card) {
    if (this.busy) return;
    if (this.selectedCardId === id) {
      this.confirmPick();
      return;
    }
    this.selectedCardId = id;
    for (const object of this.offerObjects) {
      if (object instanceof Phaser.GameObjects.Container && object.getData('offerId')) {
        const selected = object.getData('offerId') === id;
        this.tweens.add({ targets: object, y: selected ? OFFER_Y - 12 : OFFER_Y, scale: selected ? 1.05 : 1, duration: 180 });
      }
    }
    void face;
    this.statusText.setText(t('game.selected', { card: card.name }));
    this.showConfirm();
  }

  private showConfirm() {
    this.destroyConfirm();
    const button = addButton(this, SIDE_X, 600, 214, 48, 0x17334a).setDepth(70);
    const text = this.add.text(SIDE_X, 600, t('game.confirmPlay'), {
      fontSize: '16px', fontFamily: 'Arial', color: COLORS.title, fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(71);
    button.on('pointerover', () => button.setFillStyle(0x24536a, 0.96));
    button.on('pointerout', () => button.setFillStyle(0x17334a, COLORS.panelAlpha));
    button.on('pointerdown', () => this.confirmPick());
    this.confirmButton = button;
    this.confirmText = text;
  }

  private destroyConfirm() {
    this.confirmButton?.destroy();
    this.confirmText?.destroy();
    this.confirmButton = null;
    this.confirmText = null;
  }

  private confirmPick() {
    const id = this.selectedCardId;
    if (!id || this.busy) return;
    if (this.online) this.sendOnlinePick(id);
    else this.localPick(id, false);
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
    const next = this.localPickOrder(play.laneIndex).find(player => play.picks[player] === null) ?? null;
    if (!next) return;
    this.picker = next;
    this.highlightLane(lane);
    if (this.lastPicker !== null && this.lastPicker !== next) this.showHandoff(next, lane);
    else this.startLocalTurn(next, lane);
  }

  private showHandoff(player: Player, lane: Lane) {
    this.clearOffers();
    this.localDeadline = null;
    this.promptText.setText(t('game.handoff', { player, other: otherPlayer(player) }));
    this.bonusText.setText('');
    OFFER_X.forEach(x => {
      const back = createCardBack(this, lane, OFFER_W, OFFER_H);
      back.container.setPosition(x, OFFER_Y).setDepth(20);
      this.offerObjects.push(back.container);
    });
    const button = addButton(this, 530, OFFER_Y, 300, 56, 0x1d4a63).setDepth(40);
    const text = this.add.text(530, OFFER_Y, t('game.handoffButton', { player }), {
      fontSize: '18px', fontFamily: 'Arial', color: COLORS.title, fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(41);
    this.offerObjects.push(button, text);
    let done = false;
    const go = () => {
      if (done) return;
      done = true;
      this.handoffTimer?.remove();
      this.handoffTimer = null;
      this.startLocalTurn(player, lane);
    };
    button.on('pointerdown', go);
    this.handoffTimer = this.time.delayedCall(HANDOFF_AUTO_MS, go);
  }

  private startLocalTurn(player: Player, lane: Lane) {
    if (!this.play) return;
    this.renderOffers(player, lane, this.play.offers[player]);
    this.statusText.setText('');
    this.localDeadline = createTurnDeadline(Date.now());
  }

  private localPick(cardId: string, auto: boolean) {
    const play = this.play;
    const player = this.picker;
    if (!play || !player || this.busy) return;
    const chosen = auto ? autoLanePick(play, player, this.random) : (submitLanePick(play, player, cardId) === null ? cardId : null);
    if (!chosen) return;
    this.localDeadline = null;
    this.lastPicker = player;
    this.picker = null;
    this.clearOffers();
    const lane = currentPlayLane(play)!;
    this.setBackSlot(this.rowOf(player), lane);
    if (auto) this.statusText.setText(t('game.autoPicked', { card: cardById(chosen)?.name ?? chosen }));
    else this.statusText.setText('');
    if (!bothPicked(play)) {
      this.time.delayedCall(350, () => this.nextLocalPick());
      return;
    }
    const result = resolveCurrentLane(play, this.random);
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
      this.animateLane(result, () => this.refreshOnline());
      return;
    }
    if (view.phase === 'summary' || view.phase === 'matchEnd') {
      this.leavingOnline = true;
      this.clearOffers();
      this.promptText.setText(t('game.roundComplete'));
      this.time.delayedCall(900, () => this.scene.start('SummaryScene', { online: true }));
      return;
    }
    const lane = battle.currentLane;
    if (!lane) return;
    this.highlightLane(lane);
    const topRow: Row = 'top';
    if (battle.opponentPicked) this.setBackSlot(topRow, lane);
    const pending = this.isPickPending(battle.laneIndex);
    if (battle.myPick || pending) {
      this.clearOffers();
      this.setBackSlot('bottom', lane);
      this.promptText.setText(battle.opponentPicked
        ? t('game.opponentLocked', { name: opponentName(view) })
        : t('game.locked', { name: opponentName(view) }));
      this.bonusText.setText('');
      this.renderedOfferLane = -1;
      return;
    }
    this.statusText.setText(battle.opponentPicked
      ? t('game.opponentLocked', { name: opponentName(view) })
      : t('game.opponentThinking', { name: opponentName(view) }));
    if (this.renderedOfferLane !== battle.laneIndex) {
      this.renderedOfferLane = battle.laneIndex;
      this.renderOffers(view.you, lane, battle.myOffer);
    }
  }

  /** A pick we sent for this lane that the server has not confirmed yet. */
  private isPickPending(laneIndex: number): boolean {
    return this.pickPendingLane === laneIndex && Date.now() < this.pickPendingUntil;
  }

  private sendOnlinePick(cardId: string) {
    if (!this.online || !this.view?.battle) return;
    this.online.send({ type: 'pick', cardId });
    this.pickPendingUntil = Date.now() + 3000;
    this.pickPendingLane = this.view.battle.laneIndex;
    this.statusText.setText('');
    this.renderedOfferLane = -1;
    this.refreshOnline();
    // If the server rejected the pick, the next refresh after the pending window shows the offers again.
    this.time.delayedCall(3100, () => this.refreshOnline());
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
      const mine = !battle.myPick && !this.isPickPending(battle.laneIndex);
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
      this.localPick('', true);
    }
  }

  // ---------- lane reveal + synergy pop ----------

  private animateLane(result: LaneRevealResult, onDone: () => void) {
    this.busy = true;
    this.clearOffers();
    this.turnTimer.hide();
    this.highlightLane(result.lane);
    const lane = result.lane;
    const x = this.columnX(lane);
    this.promptText.setText(t('game.dueling', { lane }));
    this.bonusText.setText('');

    const sides: { player: Player; row: Row; card: Card; winRate: number; synergy: LaneSynergy; total: number }[] = [
      { player: Player.P1, row: this.rowOf(Player.P1), card: result.p1Card, winRate: result.p1WinRate, synergy: result.p1Synergy, total: result.p1Total },
      { player: Player.P2, row: this.rowOf(Player.P2), card: result.p2Card, winRate: result.p2WinRate, synergy: result.p2Synergy, total: result.p2Total },
    ];

    // 1) Flip both cards face up.
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

    // 2) Each synergy partner pops out of its column, flies in beside the new card and adds its tier %.
    const flipMs = 700;
    const maxLinks = Math.max(result.p1Synergy.links.length, result.p2Synergy.links.length);
    for (const side of sides) {
      let running = side.winRate + result.orderBonus;
      side.synergy.links.forEach((link, index) => {
        running += link.bonus;
        const totalAfter = running;
        this.time.delayedCall(flipMs + index * SYNERGY_STEP_MS, () =>
          this.popSynergyPartner(side.row, lane, link, index, totalAfter, faces.get(side.row)!));
      });
    }

    // 3) Lane winner.
    const winnerAt = flipMs + maxLinks * SYNERGY_STEP_MS + (maxLinks > 0 ? 700 : 150);
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

  private popSynergyPartner(row: Row, lane: Lane, link: LaneSynergyLink, index: number, totalAfter: number, target: CardView) {
    const partnerSlot = this.slots.get(this.key(row, link.lane));
    const fromX = this.columnX(link.lane);
    const fromY = this.rowY(row);
    const toX = this.columnX(lane);
    const toY = this.rowY(row);
    const bonusLabel = `+${this.pct(link.bonus)}%`;

    // Partner card in its own column lights up and pulses.
    if (partnerSlot?.border) {
      const border = partnerSlot.border;
      border.setStrokeStyle(4, hexToInt(COLORS.gold), 1);
      this.time.delayedCall(1600, () => {
        if (border.active) this.markUsedPartner(row, link.lane);
      });
    }
    if (partnerSlot) {
      this.tweens.add({ targets: partnerSlot.container, scale: 1.14, duration: 180, yoyo: true, ease: 'Sine.Out' });
      const tag = this.add.text(fromX, fromY + SLOT_H / 2 - 2, bonusLabel, {
        fontSize: '13px', fontFamily: 'Arial', color: '#1a1200', fontStyle: 'bold',
        backgroundColor: COLORS.gold, padding: { x: 5, y: 1 },
      }).setOrigin(0.5).setDepth(36);
      this.time.delayedCall(1500, () => tag.destroy());
    }

    // A copy of the partner flies in and docks beside the newly played card with its tier %.
    const copy = createCardFace(this, link.card, link.lane, SLOT_W, SLOT_H, { nameFontSize: '10px' });
    copy.border.setStrokeStyle(4, hexToInt(COLORS.gold), 1);
    copy.container.setPosition(fromX, fromY).setDepth(50 + index);
    const glow = this.add.rectangle(0, 0, SLOT_W + 14, SLOT_H + 14, hexToInt(COLORS.gold), 0.18)
      .setRounded(10).setStrokeStyle(5, hexToInt(COLORS.gold), 0.9);
    copy.container.addAt(glow, 0);
    const tierTag = this.add.text(0, -SLOT_H / 2 - 12, bonusLabel, {
      fontSize: '22px', fontFamily: 'Arial', color: '#1a1200', fontStyle: 'bold',
      backgroundColor: COLORS.gold, padding: { x: 8, y: 2 },
    }).setOrigin(0.5);
    copy.container.add(tierTag);
    const side = toX >= fromX ? -1 : 1;
    const dockX = toX + side * (SLOT_W * 0.5 + 42) * (index % 2 === 0 ? 1 : -1);
    const dockY = toY + (row === 'top' ? 52 : -52) + Math.floor(index / 2) * 18;

    const line = this.add.graphics().setDepth(45);
    line.lineStyle(3, hexToInt(COLORS.gold), 0.85);
    line.beginPath();
    line.moveTo(fromX, fromY);
    line.lineTo(toX, toY);
    line.strokePath();
    this.tweens.add({ targets: line, alpha: 0, delay: 500, duration: 500, onComplete: () => line.destroy() });

    this.tweens.add({
      targets: copy.container,
      x: dockX,
      y: dockY,
      scale: 0.76,
      duration: 480,
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
        this.tweens.add({ targets: copy.container, alpha: 0, delay: 1700, duration: 450, onComplete: () => copy.container.destroy() });
      },
    });
  }
}
