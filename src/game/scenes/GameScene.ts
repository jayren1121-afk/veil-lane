import Phaser from 'phaser';
import {
  resolveRound,
  isMatchOver,
  getScoreString,
  Placement,
  Player,
  Lane,
  LANE_ORDER,
  Card,
  MatchState,
  LaneRevealResult,
  resolveLaneDuel,
  createRevealState,
  revealLane,
  getRemainingLanes,
  getRevealOrder,
  isRevealComplete,
  getFirstPlayer,
  otherPlayer,
  ORDER_BONUS,
  GamePhase,
} from '../rules';
import { CARDS } from '../data/cards';
import { CARD_BACK_KEY, cardArtPath, cardBackPath } from '../data/art';
import { t } from '../i18n';
import { createCardBack, createCardFace, CardView } from './cardView';
import { setupSceneMusic } from './musicToggle';
import {
  BATTLE_TURN_SECONDS,
  createTurnDeadline,
  isTurnExpired,
  pickRandomLane,
} from '../rules';
import type { MatchView } from '../online/protocol';
import type { OnlineClient } from '../../net/onlineClient';
import { bindOnlineScene, mirrorMatchState, opponentName, sideLabel } from './onlineScene';
import { TurnTimerView } from './turnTimer';
import {
  addArtBrighten,
  addButton,
  addCardGlow,
  addPanel,
  COLORS,
  countUp,
  drawBackground,
  drawHeader,
  glowText,
  hexToInt,
  laneColor,
} from './theme';

const WIDTH = 1200;
const CARD_W = 126;
const CARD_H = 168;
const CARD_ART_H = 132;
const LANE_CENTERS = [180, 390, 600, 810, 1020];
const P2_CARD_Y = 164;
const P1_CARD_Y = 438;
const LANE_BUTTON_Y = 318;

const TABLE_LANE_CENTERS = [280, 440, 600, 760, 920];
const TABLE_HAND_Y = [696, 678, 668, 678, 696];
const TABLE_HAND_ROTATION = [-8, -4, 0, 4, 8].map(degrees => Phaser.Math.DegToRad(degrees));
const TABLE_HAND_W = 144;
const TABLE_HAND_H = 192;
const TABLE_DUEL_W = 132;
const TABLE_DUEL_H = 176;
const TABLE_OPPONENT_X = 500;
const TABLE_LEAD_X = 700;
const TABLE_OPPONENT_Y = 214;
const TABLE_LEAD_Y = 426;

interface TableHandCard extends CardView {
  lane: Lane;
  baseY: number;
  baseRotation: number;
  hitZone: Phaser.GameObjects.Rectangle;
}

export class GameScene extends Phaser.Scene {
  constructor() {
    super({ key: 'GameScene' });
  }

  private state!: MatchState;
  private p1Placements: Placement[] = [];
  private p2Placements: Placement[] = [];
  private currentRound = 1;

  private placedCardsP1 = new Map<Lane, Phaser.GameObjects.Container>();  // face-down P1 cards per lane
  private placedCardsP2 = new Map<Lane, Phaser.GameObjects.Container>();  // face-down P2 cards per lane
  private faceDownCardBacks = new Map<Lane, Phaser.GameObjects.Rectangle[]>();
  private laneLabels = new Map<Lane, Phaser.GameObjects.Text>();
  private laneButtons = new Map<Lane, Phaser.GameObjects.Rectangle>();
  private statusText!: Phaser.GameObjects.Text;
  private revealHintText!: Phaser.GameObjects.Text;
  private revealBonusText!: Phaser.GameObjects.Text;
  private scoreText!: Phaser.GameObjects.Text;
  private progressText!: Phaser.GameObjects.Text;
  private resultGroup!: Phaser.GameObjects.Container;
  
  private revealState!: ReturnType<typeof createRevealState>;
  private isRevealing = false;
  private laneRevealResults: LaneRevealResult[] = [];

  private tableHands = new Map<Lane, TableHandCard>();
  private tableBacks = new Map<Lane, Phaser.GameObjects.Container>();
  private tablePlayed = new Set<Lane>();
  private tableOrder: Lane[] = [];
  private tableResults: LaneRevealResult[] = [];
  private tableLeadPlayer!: Player;
  private tableSelectedLane: Lane | null = null;
  private tableBusy = false;
  private tableAdvancePending = false;
  private tableNextTimer: Phaser.Time.TimerEvent | null = null;
  private tableStageObjects: Phaser.GameObjects.GameObject[] = [];
  private tableActionButton: Phaser.GameObjects.Rectangle | null = null;
  private tableActionText: Phaser.GameObjects.Text | null = null;
  private tableStatusText!: Phaser.GameObjects.Text;
  private tableProgressText!: Phaser.GameObjects.Text;
  private tableScoreText!: Phaser.GameObjects.Text;

  /** Player whose hand is drawn face-up at the bottom (lead locally, always "me" online). */
  private bottomPlayer: Player = Player.P1;
  private turnTimer!: TurnTimerView;
  private localDeadline: number | null = null;
  private timerTick: Phaser.Time.TimerEvent | null = null;
  private online: OnlineClient | null = null;
  private view: MatchView | null = null;
  private animatedCount = 0;
  private leavingOnline = false;
  private playPending = false;

  init(data: any) {
    this.online = null;
    this.view = null;
    this.animatedCount = 0;
    this.leavingOnline = false;
    this.playPending = false;
    this.localDeadline = null;
    this.timerTick = null;
    if (data?.online) {
      // Online: only my own cards are known up front; opponent cards arrive lane by lane.
      this.view = null;
      this.state = undefined as unknown as MatchState;
      this.p1Placements = [];
      this.p2Placements = [];
      this.currentRound = 1;
      this.initOnline = true;
      return;
    }
    this.initOnline = false;
    this.state = data.matchState;
    this.p1Placements = data.p1Placements;
    this.p2Placements = data.p2Placements;
    this.currentRound = data.round || 1;
  }

  private initOnline = false;

  /** Label for a side: P1/P2 locally, "YOU"/nickname online. */
  private label(player: Player): string {
    return this.view ? sideLabel(this.view, player) : player;
  }

  private canAct(): boolean {
    if (!this.view) return true;
    return this.view.phase === 'battle' && this.view.battle?.lead === this.view.you;
  }

  preload() {
    // Load all card art images
    for (const card of CARDS) {
      this.load.image(card.id, cardArtPath(card.id));
    }
    this.load.image(CARD_BACK_KEY, cardBackPath());
  }

  create() {
    this.placedCardsP1.clear();
    this.placedCardsP2.clear();
    this.faceDownCardBacks.clear();
    this.laneLabels.clear();
    this.laneButtons.clear();
    this.laneRevealResults = [];
    this.tableHands.clear();
    this.tableBacks.clear();
    this.tablePlayed.clear();
    this.tableOrder = [];
    this.tableResults = [];
    this.tableSelectedLane = null;
    this.tableBusy = false;
    this.tableAdvancePending = false;
    this.tableNextTimer = null;
    this.tableStageObjects = [];
    setupSceneMusic(this);
    drawBackground(this);
    if (this.initOnline) {
      const client = bindOnlineScene(this, view => this.onOnlineState(view));
      if (!client?.state || !client.state.battle) {
        this.scene.start('LobbyScene');
        return;
      }
      this.online = client;
      this.applyOnlineView(client.state);
    }
    this.createTableView();
    this.turnTimer = new TurnTimerView(this, 1068, 282);
    this.timerTick = this.time.addEvent({ delay: 200, loop: true, callback: () => this.updateTurnTimer() });
    if (this.online) {
      this.updateOnlineStatus();
      this.processOnlineReveals();
    } else {
      this.startLocalTurn();
    }
  }

  // ----- online -----

  private applyOnlineView(view: MatchView) {
    this.view = view;
    this.state = mirrorMatchState(view);
    this.currentRound = view.round;
    const mine: Placement[] = [];
    for (const lane of LANE_ORDER) {
      const id = view.battle?.myCards[lane];
      const card = id ? CARDS.find(item => item.id === id) : undefined;
      if (card) mine.push({ card, lane });
    }
    if (view.you === Player.P1) this.p1Placements = mine;
    else this.p2Placements = mine;
  }

  private onOnlineState(view: MatchView) {
    if (this.leavingOnline) return;
    if (view.phase === 'draft' || view.phase === 'waiting') {
      this.leavingOnline = true;
      this.scene.start(view.phase === 'draft' ? 'DraftScene' : 'LobbyScene', { online: true });
      return;
    }
    if (view.round !== this.currentRound && view.phase === 'battle') {
      this.scene.restart({ online: true });
      return;
    }
    const keepBattle = this.view?.battle;
    this.view = view;
    this.state = mirrorMatchState(view);
    if (!view.battle && keepBattle) this.view = { ...view, battle: keepBattle };
    this.updateOnlineStatus();
    this.processOnlineReveals();
  }

  /** Animate the next lane the server has opened that we have not shown yet. */
  private processOnlineReveals() {
    const view = this.view;
    if (!view?.battle || this.tableBusy || this.tableAdvancePending) return;
    const revealed = view.battle.revealed;
    if (this.animatedCount < revealed.length) {
      const result = revealed[this.animatedCount];
      this.animatedCount += 1;
      this.animateLane(result.lane, result);
      return;
    }
    if ((view.phase === 'summary' || view.phase === 'matchEnd') && this.animatedCount >= LANE_ORDER.length) {
      this.leavingOnline = true;
      this.time.delayedCall(900, () => this.scene.start('SummaryScene', { online: true }));
    }
  }

  private updateOnlineStatus() {
    const view = this.view;
    if (!view?.battle || this.tableBusy || !this.tableStatusText) return;
    if (view.phase !== 'battle') return;
    this.tableStatusText.setText(this.canAct()
      ? t('online.yourTurnPlay')
      : t('online.waitingOpponentPlay', { name: opponentName(view) }));
  }

  // ----- 20s battle turn timer -----

  private startLocalTurn() {
    if (this.online || this.tableOrder.length >= LANE_ORDER.length) return;
    this.localDeadline = createTurnDeadline(Date.now());
  }

  private updateTurnTimer() {
    if (!this.turnTimer) return;
    if (this.online) {
      const battle = this.view?.battle;
      const now = this.online.serverNow();
      if (!battle || this.view?.phase !== 'battle' || battle.turnDeadline === null
        || (battle.turnStartsAt !== null && now < battle.turnStartsAt) || this.tableBusy) {
        this.turnTimer.hide();
        return;
      }
      this.turnTimer.update(battle.turnDeadline - now, this.canAct()
        ? t('online.yourTurnPlay')
        : t('online.waitingOpponentPlay', { name: opponentName(this.view!) }));
      return;
    }
    if (this.localDeadline === null || this.tableBusy) {
      this.turnTimer.hide();
      return;
    }
    const now = Date.now();
    this.turnTimer.update(this.localDeadline - now, t('timer.caption'));
    if (isTurnExpired(this.localDeadline, now)) {
      this.localDeadline = null;
      const lane = pickRandomLane(this.revealState);
      if (!lane) return;
      this.tableStatusText.setText(t('timer.autoPicked', { lane }));
      this.playTableLane(lane);
    }
  }

  private createLaneZones() {
    const firstPlayer = getFirstPlayer(this.state, this.currentRound);
    this.add.text(44, P2_CARD_Y, firstPlayer === Player.P2 ? 'P2\n先手' : 'P2', {
      fontSize: '16px', fontFamily: 'Arial', color: COLORS.p2, fontStyle: 'bold', align: 'center',
    }).setOrigin(0.5);
    this.add.text(44, P1_CARD_Y, firstPlayer === Player.P1 ? 'P1\n先手' : 'P1', {
      fontSize: '16px', fontFamily: 'Arial', color: COLORS.p1, fontStyle: 'bold', align: 'center',
    }).setOrigin(0.5);

    for (let i = 0; i < LANE_ORDER.length; i++) {
      const lane = LANE_ORDER[i];
      const x = LANE_CENTERS[i];
      addPanel(this, x, 321, 184, 478, 0x0d2032);

      const laneTint = hexToInt(laneColor(lane));
      const button = this.add.rectangle(x, LANE_BUTTON_Y, 132, 34, 0x10263a, COLORS.panelAlpha)
        .setRounded(8).setStrokeStyle(1, laneTint, 0.8).setInteractive({ useHandCursor: true });
      const laneLabel = this.add.text(x, LANE_BUTTON_Y, lane, {
        fontSize: '11px', fontFamily: 'Arial', color: laneColor(lane), fontStyle: 'bold',
      }).setOrigin(0.5).setInteractive({ useHandCursor: true });
      button.on('pointerdown', () => this.onLaneSelect(lane));
      laneLabel.on('pointerdown', () => this.onLaneSelect(lane));
      this.laneButtons.set(lane, button);
      button.on('pointerover', () => this.setLaneHighlight(lane, true));
      button.on('pointerout', () => this.setLaneHighlight(lane, false));
      laneLabel.on('pointerover', () => this.setLaneHighlight(lane, true));
      laneLabel.on('pointerout', () => this.setLaneHighlight(lane, false));
      this.laneLabels.set(lane, laneLabel);

      addPanel(this, x, P2_CARD_Y, CARD_W + 10, CARD_H + 10, 0x0b2034);
      addPanel(this, x, P1_CARD_Y, CARD_W + 10, CARD_H + 10, 0x0b2034);
    }
  }

  private createUI() {
    drawHeader(this, `第 ${this.currentRound} 局 — 開牌階段`);
    const firstPlayer = getFirstPlayer(this.state, this.currentRound);
    this.add.text(30, 58, `本局先手：${firstPlayer}`, {
      fontSize: '12px', fontFamily: 'Arial', color: COLORS.muted,
    }).setOrigin(0, 0.5);
    this.scoreText = this.add.text(WIDTH / 2, 35, getScoreString(this.state), {
      fontSize: '17px', fontFamily: 'Arial', color: COLORS.title, fontStyle: 'bold',
    }).setOrigin(0.5);
    this.progressText = this.add.text(1170, 35, '', {
      fontSize: '14px', fontFamily: 'Arial', color: COLORS.gold,
    }).setOrigin(1, 0.5);
    this.statusText = this.add.text(WIDTH / 2, 775, '', {
      fontSize: '15px', fontFamily: 'Arial', color: COLORS.muted,
    }).setOrigin(0.5);
    this.revealHintText = this.add.text(WIDTH / 2, 610, '', {
      fontSize: '22px', fontFamily: 'Arial', color: COLORS.title, fontStyle: 'bold',
    }).setOrigin(0.5);
    glowText(this.revealHintText);
    this.revealBonusText = this.add.text(WIDTH / 2, 642, '', {
      fontSize: '15px', fontFamily: 'Arial', color: COLORS.muted,
    }).setOrigin(0.5);
    this.resultGroup = this.add.container(0, 0).setDepth(100);
  }

  private updateScore() {
    this.scoreText.setText(getScoreString(this.state));
  }

  private updateProgress() {
    const revealed = this.revealState.revealOrder.length;
    const nextBonus = ORDER_BONUS[revealed];
    this.progressText.setText(nextBonus === undefined
      ? `已開 ${revealed}/5`
      : `已開 ${revealed}/5 · 下一路 +${nextBonus}%`);
  }

  // Show face-down cards from draft result, then start sequential reveal
  private showFaceDownCards() {
    this.placedCardsP1.clear();
    this.placedCardsP2.clear();
    this.laneRevealResults = [];
    this.revealState = createRevealState(getFirstPlayer(this.state, this.currentRound));
    this.isRevealing = false;

    // Show face-down cards in LANE_ORDER order (one per lane)
    for (let i = 0; i < LANE_ORDER.length; i++) {
      const lane = LANE_ORDER[i];
      const x = LANE_CENTERS[i];
      const cardBacks: Phaser.GameObjects.Rectangle[] = [];

      // P1 face-down card
      const p1Place = this.p1Placements.find(p => p.lane === lane);
      if (p1Place) {
        const { container, border } = this.createFaceDownCard(x, P1_CARD_Y, lane);
        cardBacks.push(border);
        this.placedCardsP1.set(lane, container);
      }

      // P2 face-down card
      const p2Place = this.p2Placements.find(p => p.lane === lane);
      if (p2Place) {
        const { container, border } = this.createFaceDownCard(x, P2_CARD_Y, lane);
        cardBacks.push(border);
        this.placedCardsP2.set(lane, container);
      }

      this.faceDownCardBacks.set(lane, cardBacks);
    }

    this.state.phase = GamePhase.Reveal;
    for (let i = 0; i < LANE_ORDER.length; i++) {
      this.laneLabels.get(LANE_ORDER[i])?.setText(`${LANE_ORDER[i]}｜點此開牌`);
    }
    this.statusText.setText('可點擊任一張蓋牌，或點擊該路按鈕開牌');
    this.updateRevealHint();
    this.updateProgress();
  }

  private createFaceDownCard(
    x: number,
    y: number,
    lane: Lane,
  ): { container: Phaser.GameObjects.Container; border: Phaser.GameObjects.Rectangle } {
    const container = this.add.container(x, y);
    container.add(addCardGlow(this, 0, 0, CARD_W, CARD_H, laneColor(lane)));
    container.add(this.add.image(0, 0, CARD_BACK_KEY).setDisplaySize(CARD_W, CARD_H));

    const border = this.add.rectangle(0, 0, CARD_W, CARD_H, 0x000000, 0)
      .setRounded(7)
      .setStrokeStyle(2, hexToInt(laneColor(lane)))
      .setInteractive({ useHandCursor: true });
    border.on('pointerdown', () => this.onLaneSelect(lane));
    border.on('pointerover', () => this.setLaneHighlight(lane, true));
    border.on('pointerout', () => this.setLaneHighlight(lane, false));
    container.add(border);

    return { container, border };
  }

  private setLaneHighlight(lane: Lane, highlighted: boolean) {
    if (!getRemainingLanes(this.revealState).includes(lane)) return;

    const backs = this.faceDownCardBacks.get(lane) ?? [];
    for (let i = 0; i < backs.length; i++) {
      backs[i].setStrokeStyle(highlighted ? 4 : 2,
        highlighted ? hexToInt(COLORS.gold) : hexToInt(laneColor(lane)));
    }

    this.placedCardsP1.get(lane)?.setScale(highlighted ? 1.05 : 1);
    this.placedCardsP2.get(lane)?.setScale(highlighted ? 1.05 : 1);

    this.laneButtons.get(lane)
      ?.setFillStyle(highlighted ? hexToInt(laneColor(lane)) : 0x10263a, highlighted ? 0.42 : COLORS.panelAlpha)
      .setStrokeStyle(highlighted ? 3 : 1, hexToInt(laneColor(lane)));
    this.laneLabels.get(lane)?.setColor(highlighted ? COLORS.title : laneColor(lane));
  }

  private updateRevealHint(message?: string) {
    const nextBonus = ORDER_BONUS[this.revealState.revealOrder.length];
    this.revealHintText.setText(message ?? `先手 ${this.revealState.firstPlayer}：點任一路的卡片開牌`);
    this.revealBonusText.setText(nextBonus === undefined
      ? ''
      : `所選路線雙方各 +${nextBonus}%`);
  }

  private onLaneSelect(lane: Lane) {
    if (this.isRevealing || isRevealComplete(this.revealState)) return;
    const nextState = revealLane(this.revealState, lane);
    if (!nextState) {
      this.statusText.setText(`${lane} 已開牌，請選擇尚未揭曉的路線`);
      return;
    }

    this.setLaneHighlight(lane, false);
    this.revealState = nextState;
    this.updateProgress();
    const orderIndex = nextState.revealOrder.length - 1;
    const p1Place = this.p1Placements.find(p => p.lane === lane);
    const p2Place = this.p2Placements.find(p => p.lane === lane);
    if (!p1Place || !p2Place) {
      this.statusText.setText(`缺少 ${lane} 路卡牌，無法開牌`);
      return;
    }

    const laneResult = resolveLaneDuel(p1Place.card, p2Place.card, lane, orderIndex);
    this.laneRevealResults.push(laneResult);

    // Animate flip: scale X to 0 then replace with revealed card
    const p1Container = this.placedCardsP1.get(lane);
    const p2Container = this.placedCardsP2.get(lane);
    if (!p1Container || !p2Container) {
      return;
    }

    this.isRevealing = true;
    const x = LANE_CENTERS[LANE_ORDER.indexOf(lane)];
    this.statusText.setText(`開牌中：${lane}`);
    this.updateRevealHint(`正在翻開 ${lane}...`);

    // Close the face-down cards, swap the face while narrow, then open the revealed cards.
    this.tweens.add({
      targets: [p1Container, p2Container],
      scaleX: 0,
      duration: 150,
      ease: 'Power2',
    });

    this.time.delayedCall(160, () => {
      if (p1Container.active) p1Container.destroy();
      if (p2Container.active) p2Container.destroy();

      const p1Revealed = this.showRevealedCard(x, P1_CARD_Y, lane, p1Place.card, laneResult.p1WinRate,
        laneResult.p1Total, laneResult.orderBonus, laneResult.laneWinner === Player.P1,
        laneResult.laneWinner === Player.P2);
      const p2Revealed = this.showRevealedCard(x, P2_CARD_Y, lane, p2Place.card, laneResult.p2WinRate,
        laneResult.p2Total, laneResult.orderBonus, laneResult.laneWinner === Player.P2,
        laneResult.laneWinner === Player.P1);
      p1Revealed.setScale(0, 1);
      p2Revealed.setScale(0, 1);
      this.tweens.add({ targets: [p1Revealed, p2Revealed], scaleX: 1, duration: 150, ease: 'Power2' });

      const flashes = [P1_CARD_Y, P2_CARD_Y].map(y => this.add.rectangle(x, y, CARD_W + 8, CARD_H + 8, 0xffffff, 0.65)
        .setBlendMode(Phaser.BlendModes.ADD).setDepth(20));
      this.tweens.add({ targets: flashes, alpha: 0, duration: 220, ease: 'Sine.Out' });

      // Update status
      const winnerText = laneResult.laneWinner ? `${laneResult.laneWinner} 對線勝` : '對線平手';
      const resultColor = laneResult.laneWinner === Player.P1 ? COLORS.win
        : laneResult.laneWinner === Player.P2 ? COLORS.lose : COLORS.muted;
      const laneLabel = this.laneLabels.get(lane);
      laneLabel?.setText(`${lane}｜第 ${orderIndex + 1} 開 +${ORDER_BONUS[orderIndex]}%`)
        .setFontSize(11).setColor(resultColor).disableInteractive();
      this.laneButtons.get(lane)?.setFillStyle(0x0d2032, COLORS.panelAlpha)
        .setStrokeStyle(2, hexToInt(laneColor(lane))).disableInteractive();
      this.time.delayedCall(160, () => {
        flashes.forEach(flash => flash.destroy());
        this.updateProgress();
        this.isRevealing = false;
        if (isRevealComplete(this.revealState)) {
          this.revealHintText.setVisible(false);
          this.revealBonusText.setVisible(false);
          this.statusText.setText(`${lane} 開牌完成，正在結算配合...`);
          this.time.delayedCall(600, () => this.showFinalResult());
        } else {
          this.statusText.setText(`${winnerText}｜請選擇下一路`);
          this.updateRevealHint();
        }
      });
    });
  }

  // Show a revealed card with win rate below
  private showRevealedCard(
    x: number,
    y: number,
    lane: Lane,
    card: Card,
    winRate: number,
    total: number,
    orderBonus: number,
    isWinner: boolean,
    isLoser: boolean,
  ): Phaser.GameObjects.Container {
    const container = this.add.container(x, y);
    container.add(addCardGlow(this, 0, 0, CARD_W, CARD_H, laneColor(lane)));
    const rect = this.add.rectangle(0, 0, CARD_W, CARD_H, hexToInt(card.color), 0.96)
      .setRounded(7).setInteractive();
    rect.setStrokeStyle(2, hexToInt(laneColor(lane)));
    container.add(rect);

    let brighten: Phaser.GameObjects.Rectangle | undefined;
    if (this.textures.exists(card.id)) {
      const art = this.add.image(0, -18, card.id).setDisplaySize(CARD_W - 4, CARD_ART_H);
      container.add(art);
      brighten = addArtBrighten(this, 0, -18, CARD_W - 4, CARD_ART_H);
      container.add(brighten);
    }
    rect.on('pointerover', () => {
      container.setScale(1.05);
      rect.setStrokeStyle(3, hexToInt(laneColor(lane)));
      brighten?.setAlpha(0.2);
    });
    rect.on('pointerout', () => {
      container.setScale(1);
      rect.setStrokeStyle(2, hexToInt(laneColor(lane)));
      brighten?.setAlpha(0.08);
    });

    container.add(this.add.rectangle(0, 66, CARD_W - 4, 34, 0x0b2034, 0.9).setRounded(5));
    container.add(this.add.text(0, 65, card.name, {
      fontSize: '11px', fontFamily: 'Arial', color: COLORS.text, fontStyle: 'bold',
      align: 'center', wordWrap: { width: CARD_W - 12, useAdvancedWrap: true },
    }).setOrigin(0.5));
    if (isWinner) {
      container.add(this.add.text(CARD_W / 2 - 4, -CARD_H / 2 + 4, '勝', {
        fontSize: '13px', fontFamily: 'Arial', color: '#082a19', fontStyle: 'bold',
        backgroundColor: COLORS.win, padding: { x: 5, y: 2 },
      }).setOrigin(1, 0));
    }

    const yValue = y + CARD_H / 2 + 12;
    const rateColor = isWinner ? COLORS.win : isLoser ? COLORS.lose : COLORS.text;
    const rateText = this.add.text(x, yValue, '對線 0.0%', {
      fontSize: '12px', fontFamily: 'Arial', color: rateColor, fontStyle: 'bold',
    }).setOrigin(0.5);
    countUp(this, rateText, winRate * 100, value => `對線 ${value.toFixed(1)}%`, 450);
    const totalText = this.add.text(x, yValue + 17,
      `順序 +${(orderBonus * 100).toFixed(0)}% → 0.0%`, {
        fontSize: '11px', fontFamily: 'Arial', color: rateColor, fontStyle: 'bold',
      }).setOrigin(0.5);
    countUp(this, totalText, total * 100,
      value => `順序 +${(orderBonus * 100).toFixed(0)}% → ${value.toFixed(1)}%`, 500);
    return container;
  }

  // After all 5 lanes revealed, compute synergies and show final result
  private showFinalResult() {
    const result = resolveRound(this.p1Placements, this.p2Placements, this.state, getRevealOrder(this.revealState));
    this.resultGroup.removeAll(true);
    this.resultGroup.add(addPanel(this, 600, 665, 1100, 170, 0x0b2034));
    this.drawSynergyLinks(result.p1Synergy.obviousSynergies, COLORS.p1, 568);
    this.drawSynergyLinks(result.p2Synergy.obviousSynergies, COLORS.p2, 286);
    const winnerText = result.roundWinner ? `${result.roundWinner} 贏得本局` : '本局平手';
    const winnerColor = result.roundWinner === Player.P1 ? COLORS.p1
      : result.roundWinner === Player.P2 ? COLORS.p2 : COLORS.gold;
    if (result.roundWinner) {
      const aura = this.add.ellipse(600, 598, 330, 54, hexToInt(winnerColor), 0.14)
        .setBlendMode(Phaser.BlendModes.ADD);
      this.resultGroup.add(aura);
      this.tweens.add({ targets: aura, alpha: { from: 0.08, to: 0.24 }, scale: { from: 0.94, to: 1.08 },
        duration: 1100, yoyo: true, repeat: -1, ease: 'Sine.InOut' });
    }
    const winnerLabel = this.add.text(600, 598, winnerText, {
      fontSize: '28px', fontFamily: 'Arial', color: winnerColor, fontStyle: 'bold',
    }).setOrigin(0.5);
    this.resultGroup.add(glowText(winnerLabel, winnerColor));
    const barW = 520;
    const p1W = barW * result.p1WinRate / (result.p1WinRate + result.p2WinRate);
    const p1TotalText = this.add.text(600 - barW / 2 - 12, 628, 'P1 總勝率 0.0%', {
      fontSize: '16px', fontFamily: 'Arial', color: COLORS.p1, fontStyle: 'bold',
    }).setOrigin(1, 0.5);
    const p2TotalText = this.add.text(600 + barW / 2 + 12, 628, '0.0% P2 總勝率', {
      fontSize: '16px', fontFamily: 'Arial', color: COLORS.p2, fontStyle: 'bold',
    }).setOrigin(0, 0.5);
    this.resultGroup.add([p1TotalText, p2TotalText]);
    countUp(this, p1TotalText, result.p1WinRate * 100,
      value => `P1 總勝率 ${value.toFixed(1)}%`, 700);
    countUp(this, p2TotalText, result.p2WinRate * 100,
      value => `${value.toFixed(1)}% P2 總勝率`, 700);
    this.resultGroup.add(this.add.rectangle(600 - barW / 2, 628, p1W, 12, 0x79b8ff).setOrigin(0, 0.5));
    this.resultGroup.add(this.add.rectangle(600 - barW / 2 + p1W, 628, barW - p1W, 12, hexToInt(COLORS.lose)).setOrigin(0, 0.5));
    this.resultGroup.add(this.add.text(600, 652,
      `對線平均 P1 ${(result.p1MatchupAvg * 100).toFixed(1)}% / P2 ${(result.p2MatchupAvg * 100).toFixed(1)}%　開路 +${(result.orderBonusAvg * 100).toFixed(1)}%　配合 P1 +${(result.p1Synergy.bonus * 100).toFixed(1)}% / P2 +${(result.p2Synergy.bonus * 100).toFixed(1)}%`, {
        fontSize: '12px', fontFamily: 'Arial', color: COLORS.text,
      }).setOrigin(0.5));

    const comboText = (team: typeof result.p1Synergy) => {
      const combos = team.obviousSynergies.slice(0, 4)
        .map(s => `${s.cardA.name}＋${s.cardB.name}`);
      if (team.obviousSynergies.length > 4) combos.push(`等 ${team.obviousSynergies.length - 4} 組`);
      return combos.map(combo => `✦ ${combo}`).join('　') || '無';
    };
    this.resultGroup.add(this.add.text(600, 672,
      `P1 配合（+${(result.p1Synergy.bonus * 100).toFixed(1)}%）：${comboText(result.p1Synergy)}`, {
        fontSize: '11px', fontFamily: 'Arial', color: COLORS.p1,
      }).setOrigin(0.5));
    this.resultGroup.add(this.add.text(600, 689,
      `P2 配合（+${(result.p2Synergy.bonus * 100).toFixed(1)}%）：${comboText(result.p2Synergy)}`, {
        fontSize: '11px', fontFamily: 'Arial', color: COLORS.p2,
      }).setOrigin(0.5));
    this.resultGroup.add(this.add.text(600, 706, `開牌順序：${result.revealOrder.join(' → ')}`, {
      fontSize: '11px', fontFamily: 'Arial', color: COLORS.muted,
    }).setOrigin(0.5));

    this.updateScore();
    this.statusText.setText('本局結算完成');

    const nextScene = isMatchOver(this.state) ? 'SummaryScene' : 'DraftScene';
    const buttonLabel = isMatchOver(this.state) ? '查看總結' : '下一局';
    const button = addButton(this, 600, 732, 220, 28, 0x17334a);
    const buttonText = this.add.text(600, 732, '', {
      fontSize: '13px', fontFamily: 'Arial', color: COLORS.text, fontStyle: 'bold',
    }).setOrigin(0.5);
    this.resultGroup.add([button, buttonText]);
    let secondsLeft = 8;
    let proceeded = false;
    const proceed = () => {
      if (proceeded) return;
      proceeded = true;
      if (nextScene === 'SummaryScene') this.scene.start(nextScene, { state: this.state });
      else this.scene.start(nextScene, { matchState: this.state, round: this.state.currentRound });
    };
    const refresh = () => buttonText.setText(`${buttonLabel} ▶（${secondsLeft} 秒後自動）`);
    refresh();
    button.on('pointerover', () => button.setFillStyle(0x24536a, 0.95));
    button.on('pointerout', () => button.setFillStyle(0x17334a, COLORS.panelAlpha));
    button.on('pointerdown', proceed);
    this.time.addEvent({
      delay: 1000,
      repeat: secondsLeft - 1,
      callback: () => {
        if (proceeded) return;
        secondsLeft--;
        if (secondsLeft <= 0) proceed();
        else refresh();
      },
    });
  }

  private drawSynergyLinks(
    synergies: { laneA: Lane; laneB: Lane }[],
    color: string,
    linkY: number,
  ) {
    synergies.forEach((synergy, index) => {
      const laneAIndex = LANE_ORDER.indexOf(synergy.laneA);
      const laneBIndex = LANE_ORDER.indexOf(synergy.laneB);
      if (laneAIndex < 0 || laneBIndex < 0 || laneAIndex === laneBIndex) return;
      const left = Math.min(LANE_CENTERS[laneAIndex], LANE_CENTERS[laneBIndex]) + CARD_W / 2;
      const right = Math.max(LANE_CENTERS[laneAIndex], LANE_CENTERS[laneBIndex]) - CARD_W / 2;
      const y = linkY + Math.min(index, 4) * 2;
      const links = this.add.graphics().setDepth(5);
      links.lineStyle(2, hexToInt(color), 0.65);
      links.beginPath();
      links.moveTo(left, y);
      links.lineTo(right, y);
      links.strokePath();
      this.add.text((left + right) / 2, y - 2, '✦', {
        fontSize: '13px', fontFamily: 'Arial', color, fontStyle: 'bold',
      }).setOrigin(0.5).setDepth(6);
    });
  }

  private createTableView() {
    this.tableLeadPlayer = this.view?.battle ? this.view.battle.lead : getFirstPlayer(this.state, this.currentRound);
    this.bottomPlayer = this.view ? this.view.you : this.tableLeadPlayer;
    this.revealState = createRevealState(this.tableLeadPlayer);
    this.state.phase = GamePhase.Reveal;

    this.add.text(28, 22, t('game.title', { round: this.currentRound }), {
      fontSize: '20px', fontFamily: 'Arial', color: COLORS.title, fontStyle: 'bold',
    }).setOrigin(0, 0.5).setDepth(10);
    this.add.text(28, 48, t('game.lead', { player: this.label(this.tableLeadPlayer) }), {
      fontSize: '13px', fontFamily: 'Arial', color: COLORS.muted,
    }).setOrigin(0, 0.5).setDepth(10);
    this.tableScoreText = this.add.text(1172, 24, getScoreString(this.state), {
      fontSize: '16px', fontFamily: 'Arial', color: COLORS.text, fontStyle: 'bold',
    }).setOrigin(1, 0.5).setDepth(10);
    this.tableProgressText = this.add.text(1172, 49, t('game.progress', { played: 0 }), {
      fontSize: '13px', fontFamily: 'Arial', color: COLORS.gold,
    }).setOrigin(1, 0.5).setDepth(10);

    this.add.rectangle(600, 320, 690, 4, hexToInt(COLORS.cyan), 0.12)
      .setBlendMode(Phaser.BlendModes.ADD).setDepth(1);
    this.add.rectangle(600, 320, 690, 2, hexToInt(COLORS.cyan), 0.75).setDepth(2);
    addPanel(this, 136, 319, 238, 352, 0x091a2b).setDepth(2);
    this.add.text(136, 164, t('game.duelRecord'), {
      fontSize: '17px', fontFamily: 'Arial', color: COLORS.title, fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(4);
    this.add.text(136, 191, t('game.recordHint'), {
      fontSize: '11px', fontFamily: 'Arial', color: COLORS.muted,
    }).setOrigin(0.5).setDepth(4);

    const leadPlacements = this.bottomPlayer === Player.P1 ? this.p1Placements : this.p2Placements;
    LANE_ORDER.forEach((lane, index) => {
      const x = TABLE_LANE_CENTERS[index];
      const back = createCardBack(this, lane, 110, 147);
      back.container.setPosition(x, 10).setDepth(4);
      this.tableBacks.set(lane, back.container);
      this.add.rectangle(x, 98, 86, 22, 0x091725, 0.82).setRounded(6)
        .setStrokeStyle(1, hexToInt(laneColor(lane)), 0.8).setDepth(5);
      this.add.text(x, 98, lane, {
        fontSize: '11px', fontFamily: 'Arial', color: laneColor(lane), fontStyle: 'bold',
      }).setOrigin(0.5).setDepth(6);

      const placement = leadPlacements.find(item => item.lane === lane);
      if (!placement) return;
      const hand = createCardFace(this, placement.card, lane, TABLE_HAND_W, TABLE_HAND_H);
      hand.container.setPosition(x, TABLE_HAND_Y[index])
        .setRotation(TABLE_HAND_ROTATION[index]).setDepth(20 + index);
      const hitZone = this.add.rectangle(x, TABLE_HAND_Y[index], TABLE_HAND_W + 8, TABLE_HAND_H + 8,
        0xffffff, 0).setDepth(40 + index).setInteractive({ useHandCursor: true });
      const view: TableHandCard = {
        ...hand,
        lane,
        baseY: TABLE_HAND_Y[index],
        baseRotation: TABLE_HAND_ROTATION[index],
        hitZone,
      };
      this.tableHands.set(lane, view);
      hitZone.on('pointerover', () => this.previewHandCard(lane, true));
      hitZone.on('pointerout', () => this.previewHandCard(lane, false));
      hitZone.on('pointerdown', () => this.selectHandCard(lane));
    });

    this.add.text(72, 126, t('game.opponentHand', { player: this.label(otherPlayer(this.bottomPlayer)) }), {
      fontSize: '12px', fontFamily: 'Arial', color: this.bottomPlayer === Player.P1 ? COLORS.p2 : COLORS.p1,
      fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(6);
    this.add.text(72, 552, t('game.playArea', { player: this.label(this.bottomPlayer) }), {
      fontSize: '12px', fontFamily: 'Arial', color: this.bottomPlayer === Player.P1 ? COLORS.p1 : COLORS.p2,
      fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(6);

    this.tableStatusText = this.add.text(1068, 448, t('game.actionHint'), {
      fontSize: '13px', fontFamily: 'Arial', color: COLORS.muted,
      align: 'center', wordWrap: { width: 210 },
    }).setOrigin(0.5).setDepth(60);
    this.setTableActionButton(t('game.confirmPlay'), () => {
      if (this.tableSelectedLane) this.playTableLane(this.tableSelectedLane);
    }, false);
  }

  private previewHandCard(lane: Lane, hovered: boolean) {
    const hand = this.tableHands.get(lane);
    if (!hand || this.tablePlayed.has(lane) || this.tableBusy || !this.canAct()) return;
    if (hovered) {
      this.tweens.add({
        targets: hand.container,
        y: hand.baseY - 44,
        rotation: 0,
        scale: lane === this.tableSelectedLane ? 1.06 : 1.04,
        duration: 180,
        ease: 'Sine.Out',
      });
      hand.border.setStrokeStyle(4, hexToInt(COLORS.gold), 1);
      return;
    }
    if (lane !== this.tableSelectedLane) this.restoreHandCard(hand);
  }

  private selectHandCard(lane: Lane) {
    if (this.tableBusy || this.tablePlayed.has(lane) || !this.canAct()) return;
    if (this.tableSelectedLane === lane) {
      this.playTableLane(lane);
      return;
    }

    if (this.tableSelectedLane) {
      const previous = this.tableHands.get(this.tableSelectedLane);
      if (previous) this.restoreHandCard(previous);
    }
    this.tableSelectedLane = lane;
    const hand = this.tableHands.get(lane);
    if (hand) {
      this.tweens.add({
        targets: hand.container,
        y: hand.baseY - 44,
        rotation: 0,
        scale: 1.06,
        duration: 220,
        ease: 'Back.Out',
      });
      hand.border.setStrokeStyle(4, hexToInt(COLORS.gold), 1);
    }
    this.tableStatusText.setText(t('game.laneSelected', { lane }));
    this.setTableActionButton(t('game.confirmPlay'), () => this.playTableLane(lane), true);
  }

  private restoreHandCard(hand: TableHandCard) {
    this.tweens.add({
      targets: hand.container,
      y: hand.baseY,
      rotation: hand.baseRotation,
      scale: 1,
      duration: 180,
      ease: 'Sine.Out',
    });
    hand.border.setStrokeStyle(2, hexToInt(laneColor(hand.lane)), 0.95);
  }

  private playTableLane(lane: Lane) {
    if (this.tableBusy || this.tablePlayed.has(lane)) return;
    if (this.online) {
      // Server decides; the duel animates when the reveal comes back in the next state.
      if (this.playPending || !this.canAct() || !revealLane(this.revealState, lane)) return;
      this.playPending = true;
      this.time.delayedCall(3000, () => { this.playPending = false; });
      this.online.send({ type: 'play', lane });
      this.destroyTableActionButton();
      this.tableStatusText.setText(t('game.dueling', { lane }));
      return;
    }
    const p1Placement = this.p1Placements.find(item => item.lane === lane);
    const p2Placement = this.p2Placements.find(item => item.lane === lane);
    if (!p1Placement || !p2Placement) {
      this.tableStatusText.setText(t('game.cardMissing', { lane }));
      return;
    }
    this.localDeadline = null;
    this.animateLane(lane, resolveLaneDuel(p1Placement.card, p2Placement.card, lane, this.tableOrder.length));
  }

  /** Fly my card and the opponent's card to the table, flip, and pop WIN. */
  private animateLane(lane: Lane, result: LaneRevealResult) {
    const nextReveal = revealLane(this.revealState, lane);
    const hand = this.tableHands.get(lane);
    const back = this.tableBacks.get(lane);
    if (!nextReveal || !hand || !back) {
      this.tableStatusText.setText(t('game.cardMissing', { lane }));
      return;
    }
    if (this.tableSelectedLane && this.tableSelectedLane !== lane) {
      const previous = this.tableHands.get(this.tableSelectedLane);
      if (previous) this.restoreHandCard(previous);
    }
    this.tableBusy = true;
    this.playPending = false;
    this.tableSelectedLane = lane;
    this.revealState = nextReveal;
    const orderIndex = this.tableOrder.length;
    this.tableOrder.push(lane);
    this.tableResults.push(result);
    this.tableAdvancePending = false;
    this.destroyTableActionButton();
    this.tableStatusText.setText(t('game.dueling', { lane }));

    // Bottom hand card lands on the lower table spot, the opponent's card on the upper one.
    const leadX = TABLE_LEAD_X;
    const opponentX = TABLE_OPPONENT_X;
    const leadY = TABLE_LEAD_Y;
    const opponentY = TABLE_OPPONENT_Y;
    const opponentCard = this.bottomPlayer === Player.P1 ? result.p2Card : result.p1Card;
    hand.hitZone.disableInteractive();

    this.tweens.add({
      targets: hand.container,
      x: leadX,
      y: leadY,
      rotation: 0,
      scale: TABLE_DUEL_W / TABLE_HAND_W,
      duration: 520,
      ease: 'Cubic.InOut',
    });
    this.tweens.add({
      targets: back,
      x: opponentX,
      y: opponentY,
      scale: TABLE_DUEL_W / 110,
      duration: 520,
      ease: 'Cubic.InOut',
    });

    this.time.delayedCall(540, () => {
      this.tweens.add({ targets: back, scaleX: 0, duration: 160, ease: 'Sine.In' });
      this.time.delayedCall(170, () => {
        back.destroy();
        this.tableBacks.delete(lane);
        const opponentFace = createCardFace(this, opponentCard, lane, TABLE_DUEL_W, TABLE_DUEL_H);
        opponentFace.container.setPosition(opponentX, opponentY).setDepth(45).setScale(0, 1);
        this.tableStageObjects.push(opponentFace.container);
        this.tweens.add({ targets: opponentFace.container, scaleX: 1, duration: 180, ease: 'Sine.Out' });

        const flash = this.add.rectangle(opponentX, opponentY, TABLE_DUEL_W + 14, TABLE_DUEL_H + 14,
          0xffffff, 0.72).setBlendMode(Phaser.BlendModes.ADD).setDepth(55);
        this.tableStageObjects.push(flash);
        this.tweens.add({ targets: flash, alpha: 0, duration: 300, ease: 'Sine.Out' });

        const orderLabel = this.add.text(600, 320,
          t('game.orderLabel', { lane, order: orderIndex + 1, bonus: ORDER_BONUS[orderIndex] }), {
            fontSize: '15px', fontFamily: 'Arial', color: COLORS.title, fontStyle: 'bold',
          }).setOrigin(0.5).setDepth(58);
        this.tableStageObjects.push(orderLabel);

        const p1Score = this.add.text(876, 268, '', {
          fontSize: '14px', fontFamily: 'Arial', color: result.laneWinner === Player.P1 ? COLORS.win : COLORS.text,
          fontStyle: 'bold', align: 'left',
        }).setOrigin(0, 0.5).setDepth(58);
        const p2Score = this.add.text(876, 302, '', {
          fontSize: '14px', fontFamily: 'Arial', color: result.laneWinner === Player.P2 ? COLORS.win : COLORS.text,
          fontStyle: 'bold', align: 'left',
        }).setOrigin(0, 0.5).setDepth(58);
        const p1Name = this.label(Player.P1);
        const p2Name = this.label(Player.P2);
        countUp(this, p1Score, result.p1WinRate * 100,
          value => `${p1Name} ${value.toFixed(1)}% + ${(result.orderBonus * 100).toFixed(0)}%`, 450);
        countUp(this, p2Score, result.p2WinRate * 100,
          value => `${p2Name} ${value.toFixed(1)}% + ${(result.orderBonus * 100).toFixed(0)}%`, 450);
        this.tableStageObjects.push(p1Score, p2Score);

        if (result.laneWinner) {
          const winnerX = result.laneWinner === this.bottomPlayer ? leadX : opponentX;
          const winnerY = result.laneWinner === this.bottomPlayer ? leadY : opponentY;
          const winLabel = this.add.text(winnerX + 82, winnerY - 4, 'WIN', {
            fontSize: '27px', fontFamily: 'Arial', color: COLORS.win, fontStyle: 'bold',
          }).setOrigin(0, 0.5).setDepth(60).setScale(0.2);
          glowText(winLabel, COLORS.win, 16);
          this.tableStageObjects.push(winLabel);
          this.tweens.add({ targets: winLabel, scale: 1, duration: 380, ease: 'Back.Out' });
        } else {
          const drawLabel = this.add.text(600, 356, 'DRAW', {
            fontSize: '22px', fontFamily: 'Arial', color: COLORS.gold, fontStyle: 'bold',
          }).setOrigin(0.5).setDepth(60);
          this.tableStageObjects.push(drawLabel);
        }

        this.addTableHistoryRow(result, orderIndex);
        this.tableProgressText.setText(t('game.progress', { played: this.tableOrder.length }));
        this.tableStatusText.setText(result.laneWinner
          ? t('game.laneWinner', { lane, player: this.label(result.laneWinner) })
          : t('game.laneDraw', { lane }));

        this.time.delayedCall(420, () => {
          if (this.online) {
            // Online: no buttons; the server waits LANE_REVEAL_PAUSE_MS before the next turn.
            this.tableNextTimer = this.time.delayedCall(2600, () => this.advanceTableLane(lane));
            return;
          }
          if (this.tableOrder.length === LANE_ORDER.length) {
            this.tableBusy = true;
            this.setTableActionButton(t('game.finishRound'), () => this.finishTableRound(), true);
            this.tableNextTimer = this.time.delayedCall(2500, () => this.finishTableRound());
          } else {
            this.setTableActionButton(t('game.nextLane'), () => this.advanceTableLane(lane), true);
            this.tableNextTimer = this.time.delayedCall(3800, () => this.advanceTableLane(lane));
          }
        });
      });
    });
  }

  private addTableHistoryRow(result: LaneRevealResult, orderIndex: number) {
    const winner = result.laneWinner ?? t('game.draw');
    const color = result.laneWinner === Player.P1 ? COLORS.p1
      : result.laneWinner === Player.P2 ? COLORS.p2 : COLORS.gold;
    const row = this.add.text(39, 222 + orderIndex * 48,
      t('game.historyRow', {
        order: orderIndex + 1,
        lane: result.lane,
        winner,
        p1: (result.p1Total * 100).toFixed(1),
        p2: (result.p2Total * 100).toFixed(1),
      }), {
        fontSize: '12px', fontFamily: 'Arial', color, lineSpacing: 4,
      }).setDepth(5);
  }

  private advanceTableLane(lane: Lane) {
    if (this.tableAdvancePending) return;
    this.tableNextTimer?.remove();
    this.tableNextTimer = null;
    this.tableAdvancePending = true;
    this.destroyTableActionButton();
    const hand = this.tableHands.get(lane);
    if (hand) {
      hand.container.setVisible(false);
      hand.hitZone.disableInteractive();
    }
    this.tablePlayed.add(lane);
    this.tableStageObjects.forEach(object => object.destroy());
    this.tableStageObjects = [];
    this.tableSelectedLane = null;
    this.tableBusy = false;
    this.tableAdvancePending = false;
    this.tableStatusText.setText(t('game.nextLanePrompt', { played: this.tableOrder.length }));
    if (this.online) {
      this.updateOnlineStatus();
      this.processOnlineReveals();
    } else {
      this.startLocalTurn();
    }
  }

  private finishTableRound() {
    if (this.tableAdvancePending) return;
    this.tableNextTimer?.remove();
    this.tableNextTimer = null;
    this.tableAdvancePending = true;
    this.destroyTableActionButton();
    const result = resolveRound(this.p1Placements, this.p2Placements, this.state, getRevealOrder(this.revealState));
    this.tableStatusText.setText(t('game.roundComplete'));
    this.time.delayedCall(650, () => {
      this.scene.start('SummaryScene', {
        state: this.state,
        result,
        roundNumber: this.currentRound,
      });
    });
  }

  private setTableActionButton(label: string, callback: () => void, visible: boolean) {
    this.destroyTableActionButton();
    const button = addButton(this, 1068, 378, 214, 48, 0x17334a).setDepth(70);
    const text = this.add.text(1068, 378, label, {
      fontSize: '16px', fontFamily: 'Arial', color: COLORS.title, fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(71);
    button.on('pointerover', () => button.setFillStyle(0x24536a, 0.96));
    button.on('pointerout', () => button.setFillStyle(0x17334a, COLORS.panelAlpha));
    button.on('pointerdown', callback);
    button.setVisible(visible);
    text.setVisible(visible);
    this.tableActionButton = button;
    this.tableActionText = text;
  }

  private destroyTableActionButton() {
    this.tableActionButton?.destroy();
    this.tableActionText?.destroy();
    this.tableActionButton = null;
    this.tableActionText = null;
  }
}
