import Phaser from 'phaser';

export const COLORS = {
  background: 0x0a1a2e,
  panel: 0x10263a,
  panelRaised: 0x17334a,
  border: '#3e9db3',
  cyan: '#56bfd2',
  title: '#f2c76e',
  text: '#e6eef7',
  muted: '#9fb3c8',
  gold: '#f2c76e',
  p1: '#79b8ff',
  p2: '#ff8b87',
  green: '#55d98b',
  win: '#55d98b',
  lose: '#ff6b72',
  panelAlpha: 0.75,
} as const;

export const LANE_COLORS: Record<string, string> = {
  Top: '#f28b45',
  Jungle: '#55c878',
  Mid: '#b28cff',
  Bot: '#f2c76e',
  Support: '#55c7d7',
};

const BACKGROUND_TEXTURE = 'veil-lane-gradient-background';
const GLOW_TEXTURE = 'veil-lane-soft-glow';

export function hexToInt(hex: string): number {
  return parseInt(hex.replace('#', ''), 16);
}

export function laneColor(lane: string): string {
  return LANE_COLORS[lane] ?? COLORS.cyan;
}

export function drawBackground(scene: Phaser.Scene): Phaser.GameObjects.GameObject[] {
  const { width, height } = scene.cameras.main;
  if (!scene.textures.exists(BACKGROUND_TEXTURE)) {
    const texture = scene.textures.createCanvas(BACKGROUND_TEXTURE, width, height);
    if (texture) {
      const context = texture.getContext();
      const gradient = context.createLinearGradient(0, 0, 0, height);
      gradient.addColorStop(0, '#0f2a44');
      gradient.addColorStop(1, '#0a1a2e');
      context.fillStyle = gradient;
      context.fillRect(0, 0, width, height);
      texture.refresh();
    }
  }
  if (!scene.textures.exists(GLOW_TEXTURE)) {
    const texture = scene.textures.createCanvas(GLOW_TEXTURE, 256, 256);
    if (texture) {
      const context = texture.getContext();
      const gradient = context.createRadialGradient(128, 128, 0, 128, 128, 128);
      gradient.addColorStop(0, 'rgba(86, 191, 210, 0.28)');
      gradient.addColorStop(1, 'rgba(86, 191, 210, 0)');
      context.fillStyle = gradient;
      context.fillRect(0, 0, 256, 256);
      texture.refresh();
    }
  }

  const objects: Phaser.GameObjects.GameObject[] = [];
  if (scene.textures.exists(BACKGROUND_TEXTURE)) {
    objects.push(scene.add.image(width / 2, height / 2, BACKGROUND_TEXTURE)
      .setDisplaySize(width, height).setDepth(-1000));
  } else {
    objects.push(scene.add.rectangle(width / 2, height / 2, width, height, COLORS.background).setDepth(-1000));
  }

  for (const [index, position] of [[0, 0.2], [1, 0.52], [2, 0.82]] as const) {
    if (!scene.textures.exists(GLOW_TEXTURE)) break;
    const glow = scene.add.image(width * position, height * (index === 1 ? 0.72 : 0.26), GLOW_TEXTURE)
      .setDisplaySize(430, 430).setAlpha(0.35).setBlendMode(Phaser.BlendModes.ADD).setDepth(-990);
    scene.tweens.add({
      targets: glow,
      alpha: { from: 0.22, to: 0.42 },
      scale: { from: 0.92, to: 1.08 },
      duration: 5200 + index * 700,
      ease: 'Sine.InOut',
      yoyo: true,
      repeat: -1,
    });
    objects.push(glow);
  }

  for (let i = 0; i < 36; i++) {
    const x = Phaser.Math.Between(10, width - 10);
    const y = Phaser.Math.Between(0, height);
    const particle = scene.add.circle(x, y, Phaser.Math.FloatBetween(0.7, 1.8), 0x9be8f0, 0.22)
      .setDepth(-980);
    scene.tweens.add({
      targets: particle,
      y: -12,
      alpha: { from: 0.08, to: 0.28 },
      duration: Phaser.Math.Between(13000, 24000),
      repeat: -1,
      onRepeat: () => {
        particle.y = height + Phaser.Math.Between(0, 100);
        particle.x = Phaser.Math.Between(10, width - 10);
      },
    });
    objects.push(particle);
  }
  return objects;
}

export function addPanel(
  scene: Phaser.Scene,
  x: number,
  y: number,
  width: number,
  height: number,
  fill: number | string = COLORS.panel,
): Phaser.GameObjects.Rectangle {
  return scene.add.rectangle(x, y, width, height, typeof fill === 'string' ? hexToInt(fill) : fill, COLORS.panelAlpha)
    .setRounded(8)
    .setStrokeStyle(1, hexToInt(COLORS.cyan), 0.8);
}

export function addButton(
  scene: Phaser.Scene,
  x: number,
  y: number,
  width: number,
  height: number,
  fill: number | string = COLORS.panelRaised,
): Phaser.GameObjects.Rectangle {
  return addPanel(scene, x, y, width, height, fill).setInteractive({ useHandCursor: true });
}

export function addCardGlow(
  scene: Phaser.Scene,
  x: number,
  y: number,
  width: number,
  height: number,
  color: string,
): Phaser.GameObjects.Rectangle[] {
  const tint = hexToInt(color);
  return [
    scene.add.rectangle(x, y, width + 8, height + 8, 0x000000, 0)
      .setStrokeStyle(6, tint, 0.1).setRounded(7),
    scene.add.rectangle(x, y, width + 4, height + 4, 0x000000, 0)
      .setStrokeStyle(3, tint, 0.28).setRounded(6),
  ];
}

export function addArtBrighten(
  scene: Phaser.Scene,
  x: number,
  y: number,
  width: number,
  height: number,
): Phaser.GameObjects.Rectangle {
  return scene.add.rectangle(x, y, width, height, 0xffffff, 0.08);
}

export function glowText(
  text: Phaser.GameObjects.Text,
  color: string = COLORS.gold,
  blur = 12,
): Phaser.GameObjects.Text {
  return text.setShadow(0, 0, color, blur, true, true);
}

export function countUp(
  scene: Phaser.Scene,
  text: Phaser.GameObjects.Text,
  to: number,
  format: (value: number) => string,
  duration = 500,
): void {
  const start = scene.time.now;
  const from = 0;
  let event: Phaser.Time.TimerEvent;
  event = scene.time.addEvent({
    delay: 16,
    repeat: Math.ceil(duration / 16),
    callback: () => {
      const progress = Phaser.Math.Clamp((scene.time.now - start) / duration, 0, 1);
      const eased = 1 - (1 - progress) ** 3;
      text.setText(format(from + (to - from) * eased));
      if (progress >= 1) event.remove();
    },
  });
}

export function drawHeader(scene: Phaser.Scene, title: string): void {
  scene.add.rectangle(600, 35, 1200, 70, 0x0b2034, 0.78).setDepth(0);
  scene.add.rectangle(600, 71, 1200, 2, hexToInt(COLORS.cyan), 0.65).setDepth(1);
  scene.add.text(30, 35, title, {
    fontSize: '22px',
    fontFamily: 'Arial',
    color: COLORS.title,
    fontStyle: 'bold',
  }).setOrigin(0, 0.5).setDepth(2);
}