import Phaser from 'phaser';
import {
  BATTLE_TURN_SECONDS,
  LANE_ORDER,
  ORDER_BONUS,
  SYNERGY_TIER,
  TOTAL_ROUNDS,
} from '../rules';
import { t } from '../i18n';
import { addBackButton } from './sceneNav';
import { setupSceneMusic } from './musicToggle';
import { addButton, addPanel, COLORS, drawBackground, drawHeader, hexToInt, laneColor } from './theme';

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
          bonuses: ORDER_BONUS.map(bonus => `+${bonus}%`).join(' / '),
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

  create() {
    this.pageIndex = 0;
    setupSceneMusic(this);
    drawBackground(this);
    drawHeader(this, t('tutorial.title'), 150);
    addBackButton(this, () => this.scene.start('MenuScene'));
    addPanel(this, 600, 385, 1100, 590, 0x0b2034).setDepth(-1);

    const close = addButton(this, 1150, 35, 44, 44, 0x17334a).setDepth(10);
    this.add.text(1150, 35, '×', {
      fontSize: '30px', fontFamily: 'Arial', color: COLORS.text, fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(11);
    close.on('pointerdown', () => this.scene.start('MenuScene'));

    this.pageTitle = this.add.text(600, 155, '', {
      fontSize: '38px', fontFamily: 'Arial', color: COLORS.title, fontStyle: 'bold',
    }).setOrigin(0.5);
    this.pageBody = this.add.text(600, 230, '', {
      fontSize: '19px', fontFamily: 'Arial', color: COLORS.text, align: 'center',
      lineSpacing: 12, wordWrap: { width: 850 },
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
    this.pageBody.setText(page.lines.join('\n'));
    const dots = pages.map((_, index) => index === this.pageIndex ? '●' : '○').join(' ');
    this.pageIndicator.setText(t('tutorial.pageIndicator', {
      page: this.pageIndex + 1,
      total: pages.length,
      dots,
    }));
    this.diagramGroup.removeAll(true);
    if (this.pageIndex === 0) this.drawDraftDiagram();
    else if (this.pageIndex === 1) this.drawRevealDiagram();
    else if (this.pageIndex === 2) this.drawScoreDiagram();
    else this.drawFearlessDiagram();
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
    const revealedX = 370 + revealedIndex * 120;
    this.addDiagramText(revealedX, 415, t('tutorial.reveal.order', { bonus: ORDER_BONUS[0] }), 14, COLORS.gold);
    this.addDiagramText(925, 470, 'P2', 16, COLORS.p2);
    this.addDiagramText(925, 585, 'P1', 16, COLORS.p1);
  }

  private drawScoreDiagram() {
    const boxes = [
      { x: 240, label: t('tutorial.score.matchup'), sub: t('tutorial.score.grid'), color: COLORS.p1 },
      { x: 490, label: t('tutorial.score.order'), sub: t('tutorial.score.both'), color: COLORS.gold },
      { x: 740, label: t('tutorial.score.synergy'), sub: `+${SYNERGY_TIER[SYNERGY_TIER.length - 1]}–${SYNERGY_TIER[0]}%`, color: COLORS.green },
    ];
    for (const box of boxes) {
      this.addDiagramPanel(box.x, 425, 200, 96, box.color);
      this.addDiagramText(box.x, 409, box.label, 18, box.color);
      this.addDiagramText(box.x, 443, box.sub, 15, COLORS.text);
    }
    this.addDiagramText(365, 425, '＋', 24, COLORS.text);
    this.addDiagramText(615, 425, '＋', 24, COLORS.text);
    this.addArrow(852, 425, 898, 425, COLORS.cyan);
    this.addDiagramPanel(985, 425, 150, 96, COLORS.title);
    this.addDiagramText(985, 425, t('tutorial.score.total'), 20, COLORS.title);

    this.addDiagramText(600, 525, t('tutorial.score.order'), 15, COLORS.muted);
    ORDER_BONUS.forEach((bonus, index) => {
      const x = 380 + index * 110;
      this.addDiagramPanel(x, 590, 96, 60, COLORS.gold);
      this.addDiagramText(x, 577, t('tutorial.score.orderNth', { number: index + 1 }), 13, COLORS.text);
      this.addDiagramText(x, 601, `+${bonus}%`, 18, COLORS.gold);
    });
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
    const card = this.add.rectangle(x, y, 82, 72, fill, 0.95)
      .setRounded(7).setStrokeStyle(2, border);
    this.diagramGroup.add(card);
    const cardText = disabled ? '✕' : state === 'faceDown' ? '??' : label;
    this.addDiagramText(x, y, cardText, disabled ? 22 : state === 'faceDown' ? 22 : 12,
      disabled ? '#c1c8d0' : state === 'faceDown' ? COLORS.muted : COLORS.text);
  }

  private addDiagramPanel(x: number, y: number, width: number, height: number, color: string | number) {
    const panel = this.add.rectangle(x, y, width, height, 0x10263a, 0.9)
      .setRounded(8).setStrokeStyle(2, typeof color === 'string' ? hexToInt(color) : color);
    this.diagramGroup.add(panel);
  }

  private addDiagramCircle(x: number, y: number, radius: number, color: number, label: string) {
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
    const text = this.add.text(x, y, value, {
      fontSize: `${size}px`, fontFamily: 'Arial', color, align: 'center',
    }).setOrigin(0.5);
    this.diagramGroup.add(text);
  }
}