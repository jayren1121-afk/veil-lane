import Phaser from 'phaser';
import {
  createMatchState,
  createDraftState,
  pickCard,
  autoPick,
  autoPickRemaining,
  isDraftComplete,
  getCurrentDraftPlayer,
  getCurrentDraftLane,
  draftToPlacements,
  applyDraftFearless,
  draftSecondsLeft,
  usedCardIdsFor,
  Player,
  Lane,
  LANE_ORDER,
  Card,
  DraftState,
  MatchState,
  getFirstPlayer,
} from '../rules';
import { CARDS } from '../data/cards';
import { cardArtPath } from '../data/art';
import { getIntel, getCardNameById } from '../data/intel';
import { t } from '../i18n';
import { playCoinFlip } from './coinFlip';
import { setupSceneMusic } from './musicToggle';
import type { MatchView } from '../online/protocol';
import type { OnlineClient } from '../../net/onlineClient';
import { turnSecondsLeft, otherPlayer } from '../rules';
import {
  bindOnlineScene,
  mirrorDraftState,
  mirrorMatchState,
  opponentName,
  sceneForPhase,
  sideLabel,
} from './onlineScene';
import {
  addArtBrighten,
  addCardGlow,
  addPanel,
  COLORS,
  drawBackground,
  hexToInt,
  laneColor,
} from './theme';

// ===== 固定座標常數 =====
const WIDTH = 1200;

// 【上方標題列】y = 0~70
const TITLE_Y = 25;
const TIMER_Y = 35;
const SCORE_Y = 25;
const DIVIDER_Y = 70;

// 【左欄：路線按鈕】x = 30~170
const LANE_BUTTON_W = 140;
const LANE_BUTTON_H = 44;
const LANE_BUTTON_START_Y = 110;
const LANE_BUTTON_SPACING = 56;

// 【中欄：卡片區】x = 200~880, y = 90~740
const CARD_AREA_X = 200;
const CARD_AREA_W = 680;

// 搜尋框
const SEARCH_BAR_X = 200;
const SEARCH_BAR_Y = 90;
const SEARCH_BAR_W = 680;
const SEARCH_BAR_H = 36;

// 卡片排列
const CARD_W = 150;
const CARD_H = 200;
const CARD_COLS = 4;
const CARD_SPACING_X = 20;
const CARD_SPACING_Y = 20;
const CARDS_VIEW_Y = 140;
const CARDS_VIEW_H = 600;

// 底部提示文字
const STATUS_TEXT_Y = 765;

// 【右欄：GRID 情報面板】x = 910~1170, y = 90~740
const INTEL_PANEL_X = 1040;
const INTEL_PANEL_W = 260; // 1170 - 910
const INTEL_PANEL_Y = 415;
const INTEL_PANEL_H = 650; // 740 - 90

export class DraftScene extends Phaser.Scene {
  constructor() {
    super({ key: 'DraftScene' });
  }

  private matchState!: MatchState;
  private draftState!: DraftState;
  private currentRound = 1;

  // UI elements
  private statusText!: Phaser.GameObjects.Text;
  private clockName = {} as Record<Player, Phaser.GameObjects.Text>;
  private clockValue = {} as Record<Player, Phaser.GameObjects.Text>;
  private clockPanel = {} as Record<Player, Phaser.GameObjects.Rectangle>;
  private clockLastMs = 0;
  private pickCountText!: Phaser.GameObjects.Text;
  private scoreText!: Phaser.GameObjects.Text;
  private candidateButtons: Phaser.GameObjects.Container[] = [];
  private laneButtons: Phaser.GameObjects.Container[] = [];
  private candidateGroup!: Phaser.GameObjects.Container;
  private cardsCamera!: Phaser.Cameras.Scene2D.Camera;
  private searchText!: Phaser.GameObjects.Text;
  private searchBox!: Phaser.GameObjects.Rectangle;
  
  // Intel panel
  private intelPanel!: Phaser.GameObjects.Container;
  private intelBg!: Phaser.GameObjects.Rectangle;
  private intelTitle!: Phaser.GameObjects.Text;
  private intelBody!: Phaser.GameObjects.Container;
  private hoveredCardId: string | null = null;

  // Timer
  private timerEvent!: Phaser.Time.TimerEvent | null;
  
  // Search
  private searchQuery = '';

  // Online mode (null = local hot-seat)
  private online: OnlineClient | null = null;
  private view: MatchView | null = null;
  private pickPending = false;
  private leaving = false;

  /** P1/P2 locally; "YOU" / opponent nickname online. */
  private playerLabel(player: Player): string {
    return this.view ? sideLabel(this.view, player) : player;
  }

  // Preserve match state across rounds
  private initMatchState() {
    // Check if we have a previous match state from GameScene
    // For now, create new; will be passed via scene data
    this.matchState = createMatchState();
    this.currentRound = 1;
  }

  preload() {
    // Load all card art images
    for (const card of CARDS) {
      this.load.image(card.id, cardArtPath(card.id));
    }
  }

  create(data?: any) {
    this.online = null;
    this.view = null;
    this.pickPending = false;
    this.leaving = false;
    if (data?.online) {
      this.createOnline(Boolean(data.showCoin));
      return;
    }
    const isNewMatch = !data?.matchState;
    // Restore match state if coming from a previous round
    if (data?.matchState) {
      this.matchState = data.matchState;
      this.currentRound = data.round || 1;
    } else {
      this.initMatchState();
    }

    this.draftState = createDraftState(this.currentRound);
    this.searchQuery = '';
    this.scrollY = 0;
    this.hoveredCardId = null;
    this.candidateButtons = [];
    this.laneButtons = [];

    this.createUI();
    this.renderDraft();
    if (isNewMatch) this.showCoinFlipResult();
    else this.startTimer();
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.cleanupScene, this);
  }

  private createOnline(showCoin: boolean) {
    this.searchQuery = '';
    this.scrollY = 0;
    this.hoveredCardId = null;
    this.candidateButtons = [];
    this.laneButtons = [];
    // Must exist before createUI() so headers can use names.
    const client = bindOnlineScene(this, view => this.onOnlineState(view));
    if (!client || !client.state) {
      this.scene.start('LobbyScene');
      return;
    }
    this.online = client;
    this.applyView(client.state);
    this.createUI();
    this.add.text(1170, 52, `${t('online.versus', {
      me: this.view!.players[this.view!.you]?.name ?? '', you: t('online.you'), opponent: opponentName(this.view!),
    })}　·　${this.view!.roomCode}`, {
      fontSize: '11px', fontFamily: 'Arial', color: COLORS.muted,
    }).setOrigin(1, 0.5).setDepth(2);
    this.renderDraft();
    const startTicker = () => this.startOnlineTicker();
    if (showCoin && this.view!.draft && this.view!.draft.currentIndex === 0) {
      this.cardsCamera.setVisible(false);
      playCoinFlip(this, this.view!.round1FirstPlayer, () => {
        this.cardsCamera.setVisible(true);
        startTicker();
      });
    } else {
      startTicker();
    }
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.cleanupScene, this);
  }

  private applyView(view: MatchView) {
    this.view = view;
    this.matchState = mirrorMatchState(view);
    this.currentRound = view.round;
    this.draftState = mirrorDraftState(view, this.online?.serverNow() ?? view.serverNow);
  }

  private onOnlineState(view: MatchView) {
    if (this.leaving) return;
    if (view.phase !== 'draft' || view.round !== this.currentRound) {
      if (view.phase === 'battle') {
        this.leaving = true;
        this.applyView(view);
        this.statusText.setText(t('draft.complete')).setColor('#66ff66');
        this.candidateGroup.removeAll(true);
        this.time.delayedCall(1200, () => this.scene.start('GameScene', { online: true }));
      } else {
        this.leaving = true;
        this.scene.start(sceneForPhase(view.phase), { online: true });
      }
      return;
    }
    const previousIndex = this.draftState.currentIndex;
    this.applyView(view);
    this.pickPending = false;
    if (previousIndex !== this.draftState.currentIndex) {
      this.searchQuery = '';
      this.updateSearchText();
    }
    this.renderDraft();
  }

  private startOnlineTicker() {
    if (this.timerEvent) this.timerEvent.remove();
    const update = () => {
      const draft = this.view?.draft;
      if (!draft || !this.online) return;
      const banks = { ...draft.timeRemainingMs };
      if (draft.currentPlayer) {
        banks[draft.currentPlayer] = Math.max(0, draft.deadline - this.online.serverNow());
      }
      this.draftState.timeRemainingMs = banks;
      this.updateClocks();
    };
    update();
    this.timerEvent = this.time.addEvent({ delay: 250, loop: true, callback: update });
  }

  private isMyOnlineTurn(): boolean {
    return Boolean(this.view?.draft && this.view.draft.currentPlayer === this.view.you);
  }

  private showCoinFlipResult() {
    this.cardsCamera.setVisible(false);
    playCoinFlip(this, this.matchState.round1FirstPlayer, () => {
      this.cardsCamera.setVisible(true);
      this.startTimer();
    });
  }

  private createClocks() {
    const positions: Record<Player, number> = { [Player.P1]: 530, [Player.P2]: 700 };
    for (const player of [Player.P1, Player.P2]) {
      const x = positions[player];
      const panel = this.add.rectangle(x, 35, 150, 54, 0x10263a, 0.92)
        .setRounded(8).setStrokeStyle(1, hexToInt(COLORS.cyan), 0.6).setDepth(2);
      const name = this.add.text(x, 17, this.playerLabel(player), {
        fontSize: '12px', fontFamily: 'Arial', color: COLORS.muted, fontStyle: 'bold',
      }).setOrigin(0.5).setDepth(3);
      const value = this.add.text(x, 40, '100s', {
        fontSize: '22px', fontFamily: 'Arial', color: COLORS.gold, fontStyle: 'bold',
      }).setOrigin(0.5).setDepth(3);
      this.clockPanel[player] = panel;
      this.clockName[player] = name;
      this.clockValue[player] = value;
    }
    this.updateClocks();
  }

  private updateClocks() {
    if (!this.clockValue[Player.P1]) return;
    const current = getCurrentDraftPlayer(this.draftState);
    for (const player of [Player.P1, Player.P2]) {
      const seconds = this.draftState ? draftSecondsLeft(this.draftState, player) : 0;
      const active = player === current;
      const low = active && seconds <= 10;
      this.clockName[player].setText(this.playerLabel(player));
      this.clockValue[player].setText(`${seconds}s`);
      this.clockValue[player].setColor(low ? '#ff4444' : active ? COLORS.gold : COLORS.muted);
      this.clockName[player].setColor(active
        ? (player === Player.P1 ? COLORS.p1 : COLORS.p2)
        : COLORS.muted);
      this.clockPanel[player]
        .setStrokeStyle(active ? 2 : 1, low ? 0xff4444 : (active ? 0xf4c95d : hexToInt(COLORS.cyan)), active ? 1 : 0.5)
        .setFillStyle(active ? 0x17334a : 0x10263a, 0.92);
    }
  }

  private createUI() {
    drawBackground(this);
    this.add.rectangle(WIDTH / 2, 35, WIDTH, 70, 0x0b2034, 0.78).setDepth(0);
    this.add.rectangle(WIDTH / 2, DIVIDER_Y, WIDTH, 2, hexToInt(COLORS.cyan), 0.65).setDepth(1);
    this.add.text(30, 20, t('draft.title', { round: this.currentRound }), {
      fontSize: '19px', fontFamily: 'Arial', color: COLORS.title, fontStyle: 'bold',
    }).setOrigin(0, 0.5).setDepth(2);
    this.add.text(30, 49, t('draft.firstPlayer', { player: this.playerLabel(getFirstPlayer(this.matchState, this.currentRound)) }), {
      fontSize: '13px', fontFamily: 'Arial', color: COLORS.muted,
    }).setOrigin(0, 0.5).setDepth(2);

    this.createClocks();
    this.scoreText = this.add.text(1170, SCORE_Y,
      t('draft.score', { p1: this.matchState.p1RoundWins, p2: this.matchState.p2RoundWins }), {
        fontSize: '16px', fontFamily: 'Arial', color: COLORS.muted,
      }).setOrigin(1, 0.5).setDepth(2);

    this.laneButtons = [];
    for (let i = 0; i < LANE_ORDER.length; i++) {
      const lane = LANE_ORDER[i];
      const y = LANE_BUTTON_START_Y + i * LANE_BUTTON_SPACING;
      const btn = this.add.container(100, y);
      const tint = hexToInt(laneColor(lane));
      const bg = this.add.rectangle(0, 0, LANE_BUTTON_W, LANE_BUTTON_H, 0x10263a, COLORS.panelAlpha)
        .setRounded(8).setStrokeStyle(1, tint, 0.8);
      const label = this.add.text(0, 0, lane, {
        fontSize: '16px', fontFamily: 'Arial', color: laneColor(lane), fontStyle: 'bold',
      }).setOrigin(0.5);
      bg.setInteractive({ useHandCursor: true });
      bg.on('pointerdown', () => this.onLaneSelect(i));
      bg.on('pointerover', () => bg.setStrokeStyle(3, tint, 1));
      bg.on('pointerout', () => this.updateLaneButtonStyles());
      btn.add([bg, label]);
      this.laneButtons.push(btn);
    }

    const sidePanel = addPanel(this, 100, 480, 140, 150);
    this.pickCountText = this.add.text(100, 455, '', {
      fontSize: '14px', fontFamily: 'Arial', color: COLORS.text, align: 'center',
      wordWrap: { width: 120 },
    }).setOrigin(0.5);
    this.statusText = this.add.text(100, 505, '', {
      fontSize: '14px', fontFamily: 'Arial', color: COLORS.muted, align: 'center',
      wordWrap: { width: 120 },
    }).setOrigin(0.5);
    sidePanel.setDepth(0);
    this.pickCountText.setDepth(1);
    this.statusText.setDepth(1);

    addPanel(this, 540, 440, CARD_AREA_W, CARDS_VIEW_H, 0x0d2032).setDepth(0);
    this.createSearchBar();

    this.add.text(540, STATUS_TEXT_Y, t('draft.footerHint'), {
      fontSize: '13px', fontFamily: 'Arial', color: COLORS.muted,
    }).setOrigin(0.5).setDepth(2);
    this.createIntelPanel();
    setupSceneMusic(this);

    // 卡片放在專屬 camera 裡，由 viewport 裁切在中欄 y=140~740
    this.candidateGroup = this.add.container(0, 0).setDepth(10);
    this.cameras.main.ignore(this.candidateGroup);
    this.cardsCamera = this.cameras.add(CARD_AREA_X, CARDS_VIEW_Y, CARD_AREA_W, CARDS_VIEW_H)
      .setName('draftCards');
    this.cardsCamera.ignore(this.children.list.filter(child => child !== this.candidateGroup));
  }

  private createIntelPanel() {
    this.intelPanel = this.add.container(INTEL_PANEL_X, INTEL_PANEL_Y);

    // 背景
    this.intelBg = this.add.rectangle(0, 0, INTEL_PANEL_W, INTEL_PANEL_H, 0x10263a, COLORS.panelAlpha)
      .setRounded(8);
    this.intelBg.setStrokeStyle(1, hexToInt(COLORS.cyan), 0.8);
    this.intelPanel.add(this.intelBg);

    // 標題「GRID 情報」
    this.intelTitle = this.add.text(0, -INTEL_PANEL_H / 2 + 20, t('draft.intelTitle'), {
      fontSize: '18px',
      fontFamily: 'Arial',
      color: COLORS.gold,
      fontStyle: 'bold',
    }).setOrigin(0.5);
    this.intelPanel.add(this.intelTitle);

    // 分隔線
    const divider = this.add.rectangle(0, -INTEL_PANEL_H / 2 + 40, INTEL_PANEL_W - 40, 1,
      hexToInt(COLORS.cyan), 0.55);
    this.intelPanel.add(divider);

    // 內容容器
    this.intelBody = this.add.container(-INTEL_PANEL_W / 2, -INTEL_PANEL_H / 2 + 55);
    this.intelPanel.add(this.intelBody);

    // 預設提示文字
    this.showIntelPlaceholder();
  }

  private showIntelPlaceholder() {
    this.intelBody.removeAll(true);
    const placeholder = this.add.text(INTEL_PANEL_W / 2, INTEL_PANEL_H / 2 - 30,
      t('draft.intelPlaceholder'), {
      fontSize: '14px',
      fontFamily: 'Arial',
      color: COLORS.muted,
      align: 'center',
      lineSpacing: 8,
    }).setOrigin(0.5);
    this.intelBody.add(placeholder);
  }

  private showIntelForCard(cardId: string) {
    this.hoveredCardId = cardId;
    this.intelBody.removeAll(true);
    const intel = getIntel(cardId);
    const card = CARDS.find(c => c.id === cardId);
    if (!card) return;

    let y = 0;

    // 卡圖縮圖 120x160 置中
    if (this.textures.exists(cardId)) {
      const thumb = this.add.image(INTEL_PANEL_W / 2, y, cardId);
      thumb.displayWidth = 120;
      thumb.displayHeight = 160;
      thumb.setOrigin(0.5, 0);
      this.intelBody.add(thumb);
      const brighten = addArtBrighten(this, INTEL_PANEL_W / 2, y + 80, 120, 160);
      this.intelBody.add(brighten);
      y += 170;
    }

    // 卡名
    const nameText = this.add.text(INTEL_PANEL_W / 2, y, card.name, {
      fontSize: '14px',
      fontFamily: 'Arial',
      color: COLORS.text,
      fontStyle: 'bold',
      wordWrap: { width: INTEL_PANEL_W - 20, useAdvancedWrap: true },
    }).setOrigin(0.5);
    this.intelBody.add(nameText);
    y += 30;

    if (intel) {
      // 出場次數
      const gamesText = this.add.text(10, y, t('draft.games', { games: intel.games }),
        { fontSize: '12px', fontFamily: 'Arial', color: COLORS.text });
      this.intelBody.add(gamesText);
      y += 22;

      // 禁用率
      const banText = this.add.text(10, y, t('draft.banRate', { rate: (intel.banRate * 100).toFixed(1) }),
        { fontSize: '12px', fontFamily: 'Arial', color: COLORS.gold });
      this.intelBody.add(banText);
      y += 25;

      // 分隔線
      const div1 = this.add.rectangle(INTEL_PANEL_W / 2, y, INTEL_PANEL_W - 40, 1, hexToInt(COLORS.cyan), 0.55);
      this.intelBody.add(div1);
      y += 15;

      // 常見搭檔
      const partnerTitle = this.add.text(10, y, t('draft.partners'),
        { fontSize: '12px', fontFamily: 'Arial', color: COLORS.cyan, fontStyle: 'bold' });
      this.intelBody.add(partnerTitle);
      y += 20;

      for (const partnerId of intel.topPartners.slice(0, 3)) {
        const partnerName = getCardNameById(partnerId);
        const pText = this.add.text(15, y, `• ${partnerName}`,
          { fontSize: '12px', fontFamily: 'Arial', color: COLORS.text });
        this.intelBody.add(pText);
        y += 20;
      }

      y += 5;

      // 分隔線
      const div2 = this.add.rectangle(INTEL_PANEL_W / 2, y, INTEL_PANEL_W - 40, 1, hexToInt(COLORS.cyan), 0.55);
      this.intelBody.add(div2);
      y += 15;

      // 常見對手
      const oppTitle = this.add.text(10, y, t('draft.opponents'),
        { fontSize: '12px', fontFamily: 'Arial', color: COLORS.lose, fontStyle: 'bold' });
      this.intelBody.add(oppTitle);
      y += 20;

      for (const oppId of intel.topOpponents.slice(0, 3)) {
        const oppName = getCardNameById(oppId);
        const oText = this.add.text(15, y, `• ${oppName}`,
          { fontSize: '12px', fontFamily: 'Arial', color: COLORS.text });
        this.intelBody.add(oText);
        y += 20;
      }

    } else {
      // 無情報數據
      const noData = this.add.text(INTEL_PANEL_W / 2, y + 20, t('draft.noIntel'),
        { fontSize: '12px', fontFamily: 'Arial', color: COLORS.muted, align: 'center' }).setOrigin(0.5);
      this.intelBody.add(noData);
    }

    // 資料來源（固定在面板底部）
    const sourceText = this.add.text(INTEL_PANEL_W / 2, INTEL_PANEL_H - 75, t('draft.dataSource'),
      { fontSize: '10px', fontFamily: 'Arial', color: COLORS.muted, fontStyle: 'italic' });
    sourceText.setOrigin(0.5);
    this.intelBody.add(sourceText);
  }

  private createSearchBar() {
    this.searchBox = this.add.rectangle(SEARCH_BAR_X + SEARCH_BAR_W / 2,
      SEARCH_BAR_Y + SEARCH_BAR_H / 2, SEARCH_BAR_W, SEARCH_BAR_H, 0x10263a, COLORS.panelAlpha)
      .setRounded(8).setStrokeStyle(1, hexToInt(COLORS.cyan), 0.8).setDepth(2);
    this.searchText = this.add.text(SEARCH_BAR_X + 12, SEARCH_BAR_Y + SEARCH_BAR_H / 2,
      t('draft.searchPlaceholder'), {
        fontSize: '14px', fontFamily: 'Arial', color: COLORS.muted,
      }).setOrigin(0, 0.5).setDepth(3);
    this.searchBox.setInteractive({ useHandCursor: true });
    this.searchBox.on('pointerdown', () => this.searchBox.setStrokeStyle(2, hexToInt(COLORS.gold)));
    this.input.keyboard?.on('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        this.clearSearch();
      } else if (event.key === 'Backspace') {
        this.searchQuery = this.searchQuery.slice(0, -1);
      } else if (event.key.length === 1 && /^[a-zA-Z0-9 ]$/.test(event.key)) {
        this.searchQuery += event.key.toLowerCase();
      } else {
        return;
      }
      this.scrollY = 0;
      this.updateSearchText();
      this.renderCandidates();
    });
  }

  private updateSearchText() {
    if (this.searchQuery) {
      this.searchText.setText(`⌕ ${this.searchQuery}`);
      this.searchText.setColor(COLORS.text);
    } else {
      this.searchText.setText(t('draft.searchPlaceholder'));
      this.searchText.setColor(COLORS.muted);
    }
  }

  private clearSearch() {
    this.searchQuery = '';
    this.updateSearchText();
    this.renderCandidates();
  }

  private currentLaneIndex = -1;
  private scrollY = 0;
  private scrollThumb?: Phaser.GameObjects.Rectangle;
  private scrollWheelHandler!: (pointer: Phaser.Input.Pointer, gameObjects: Phaser.GameObjects.GameObject[], deltaX: number, deltaY: number) => void;

  private onLaneSelect(laneIndex: number) {
    this.currentLaneIndex = laneIndex;
    this.scrollY = 0; // Reset scroll when switching lanes
    this.updateLaneButtonStyles();
    this.renderCandidates();
  }

  private updateLaneButtonStyles() {
    for (let i = 0; i < this.laneButtons.length; i++) {
      const btn = this.laneButtons[i];
      const bg = btn.list[0] as Phaser.GameObjects.Rectangle;
      const label = btn.list[1] as Phaser.GameObjects.Text;

      if (i === this.currentLaneIndex) {
        bg.setFillStyle(hexToInt(laneColor(LANE_ORDER[i])), 0.42);
        bg.setStrokeStyle(3, hexToInt(laneColor(LANE_ORDER[i])));
        label.setText(`▶ ${LANE_ORDER[i]}${label.text.includes('✓') ? ' ✓' : ''}`);
        label.setColor(laneColor(LANE_ORDER[i]));
      } else {
        bg.setFillStyle(0x10263a, COLORS.panelAlpha);
        bg.setStrokeStyle(1, hexToInt(laneColor(LANE_ORDER[i])), 0.8);
        label.setText(`${LANE_ORDER[i]}${label.text.includes('✓') ? ' ✓' : ''}`);
        label.setColor(laneColor(LANE_ORDER[i]));
      }

      // Mark completed lanes with a checkmark
      const lane = LANE_ORDER[i];
      const laneSlots = this.draftState.slots.filter(s => s.lane === lane);
      const allPicked = laneSlots.every(s => s.cardId !== null);
      if (allPicked) {
        label.setText(lane + ' ✓');
      }
    }
  }

  private renderDraft() {
    // Clear old candidate buttons
    this.candidateButtons.forEach((c) => c.destroy());
    this.candidateButtons = [];
    this.candidateGroup.removeAll(true);

    if (isDraftComplete(this.draftState)) {
      if (!this.online) this.onDraftComplete();
      return;
    }

    const currentPlayer = getCurrentDraftPlayer(this.draftState)!;
    const currentLane = getCurrentDraftLane(this.draftState)!;
    const currentLaneIdx = LANE_ORDER.indexOf(currentLane);

    // Auto-select current lane
    if (this.currentLaneIndex !== currentLaneIdx) this.scrollY = 0;
    this.currentLaneIndex = currentLaneIdx;
    this.updateLaneButtonStyles();

    // Status message
    const playerColor = currentPlayer === Player.P1 ? COLORS.p1 : COLORS.p2;
    this.statusText.setText(this.online && !this.isMyOnlineTurn()
      ? t('online.waitingOpponentPick', { name: this.playerLabel(currentPlayer), lane: currentLane })
      : t('draft.pickStatus', { player: this.playerLabel(currentPlayer), lane: currentLane }));
    this.statusText.setColor(playerColor);

    this.updateClocks();

    // Pick count
    const picksMade = this.draftState.currentIndex;
    this.pickCountText.setText(t('draft.pickCount', { picked: picksMade, total: this.draftState.slots.length }));

    // Show picked cards for completed lanes
    this.showPickedCards();

    // Render candidates for the current lane
    this.renderCandidates();
  }

  private renderCandidates() {
    this.candidateGroup.removeAll(true);
    this.candidateButtons = [];
    this.showIntelPlaceholder();

    if (isDraftComplete(this.draftState)) return;

    const currentLane = getCurrentDraftLane(this.draftState)!;
    let candidates = CARDS.filter(card => card.lanes.includes(currentLane));

    if (this.online && this.view) {
      if (!this.isMyOnlineTurn()) {
        this.candidateGroup.add(this.add.text(CARD_AREA_W / 2, 260,
          t('online.waitingOpponentPick', {
            name: this.playerLabel(this.view.draft?.currentPlayer ?? otherPlayer(this.view.you)),
            lane: currentLane,
          }), { fontSize: '22px', fontFamily: 'Arial', color: COLORS.muted, align: 'center' }).setOrigin(0.5));
        return;
      }
      // Only the server's valid candidates, plus earlier-round (Fearless) cards shown disabled.
      const allowed = new Set(this.view.draft?.candidates ?? []);
      const mine = usedCardIdsFor(this.matchState, this.view.you);
      candidates = candidates.filter(card => allowed.has(card.id) || mine.has(card.id));
    }

    // 搜尋過濾
    if (this.searchQuery) {
      candidates = candidates.filter(card =>
        card.name.toLowerCase().includes(this.searchQuery) ||
        card.role.toLowerCase().includes(this.searchQuery) ||
        card.id.toLowerCase().includes(this.searchQuery)
      );
      // 名稱以搜尋字串開頭的卡排在最前面
      const startsWithQuery = (card: Card) => card.name.toLowerCase().startsWith(this.searchQuery) ? 0 : 1;
      candidates = [...candidates].sort((a, b) => startsWithQuery(a) - startsWithQuery(b));
    }

    // 如果選擇的路線不是當前需要選的路線
    if (this.currentLaneIndex !== LANE_ORDER.indexOf(currentLane)) {
      this.candidateGroup.add(
        this.add.text(CARD_AREA_W / 2, 300, t('draft.selectLaneFirst', { lane: currentLane }), {
          fontSize: '18px',
          fontFamily: 'Arial',
          color: COLORS.muted,
        }).setOrigin(0.5)
      );
      return;
    }

    if (candidates.length === 0) {
      const noResultText = this.searchQuery
        ? t('draft.noSearchResults', { query: this.searchQuery })
        : t('draft.noAvailableCards');
      this.candidateGroup.add(
        this.add.text(CARD_AREA_W / 2, 300, noResultText, {
          fontSize: '18px',
          fontFamily: 'Arial',
          color: COLORS.lose,
        }).setOrigin(0.5)
      );
      return;
    }

    // Only this player's own picks and Fearless cards are marked unavailable.
    // The opponent's picks are hidden and do not remove cards from the list.
    const actor = (this.online && this.view)
      ? this.view.you
      : getCurrentDraftPlayer(this.draftState)!;
    const alreadyPickedInRound = new Set(
      this.draftState.slots
        .filter(s => s.cardId && s.player === actor)
        .map(s => s.cardId as string)
    );
    const myFearless = usedCardIdsFor(this.matchState, actor);

    // 計算滾動範圍
    const totalRows = Math.ceil(candidates.length / CARD_COLS);
    const totalHeight = totalRows * (CARD_H + CARD_SPACING_Y);
    const maxScrollY = Math.max(0, totalHeight - CARDS_VIEW_H);

    // 限制 scrollY 範圍
    if (this.scrollY < 0) this.scrollY = 0;
    if (this.scrollY > maxScrollY) this.scrollY = maxScrollY;
    this.cardsCamera.setScroll(0, this.scrollY);

    candidates.forEach((card, idx) => {
      const col = idx % CARD_COLS;
      const row = Math.floor(idx / CARD_COLS);
      const x = (CARD_W / 2 + 10) + col * (CARD_W + CARD_SPACING_X);
      const y = CARD_H / 2 + row * (CARD_H + CARD_SPACING_Y);

      const isFearless = myFearless.has(card.id);
      const isAlreadyPicked = alreadyPickedInRound.has(card.id);
      const isDisabled = isFearless || isAlreadyPicked;

      const btn = this.add.container(x, y);

      const currentLaneColor = laneColor(currentLane);
      const borderColor = isDisabled ? 0x555b66 : hexToInt(currentLaneColor);
      if (!isDisabled) btn.add(addCardGlow(this, 0, 0, CARD_W, CARD_H, currentLaneColor));
      const bg = this.add.rectangle(0, 0, CARD_W, CARD_H, isDisabled ? 0x202530 : 0x10263a, 0.92)
        .setRounded(7);
      bg.setStrokeStyle(isDisabled ? 1 : 2, borderColor);
      btn.add(bg);

      if (this.textures.exists(card.id)) {
        const art = this.add.image(0, 0, card.id).setDisplaySize(CARD_W, CARD_H);
        if (isDisabled) art.setAlpha(0.35);
        btn.add(art);
        if (!isDisabled) {
          const brighten = addArtBrighten(this, 0, 0, CARD_W, CARD_H);
          btn.add(brighten);
          bg.on('pointerover', () => brighten.setAlpha(0.2));
          bg.on('pointerout', () => brighten.setAlpha(0.08));
        }
      } else {
        btn.add(this.add.text(0, 0, card.role, {
          fontSize: '18px', fontFamily: 'Arial', color: COLORS.muted, fontStyle: 'bold',
          align: 'center', wordWrap: { width: CARD_W - 12 },
        }).setOrigin(0.5));
      }

      btn.add(this.add.rectangle(0, 70, CARD_W - 2, 58, isDisabled ? 0x202530 : 0x0b2034, 0.88));
      btn.add(this.add.text(0, 62, card.name, {
        fontSize: '12px', fontFamily: 'Arial', color: isDisabled ? '#7a8492' : COLORS.text,
        fontStyle: 'bold', align: 'center', wordWrap: { width: CARD_W - 12, useAdvancedWrap: true },
      }).setOrigin(0.5));
      btn.add(this.add.text(0, 88, `${card.role} · ${card.lanes.join('/')}`, {
        fontSize: '9px', fontFamily: 'Arial', color: isDisabled ? '#687181' : COLORS.muted,
        align: 'center', wordWrap: { width: CARD_W - 12 },
      }).setOrigin(0.5));

      // 已選標記
      if (isDisabled) {
        btn.add(this.add.text(0, -30, isAlreadyPicked ? t('draft.picked') : t('draft.fearlessUsed'), {
          fontSize: '13px', fontFamily: 'Arial', color: '#ffffff', fontStyle: 'bold',
          backgroundColor: '#555b66', padding: { x: 5, y: 3 },
        }).setOrigin(0.5));
      }

      bg.setInteractive({ useHandCursor: !isDisabled });
      bg.on('pointerdown', () => {
        if (!isDisabled) this.onCardPick(card);
      });
      bg.on('pointerover', () => {
        if (!isDisabled) {
          btn.setScale(1.05);
          this.candidateGroup.bringToTop(btn);
          bg.setStrokeStyle(3, hexToInt(COLORS.gold));
          bg.setFillStyle(0x24445a, 0.96);
        }
        this.showIntelForCard(card.id);
      });
      bg.on('pointerout', () => {
        bg.setStrokeStyle(isDisabled ? 1 : 2, borderColor);
        bg.setFillStyle(isDisabled ? 0x202530 : 0x10263a, isDisabled ? 1 : 0.92);
        btn.setScale(1);
        this.showIntelPlaceholder();
      });

      this.candidateGroup.add(btn);
      this.candidateButtons.push(btn);
    });

    this.setupScrolling(candidates.length, maxScrollY);
  }

  private showPickedCards() {
    // Show already-picked cards in lane buttons (checkmark + card name)
    for (let i = 0; i < LANE_ORDER.length; i++) {
      const lane = LANE_ORDER[i];
      const laneSlots = this.draftState.slots.filter(s => s.lane === lane);
      const allPicked = laneSlots.every(s => s.cardId !== null);
      
      if (allPicked) {
        const btn = this.laneButtons[i];
        const label = btn.list[1] as Phaser.GameObjects.Text;
        label.setText(`${lane} ✓`);
      }
    }
  }

  private onCardPick(card: Card) {
    if (this.online) {
      if (this.pickPending || !this.isMyOnlineTurn()) return;
      this.pickPending = true;
      this.online.send({ type: 'pick', cardId: card.id });
      this.time.delayedCall(3000, () => { this.pickPending = false; });
      return;
    }
    const err = pickCard(this.draftState, this.matchState, card.id);
    if (err) {
      this.flashMessage(err);
      return;
    }

    // Stop current timer
    if (this.timerEvent) {
      this.timerEvent.remove();
      this.timerEvent = null;
    }

    this.searchQuery = '';
    this.updateSearchText();
    this.showIntelPlaceholder();

    if (isDraftComplete(this.draftState)) {
      this.onDraftComplete();
    } else {
      this.renderDraft();
      this.startTimer();
    }
  }

  private startTimer() {
    if (this.timerEvent) {
      this.timerEvent.remove();
    }
    this.clockLastMs = Date.now();
    this.updateClocks();
    const current = getCurrentDraftPlayer(this.draftState);
    if (current && this.draftState.timeRemainingMs[current] <= 0) {
      this.onPlayerClockExpired(current);
      return;
    }
    this.timerEvent = this.time.addEvent({
      delay: 200,
      loop: true,
      callback: () => {
        const now = Date.now();
        const elapsed = now - this.clockLastMs;
        this.clockLastMs = now;
        const player = getCurrentDraftPlayer(this.draftState);
        if (!player) return;
        this.draftState.timeRemainingMs[player] = Math.max(
          0, this.draftState.timeRemainingMs[player] - elapsed,
        );
        this.updateClocks();
        if (this.draftState.timeRemainingMs[player] <= 0) {
          this.onPlayerClockExpired(player);
        }
      },
    });
  }

  private onPlayerClockExpired(player: Player) {
    const err = autoPickRemaining(this.draftState, this.matchState, player);
    if (err) {
      if (this.timerEvent) {
        this.timerEvent.remove();
        this.timerEvent = null;
      }
      this.flashMessage(err);
      return;
    }
    if (isDraftComplete(this.draftState)) {
      this.onDraftComplete();
      return;
    }
    this.clockLastMs = Date.now();
    this.searchQuery = '';
    this.updateSearchText();
    this.renderDraft();
  }

  private onDraftComplete() {
    if (this.timerEvent) {
      this.timerEvent.remove();
      this.timerEvent = null;
    }

    // Clear UI
    this.candidateGroup.removeAll(true);
    this.candidateButtons = [];
    this.children.list.filter(child => child.name === 'draft-scroll-indicator')
      .forEach(child => child.destroy());
    this.scrollThumb = undefined;

    this.statusText.setText(t('draft.complete'));
    this.statusText.setColor('#66ff66');
    this.updateClocks();

    // Convert draft to placements
    const { p1Placements, p2Placements } = draftToPlacements(this.draftState);

    // Apply Fearless
    applyDraftFearless(this.draftState, this.matchState);

    // Transition to GameScene after a short delay
    this.time.delayedCall(1500, () => {
      this.scene.start('GameScene', {
        matchState: this.matchState,
        p1Placements,
        p2Placements,
        round: this.currentRound,
      });
    });
  }

  private flashMessage(msg: string) {
    this.statusText.setText(msg);
    this.time.delayedCall(2000, () => {
      if (this.statusText && !isDraftComplete(this.draftState)) {
        const currentPlayer = getCurrentDraftPlayer(this.draftState)!;
        const currentLane = getCurrentDraftLane(this.draftState)!;
        const playerColor = currentPlayer === Player.P1 ? '#66aaff' : '#ff6666';
        this.statusText.setText(t('draft.pickStatus', { player: this.playerLabel(currentPlayer), lane: currentLane }));
        this.statusText.setColor(playerColor);
      }
    });
  }

  private setupScrolling(totalCards: number, maxScrollY: number) {
    if (this.scrollWheelHandler) {
      this.input.off('wheel', this.scrollWheelHandler);
    }
    this.scrollWheelHandler = (pointer: Phaser.Input.Pointer, gameObjects: Phaser.GameObjects.GameObject[], deltaX: number, deltaY: number) => {
      if (pointer.x < CARD_AREA_X || pointer.x > CARD_AREA_X + CARD_AREA_W ||
          pointer.y < CARDS_VIEW_Y || pointer.y > CARDS_VIEW_Y + CARDS_VIEW_H) return;
      this.scrollY = Phaser.Math.Clamp(this.scrollY + deltaY, 0, maxScrollY);
      this.cardsCamera.setScroll(0, this.scrollY);
      if (this.scrollThumb && maxScrollY > 0) {
        const height = this.scrollThumb.height;
        this.scrollThumb.setY(CARDS_VIEW_Y + height / 2 +
          (this.scrollY / maxScrollY) * (CARDS_VIEW_H - height));
      }
    };
    this.input.on('wheel', this.scrollWheelHandler);

    const oldIndicators = this.children.list.filter(child => child.name === 'draft-scroll-indicator');
    oldIndicators.forEach(child => child.destroy());
    if (maxScrollY > 0) {
      const track = this.add.rectangle(876, 440, 4, CARDS_VIEW_H, 0x26354c)
        .setName('draft-scroll-indicator').setDepth(3);
      const thumbHeight = Math.max(42, CARDS_VIEW_H * CARDS_VIEW_H / (maxScrollY + CARDS_VIEW_H));
      const thumbY = CARDS_VIEW_Y + thumbHeight / 2 +
        (this.scrollY / maxScrollY) * (CARDS_VIEW_H - thumbHeight);
      this.scrollThumb = this.add.rectangle(876, thumbY, 6, thumbHeight, 0xf4c95d)
        .setName('draft-scroll-indicator').setDepth(4);
      this.cardsCamera.ignore([track, this.scrollThumb]);
    } else {
      this.scrollThumb = undefined;
    }
  }

  private cleanupScene() {
    if (this.timerEvent) this.timerEvent.remove();
    if (this.scrollWheelHandler) this.input.off('wheel', this.scrollWheelHandler);
    if (this.input.keyboard) this.input.keyboard.removeAllListeners('keydown');
  }
}
