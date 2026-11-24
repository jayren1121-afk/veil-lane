import Phaser from 'phaser';
import { MUSIC_CREDIT } from '../audio/tracks';
import { COVER_BG_KEY, coverBgPath } from '../data/art';
import { getLanguage, setLanguage, t } from '../i18n';
import { setupSceneMusic } from './musicToggle';
import { getAccount, getGuestName, hasIdentity, refreshAccount } from '../../net/identity';
import { leaveOnline, peekInviteCode } from '../../net/onlineClient';
import { addButton, COLORS, glowText } from './theme';

const COVER_OVERLAY_KEY = 'veil-lane-cover-overlay';
const COVER_FOG_KEY = 'veil-lane-cover-fog';

export class MenuScene extends Phaser.Scene {
  constructor() {
    super({ key: 'MenuScene' });
  }

  preload() {
    this.load.image(COVER_BG_KEY, coverBgPath());
  }

  create() {
    const { width, height } = this.cameras.main;
    const cover = this.add.image(width / 2, height / 2, COVER_BG_KEY);
    const source = this.textures.get(COVER_BG_KEY).getSourceImage() as HTMLImageElement;
    const coverScale = Math.max(width / source.width, height / source.height);
    cover.setDisplaySize(source.width * coverScale, source.height * coverScale);

    this.createCoverOverlay(width, height);
    this.createFog(width, height);

    const title = this.add.text(width / 2, height * 0.3, 'VEIL LANE', {
      fontSize: '76px',
      fontFamily: 'Arial',
      color: '#f2c76e',
      fontStyle: 'bold',
    }).setOrigin(0.5).setPadding(40, 40, 40, 40);
    glowText(title, '#f2c76e', 24);

    const tagline = this.add.text(width / 2, height * 0.39, t('menu.tagline'), {
      fontSize: '24px',
      fontFamily: 'Arial',
      color: '#e6eef7',
    }).setOrigin(0.5);

    const startY = height * 0.6;
    const startButton = addButton(this, width / 2, startY, 300, 60, 0x17334a);
    const startLabel = this.add.text(width / 2, startY, t('menu.online'), {
      fontSize: '24px',
      fontFamily: 'Arial',
      color: COLORS.title,
      fontStyle: 'bold',
    }).setOrigin(0.5);

    const localY = startY + 76;
    const localButton = addButton(this, width / 2, localY, 300, 54, 0x17334a);
    const localLabel = this.add.text(width / 2, localY, t('menu.local'), {
      fontSize: '20px',
      fontFamily: 'Arial',
      color: COLORS.text,
      fontStyle: 'bold',
    }).setOrigin(0.5);

    const howToY = localY + 70;
    const howToButton = addButton(this, width / 2, howToY, 300, 54, 0x17334a);
    const howToLabel = this.add.text(width / 2, howToY, t('menu.howToPlay'), {
      fontSize: '20px',
      fontFamily: 'Arial',
      color: COLORS.text,
      fontStyle: 'bold',
    }).setOrigin(0.5);

    // Account chip (top-left): Google account record, guest name, or sign-in prompt.
    const accountButton = addButton(this, 170, 36, 300, 38, 0x17334a).setDepth(20);
    const accountLabel = this.add.text(170, 36, '', {
      fontSize: '14px', fontFamily: 'Arial', color: COLORS.text, fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(21);
    const updateAccount = () => {
      const account = getAccount();
      const guest = getGuestName();
      accountLabel.setText(account
        ? `👤 ${t('menu.signedInAs', { name: account.nickname, wins: account.wins, losses: account.losses })}`
        : guest ? `👤 ${t('menu.guestAs', { name: guest })}` : `👤 ${t('menu.notSignedIn')}`);
    };
    updateAccount();
    void refreshAccount().then(() => this.scene.isActive() && updateAccount());
    this.styleButton(accountButton, () => this.scene.start('LoginScene'));

    this.add.text(width / 2, height - 22, MUSIC_CREDIT, {
      fontSize: '12px',
      fontFamily: 'Arial',
      color: COLORS.muted,
    }).setOrigin(0.5);

    this.styleButton(startButton, () => this.scene.start(hasIdentity() ? 'LobbyScene' : 'LoginScene'));
    this.styleButton(localButton, () => {
      leaveOnline();
      this.scene.start('GameScene', {});
    });
    this.styleButton(howToButton, () => this.scene.start('HowToPlayScene'));

    const zhButton = addButton(this, width - 150, 36, 68, 34, 0x17334a).setDepth(20);
    const enButton = addButton(this, width - 72, 36, 58, 34, 0x17334a).setDepth(20);
    this.add.text(zhButton.x, zhButton.y, '中文', {
      fontSize: '14px', fontFamily: 'Arial', color: COLORS.text, fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(21);
    this.add.text(enButton.x, enButton.y, 'EN', {
      fontSize: '14px', fontFamily: 'Arial', color: COLORS.text, fontStyle: 'bold',
    }).setOrigin(0.5).setDepth(21);
    const updateLanguage = () => {
      const language = getLanguage();
      tagline.setText(t('menu.tagline'));
      startLabel.setText(t('menu.online'));
      localLabel.setText(t('menu.local'));
      updateAccount();
      howToLabel.setText(t('menu.howToPlay'));
      zhButton.setFillStyle(language === 'zh' ? 0x31536a : 0x17334a, 0.95)
        .setStrokeStyle(language === 'zh' ? 2 : 1, language === 'zh' ? 0xf2c76e : 0x56bfd2, 1);
      enButton.setFillStyle(language === 'en' ? 0x31536a : 0x17334a, 0.95)
        .setStrokeStyle(language === 'en' ? 2 : 1, language === 'en' ? 0xf2c76e : 0x56bfd2, 1);
    };
    zhButton.on('pointerdown', () => {
      setLanguage('zh');
      updateLanguage();
    });
    enButton.on('pointerdown', () => {
      setLanguage('en');
      updateLanguage();
    });
    updateLanguage();
    setupSceneMusic(this);

    // Invite link (?room=XXXX): go straight to the lobby, or sign-in first.
    if (peekInviteCode()) this.scene.start(hasIdentity() ? 'LobbyScene' : 'LoginScene');
  }

  private createCoverOverlay(width: number, height: number) {
    if (!this.textures.exists(COVER_OVERLAY_KEY)) {
      const texture = this.textures.createCanvas(COVER_OVERLAY_KEY, width, height);
      if (texture) {
        const context = texture.getContext();
        const gradient = context.createLinearGradient(0, height, 0, 0);
        gradient.addColorStop(0, 'rgba(5, 16, 30, 0.94)');
        gradient.addColorStop(0.45, 'rgba(5, 18, 33, 0.48)');
        gradient.addColorStop(1, 'rgba(5, 18, 33, 0.12)');
        context.fillStyle = gradient;
        context.fillRect(0, 0, width, height);
        texture.refresh();
      }
    }
    if (this.textures.exists(COVER_OVERLAY_KEY)) {
      this.add.image(width / 2, height / 2, COVER_OVERLAY_KEY).setDisplaySize(width, height);
    }
  }

  private createFog(width: number, height: number) {
    if (!this.textures.exists(COVER_FOG_KEY)) {
      const texture = this.textures.createCanvas(COVER_FOG_KEY, 900, 260);
      if (texture) {
        const context = texture.getContext();
        const clouds = [
          [170, 150, 200], [340, 110, 230], [520, 160, 210], [710, 105, 240],
          [260, 210, 170], [610, 215, 180],
        ];
        for (const [x, y, radius] of clouds) {
          const gradient = context.createRadialGradient(x, y, 0, x, y, radius);
          gradient.addColorStop(0, 'rgba(185, 218, 234, 0.14)');
          gradient.addColorStop(1, 'rgba(115, 171, 194, 0)');
          context.fillStyle = gradient;
          context.fillRect(0, 0, 900, 260);
        }
        context.globalCompositeOperation = 'destination-in';
        const verticalFade = context.createLinearGradient(0, 0, 0, 260);
        verticalFade.addColorStop(0, 'rgba(255, 255, 255, 0)');
        verticalFade.addColorStop(0.25, 'rgba(255, 255, 255, 1)');
        verticalFade.addColorStop(0.75, 'rgba(255, 255, 255, 1)');
        verticalFade.addColorStop(1, 'rgba(255, 255, 255, 0)');
        context.fillStyle = verticalFade;
        context.fillRect(0, 0, 900, 260);
        context.globalCompositeOperation = 'source-over';
        texture.refresh();
      }
    }
    if (!this.textures.exists(COVER_FOG_KEY)) return;

    for (let i = 0; i < 2; i++) {
      const fog = this.add.image(width * (i === 0 ? 0.18 : 0.82), height * (0.62 + i * 0.08), COVER_FOG_KEY)
        .setDisplaySize(width * 1.15, height * 0.34)
        .setAlpha(i === 0 ? 0.7 : 0.48);
      this.tweens.add({
        targets: fog,
        x: fog.x + (i === 0 ? 90 : -90),
        alpha: { from: fog.alpha, to: fog.alpha * 0.72 },
        duration: 13000 + i * 2400,
        ease: 'Sine.InOut',
        yoyo: true,
        repeat: -1,
      });
    }
  }

  private styleButton(button: Phaser.GameObjects.Rectangle, action: () => void) {
    button.on('pointerover', () => button.setFillStyle(0x24536a, 0.95));
    button.on('pointerout', () => button.setFillStyle(0x17334a, 0.75));
    button.on('pointerdown', action);
  }
}
