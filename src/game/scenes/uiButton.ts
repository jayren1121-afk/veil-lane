import Phaser from 'phaser';
import { addButton, COLORS } from './theme';

export interface UiButton {
  bg: Phaser.GameObjects.Rectangle;
  label: Phaser.GameObjects.Text;
  setText(text: string): UiButton;
  setEnabled(enabled: boolean): UiButton;
  setVisible(visible: boolean): UiButton;
}

export function addTextButton(
  scene: Phaser.Scene,
  x: number,
  y: number,
  width: number,
  height: number,
  text: string,
  onClick: () => void,
  options: { fontSize?: number; fill?: number; color?: string; depth?: number } = {},
): UiButton {
  const fill = options.fill ?? 0x17334a;
  const depth = options.depth ?? 10;
  const bg = addButton(scene, x, y, width, height, fill).setDepth(depth);
  const label = scene.add.text(x, y, text, {
    fontSize: `${options.fontSize ?? 18}px`, fontFamily: 'Arial', color: options.color ?? COLORS.title, fontStyle: 'bold',
  }).setOrigin(0.5).setDepth(depth + 1);
  let enabled = true;
  bg.on('pointerover', () => enabled && bg.setFillStyle(0x24536a, 0.96));
  bg.on('pointerout', () => bg.setFillStyle(fill, COLORS.panelAlpha));
  bg.on('pointerdown', () => enabled && onClick());
  const button: UiButton = {
    bg,
    label,
    setText(value) { label.setText(value); return button; },
    setEnabled(value) {
      enabled = value;
      bg.setAlpha(value ? 1 : 0.45);
      label.setAlpha(value ? 1 : 0.55);
      return button;
    },
    setVisible(value) { bg.setVisible(value); label.setVisible(value); return button; },
  };
  return button;
}
