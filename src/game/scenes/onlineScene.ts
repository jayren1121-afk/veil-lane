import Phaser from 'phaser';
import type { MatchView } from '../online/protocol';
import { buildDraftSlots, DraftState, GamePhase, initialDraftBanks, MatchState, Player, otherPlayer } from '../rules';
import { t } from '../i18n';
import { getOnlineClient, OnlineClient } from '../../net/onlineClient';
import { COLORS } from './theme';

/** Placeholder id for an opponent pick whose card stays hidden on the client. */
export const HIDDEN_CARD_ID = '__hidden__';

export function sceneForPhase(phase: MatchView['phase']): string {
  switch (phase) {
    case 'draft': return 'DraftScene';
    case 'battle': return 'GameScene';
    case 'summary':
    case 'matchEnd': return 'SummaryScene';
    default: return 'LobbyScene';
  }
}

/** Client-side MatchState mirror built only from what the server chose to show this player. */
export function mirrorMatchState(view: MatchView): MatchState {
  return {
    p1Hand: [],
    p2Hand: [],
    p1UsedCardIds: view.you === Player.P1 ? new Set(view.usedCardIds) : new Set(),
    p2UsedCardIds: view.you === Player.P2 ? new Set(view.usedCardIds) : new Set(),
    currentRound: view.round,
    round1FirstPlayer: view.round1FirstPlayer,
    p1RoundWins: view.score.P1,
    p2RoundWins: view.score.P2,
    roundResults: view.lastRound ? [view.lastRound] : [],
    matchWinner: view.matchWinner,
    phase: view.phase === 'matchEnd' ? GamePhase.MatchEnd : view.phase === 'battle' ? GamePhase.Reveal : GamePhase.Draft,
  };
}

/** Draft mirror: own picks are real ids, opponent picks are HIDDEN_CARD_ID placeholders. */
export function mirrorDraftState(view: MatchView, serverNow: number): DraftState {
  const slots = buildDraftSlots(view.round);
  const draft = view.draft;
  for (const slot of slots) {
    if (!draft) continue;
    if (slot.player === view.you) slot.cardId = draft.myPicks[slot.lane] ?? null;
    else slot.cardId = draft.opponentLocked.includes(slot.lane) ? HIDDEN_CARD_ID : null;
  }
  return {
    slots,
    currentIndex: draft ? draft.currentIndex : slots.length,
    timeRemainingMs: draft?.timeRemainingMs
      ? { ...draft.timeRemainingMs }
      : initialDraftBanks(),
  };
  void serverNow;
}

export function playerName(view: MatchView, player: Player): string {
  return view.players[player]?.name ?? player;
}

export function opponentName(view: MatchView): string {
  return playerName(view, otherPlayer(view.you));
}

/** "YOU" for this player, otherwise the opponent's nickname. */
export function sideLabel(view: MatchView, player: Player): string {
  return player === view.you ? t('online.you') : playerName(view, player);
}

/**
 * Subscribes a scene to the online client for its lifetime and shows a banner when the
 * opponent is disconnected or our own socket is reconnecting.
 */
export function bindOnlineScene(scene: Phaser.Scene, onState: (view: MatchView) => void): OnlineClient | null {
  const client = getOnlineClient();
  if (!client) return null;
  const banner = scene.add.text(600, 92, '', {
    fontSize: '15px', fontFamily: 'Arial', color: '#ffffff', fontStyle: 'bold',
    backgroundColor: '#8a2b2b', padding: { x: 14, y: 6 },
  }).setOrigin(0.5).setDepth(3000).setVisible(false);

  const refresh = () => {
    const view = client.state;
    let message = '';
    if (client.status === 'reconnecting' || client.status === 'connecting') message = t('online.reconnecting');
    else if (client.status === 'closed') message = t('online.connectionClosed');
    else if (view && view.players[otherPlayer(view.you)] && !view.players[otherPlayer(view.you)]!.connected) {
      message = t('online.opponentDisconnected');
    }
    banner.setText(message).setVisible(Boolean(message));
  };
  const offState = client.onState(view => {
    refresh();
    onState(view);
  });
  const offEvent = client.onEvent(event => {
    if (event.kind === 'status') refresh();
  });
  refresh();
  scene.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
    offState();
    offEvent();
  });
  return client;
}

export const ONLINE_TEXT_COLOR = COLORS.text;
