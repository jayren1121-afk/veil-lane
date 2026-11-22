import Phaser from 'phaser';
import { t } from '../i18n';
import type { MatchView } from '../online/protocol';
import { normalizeRoomCode } from '../online/roomCode';
import { currentDisplayName, getAccount, hasIdentity, refreshAccount } from '../../net/identity';
import {
  consumeInviteCode,
  createRoom,
  getOnlineClient,
  inviteLink,
  leaveOnline,
  OnlineClient,
  startOnline,
} from '../../net/onlineClient';
import { addTextInput } from './domInput';
import { setupSceneMusic } from './musicToggle';
import { sceneForPhase } from './onlineScene';
import { addPanel, COLORS, drawBackground, glowText } from './theme';
import { addTextButton, UiButton } from './uiButton';

/** Create a room (big code + invite link) or join one with a 4-character code. */
export class LobbyScene extends Phaser.Scene {
  private statusText!: Phaser.GameObjects.Text;
  private codeText!: Phaser.GameObjects.Text;
  private roomGroup: Phaser.GameObjects.GameObject[] = [];
  private entryGroup: (Phaser.GameObjects.GameObject | UiButton)[] = [];
  private copyButton!: UiButton;
  private codeInput!: HTMLInputElement;
  private unsubscribe: (() => void)[] = [];
  private sawState = false;

  constructor() {
    super({ key: 'LobbyScene' });
  }

  create() {
    if (!hasIdentity()) {
      this.scene.start('LoginScene');
      return;
    }
    this.unsubscribe = [];
    this.roomGroup = [];
    this.entryGroup = [];
    this.sawState = false;
    drawBackground(this);
    setupSceneMusic(this);
    const title = this.add.text(600, 70, t('lobby.title'), {
      fontSize: '38px', fontFamily: 'Arial', color: COLORS.title, fontStyle: 'bold',
    }).setOrigin(0.5);
    glowText(title);
    addTextButton(this, 90, 40, 130, 40, t('lobby.back'), () => {
      leaveOnline();
      this.scene.start('MenuScene');
    }, { fontSize: 15 });

    const playerText = this.add.text(600, 122, '', {
      fontSize: '17px', fontFamily: 'Arial', color: COLORS.text, fontStyle: 'bold',
    }).setOrigin(0.5);
    const updatePlayer = () => {
      const account = getAccount();
      playerText.setText(`${t('lobby.playingAs', { name: currentDisplayName() })}　·　${account
        ? t('lobby.record', { wins: account.wins, losses: account.losses })
        : t('lobby.guest')}`);
    };
    updatePlayer();
    void refreshAccount().then(() => this.scene.isActive() && updatePlayer());

    this.statusText = this.add.text(600, 690, '', {
      fontSize: '17px', fontFamily: 'Arial', color: COLORS.gold, align: 'center',
    }).setOrigin(0.5).setDepth(20);

    this.buildEntry();
    this.buildRoomView();
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => this.unsubscribe.forEach(off => off()));

    const existing = getOnlineClient();
    const invite = consumeInviteCode();
    if (invite) this.join(invite);
    else if (existing && existing.status !== 'closed') this.attach(existing);
  }

  private buildEntry() {
    const left = addPanel(this, 330, 380, 420, 300, 0x0b2034);
    const right = addPanel(this, 870, 380, 420, 300, 0x0b2034);
    const createTitle = this.add.text(330, 285, t('lobby.create'), {
      fontSize: '22px', fontFamily: 'Arial', color: COLORS.title, fontStyle: 'bold',
    }).setOrigin(0.5);
    const createButton = addTextButton(this, 330, 400, 280, 64, `＋ ${t('lobby.create')}`, () => this.onCreateRoom(), { fontSize: 22 });
    const joinTitle = this.add.text(870, 285, t('lobby.joinTitle'), {
      fontSize: '22px', fontFamily: 'Arial', color: COLORS.title, fontStyle: 'bold',
    }).setOrigin(0.5);
    const { dom, input } = addTextInput(this, 870, 370, { width: 220, placeholder: t('lobby.codePlaceholder'), maxLength: 4, upper: true });
    this.codeInput = input;
    const doJoin = () => {
      const code = normalizeRoomCode(input.value);
      if (!code) {
        this.statusText.setText(t('lobby.invalidCode'));
        return;
      }
      this.join(code);
    };
    input.addEventListener('keydown', event => { if (event.key === 'Enter') doJoin(); });
    const joinButton = addTextButton(this, 870, 440, 220, 54, t('lobby.join'), doJoin, { fontSize: 20 });
    this.entryGroup = [left, right, createTitle, createButton, joinTitle, dom, joinButton];
  }

  private buildRoomView() {
    const panel = addPanel(this, 600, 390, 620, 380, 0x0b2034);
    const label = this.add.text(600, 250, t('lobby.roomCode'), {
      fontSize: '18px', fontFamily: 'Arial', color: COLORS.muted, fontStyle: 'bold',
    }).setOrigin(0.5);
    this.codeText = this.add.text(600, 335, '----', {
      fontSize: '96px', fontFamily: 'Arial', color: COLORS.gold, fontStyle: 'bold', letterSpacing: 18,
    } as Phaser.Types.GameObjects.Text.TextStyle).setOrigin(0.5);
    glowText(this.codeText, COLORS.gold, 18);
    this.copyButton = addTextButton(this, 600, 450, 280, 50, t('lobby.copyInvite'), () => this.copyInvite(), { fontSize: 18, depth: 30 });
    const leave = addTextButton(this, 600, 530, 200, 42, t('lobby.leave'), () => {
      leaveOnline();
      this.scene.restart();
    }, { fontSize: 15, fill: 0x3a1f2a, depth: 30 });
    this.roomGroup = [panel, label, this.codeText, this.copyButton.bg, this.copyButton.label, leave.bg, leave.label];
    this.showRoom(false);
  }

  private showRoom(visible: boolean) {
    this.roomGroup.forEach(item => (item as unknown as { setVisible(v: boolean): void }).setVisible(visible));
    this.entryGroup.forEach(item => (item as unknown as { setVisible(v: boolean): void }).setVisible(!visible));
  }

  private async onCreateRoom() {
    this.statusText.setText(t('lobby.creating'));
    try {
      const code = await createRoom();
      this.join(code);
    } catch {
      this.statusText.setText(t('lobby.serverDown'));
    }
  }

  private join(code: string) {
    this.statusText.setText(t('lobby.connecting'));
    this.attach(startOnline(code));
  }

  private attach(client: OnlineClient) {
    this.codeText.setText(client.roomCode);
    this.showRoom(true);
    this.unsubscribe.forEach(off => off());
    this.unsubscribe = [
      client.onState(view => this.onState(view)),
      client.onEvent(event => {
        if (event.kind === 'error') {
          if (event.code === 'ROOM_FULL' || event.code === 'ROOM_NOT_FOUND') {
            leaveOnline();
            this.showRoom(false);
            this.statusText.setText(t(event.code === 'ROOM_FULL' ? 'lobby.roomFull' : 'lobby.roomNotFound'));
          }
        } else if (event.status === 'closed' && !this.sawState) {
          this.showRoom(false);
          if (!this.statusText.text || this.statusText.text === t('lobby.connecting')) this.statusText.setText(t('lobby.serverDown'));
        }
      }),
    ];
    if (client.state) this.onState(client.state);
  }

  private onState(view: MatchView) {
    this.sawState = true;
    if (view.phase === 'waiting') {
      this.statusText.setText(t('lobby.waiting'));
      return;
    }
    this.scene.start(sceneForPhase(view.phase), { online: true, showCoin: view.phase === 'draft' && view.round === 1 });
  }

  private async copyInvite() {
    const client = getOnlineClient();
    if (!client) return;
    const link = inviteLink(client.roomCode);
    try {
      await navigator.clipboard.writeText(link);
      this.copyButton.setText(t('lobby.copied'));
    } catch {
      this.statusText.setText(link);
    }
    this.time.delayedCall(1800, () => this.copyButton.setText(t('lobby.copyInvite')));
  }
}
