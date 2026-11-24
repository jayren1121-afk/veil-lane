import Phaser from 'phaser';
import { cardArtPath } from '../data/art';
import {
  cardLaneStats, GALLERY_COLS, GALLERY_FILTERS, GalleryFilter, galleryCards,
  galleryPage, galleryPageCount,
} from '../data/gallery';
import { Card, Lane } from '../rules/types';
import { t } from '../i18n';
import type { StringKey } from '../i18n/strings';
import { playCardSfx, preloadCardSfx } from '../audio/sfx';
import { measureTextWidth, wrapLines } from '../ui/wrapText';
import { createCardFace } from './cardView';
import { setupSceneMusic } from './musicToggle';
import { addBackButton } from './sceneNav';
import { addButton, addPanel, COLORS, drawBackground, drawHeader, laneColor } from './theme';

/** Framed panel: x 30–1170, y 96–740. */
const PANEL = { x: 600, y: 418, width: 1140, height: 644 };
const TAB_Y = 134;
const TAB_W = 150;
const TAB_H = 40;
const TAB_STEP = 162;
const CARD_W = 104;
const CARD_H = 140;
const COL_STEP = 128;
const ROW_STEP = 162;
const GRID_TOP = 252;
const PAGER_Y = 700;
const FONT = 'Arial';
const MODAL_DEPTH = 1000;

function laneLabel(lane: Lane): string {
  return t(`lane.${lane.toLowerCase()}` as StringKey);
}

function filterLabel(filter: GalleryFilter): string {
  return filter === 'all' ? t('gallery.all') : laneLabel(filter);
}

/** Wrap and, if still too wide (one long word), shrink until it fits. */
function fitText(
  scene: Phaser.Scene, x: number, y: number, value: string, maxWidth: number,
  style: { size: number; color: string; bold?: boolean; align?: 'left' | 'center'; minSize?: number },
): Phaser.GameObjects.Text {
  let size = style.size;
  const minSize = style.minSize ?? Math.min(size, 11);
  let lines: string[] = [];
  for (; size >= minSize; size--) {
    const font = `${style.bold ? 'bold ' : ''}${size}px ${FONT}`;
    lines = wrapLines(value, maxWidth, line => measureTextWidth(line, font));
    if (lines.every(line => measureTextWidth(line, font) <= maxWidth)) break;
  }
  return scene.add.text(x, y, lines, {
    fontSize: `${Math.max(size, minSize)}px`, fontFamily: FONT, color: style.color,
    fontStyle: style.bold ? 'bold' : 'normal', align: style.align ?? 'center', lineSpacing: 4,
  });
}

export class GalleryScene extends Phaser.Scene {
  constructor() {
    super({ key: 'GalleryScene' });
  }

  private filter: GalleryFilter = 'all';
  private page = 0;
  private gridObjects: Phaser.GameObjects.GameObject[] = [];
  private tabs: { filter: GalleryFilter; bg: Phaser.GameObjects.Rectangle }[] = [];
  private pageInfo!: Phaser.GameObjects.Text;
  private modal: Phaser.GameObjects.Container | null = null;
  private renderToken = 0;

  preload() {
    // Card art is loaded lazily, one page at a time (see ensureArt).
    preloadCardSfx(this);
  }

  create() {
    this.filter = 'all';
    this.page = 0;
    this.gridObjects = [];
    this.tabs = [];
    this.modal = null;
    setupSceneMusic(this);
    drawBackground(this);
    drawHeader(this, t('gallery.title'), 150);
    // addBackButton also wires Esc and the browser back button to this handler.
    const back = () => {
      if (this.modal) this.closeModal();
      else this.scene.start('MenuScene');
    };
    addBackButton(this, back);
    addPanel(this, PANEL.x, PANEL.y, PANEL.width, PANEL.height, 0x0b2034).setDepth(-1);

    GALLERY_FILTERS.forEach((filter, index) => {
      const x = PANEL.x + (index - (GALLERY_FILTERS.length - 1) / 2) * TAB_STEP;
      const bg = addButton(this, x, TAB_Y, TAB_W, TAB_H, 0x17334a);
      const color = filter === 'all' ? COLORS.title : laneColor(filter);
      fitText(this, x, TAB_Y, filterLabel(filter), TAB_W - 16, { size: 17, color, bold: true }).setOrigin(0.5);
      bg.on('pointerdown', () => this.setFilter(filter));
      this.tabs.push({ filter, bg });
    });

    const previous = addButton(this, 420, PAGER_Y, 132, 40, 0x17334a);
    const next = addButton(this, 780, PAGER_Y, 132, 40, 0x17334a);
    fitText(this, 420, PAGER_Y, t('tutorial.previous'), 120, { size: 16, color: COLORS.text }).setOrigin(0.5);
    fitText(this, 780, PAGER_Y, t('tutorial.next'), 120, { size: 16, color: COLORS.text }).setOrigin(0.5);
    previous.on('pointerdown', () => this.changePage(-1));
    next.on('pointerdown', () => this.changePage(1));
    this.pageInfo = this.add.text(600, PAGER_Y, '', {
      fontSize: '16px', fontFamily: FONT, color: COLORS.muted,
    }).setOrigin(0.5);
    fitText(this, 1000, PAGER_Y, t('gallery.hint'), 260, { size: 14, color: COLORS.muted }).setOrigin(0.5);

    const onLeft = () => !this.modal && this.changePage(-1);
    const onRight = () => !this.modal && this.changePage(1);
    this.input.keyboard?.on('keydown-LEFT', onLeft);
    this.input.keyboard?.on('keydown-RIGHT', onRight);
    this.input.on('wheel', (_p: unknown, _o: unknown, _dx: number, dy: number) => {
      if (!this.modal && Math.abs(dy) > 0) this.changePage(dy > 0 ? 1 : -1);
    });
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.input.keyboard?.off('keydown-LEFT', onLeft);
      this.input.keyboard?.off('keydown-RIGHT', onRight);
      this.input.off('wheel');
    });
    this.renderGrid();
  }

  private setFilter(filter: GalleryFilter) {
    if (this.modal) return;
    this.filter = filter;
    this.page = 0;
    this.renderGrid();
  }

  private changePage(direction: number) {
    const total = galleryPageCount(galleryCards(this.filter).length);
    const page = Phaser.Math.Clamp(this.page + direction, 0, total - 1);
    if (page === this.page) return;
    this.page = page;
    this.renderGrid();
  }

  private renderGrid() {
    const token = ++this.renderToken;
    for (const object of this.gridObjects) object.destroy();
    this.gridObjects = [];
    const cards = galleryCards(this.filter);
    const total = galleryPageCount(cards.length);
    const pageCards = galleryPage(cards, this.page);
    this.pageInfo.setText(t('gallery.pageInfo', { page: this.page + 1, total, count: cards.length }));
    for (const tab of this.tabs) {
      const active = tab.filter === this.filter;
      tab.bg.setFillStyle(active ? 0x31536a : 0x17334a, 0.95)
        .setStrokeStyle(active ? 2 : 1, active ? 0xf2c76e : 0x56bfd2, 1);
    }

    const missing = pageCards.filter(card => !this.textures.exists(card.id));
    if (missing.length > 0) {
      for (const card of missing) this.load.image(card.id, cardArtPath(card.id));
      this.load.once(Phaser.Loader.Events.COMPLETE, () => {
        if (token === this.renderToken && this.scene.isActive()) this.renderGrid();
      });
      this.load.start();
    }

    pageCards.forEach((card, index) => {
      const col = index % GALLERY_COLS;
      const row = Math.floor(index / GALLERY_COLS);
      const x = PANEL.x + (col - (GALLERY_COLS - 1) / 2) * COL_STEP;
      const y = GRID_TOP + row * ROW_STEP;
      const lane = this.filter === 'all' ? card.lanes[0] : this.filter;
      const view = createCardFace(this, card, lane, CARD_W, CARD_H, { nameFontSize: '11px' });
      view.container.setPosition(x, y);
      const hit = this.add.rectangle(x, y, CARD_W, CARD_H, 0x000000, 0.001)
        .setInteractive({ useHandCursor: true });
      hit.on('pointerover', () => !this.modal && view.container.setScale(1.06));
      hit.on('pointerout', () => view.container.setScale(1));
      hit.on('pointerdown', () => {
        if (this.modal) return;
        playCardSfx(this);
        this.openModal(card);
      });
      this.gridObjects.push(view.container, hit);
    });
  }

  private openModal(card: Card) {
    this.closeModal();
    const modal = this.add.container(0, 0).setDepth(MODAL_DEPTH);
    const dim = this.add.rectangle(600, 400, 1200, 800, 0x02070d, 0.78).setInteractive();
    dim.on('pointerdown', () => this.closeModal());
    const box = { x: 600, y: 414, width: 860, height: 540 };
    const panel = addPanel(this, box.x, box.y, box.width, box.height, 0x0b2034).setInteractive();
    modal.add([dim, panel]);

    const left = box.x - box.width / 2;
    const top = box.y - box.height / 2;
    const stats = cardLaneStats(card);
    const lane = this.filter === 'all' ? stats[0]?.lane ?? card.lanes[0] : this.filter;
    const face = createCardFace(this, card, lane, 280, 384, { nameFontSize: '20px' });
    face.container.setPosition(left + 40 + 140, box.y);
    modal.add(face.container);

    const textLeft = left + 360;
    const textWidth = box.width - 360 - 40;
    let y = top + 44;
    const name = fitText(this, textLeft, y, card.name, textWidth, { size: 32, color: COLORS.title, bold: true, align: 'left', minSize: 18 });
    modal.add(name);
    y += name.height + 12;
    const role = fitText(this, textLeft, y, t('gallery.role', { role: t(`role.${card.role}` as StringKey) }), textWidth, { size: 18, color: COLORS.text, align: 'left' });
    modal.add(role);
    y += role.height + 26;
    const header = fitText(this, textLeft, y, t('gallery.lanes'), textWidth, { size: 16, color: COLORS.muted, align: 'left' });
    modal.add(header);
    y += header.height + 14;
    for (const stat of stats) {
      const chip = addPanel(this, textLeft + 60, y + 15, 120, 32, 0x10263a)
        .setStrokeStyle(2, Phaser.Display.Color.HexStringToColor(laneColor(stat.lane)).color, 1);
      const label = fitText(this, textLeft + 60, y + 15, laneLabel(stat.lane), 108, { size: 16, color: laneColor(stat.lane), bold: true }).setOrigin(0.5);
      const rate = fitText(this, textLeft + 136, y + 15, t('gallery.laneRow', {
        rate: (stat.winRate * 100).toFixed(1), games: stat.games,
      }), textWidth - 136, { size: 18, color: COLORS.text, align: 'left' }).setOrigin(0, 0.5);
      modal.add([chip, label, rate]);
      y += 44;
    }
    const hint = fitText(this, box.x, top + box.height - 30, t('gallery.closeHint'), box.width - 80, { size: 14, color: COLORS.muted }).setOrigin(0.5);
    const close = addButton(this, left + box.width - 30, top + 30, 40, 40, 0x17334a);
    const closeLabel = this.add.text(close.x, close.y, '×', {
      fontSize: '26px', fontFamily: FONT, color: COLORS.text, fontStyle: 'bold',
    }).setOrigin(0.5);
    close.on('pointerdown', () => this.closeModal());
    modal.add([hint, close, closeLabel]);
    modal.setAlpha(0);
    this.tweens.add({ targets: modal, alpha: 1, duration: 140 });
    this.modal = modal;
  }

  private closeModal() {
    if (!this.modal) return;
    this.modal.destroy(true);
    this.modal = null;
  }
}
