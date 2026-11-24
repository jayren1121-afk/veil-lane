import Phaser from 'phaser';
import { isMatchOver, Lane, LANE_ORDER, LaneRevealResult, LaneSynergyLink, MatchState, Player, RoundResult } from '../rules';
import { CARDS } from '../data/cards';
import { cardArtPath } from '../data/art';
import { t, tSubject } from '../i18n';
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
import { summaryTrack } from '../audio/tracks';
import { measureTextWidth, wrapLines } from '../ui/wrapText';
import { layoutComboColumns } from '../ui/comboLayout';

// Layout (1200×800): five lane rows, then two synergy panels, then totals / winner / button.
const ROW_Y0 = 142;
const ROW_STEP = 88;
const ROW_H = 80;
const MINI_CARD_W = 62;
const MINI_CARD_H = 80;
const SYN_Y = 607;
const SYN_H = 132;
const SYN_W = 540;
const SYN_COLUMNS = 2;
const SYN_LINES = 6;
const SYN_FONT_SIZE = 11;
const SYN_LINE_H = 14;
const TOTAL_Y = 690;
const WINNER_Y = 717;
const FOOTNOTE_Y = 745;
const BUTTON_Y = 778;
/** Status note right of the bottom buttons (opponent ready / rematch), kept clear of the ♫ toggle. */
const NOTE_X = 968;
const NOTE_W = 200;

function rowY(index: number): number {
  return ROW_Y0 + index * ROW_STEP;
}

/** Largest font size (down to minSize) at which `value` fits in maxWidth. */
function fitFontSize(value: string, maxWidth: number, size: number, minSize: number, bold = false): number {
  for (let current = size; current > minSize; current--) {
    if (measureTextWidth(value, `${bold ? 'bold ' : ''}${current}px Arial`) <= maxWidth) return current;
  }
  return minSize;
}
import type { MatchView } from '../online/protocol';
import type { OnlineClient } from '../../net/onlineClient';
import { leaveOnline } from '../../net/onlineClient';
import { refreshAccount } from '../../net/identity';
import { bindOnlineScene, hideOnlineBanner, mirrorMatchState, opponentName, sideLabel } from './onlineScene';
import { addBackButton, confirmDialog, showOpponentLeft } from './sceneNav';
import { addTextButton, UiButton } from './uiButton';

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
  private readyNote: Phaser.GameObjects.Text | null = null;
  private rematchButton: UiButton | null = null;
  private rematchNote: Phaser.GameObjects.Text | null = null;
  private rematchClosing = false;
  private view: MatchView | null = null;
  private leaving = false;

  init(data: { state?: MatchState; result?: RoundResult; roundNumber?: number; online?: boolean }) {
    this.online = null;
    this.view = null;
    this.leaving = false;
    this.readyNote = null;
    this.rematchButton = null;
    this.rematchNote = null;
    this.rematchClosing = false;
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
    if (view.phase === 'matchEnd' && view.forfeitedBy && view.forfeitedBy !== view.you) {
      this.leaving = true;
      void refreshAccount();
      showOpponentLeft(this, opponentName(view), () => {
        leaveOnline();
        this.scene.start('MenuScene');
      });
      return;
    }
    if (view.phase === 'battle') {
      this.leaving = true;
      // A rematch starts at round 1 with a fresh coin toss.
      this.scene.start('GameScene', { online: true, showCoin: view.round === 1 && (view.battle?.revealed.length ?? 0) === 0 });
      return;
    }
    this.refreshOnlineNotes();
  }

  /** Online extras under the results: "opponent is ready" between rounds, rematch status after the match. */
  private refreshOnlineNotes() {
    const view = this.view;
    const online = this.online;
    if (!view || !online || this.leaving) return;
    const seconds = (deadline: number | null | undefined) =>
      Math.max(0, Math.ceil(((deadline ?? online.serverNow()) - online.serverNow()) / 1000));
    if (this.readyNote) {
      const opponent = view.you === Player.P1 ? Player.P2 : Player.P1;
      const opponentReady = view.phase === 'summary' && view.ready.includes(opponent) && !view.ready.includes(view.you);
      this.readyNote.setVisible(opponentReady);
    }
    const rematch = view.rematch;
    if (this.rematchNote && rematch) {
      let text: string;
      let color: string = COLORS.text;
      if (rematch.closed) {
        text = t('online.rematchClosed');
        color = COLORS.muted;
      } else if (rematch.opponentLeft) {
        text = t('online.rematchLeft');
        color = COLORS.lose;
      } else if (rematch.you) {
        text = t('online.rematchWaiting', { seconds: seconds(rematch.deadline) });
        color = COLORS.muted;
      } else if (rematch.opponent) {
        text = t('online.rematchOffered', { seconds: seconds(rematch.deadline) });
        color = COLORS.gold;
      } else {
        text = t('online.rematchPrompt', { seconds: seconds(rematch.deadline) });
      }
      this.setNote(this.rematchNote, text, color);
      // The rematch note already says the opponent left / the room is closing: no red banner on top.
      if (rematch.opponentLeft || rematch.closed) hideOnlineBanner(this);
      const canAsk = !rematch.closed && !rematch.opponentLeft && !rematch.you;
      this.rematchButton?.setEnabled(canAsk).setVisible(!rematch.opponentLeft && !rematch.closed);
      if (rematch.closed && !this.rematchClosing) {
        this.rematchClosing = true;
        this.time.delayedCall(1800, () => {
          if (this.leaving) return;
          this.leaving = true;
          leaveOnline();
          this.scene.start('LobbyScene');
        });
      }
    }
  }

  /** Wrap a status note to NOTE_W (shrinking the font if needed) so it stays inside its area. */
  private setNote(note: Phaser.GameObjects.Text, text: string, color: string) {
    let size = 15;
    let lines: string[] = [];
    for (; size >= 11; size--) {
      const font = `bold ${size}px Arial`;
      lines = wrapLines(text, NOTE_W, value => measureTextWidth(value, font));
      if (lines.length <= 2 && lines.every(line => measureTextWidth(line, font) <= NOTE_W)) break;
    }
    note.setFontSize(Math.max(size, 11)).setText(lines).setColor(color);
  }

  create() {
    drawBackground(this);
    const client = this.initOnline ? bindOnlineScene(this, view => this.onOnlineState(view)) : null;
    const musicMatchOver = this.initOnline
      ? !client?.state?.lastRound || client.state.phase === 'matchEnd'
      : !this.state || isMatchOver(this.state);
    setupSceneMusic(this, summaryTrack(musicMatchOver));
    if (this.initOnline) {
      if (client?.state && client.state.phase === 'matchEnd' && client.state.forfeitedBy && client.state.forfeitedBy !== client.state.you) {
        this.online = client;
        this.onOnlineState(client.state);
        return;
      }
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
      addBackButton(this, () => this.goBack());
      return;
    }

    this.laneCards.clear();
    this.revealRows.length = 0;
    drawHeader(this, t('summary.title', { round: this.roundNumber }), 150);
    addBackButton(this, () => this.goBack());
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

    const dividerY = (rowY(0) + rowY(LANE_ORDER.length - 1)) / 2;
    const dividerH = rowY(LANE_ORDER.length - 1) - rowY(0) + ROW_H;
    this.add.rectangle(600, dividerY, 2, dividerH, hexToInt(COLORS.cyan), 0.65).setDepth(8);
    this.add.rectangle(600, dividerY, 10, dividerH, hexToInt(COLORS.cyan), 0.08)
      .setBlendMode(Phaser.BlendModes.ADD).setDepth(7);

    const rowsByLane = new Map(this.result.laneResults.map(laneResult => [laneResult.lane, laneResult]));
    LANE_ORDER.forEach((lane, index) => {
      const laneResult = rowsByLane.get(lane);
      if (!laneResult) return;
      const y = rowY(index);
      const row = this.add.container(0, 0).setAlpha(0).setDepth(10 + index);
      this.revealRows.push(row);
      row.add(addPanel(this, 600, y, 1090, ROW_H, 0x0b2034));

      const p1Card = createCardFace(this, laneResult.p1Card, lane, MINI_CARD_W, MINI_CARD_H, { nameFontSize: '8px' });
      const p2Card = createCardFace(this, laneResult.p2Card, lane, MINI_CARD_W, MINI_CARD_H, { nameFontSize: '8px' });
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
    const base = `${(winRate * 100).toFixed(1)}%`;
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
    const yA = rowY(rowA);
    const yB = rowY(rowB);
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
    const sumBonus = (player: Player) => this.result.laneResults.reduce((sum, item) =>
      sum + (player === Player.P1 ? item.p1Synergy.bonus : item.p2Synergy.bonus), 0) * 100;
    const fadeIn: Phaser.GameObjects.GameObject[] = [];
    for (const [player, x, color] of [[Player.P1, 310, COLORS.p1], [Player.P2, 890, COLORS.p2]] as const) {
      const panel = addPanel(this, x, SYN_Y, SYN_W, SYN_H, 0x0b2034).setDepth(35);
      const top = SYN_Y - SYN_H / 2;
      const left = x - SYN_W / 2;
      const headerText = tSubject('summary.synergyBonus', this.isYou(player), {
        player: this.nameOf(player), bonus: sumBonus(player).toFixed(1),
      });
      const header = this.add.text(x, top + 16, headerText, {
        fontSize: `${fitFontSize(headerText, SYN_W - 30, 15, 11, true)}px`, fontFamily: 'Arial', color, fontStyle: 'bold',
      }).setOrigin(0.5).setDepth(36);
      fadeIn.push(panel, header);
      const columnWidth = (SYN_W - 28 - 12 * (SYN_COLUMNS - 1)) / SYN_COLUMNS;
      const font = `${SYN_FONT_SIZE}px Arial`;
      const entries = this.synergyEntries(player);
      const columns = entries.length === 0
        ? [[t('summary.noSynergy')]]
        : layoutComboColumns(entries, SYN_COLUMNS, SYN_LINES,
          entry => wrapLines(entry, columnWidth, value => measureTextWidth(value, font)),
          count => t('summary.moreSynergies', { count }));
      columns.forEach((lines, index) => {
        const text = this.add.text(left + 14 + index * (columnWidth + 12), top + 32, lines, {
          fontSize: `${SYN_FONT_SIZE}px`, fontFamily: 'Arial', color: COLORS.text,
          lineSpacing: SYN_LINE_H - SYN_FONT_SIZE - 2,
        }).setDepth(36);
        if (entries.length === 0) text.setX(x).setOrigin(0.5, 0).setColor(COLORS.muted);
        fadeIn.push(text);
      });
    }
    for (const object of fadeIn) (object as unknown as Phaser.GameObjects.Components.Alpha).setAlpha(0);
    this.tweens.add({ targets: fadeIn, alpha: 1, duration: 400 });

    const p1Total = this.add.text(600, TOTAL_Y, '', {
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
    const winnerLabel = this.add.text(600, WINNER_Y, winner
      ? t('summary.roundWinner', { player: this.nameOf(winner) })
      : t('summary.roundDraw'), {
      fontSize: '22px', fontFamily: 'Arial', color: winnerColor, fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(40);
    glowText(winnerLabel, winnerColor, 16);

    const matchOver = isMatchOver(this.state);
    if (matchOver) {
      const matchWinnerText = this.state.matchWinner
        ? tSubject('summary.matchWinner', this.isYou(this.state.matchWinner), { player: this.nameOf(this.state.matchWinner) })
        : t('summary.matchDraw');
      this.add.text(600, FOOTNOTE_Y,
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

    const proceed = () => {
      if (this.online) {
        if (matchOver) {
          this.leaving = true;
          leaveOnline();
          this.scene.start('LobbyScene');
        } else {
          this.online.send({ type: 'ready' });
          main.setText(t('online.waitingReady'));
          this.readyNote?.setVisible(false);
        }
        return;
      }
      if (matchOver) this.scene.start('GameScene', {});
      else this.scene.start('GameScene', { matchState: this.state, round: this.state.currentRound });
    };
    // Online after a finished match (newer servers): REMATCH next to BACK TO LOBBY.
    const offerRematch = Boolean(this.online && matchOver && this.view?.rematch);
    const mainLabel = matchOver
      ? (this.online ? t('online.backToLobby') : t('summary.playAgain'))
      : t('summary.nextRound');
    const main = addTextButton(this, offerRematch ? 730 : 600, BUTTON_Y, offerRematch ? 230 : 260, 40, mainLabel, proceed,
      { fontSize: 16, depth: 50 });
    if (offerRematch) {
      this.rematchButton = addTextButton(this, 470, BUTTON_Y, 230, 40, t('online.rematch'), () => {
        this.online?.send({ type: 'rematch' });
        this.rematchButton?.setEnabled(false);
      }, { fontSize: 16, depth: 50, color: COLORS.gold });
      this.rematchNote = this.add.text(NOTE_X, BUTTON_Y, '', {
        fontSize: '15px', fontFamily: 'Arial', color: COLORS.text, fontStyle: 'bold', align: 'center',
      }).setOrigin(0.5).setDepth(51);
    }
    if (this.online && !matchOver) {
      this.readyNote = this.add.text(NOTE_X, BUTTON_Y, '', {
        fontSize: '15px', fontFamily: 'Arial', color: COLORS.win, fontStyle: 'bold', align: 'center',
      }).setOrigin(0.5).setDepth(51).setVisible(false);
      this.setNote(this.readyNote, `✔ ${t('online.opponentReady')}`, COLORS.win);
      this.readyNote.setVisible(false);
    }
    if (this.online) {
      this.time.addEvent({ delay: 500, loop: true, callback: () => this.refreshOnlineNotes() });
      this.refreshOnlineNotes();
    }
    if (this.online && !matchOver) {
      const countdown = this.add.text(600, FOOTNOTE_Y, '', {
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

  /** One "✦ partner＋main +n%" line per partner, in lane order. */
  private synergyEntries(player: Player): string[] {
    const entries: string[] = [];
    for (const item of this.result.laneResults) {
      const card = player === Player.P1 ? item.p1Card : item.p2Card;
      const synergy = player === Player.P1 ? item.p1Synergy : item.p2Synergy;
      for (const link of synergy.links) entries.push(`✦ ${link.card.name}＋${card.name} +${Math.round(link.bonus * 100)}%`);
    }
    return entries;
  }

  private cardKey(player: Player, lane: Lane): string {
    return `${player}:${lane}`;
  }

  /** ← back / Esc / browser back: vs CPU or after the match go to the menu; online mid-match confirm (forfeit). */
  private goBack() {
    if (this.leaving) return;
    const exit = () => {
      this.leaving = true;
      if (this.online) leaveOnline();
      this.time.removeAllEvents();
      this.tweens.killAll();
      this.scene.start('MenuScene');
    };
    if (this.online && this.view?.phase === 'summary') {
      confirmDialog(this, t('leave.title'), t('leave.body'), t('leave.confirm'), t('leave.cancel'), exit);
    } else {
      exit();
    }
  }

  /** 你 / 電腦 vs CPU; online: 你 for this player, the opponent's nickname for the other. */
  private nameOf(player: Player): string {
    return this.view ? sideLabel(this.view, player) : this.localName(player);
  }

  /** Whether `player` is the person at this screen (label "YOU"), for English verb agreement. */
  private isYou(player: Player): boolean {
    return this.view ? player === this.view.you : player === Player.P1;
  }

  /** vs CPU: P1 is you, P2 is the computer. */
  private localName(player: Player): string {
    return player === Player.P1 ? t('game.you') : t('game.cpu');
  }
}
