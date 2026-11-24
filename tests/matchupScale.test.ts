import { describe, expect, it } from 'vitest';
import { computeShrinkageWinRate, laneMatchupWinRate, LANE_ORDER, laneDealPool, MATCHUP_MIN, MATCHUP_SCALE } from '../src/game/rules';

function seeded(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

describe('lane matchup win rate (counter-pick weight)', () => {
  it('scales the head-to-head part by MATCHUP_SCALE, stays symmetric and clamped', () => {
    for (const lane of LANE_ORDER) {
      const pool = laneDealPool(lane, []);
      for (let i = 0; i < pool.length; i++) {
        for (let j = 0; j < pool.length; j++) {
          const a = pool[i];
          const b = pool[j];
          const p = laneMatchupWinRate(a, b, lane);
          expect(p + laneMatchupWinRate(b, a, lane)).toBeCloseTo(1, 9);
          expect(p).toBeGreaterThanOrEqual(MATCHUP_MIN);
          expect(p).toBeLessThanOrEqual(1 - MATCHUP_MIN);
          if (i === j) expect(p).toBe(0.5);
          const { winRate, prior } = computeShrinkageWinRate(a, b, lane);
          const expected = Math.min(1 - MATCHUP_MIN, Math.max(MATCHUP_MIN, prior + MATCHUP_SCALE * (winRate - prior)));
          expect(p).toBeCloseTo(expected, 12);
        }
      }
    }
  });

  it('makes guessing matter: in counter-pick lanes a wrong guess typically costs several points', () => {
    const random = seeded(42);
    const costs: number[] = [];
    let counterLanes = 0;
    const N = 4000;
    for (let n = 0; n < N; n++) {
      const lane = LANE_ORDER[Math.floor(random() * 5)];
      const pool = laneDealPool(lane, []);
      const take = () => pool.splice(Math.floor(random() * pool.length), 1)[0];
      const [x1, x2, y1, y2] = [take(), take(), take(), take()];
      const p = [[laneMatchupWinRate(x1, y1, lane), laneMatchupWinRate(x1, y2, lane)],
        [laneMatchupWinRate(x2, y1, lane), laneMatchupWinRate(x2, y2, lane)]];
      // Counter-pick lane: which of my cards is better depends on the opponent's pick.
      if ((p[0][0] - p[1][0]) * (p[0][1] - p[1][1]) < 0) {
        counterLanes++;
        for (const j of [0, 1]) costs.push(Math.abs(p[0][j] - p[1][j]) * 100);
      }
    }
    costs.sort((a, b) => a - b);
    const median = costs[Math.floor(costs.length / 2)];
    expect(counterLanes / N).toBeGreaterThan(0.35);
    expect(median).toBeGreaterThan(5);
  });
});
