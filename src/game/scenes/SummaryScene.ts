import Phaser from 'phaser';
import { isMatchOver, Lane, LANE_ORDER, LaneRevealResult, LaneSynergyLink, MatchState, Player, RoundResult } from '../rules';
import { CARDS } from '../data/cards';
import { cardArtPath } from '../data/art';
import { t } from '../i18n';
import { CardView, createCardFace } from './cardView';
import {
  addButton,
  addPanel,
  COLORS,
  countUp,
  drawBackground,
  drawHeader,
  glowText,
  hexToInt,
  laneColor,
} from './theme';
import { setupSceneMusic } from './musicToggle';
import type { MatchView } from '../online/protocol';
import type { OnlineClient } from '../../net/onlineClient';
import { leaveOnline } from '../../net/onlineClient';
import { refreshAccount } from '../../net/identity';
import { bindOnlineScene, mirrorMatchState, sideLabel } from './onlineScene';

export class SummaryScene extends Phaser.Scene {
  constructor() {
    super({ key: 'SummaryScene' });
  }

  private state!: MatchState;
  private result!: RoundResult;
  private roundNumber = 1;
  private readonly laneCards = new Map<string, CardView>();
  private readonly revealRows: Phaser.GameObjects.Container[] = [];

  private online: OnlineClient | null = null;
  private view: MatchView | null = null;
  private leaving = false;

  init(data: { state?: MatchState; result?: RoundResult; roundNumber?: number; online?: boolean }) {
    this.online = null;
    this.view = null;
    this.leaving = false;
    if (data.online) {
      this.initOnline = true;
      return;
    }
    this.initOnline = false;
    this.state = data.state!;
    this.result = data.result ?? this.state.roundResults[this.state.roundResults.length - 1];
    this.roundNumber = data.roundNumber ?? Math.max(1, this.state.roundResults.length);
  }

  preload() {
    for (const card of CARDS) {
      if (!this.textures.exists(card.id)) this.load.image(card.id, cardArtPath(card.id));
    }
  }

  private initOnline = false;

  private onOnlineState(view: MatchView) {
    if (this.leaving) return;
    this.view = view;
    if (view.phase === 'battle') {
      this.leaving = true;
      this.scene.start('GameScene', { online: true });
    }
  }

  create() {
    setupSceneMusic(this);
    drawBackground(this);
    if (this.initOnline) {
      const client = bindOnlineScene(this, view => this.onOnlineState(view));
      if (!client?.state?.lastRound) {
        this.scene.start('LobbyScene');
        return;
      }
      this.online = client;
      this.view = client.state;
      this.state = mirrorMatchState(client.state);
      this.result = client.state.lastRound!;
      this.roundNumber = client.state.lastRoundNumber;
      if (client.state.phase === 'matchEnd') void refreshAccount();
    }
    if (!this.result) {
      this.add.text(600, 400, t('summary.missing'), {
        fontSize: '24px', fontFamily: 'Arial', color: COLORS.text,
      }).setOrigin(0.5);
      return;
    }

    this.laneCards.clear();
    this.revealRows.length = 0;
    drawHeader(this, t('summary.title', { round: this.roundNumber }));
    this.add.text(1170, 35,
      `${this.nameOf(Player.P1)} ${this.state.p1RoundWins}　－　${this.state.p2RoundWins} ${this.nameOf(Player.P2)}`, {
        fontSize: '16px', fontFamily: 'Arial', color: COLORS.text, fontStyle: 'bold',
      }).setOrigin(1, 0.5).setDepth(3);
    this.add.text(150, 88, this.nameOf(Player.P1), {
      fontSize: '16px', fontFamily: 'Arial', color: COLORS.p1, fontStyle: 'bold',
    }).setOrigin(0.5);
    this.add.text(1050, 88, this.nameOf(Player.P2), {
      fontSize: '16px', fontFamily: 'Arial', color: COLORS.p2, fontStyle: 'bold',
    }).setOrigin(0.5);

    this.add.rectangle(600, 346, 2, 520, hexToInt(COLORS.cyan), 0.65).setDepth(8);
    this.add.rectangle(600, 346, 10, 520, hexToInt(COLORS.cyan), 0.08)
      .setBlendMode(Phaser.BlendModes.ADD).setDepth(7);

    const rowsByLane = new Map(this.result.laneResults.map(laneResult => [laneResult.lane, laneResult]));
    LANE_ORDER.forEach((lane, index) => {
      const laneResult = rowsByLane.get(lane);
      if (!laneResult) return;
      const y = 145 + index * 98;
      const row = this.add.container(0, 0).setAlpha(0).setDepth(10 + index);
      this.revealRows.push(row);
      row.add(addPanel(this, 600, y, 1090, 88, 0x0b2034));

      const p1Card = createCardFace(this, laneResult.p1Card, lane, 68, 90, { nameFontSize: '8px' });
      const p2Card = createCardFace(this, laneResult.p2Card, lane, 68, 90, { nameFontSize: '8px' });
      p1Card.container.setPosition(150, y);
      p2Card.container.setPosition(1050, y);
      row.add([p1Card.container, p2Card.container]);
      this.laneCards.set(this.cardKey(Player.P1, lane), p1Card);
      this.laneCards.set(this.cardKey(Player.P2, lane), p2Card);

      row.add(this.add.text(194, y - 13, laneResult.p1Card.name, {
        fontSize: '13px', fontFamily: 'Arial', color: COLORS.text, fontStyle: 'bold',
        wordWrap: { width: 235 },
      }).setOrigin(0, 0.5));
      row.add(this.add.text(1006, y - 13, laneResult.p2Card.name, {
        fontSize: '13px', fontFamily: 'Arial', color: COLORS.text, fontStyle: 'bold',
        align: 'right', wordWrap: { width: 235 },
      }).setOrigin(1, 0.5));

      const p1Won = laneResult.laneWinner === Player.P1;
      const p2Won = laneResult.laneWinner === Player.P2;
      // WIN and the score breakdown stay clear of the centre lane badge (x 560-640).
      row.add(this.add.text(542, y - 13, p1Won ? 'WIN' : '', {
        fontSize: '15px', fontFamily: 'Arial', color: COLORS.win, fontStyle: 'bold',
      }).setOrigin(1, 0.5));
      row.add(this.add.text(542, y + 14,
        this.laneBreakdown(laneResult, laneResult.p1WinRate, laneResult.p1Synergy.bonus), {
          fontSize: '13px', fontFamily: 'Arial', color: p1Won ? COLORS.win : COLORS.muted,
          fontStyle: p1Won ? 'bold' : 'normal',
        }).setOrigin(1, 0.5));
      row.add(this.add.text(658, y - 13, p2Won ? 'WIN' : '', {
        fontSize: '15px', fontFamily: 'Arial', color: COLORS.win, fontStyle: 'bold',
      }).setOrigin(0, 0.5));
      row.add(this.add.text(658, y + 14,
        this.laneBreakdown(laneResult, laneResult.p2WinRate, laneResult.p2Synergy.bonus), {
          fontSize: '13px', fontFamily: 'Arial', color: p2Won ? COLORS.win : COLORS.muted,
          fontStyle: p2Won ? 'bold' : 'normal',
        }).setOrigin(0, 0.5));

      row.add(this.add.rectangle(600, y, 80, 26, 0x091725, 0.96).setRounded(7)
        .setStrokeStyle(1, hexToInt(laneColor(lane)), 0.95));
      row.add(this.add.text(600, y, lane, {
        fontSize: '12px', fontFamily: 'Arial', color: laneColor(lane), fontStyle: 'bold',
      }).setOrigin(0.5));
    });

    this.revealRows.forEach((row, index) => {
      this.time.delayedCall(220 + index * 220, () => {
        this.tweens.add({ targets: row, alpha: 1, duration: 360, ease: 'Sine.Out' });
      });
    });
    this.playSynergySequence();
  }

  private laneBreakdown(result: LaneRevealResult, winRate: number, synergy: number): string {
    const base = `${(winRate * 100).toFixed(1)}% + ${(result.orderBonus * 100).toFixed(0)}%`;
    return synergy > 0 ? `${base} + ✦${(synergy * 100).toFixed(0)}%` : base;
  }

  private playSynergySequence() {
    const effects: { player: Player; lane: Lane; link: LaneSynergyLink }[] = [];
    for (const laneResult of this.result.laneResults) {
      laneResult.p1Synergy.links.forEach(link => effects.push({ player: Player.P1, lane: laneResult.lane, link }));
      laneResult.p2Synergy.links.forEach(link => effects.push({ player: Player.P2, lane: laneResult.lane, link }));
    }
    effects.forEach((effect, index) => {
      this.time.delayedCall(1550 + index * 520, () => this.animateSynergy(effect.player, effect.lane, effect.link, index));
    });
    this.time.delayedCall(1900 + effects.length * 520, () => this.showRoundTotals());
  }

  private animateSynergy(player: Player, lane: Lane, link: LaneSynergyLink, index: number) {
    const second = this.laneCards.get(this.cardKey(player, lane));
    if (!second) return;
    // The partner may be any card of the hand; only draw a link when it was also that lane's main card.
    const partnerResult = this.result.laneResults.find(item => item.lane === link.lane);
    const partnerMain = partnerResult ? (player === Player.P1 ? partnerResult.p1Card : partnerResult.p2Card) : null;
    const first = partnerMain?.id === link.card.id ? this.laneCards.get(this.cardKey(player, link.lane)) : undefined;
    const color = player === Player.P1 ? COLORS.p1 : COLORS.p2;
    [first, second].forEach(card => {
      if (!card) return;
      card.border.setStrokeStyle(4, hexToInt(COLORS.gold), 1);
      this.tweens.add({ targets: card.container, scale: 1.08, duration: 220, yoyo: true, ease: 'Sine.Out' });
    });
    if (first) this.drawSynergyLink(player, link.lane, lane, color, index);
  }

  private drawSynergyLink(player: Player, laneA: Lane, laneB: Lane, color: string, index: number) {
    const rowA = LANE_ORDER.indexOf(laneA);
    const rowB = LANE_ORDER.indexOf(laneB);
    if (rowA < 0 || rowB < 0) return;
    const yA = 145 + rowA * 98;
    const yB = 145 + rowB * 98;
    const side = player === Player.P1 ? -1 : 1;
    const edgeX = player === Player.P1 ? 116 : 1084;
    const controlX = (player === Player.P1 ? 76 : 1124) + side * (index % 4) * 5;
    const middleY = (yA + yB) / 2;
    const graphics = this.add.graphics().setDepth(28);
    const drawCurve = (lineWidth: number, alpha: number) => {
      graphics.lineStyle(lineWidth, hexToInt(color), alpha);
      graphics.beginPath();
      for (let step = 0; step <= 16; step++) {
        const t = step / 16;
        const oneMinus = 1 - t;
        const x = oneMinus * oneMinus * oneMinus * edgeX
          + 3 * oneMinus * oneMinus * t * controlX
          + 3 * oneMinus * t * t * controlX
          + t * t * t * edgeX;
        const y = oneMinus * oneMinus * oneMinus * yA
          + 3 * oneMinus * oneMinus * t * yA
          + 3 * oneMinus * t * t * yB
          + t * t * t * yB;
        if (step === 0) graphics.moveTo(x, y);
        else graphics.lineTo(x, y);
      }
      graphics.strokePath();
    };
    drawCurve(8, 0.16);
    drawCurve(2, 0.9);
    this.add.text(controlX, middleY, '✦', {
      fontSize: '16px', fontFamily: 'Arial', color: COLORS.gold, fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(29);
  }

  private showRoundTotals() {
    const p1ComboText = this.formatSynergies(Player.P1);
    const p2ComboText = this.formatSynergies(Player.P2);
    const sumBonus = (player: Player) => this.result.laneResults.reduce((sum, item) =>
      sum + (player === Player.P1 ? item.p1Synergy.bonus : item.p2Synergy.bonus), 0) * 100;
    const p1Bonus = sumBonus(Player.P1);
    const p2Bonus = sumBonus(Player.P2);
    const p1Panel = addPanel(this, 310, 642, 520, 70, 0x0b2034).setDepth(35);
    const p2Panel = addPanel(this, 890, 642, 520, 70, 0x0b2034).setDepth(35);
    const p1Text = this.add.text(310, 628, t('summary.synergyBonus', { player: this.nameOf(Player.P1), bonus: p1Bonus.toFixed(1) }), {
      fontSize: '15px', fontFamily: 'Arial', color: COLORS.p1, fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(36);
    const p2Text = this.add.text(890, 628, t('summary.synergyBonus', { player: this.nameOf(Player.P2), bonus: p2Bonus.toFixed(1) }), {
      fontSize: '15px', fontFamily: 'Arial', color: COLORS.p2, fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(36);
    const p1Pairs = this.add.text(310, 653, p1ComboText, {
      fontSize: '11px', fontFamily: 'Arial', color: COLORS.text, align: 'center',
      wordWrap: { width: 490 },
    }).setOrigin(0.5).setDepth(36);
    const p2Pairs = this.add.text(890, 653, p2ComboText, {
      fontSize: '11px', fontFamily: 'Arial', color: COLORS.text, align: 'center',
      wordWrap: { width: 490 },
    }).setOrigin(0.5).setDepth(36);
    p1Panel.setAlpha(0);
    p2Panel.setAlpha(0);
    [p1Text, p2Text, p1Pairs, p2Pairs].forEach(text => text.setAlpha(0));
    this.tweens.add({ targets: [p1Panel, p2Panel, p1Text, p2Text, p1Pairs, p2Pairs], alpha: 1, duration: 400 });

    const p1Total = this.add.text(600, 690, '', {
      fontSize: '19px', fontFamily: 'Arial', color: COLORS.text, fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(40);
    countUp(this, p1Total, this.result.p1WinRate * 100,
      value => t('summary.roundTotal', {
        p1: value.toFixed(1),
        p2: (this.result.p2WinRate * 100).toFixed(1),
        p1name: this.nameOf(Player.P1),
        p2name: this.nameOf(Player.P2),
      }), 760);
    const winner = this.result.roundWinner;
    const winnerColor = winner === Player.P1 ? COLORS.p1 : winner === Player.P2 ? COLORS.p2 : COLORS.gold;
    const winnerLabel = this.add.text(600, 721, winner
      ? t('summary.roundWinner', { player: this.nameOf(winner) })
      : t('summary.roundDraw'), {
      fontSize: '22px', fontFamily: 'Arial', color: winnerColor, fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(40);
    glowText(winnerLabel, winnerColor, 16);

    const matchOver = isMatchOver(this.state);
    if (matchOver) {
      const matchWinnerText = this.state.matchWinner
        ? t('summary.matchWinner', { player: this.nameOf(this.state.matchWinner) })
        : t('summary.matchDraw');
      this.add.text(600, 748,
        t('summary.matchOver', {
          p1name: this.nameOf(Player.P1),
          p2name: this.nameOf(Player.P2),
          p1: this.state.p1RoundWins,
          p2: this.state.p2RoundWins,
          winner: matchWinnerText,
        }), {
          fontSize: '13px', fontFamily: 'Arial', color: COLORS.title, fontStyle: 'bold',
        }).setOrigin(0.5).setDepth(45);
    }

    const button = addButton(this, 600, 780, 260, 40, 0x17334a).setDepth(50);
    const label = this.add.text(600, 780, matchOver
      ? (this.online ? t('online.backToLobby') : t('summary.playAgain'))
      : t('summary.nextRound'), {
      fontSize: '16px', fontFamily: 'Arial', color: COLORS.title, fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(51);
    button.on('pointerover', () => button.setFillStyle(0x24536a, 0.95));
    button.on('pointerout', () => button.setFillStyle(0x17334a, COLORS.panelAlpha));
    const proceed = () => {
      if (this.online) {
        if (matchOver) {
          this.leaving = true;
          leaveOnline();
          this.scene.start('LobbyScene');
        } else {
          this.online.send({ type: 'ready' });
          label.setText(t('online.waitingReady'));
        }
        return;
      }
      if (matchOver) this.scene.start('GameScene', {});
      else this.scene.start('GameScene', { matchState: this.state, round: this.state.currentRound });
    };
    button.on('pointerdown', proceed);
    label.setInteractive({ useHandCursor: true }).on('pointerdown', proceed);
    if (this.online && !matchOver) {
      const countdown = this.add.text(600, 757, '', {
        fontSize: '12px', fontFamily: 'Arial', color: COLORS.muted,
      }).setOrigin(0.5, 0.5).setDepth(51);
      this.time.addEvent({
        delay: 500, loop: true, callback: () => {
          const deadline = this.view?.summaryDeadline;
          if (!deadline || !this.online) return;
          countdown.setText(t('online.autoNext', {
            seconds: Math.max(0, Math.ceil((deadline - this.online.serverNow()) / 1000)),
          }));
        },
      });
    }
  }

  private formatSynergies(player: Player): string {
    const pairs: string[] = [];
    for (const item of this.result.laneResults) {
      const card = player === Player.P1 ? item.p1Card : item.p2Card;
      const synergy = player === Player.P1 ? item.p1Synergy : item.p2Synergy;
      for (const link of synergy.links) pairs.push(`${link.card.name}＋${card.name} +${Math.round(link.bonus * 100)}%`);
    }
    if (pairs.length === 0) return t('summary.noSynergy');
    const shown = pairs.slice(0, 2);
    if (pairs.length > 2) shown.push(t('summary.moreSynergies', { count: pairs.length - 2 }));
    return `✦ ${shown.join('　✦ ')}`;
  }

  private cardKey(player: Player, lane: Lane): string {
    return `${player}:${lane}`;
  }

  /** 你 / 電腦 vs CPU; online: 你 for this player, the opponent's nickname for the other. */
  private nameOf(player: Player): string {
    return this.view ? sideLabel(this.view, player) : this.localName(player);
  }

  /** vs CPU: P1 is you, P2 is the computer. */
  private localName(player: Player): string {
    return player === Player.P1 ? t('game.you') : t('game.cpu');
  }
}
