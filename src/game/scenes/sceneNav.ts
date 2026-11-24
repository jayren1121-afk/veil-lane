/**
 * Going back: a top-left "← 返回 / BACK" button, Esc, and the browser back button all run the
 * same per-scene handler. Also the leave-match confirm dialog and the "opponent left" banner.
 */
import Phaser from 'phaser';
import { t } from '../i18n';
import { addPanel, COLORS, glowText } from './theme';
import { addTextButton, UiButton } from './uiButton';
import { hideOnlineBanner } from './onlineScene';

/** Emitted on `game.events` when the browser back button is pressed (see main.ts). */
export const BACK_EVENT = 'veil-back';
const DIALOG_DEPTH = 20000;

const openDialogs = new WeakMap<Phaser.Scene, () => void>();

/**
 * Wire Esc and the browser back button to `onBack` for this scene's lifetime. While a dialog
 * from `confirmDialog` is open, they close the dialog instead.
 */
export function bindBack(scene: Phaser.Scene, onBack: () => void): void {
  const handler = () => {
    if (!scene.sys.isActive()) return;
    const closeDialog = openDialogs.get(scene);
    if (closeDialog) closeDialog();
    else onBack();
  };
  scene.input.keyboard?.on('keydown-ESC', handler);
  scene.game.events.on(BACK_EVENT, handler);
  scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
    scene.input.keyboard?.off('keydown-ESC', handler);
    scene.game.events.off(BACK_EVENT, handler);
    openDialogs.delete(scene);
  });
}

/** Top-left back button plus Esc / browser back, all calling `onBack`. */
export function addBackButton(scene: Phaser.Scene, onBack: () => void, label = t('common.back')): UiButton {
  bindBack(scene, onBack);
  return addTextButton(scene, 70, 35, 112, 38, label, () => {
    if (!openDialogs.has(scene)) onBack();
  }, { fontSize: 15, depth: DIALOG_DEPTH - 10 });
}

/** Modal confirm dialog. Esc / browser back / the cancel button close it. */
export function confirmDialog(
  scene: Phaser.Scene,
  title: string,
  body: string,
  confirmLabel: string,
  cancelLabel: string,
  onConfirm: () => void,
): void {
  if (openDialogs.has(scene)) return;
  const { width, height } = scene.cameras.main;
  const objects: Phaser.GameObjects.GameObject[] = [];
  const shade = scene.add.rectangle(width / 2, height / 2, width, height, 0x050d18, 0.72)
    .setDepth(DIALOG_DEPTH).setInteractive();
  const panel = addPanel(scene, width / 2, height / 2, 460, 230, 0x0b2034).setDepth(DIALOG_DEPTH + 1);
  const titleText = scene.add.text(width / 2, height / 2 - 62, title, {
    fontSize: '28px', fontFamily: 'Arial', color: COLORS.title, fontStyle: 'bold',
  }).setOrigin(0.5).setDepth(DIALOG_DEPTH + 2);
  glowText(titleText);
  const bodyText = scene.add.text(width / 2, height / 2 - 18, body, {
    fontSize: '18px', fontFamily: 'Arial', color: COLORS.lose, fontStyle: 'bold',
  }).setOrigin(0.5).setDepth(DIALOG_DEPTH + 2);
  objects.push(shade, panel, titleText, bodyText);
  const close = () => {
    objects.forEach(object => object.destroy());
    openDialogs.delete(scene);
  };
  const confirm = addTextButton(scene, width / 2 - 100, height / 2 + 52, 170, 46, confirmLabel, () => {
    close();
    onConfirm();
  }, { fontSize: 17, fill: 0x5a1d24, depth: DIALOG_DEPTH + 3 });
  const cancel = addTextButton(scene, width / 2 + 100, height / 2 + 52, 170, 46, cancelLabel, close,
    { fontSize: 17, depth: DIALOG_DEPTH + 3 });
  objects.push(confirm.bg, confirm.label, cancel.bg, cancel.label);
  openDialogs.set(scene, close);
}

/** Banner for the player who stays when the opponent leaves mid-match: they win. */
export function showOpponentLeft(scene: Phaser.Scene, name: string, onDone: () => void): void {
  const { width, height } = scene.cameras.main;
  hideOnlineBanner(scene);
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    openDialogs.delete(scene);
    onDone();
  };
  // Esc / browser back dismiss it the same way as the button: to the menu.
  openDialogs.set(scene, finish);
  scene.add.rectangle(width / 2, height / 2, width, height, 0x050d18, 0.78).setDepth(DIALOG_DEPTH).setInteractive();
  addPanel(scene, width / 2, height / 2, 520, 250, 0x0b2034).setDepth(DIALOG_DEPTH + 1);
  scene.add.text(width / 2, height / 2 - 66, t('leave.opponentLeft', { name }), {
    fontSize: '22px', fontFamily: 'Arial', color: COLORS.text, fontStyle: 'bold', align: 'center', wordWrap: { width: 480 },
  }).setOrigin(0.5).setDepth(DIALOG_DEPTH + 2);
  const win = scene.add.text(width / 2, height / 2 - 10, t('leave.youWin'), {
    fontSize: '40px', fontFamily: 'Arial', color: COLORS.win, fontStyle: 'bold',
  }).setOrigin(0.5).setDepth(DIALOG_DEPTH + 2);
  glowText(win, COLORS.win, 16);
  addTextButton(scene, width / 2, height / 2 + 72, 220, 48, t('leave.toMenu'), finish,
    { fontSize: 18, depth: DIALOG_DEPTH + 3 });
}

/** Keep the browser back button inside the app: it fires BACK_EVENT instead of leaving the page. */
export function guardBrowserBack(game: Phaser.Game): void {
  if (typeof window === 'undefined' || !window.history?.pushState) return;
  const push = () => window.history.pushState({ veilLane: true }, '');
  push();
  // Chrome ignores history entries added without a user gesture, so add one on the first tap too.
  window.addEventListener('pointerdown', push, { once: true, capture: true });
  window.addEventListener('popstate', () => {
    push();
    game.events.emit(BACK_EVENT);
  });
}
