import Phaser from 'phaser';
import { Card, Lane } from '../rules';
import { CARD_BACK_KEY } from '../data/art';
import { addArtBrighten, addCardGlow, COLORS, hexToInt, laneColor } from './theme';

export interface CardView {
  container: Phaser.GameObjects.Container;
  border: Phaser.GameObjects.Rectangle;
}

export function createCardFace(
  scene: Phaser.Scene,
  card: Card,
  lane: Lane,
  width: number,
  height: number,
  options: { showLane?: boolean; nameFontSize?: string } = {},
): CardView {
  const nameHeight = Math.max(22, Math.min(34, height * 0.19));
  const artHeight = height - nameHeight - 4;
  const container = scene.add.container(0, 0);
  container.add(addCardGlow(scene, 0, 0, width, height, laneColor(lane)));
  container.add(scene.add.rectangle(0, 0, width, height, hexToInt(card.color), 0.96)
    .setRounded(7));

  if (scene.textures.exists(card.id)) {
    const art = scene.add.image(0, -nameHeight / 2, card.id)
      .setDisplaySize(width - 6, artHeight);
    container.add(art);
    container.add(addArtBrighten(scene, 0, -nameHeight / 2, width - 6, artHeight));
  }

  container.add(scene.add.rectangle(0, height / 2 - nameHeight / 2, width - 4, nameHeight,
    0x091725, 0.92).setRounded(5));
  container.add(scene.add.text(0, height / 2 - nameHeight / 2, card.name, {
    fontSize: options.nameFontSize ?? (width < 90 ? '9px' : '11px'),
    fontFamily: 'Arial',
    color: COLORS.text,
    fontStyle: 'bold',
    align: 'center',
    wordWrap: { width: width - 10, useAdvancedWrap: true },
  }).setOrigin(0.5));

  if (options.showLane !== false) {
    const badgeWidth = Math.min(width - 12, Math.max(42, lane.length * 8 + 14));
    container.add(scene.add.rectangle(-width / 2 + badgeWidth / 2 + 5, -height / 2 + 12,
      badgeWidth, 20, 0x091725, 0.86).setRounded(5)
      .setStrokeStyle(1, hexToInt(laneColor(lane)), 0.9));
    container.add(scene.add.text(-width / 2 + badgeWidth / 2 + 5, -height / 2 + 12, lane, {
      fontSize: width < 90 ? '8px' : '10px',
      fontFamily: 'Arial',
      color: laneColor(lane),
      fontStyle: 'bold',
    }).setOrigin(0.5));
  }

  const border = scene.add.rectangle(0, 0, width, height, 0x000000, 0)
    .setRounded(7)
    .setStrokeStyle(2, hexToInt(laneColor(lane)), 0.95);
  container.add(border);
  return { container, border };
}

export function createCardBack(
  scene: Phaser.Scene,
  lane: Lane,
  width: number,
  height: number,
): CardView {
  const container = scene.add.container(0, 0);
  container.add(addCardGlow(scene, 0, 0, width, height, laneColor(lane)));
  if (scene.textures.exists(CARD_BACK_KEY)) {
    container.add(scene.add.image(0, 0, CARD_BACK_KEY).setDisplaySize(width, height));
  } else {
    container.add(scene.add.rectangle(0, 0, width, height, 0x132d45, 1).setRounded(7));
  }

  const border = scene.add.rectangle(0, 0, width, height, 0x000000, 0)
    .setRounded(7)
    .setStrokeStyle(2, hexToInt(laneColor(lane)), 0.95);
  container.add(border);
  return { container, border };
}