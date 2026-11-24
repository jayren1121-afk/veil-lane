import Phaser from 'phaser';
import {
  BATTLE_TURN_SECONDS,
  LANE_ORDER,
  SYNERGY_TIER,
  TOTAL_ROUNDS,
} from '../rules';
import { t } from '../i18n';
import { addBackButton } from './sceneNav';
import { setupSceneMusic } from './musicToggle';
import { addButton, addPanel, COLORS, drawBackground, drawHeader, hexToInt, laneColor } from './theme';
import { measureTextWidth, wrapLines } from '../ui/wrapText';

/** Framed panel: x 50–1150, y 90–680. All how-to text stays inside it with padding. */
const PANEL = { x: 600, y: 385, width: 1100, height: 590 };
const PANEL_TOP = PANEL.y - PANEL.height / 2;
const PANEL_BOTTOM = PANEL.y + PANEL.height / 2;
const BODY_TOP = 200;
const BODY_WRAP_WIDTH = 920;
const DIAGRAM_TEXT_MAX_WIDTH = 960;
const BODY_DIAGRAM_GAP = 24;
const CONTENT_BOTTOM = PANEL_BOTTOM - 14;
const BODY_FONT_SIZES = [19, 18, 17, 16, 15];
const FONT_FAMILY = 'Arial';

interface TutorialPage {
  title: string;
  lines: string[];
}

function getPages(): TutorialPage[] {
  return [
    {
      title: t('tutorial.page1.title'),
      lines: [
        t('tutorial.page1.line1'),
        t('tutorial.page1.line2', { seconds: BATTLE_TURN_SECONDS }),
      ],
    },
    {
      title: t('tutorial.page2.title'),
      lines: [t('tutorial.page2.line1'), t('tutorial.page2.line2')],
    },
    {
      title: t('tutorial.page3.title'),
      lines: [
        t('tutorial.page3.line1'),
        t('tutorial.page3.line2', {
          tiers: SYNERGY_TIER.map(bonus => `+${bonus}%`).join(' / '),
        }),
        t('tutorial.page3.line3'),
      ],
    },
    {
      title: t('tutorial.page4.title'),
      lines: [
        t('tutorial.page4.line1', { rounds: TOTAL_ROUNDS }),
        t('tutorial.page4.line2'),
      ],
    },
  ];
}

export class HowToPlayScene extends Phaser.Scene {
  constructor() {
    super({ key: 'HowToPlayScene' });
  }

  private pageIndex = 0;
  private pageTitle!: Phaser.GameObjects.Text;
  private pageBody!: Phaser.GameObjects.Text;
  private pageIndicator!: Phaser.GameObjects.Text;
  private diagramGroup!: Phaser.GameObjects.Container;
  private diagramTop = Infinity;
  private diagramBottom = -Infinity;

  create() {
    this.pageIndex = 0;
    setupSceneMusic(this);
    drawBackground(this);
    drawHeader(this, t('tutorial.title'), 150);
    addBackButton(this, () => this.scene.start('MenuScene'));
    addPanel(this, PANEL.x, PANEL.y, PANEL.width, PANEL.height, 0x0b2034).setDepth(-1);

    const close = addButton(this, 1150, 35, 44, 44, 0x17334a).setDepth(10);
    this.add.text(1150, 35, '×', {
      fontSize: '30px', fontFamily: 'Arial', color: COLORS.text, fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(11);
    close.on('pointerdown', () => this.scene.start('MenuScene'));

    this.pageTitle = this.add.text(600, PANEL_TOP + 62, '', {
      fontSize: '38px', fontFamily: 'Arial', color: COLORS.title, fontStyle: 'bold',
    }).setOrigin(0.5);
    // Wrapped by wrapLines (Phaser's own wrap only breaks at spaces, so Chinese lines never wrapped).
    this.pageBody = this.add.text(600, BODY_TOP, '', {
      fontSize: '19px', fontFamily: FONT_FAMILY, color: COLORS.text, align: 'center', lineSpacing: 10,
    }).setOrigin(0.5, 0);
    this.diagramGroup = this.add.container(0, 0);

    const previous = addButton(this, 116, 722, 132, 44, 0x17334a);
    const next = addButton(this, 1084, 722, 132, 44, 0x17334a);
    this.add.text(116, 722, t('tutorial.previous'), {
      fontSize: '16px', fontFamily: 'Arial', color: COLORS.text,
    }).setOrigin(0.5);
    this.add.text(1084, 722, t('tutorial.next'), {
      fontSize: '16px', fontFamily: 'Arial', color: COLORS.text,
    }).setOrigin(0.5);
    previous.on('pointerdown', () => this.changePage(-1));
    next.on('pointerdown', () => this.changePage(1));

    this.pageIndicator = this.add.text(600, 722, '', {
      fontSize: '16px', fontFamily: 'Arial', color: COLORS.muted,
    }).setOrigin(0.5);
    this.input.keyboard?.on('keydown-LEFT', this.onLeft, this);
    this.input.keyboard?.on('keydown-RIGHT', this.onRight, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, this.onShutdown, this);
    this.renderPage();
  }

  private onLeft() {
    this.changePage(-1);
  }

  private onRight() {
    this.changePage(1);
  }

  private onShutdown() {
    this.input.keyboard?.off('keydown-LEFT', this.onLeft, this);
    this.input.keyboard?.off('keydown-RIGHT', this.onRight, this);
  }

  private changePage(direction: number) {
    this.pageIndex = Phaser.Math.Clamp(this.pageIndex + direction, 0, getPages().length - 1);
    this.renderPage();
  }

  private renderPage() {
    const pages = getPages();
    const page = pages[this.pageIndex];
    this.pageTitle.setText(page.title);
    this.diagramGroup.removeAll(true);
    this.diagramGroup.y = 0;
    this.diagramTop = Infinity;
    this.diagramBottom = -Infinity;
    if (this.pageIndex === 0) this.drawDraftDiagram();
    else if (this.pageIndex === 1) this.drawRevealDiagram();
    else if (this.pageIndex === 2) this.drawScoreDiagram();
    else this.drawFearlessDiagram();
    this.layoutBody(page.lines.join('\n'));
    const dots = pages.map((_, index) => index === this.pageIndex ? '●' : '○').join(' ');
    this.pageIndicator.setText(t('tutorial.pageIndicator', {
      page: this.pageIndex + 1,
      total: pages.length,
      dots,
    }));
  }

  /**
   * Wrap the body to the panel's inner width, then push the diagram down below it. If the
   * diagram would leave the panel, shrink the body font until everything fits.
   */
  private layoutBody(text: string) {
    let offset = 0;
    for (const size of BODY_FONT_SIZES) {
      const font = `${size}px ${FONT_FAMILY}`;
      const lines = wrapLines(text, BODY_WRAP_WIDTH, value => measureTextWidth(value, font));
      this.pageBody.setFontSize(size).setLineSpacing(size >= 18 ? 10 : 7).setText(lines);
      const bodyBottom = BODY_TOP + this.pageBody.height;
      offset = Math.max(0, bodyBottom + BODY_DIAGRAM_GAP - this.diagramTop);
      if (this.diagramBottom + offset <= CONTENT_BOTTOM) break;
    }
    this.diagramGroup.y = Math.min(offset, Math.max(0, CONTENT_BOTTOM - this.diagramBottom));
  }

  private trackY(top: number, bottom: number) {
    this.diagramTop = Math.min(this.diagramTop, top);
    this.diagramBottom = Math.max(this.diagramBottom, bottom);
  }

  private drawDraftDiagram() {
    const positions = [390, 495, 600, 705, 810];
    this.addDiagramText(600, 338, t('tutorial.draft.timer'), 14, COLORS.gold);
    this.addDiagramText(520, 378, t('tutorial.draft.clock', { player: 'P1', seconds: BATTLE_TURN_SECONDS }), 20, COLORS.p1);
    this.addDiagramText(680, 378, t('tutorial.draft.clock', { player: 'P2', seconds: BATTLE_TURN_SECONDS }), 20, COLORS.p2);
    this.addDiagramText(265, 470, 'P1', 18, COLORS.p1);
    this.addDiagramText(265, 570, 'P2', 18, COLORS.p2);

    LANE_ORDER.forEach((lane, index) => {
      this.addMiniCard(positions[index], 470, lane, laneColor(lane), 'normal');
      this.addMiniCard(positions[index], 570, lane, laneColor(lane), 'normal');
    });
    this.addArrow(390, 520, 810, 520, COLORS.cyan);
    this.addDiagramText(600, 635, t('tutorial.draft.visible'), 17, COLORS.text);
  }

  private drawRevealDiagram() {
    const revealedIndex = 2;
    this.addDiagramText(200, 462, t('tutorial.reveal.coin'), 16, COLORS.title);
    this.addDiagramCircle(200, 527, 38, 0xd79c2c, 'P1 / P2');
    this.addDiagramText(200, 592, t('tutorial.reveal.first'), 15, COLORS.text);
    this.addArrow(255, 527, 315, 527, COLORS.cyan);
    this.addDiagramText(610, 365, t('tutorial.reveal.instruction'), 17, COLORS.title);
    LANE_ORDER.forEach((lane, index) => {
      const x = 370 + index * 120;
      const revealed = index === revealedIndex;
      this.addMiniCard(x, 470, t('tutorial.reveal.revealed'), revealed ? COLORS.gold : laneColor(lane), revealed ? 'normal' : 'faceDown');
      this.addMiniCard(x, 585, t('tutorial.reveal.revealed'), revealed ? COLORS.gold : laneColor(lane), revealed ? 'normal' : 'faceDown');
      this.addDiagramText(x, 527, lane, 13, revealed ? COLORS.gold : laneColor(lane));
    });
    this.addDiagramText(925, 470, 'P2', 16, COLORS.p2);
    this.addDiagramText(925, 585, 'P1', 16, COLORS.p1);
  }

  private drawScoreDiagram() {
    const boxes = [
      { x: 365, label: t('tutorial.score.matchup'), sub: t('tutorial.score.grid'), color: COLORS.p1 },
      { x: 655, label: t('tutorial.score.synergy'), sub: `+${SYNERGY_TIER[SYNERGY_TIER.length - 1]}–${SYNERGY_TIER[0]}%`, color: COLORS.green },
    ];
    for (const box of boxes) {
      this.addDiagramPanel(box.x, 425, 200, 96, box.color);
      this.addDiagramText(box.x, 409, box.label, 18, box.color);
      this.addDiagramText(box.x, 443, box.sub, 15, COLORS.text);
    }
    this.addDiagramText(510, 425, '＋', 24, COLORS.text);
    this.addArrow(767, 425, 838, 425, COLORS.cyan);
    this.addDiagramPanel(930, 425, 150, 96, COLORS.title);
    this.addDiagramText(930, 425, t('tutorial.score.total'), 20, COLORS.title);
  }

  private drawFearlessDiagram() {
    const centers = [390, 600, 810];
    centers.forEach((x, index) => {
      this.addDiagramPanel(x, 470, 170, 190, COLORS.cyan);
      this.addDiagramText(x, 400, t('tutorial.fearless.round', { number: index + 1 }), 17, COLORS.title);
      this.addMiniCard(x, 475, t('tutorial.fearless.card'), index === 0 ? COLORS.cyan : '#77818e', index > 0 ? 'disabled' : 'normal');
      if (index > 0) {
        this.addDiagramText(x, 535, t('tutorial.fearless.disabled'), 15, COLORS.lose);
      } else {
        this.addDiagramText(x, 535, t('tutorial.fearless.used'), 15, COLORS.green);
      }
      if (index < centers.length - 1) this.addArrow(x + 95, 470, centers[index + 1] - 95, 470, COLORS.cyan);
    });
  }

  private addMiniCard(
    x: number,
    y: number,
    label: string,
    color: string,
    state: 'normal' | 'faceDown' | 'disabled',
  ) {
    const disabled = state === 'disabled';
    const fill = disabled ? 0x424a55 : 0x10263a;
    const border = disabled ? 0x7d8792 : hexToInt(color);
    this.trackY(y - 36, y + 36);
    const card = this.add.rectangle(x, y, 82, 72, fill, 0.95)
      .setRounded(7).setStrokeStyle(2, border);
    this.diagramGroup.add(card);
    const cardText = disabled ? '✕' : state === 'faceDown' ? '??' : label;
    this.addDiagramText(x, y, cardText, disabled ? 22 : state === 'faceDown' ? 22 : 12,
      disabled ? '#c1c8d0' : state === 'faceDown' ? COLORS.muted : COLORS.text);
  }

  private addDiagramPanel(x: number, y: number, width: number, height: number, color: string | number) {
    this.trackY(y - height / 2, y + height / 2);
    const panel = this.add.rectangle(x, y, width, height, 0x10263a, 0.9)
      .setRounded(8).setStrokeStyle(2, typeof color === 'string' ? hexToInt(color) : color);
    this.diagramGroup.add(panel);
  }

  private addDiagramCircle(x: number, y: number, radius: number, color: number, label: string) {
    this.trackY(y - radius - 2, y + radius + 2);
    const coin = this.add.circle(x, y, radius, color).setStrokeStyle(4, 0xffe38a);
    this.diagramGroup.add(coin);
    this.addDiagramText(x, y, label, 13, '#4b3210');
  }

  private addArrow(x1: number, y: number, x2: number, y2: number, color: string) {
    const graphics = this.add.graphics().lineStyle(3, hexToInt(color), 0.9);
    graphics.lineBetween(x1, y, x2, y2);
    const direction = x2 >= x1 ? 1 : -1;
    graphics.lineBetween(x2 - direction * 11, y2 - 7, x2, y2);
    graphics.lineBetween(x2 - direction * 11, y2 + 7, x2, y2);
    this.diagramGroup.add(graphics);
  }

  private addDiagramText(x: number, y: number, value: string, size: number, color: string) {
    const font = `${size}px ${FONT_FAMILY}`;
    const lines = wrapLines(value, DIAGRAM_TEXT_MAX_WIDTH, line => measureTextWidth(line, font));
    const text = this.add.text(x, y, lines, {
      fontSize: `${size}px`, fontFamily: FONT_FAMILY, color, align: 'center',
    }).setOrigin(0.5);
    // Keep the label inside the panel horizontally.
    const half = text.width / 2;
    const minX = PANEL.x - PANEL.width / 2 + 24 + half;
    const maxX = PANEL.x + PANEL.width / 2 - 24 - half;
    if (minX <= maxX) text.setX(Phaser.Math.Clamp(x, minX, maxX));
    this.trackY(y - text.height / 2, y + text.height / 2);
    this.diagramGroup.add(text);
  }
}