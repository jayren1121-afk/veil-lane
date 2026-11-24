import Phaser from 'phaser';
import { getMusicManager } from '../audio/music';
import { MusicTrack, trackForScene } from '../audio/tracks';
import { addButton, COLORS } from './theme';

export function setupSceneMusic(scene: Phaser.Scene, track: MusicTrack = trackForScene(scene.scene.key)): void {
  const music = getMusicManager();
  music.setTrack(track);

  const button = addButton(scene, 1135, 776, 96, 34, 0x17334a).setDepth(2000);
  const label = scene.add.text(1135, 776, '', {
    fontSize: '13px', fontFamily: 'Arial', color: COLORS.text, fontStyle: 'bold',
  }).setOrigin(0.5).setDepth(2001);

  const updateLabel = () => label.setText(music.isMuted() ? '♫ OFF' : '♫ ON');
  updateLabel();
  button.on('pointerover', () => button.setFillStyle(0x24536a, 0.95));
  button.on('pointerout', () => button.setFillStyle(0x17334a, COLORS.panelAlpha));
  button.on('pointerdown', () => {
    music.toggleMuted();
    updateLabel();
  });
}