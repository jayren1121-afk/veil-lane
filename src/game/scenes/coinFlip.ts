import Phaser from 'phaser';
import { t } from '../i18n';
import { Player } from '../rules';
import { COLORS, glowText } from './theme';

export function playCoinFlip(scene: Phaser.Scene, winner: Player, onComplete: () => void, winnerLabel: string = winner): void {
  const { width, height } = scene.cameras.main;
  const overlay = scene.add.container(0, 0).setDepth(10000);
  const shade = scene.add.rectangle(width / 2, height / 2, width, height, 0x0a1a2e, 0.94)
    .setInteractive();
  const title = scene.add.text(width / 2, 112, t('coin.title'), {
    fontSize: '30px', fontFamily: 'Arial', color: COLORS.title, fontStyle: 'bold',
  }).setOrigin(0.5);
  glowText(title);
  const hint = scene.add.text(width / 2, 158, t('coin.hint'), {
    fontSize: '16px', fontFamily: 'Arial', color: COLORS.muted,
  }).setOrigin(0.5);
  const shadow = scene.add.ellipse(width / 2, height / 2 + 84, 110, 14, 0x24324a, 0.4);
  const coin = scene.add.container(width / 2, -80);
  const face = scene.add.circle(0, 0, 66, 0xd79c2c).setStrokeStyle(7, 0xffe38a);
  const inner = scene.add.circle(0, 0, 54, 0xf2c65d).setStrokeStyle(2, 0xffedb5);
  const faceText = scene.add.text(0, 0, '', {
    fontSize: '28px', fontFamily: 'Arial', color: '#4b3210', fontStyle: 'bold',
  }).setOrigin(0.5);
  coin.add([face, inner, faceText]);
  overlay.add([shade, title, hint, shadow, coin]);

  const start = scene.time.now;
  const duration = 2600;
  const spinCount = 8;
  let completed = false;
  const finalAngle = winner === Player.P1 ? 0 : Math.PI;
  const update = () => {
    if (completed) return;
    const progress = Math.min((scene.time.now - start) / duration, 1);
    const fallProgress = Phaser.Math.Easing.Bounce.Out(progress);
    coin.y = Phaser.Math.Linear(-80, height / 2, fallProgress);
    shadow.setAlpha(0.1 + 0.5 * fallProgress);
    shadow.setScale(0.3 + 0.7 * fallProgress, 1);

    const angle = progress * (Math.PI * 2 * spinCount + finalAngle);
    const widthScale = Math.max(0.12, Math.abs(Math.cos(angle)));
    coin.setScale(widthScale, 1);
    faceText.setText(Math.cos(angle) >= 0 ? 'P1' : 'P2');
    coin.setRotation(Math.sin(angle) * 0.08);

    if (progress === 1) {
      completed = true;
      scene.events.off('update', update);
      faceText.setText(winner);
      coin.setScale(1, 1);
      coin.setRotation(0);
      const result = scene.add.text(width / 2, height / 2 + 128, t('coin.winner', { player: winnerLabel }), {
        fontSize: '32px', fontFamily: 'Arial', color: COLORS.gold, fontStyle: 'bold',
      }).setOrigin(0.5);
      glowText(result);
      overlay.add(result);
      scene.time.delayedCall(1500, () => {
        overlay.destroy();
        onComplete();
      });
    }
  };

  scene.events.on('update', update);
  scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => scene.events.off('update', update));
}