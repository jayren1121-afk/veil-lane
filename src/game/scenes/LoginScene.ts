import Phaser from 'phaser';
import { t } from '../i18n';
import {
  getAccount,
  getGuestName,
  getSessionToken,
  refreshAccount,
  setGuestName,
  signInWithGoogle,
  signOut,
  updateNickname,
} from '../../net/identity';
import { isGoogleSignInEnabled, renderGoogleButton } from '../../net/googleSignIn';
import { addDomBox, addTextInput } from './domInput';
import { setupSceneMusic } from './musicToggle';
import { addPanel, COLORS, drawBackground, glowText } from './theme';
import { addTextButton } from './uiButton';

/** Google sign-in (optional) or guest nickname, then on to the online lobby. */
export class LoginScene extends Phaser.Scene {
  private messageText!: Phaser.GameObjects.Text;

  constructor() {
    super({ key: 'LoginScene' });
  }

  create() {
    drawBackground(this);
    setupSceneMusic(this);
    const title = this.add.text(600, 90, t('login.title'), {
      fontSize: '40px', fontFamily: 'Arial', color: COLORS.title, fontStyle: 'bold',
    }).setOrigin(0.5);
    glowText(title);
    this.add.text(600, 140, t('login.subtitle'), {
      fontSize: '17px', fontFamily: 'Arial', color: COLORS.muted,
    }).setOrigin(0.5);
    addTextButton(this, 90, 40, 130, 40, t('login.back'), () => this.scene.start('MenuScene'), { fontSize: 15 });
    this.messageText = this.add.text(600, 700, '', {
      fontSize: '16px', fontFamily: 'Arial', color: COLORS.gold, align: 'center',
    }).setOrigin(0.5);

    if (getAccount()) this.showSignedIn();
    else this.showSignIn();
    if (!getAccount() && getSessionToken()) {
      void refreshAccount().then(account => {
        if (account && this.scene.isActive()) this.scene.restart();
      });
    }
  }

  private showSignIn() {
    addPanel(this, 600, 420, 560, 440, 0x0b2034);
    if (isGoogleSignInEnabled()) {
      const { div } = addDomBox(this, 600, 260, 320, 50);
      renderGoogleButton(div, credential => this.handleCredential(credential))
        .catch(() => this.messageText.setText(t('login.failed', { reason: 'Google script' })));
      this.add.text(600, 305, t('login.googleHint'), {
        fontSize: '13px', fontFamily: 'Arial', color: COLORS.muted,
      }).setOrigin(0.5);
    } else {
      this.add.text(600, 270, t('login.googleDisabled'), {
        fontSize: '15px', fontFamily: 'Arial', color: COLORS.muted, align: 'center', wordWrap: { width: 480 },
      }).setOrigin(0.5);
    }
    this.add.rectangle(600, 350, 460, 1, 0x56bfd2, 0.5);
    this.add.text(600, 350, ` ${t('login.or')} `, {
      fontSize: '14px', fontFamily: 'Arial', color: COLORS.muted, backgroundColor: '#0b2034',
    }).setOrigin(0.5);
    this.add.text(600, 395, t('login.guestLabel'), {
      fontSize: '15px', fontFamily: 'Arial', color: COLORS.text, fontStyle: 'bold',
    }).setOrigin(0.5);
    const { input } = addTextInput(this, 600, 445, { width: 320, placeholder: t('login.guestPlaceholder'), value: getGuestName() });
    const go = () => {
      const name = setGuestName(input.value);
      if (!name) {
        this.messageText.setText(t('login.nicknameRequired'));
        return;
      }
      this.scene.start('LobbyScene');
    };
    input.addEventListener('keydown', event => { if (event.key === 'Enter') go(); });
    addTextButton(this, 600, 520, 320, 54, t('login.playAsGuest'), go, { fontSize: 20 });
  }

  private async handleCredential(credential: string) {
    this.messageText.setText(t('login.signingIn'));
    try {
      await signInWithGoogle(credential);
      this.scene.restart();
    } catch (err) {
      this.messageText.setText(t('login.failed', { reason: err instanceof Error ? err.message : 'unknown' }));
    }
  }

  private showSignedIn() {
    const account = getAccount()!;
    addPanel(this, 600, 420, 560, 440, 0x0b2034).setName('signed-in');
    const nameText = this.add.text(600, 240, t('login.signedIn', { name: account.nickname }), {
      fontSize: '24px', fontFamily: 'Arial', color: COLORS.title, fontStyle: 'bold',
    }).setOrigin(0.5);
    this.add.text(600, 280, t('login.record', { wins: account.wins, losses: account.losses, draws: account.draws }), {
      fontSize: '16px', fontFamily: 'Arial', color: COLORS.gold,
    }).setOrigin(0.5);
    this.add.text(600, 335, t('login.nicknameLabel'), {
      fontSize: '14px', fontFamily: 'Arial', color: COLORS.muted, fontStyle: 'bold',
    }).setOrigin(0.5);
    const { input } = addTextInput(this, 520, 380, { width: 260, value: account.nickname });
    addTextButton(this, 735, 380, 150, 42, t('login.save'), async () => {
      try {
        const updated = await updateNickname(input.value);
        nameText.setText(t('login.signedIn', { name: updated.nickname }));
        input.value = updated.nickname;
        this.messageText.setText(t('login.saved'));
      } catch (err) {
        this.messageText.setText(err instanceof Error ? err.message : 'error');
      }
    }, { fontSize: 15 });
    addTextButton(this, 600, 470, 320, 54, t('login.continue'), () => this.scene.start('LobbyScene'), { fontSize: 20 });
    addTextButton(this, 600, 560, 200, 42, t('login.signOut'), async () => {
      await signOut();
      this.scene.restart();
    }, { fontSize: 15, fill: 0x3a1f2a });
  }
}
