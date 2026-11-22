import Phaser from 'phaser';
import { BATTLE_TURN_SECONDS, isTurnWarning } from '../rules';
import { t } from '../i18n';
import { COLORS, hexToInt } from './theme';

const BAR_W = 196;
const WARNING_COLOR = '#ff4d4d';

/** Visible 20s countdown: big number + shrinking bar, red in the last 5 seconds. */
export class TurnTimerView {
  private readonly container: Phaser.GameObjects.Container;
  private readonly caption: Phaser.GameObjects.Text;
  private readonly number: Phaser.GameObjects.Text;
  private readonly fill: Phaser.GameObjects.Rectangle;
  private lastWarning = false;

  constructor(private readonly scene: Phaser.Scene, x: number, y: number) {
    this.container = scene.add.container(x, y).setDepth(80);
    const panel = scene.add.rectangle(0, 0, 220, 92, 0x091a2b, 0.9).setRounded(10)
      .setStrokeStyle(1, hexToInt(COLORS.cyan), 0.8);
    this.caption = scene.add.text(0, -30, t('timer.caption'), {
      fontSize: '12px', fontFamily: 'Arial', color: COLORS.muted, fontStyle: 'bold',
    }).setOrigin(0.5);
    this.number = scene.add.text(0, 2, '20', {
      fontSize: '34px', fontFamily: 'Arial', color: COLORS.gold, fontStyle: 'bold',
    }).setOrigin(0.5);
    const track = scene.add.rectangle(0, 34, BAR_W, 8, 0x26354c).setRounded(4);
    this.fill = scene.add.rectangle(-BAR_W / 2, 34, BAR_W, 8, hexToInt(COLORS.gold)).setOrigin(0, 0.5).setRounded(4);
    this.container.add([panel, this.caption, this.number, track, this.fill]);
    this.container.setVisible(false);
  }

  /** remainingMs is clamped to [0, 20s]. */
  update(remainingMs: number, caption?: string): void {
    const clamped = Math.max(0, Math.min(BATTLE_TURN_SECONDS * 1000, remainingMs));
    const seconds = Math.ceil(clamped / 1000);
    const warning = isTurnWarning(seconds);
    this.container.setVisible(true);
    if (caption !== undefined) this.caption.setText(caption);
    this.number.setText(t('timer.label', { seconds }));
    this.number.setColor(warning ? WARNING_COLOR : COLORS.gold);
    this.fill.width = BAR_W * (clamped / (BATTLE_TURN_SECONDS * 1000));
    this.fill.setFillStyle(hexToInt(warning ? WARNING_COLOR : COLORS.gold));
    if (warning && !this.lastWarning) {
      this.scene.tweens.add({ targets: this.number, scale: 1.25, duration: 160, yoyo: true });
    }
    this.lastWarning = warning;
  }

  hide(): void {
    this.container.setVisible(false);
    this.lastWarning = false;
  }
}
