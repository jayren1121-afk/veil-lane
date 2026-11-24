import { afterEach, describe, expect, it } from 'vitest';
import { setLanguage, SUBJECT_YOU_VARIANTS, t, tSubject } from '../src/game/i18n';
import { STRINGS, StringKey } from '../src/game/i18n/strings';

const BROKEN_YOU = /\bYOU (GOES|WINS|HAS|IS|WAS|LEADS|PICKS|PLAYS|CHOOSES)\b|\bYOU'S\b/;
const params = { lane: 'MID', bonus: '21.0', card: 'X', seconds: 20, rate: 50, p1: 1, p2: 2, p1name: 'YOU', p2name: 'CPU' };

afterEach(() => setLanguage('zh'));

describe('English subject–verb agreement for player labels', () => {
  it('every English template that takes {player} reads correctly with YOU', () => {
    setLanguage('en');
    const keys = (Object.keys(STRINGS) as StringKey[]).filter(key => STRINGS[key].en.includes('{player}'));
    expect(keys.length).toBeGreaterThan(5);
    for (const key of keys) {
      const text = tSubject(key, true, { ...params, player: 'YOU' });
      expect(text, key).not.toMatch(BROKEN_YOU);
    }
  });

  it('uses GO/WIN/YOUR for you and GOES/WINS for CPU or an opponent', () => {
    setLanguage('en');
    expect(tSubject('coin.winner', true, { player: 'YOU' })).toBe('YOU GO FIRST!');
    expect(tSubject('coin.winner', false, { player: 'CPU' })).toBe('CPU GOES FIRST!');
    expect(tSubject('coin.winner', false, { player: 'Mia' })).toBe('Mia GOES FIRST!');
    expect(tSubject('game.laneWinner', true, { lane: 'MID', player: 'YOU' })).toBe('MID: YOU WIN THE LANE');
    expect(tSubject('game.laneWinner', false, { lane: 'MID', player: 'CPU' })).toBe('MID: CPU WINS THE LANE');
    expect(tSubject('summary.matchWinner', true, { player: 'YOU' })).toBe('YOU WIN');
    expect(tSubject('summary.matchWinner', false, { player: 'CPU' })).toBe('CPU WINS');
    expect(tSubject('game.handLabel', true, { player: 'YOU' })).toBe('YOUR\nHAND');
    expect(tSubject('summary.synergyBonus', true, { player: 'YOU', bonus: '21.0' })).toBe('YOUR SYNERGY BONUS +21.0%');
    expect(tSubject('summary.synergyBonus', false, { player: 'CPU', bonus: '27.0' })).toBe('CPU SYNERGY BONUS +27.0%');
    expect(t('summary.matchOver', { p1name: 'YOU', p2name: 'CPU', p1: 2, p2: 1, winner: tSubject('summary.matchWinner', true, { player: 'YOU' }) }))
      .toBe('MATCH OVER | YOU 2 — 1 CPU | YOU WIN');
  });

  it('every "you" variant exists in both languages', () => {
    for (const [key, variant] of Object.entries(SUBJECT_YOU_VARIANTS)) {
      expect(STRINGS[key as StringKey]).toBeDefined();
      expect(STRINGS[variant!].zh.length).toBeGreaterThan(0);
      expect(STRINGS[variant!].en.length).toBeGreaterThan(0);
    }
    setLanguage('zh');
    expect(tSubject('coin.winner', true, { player: '你' })).toBe('你先手！');
  });
});
