import Phaser from 'phaser';
import { MenuScene } from './game/scenes/MenuScene';
import { HowToPlayScene } from './game/scenes/HowToPlayScene';
import { GameScene } from './game/scenes/GameScene';
import { SummaryScene } from './game/scenes/SummaryScene';
import { LoginScene } from './game/scenes/LoginScene';
import { LobbyScene } from './game/scenes/LobbyScene';
import { captureInviteFromUrl } from './net/onlineClient';
import { guardBrowserBack } from './game/scenes/sceneNav';

captureInviteFromUrl();

const config: Phaser.Types.Core.GameConfig = {
  type: Phaser.AUTO,
  width: 1200,
  height: 800,
  parent: 'app',
  scene: [MenuScene, HowToPlayScene, LoginScene, LobbyScene, GameScene, SummaryScene],
  backgroundColor: '#0a1a2e',
  dom: { createContainer: true },
  scale: {
    mode: Phaser.Scale.FIT,
    autoCenter: Phaser.Scale.CENTER_BOTH,
  },
};

const game = new Phaser.Game(config);
guardBrowserBack(game);
