// End-to-end smoke test against `npm run dev:worker` (default http://127.0.0.1:8787).
// Two scripted WebSocket clients create/join a room and play a full best-of-3.
// Every lane, each client is dealt its own two cards and plays one. Round 2 deliberately lets
// one player's 20s lane clock expire to check the server auto-pick.
// Between rounds it checks the "opponent is ready" signal; after the match both ask for a
// rematch (a fresh Bo3 starts in the same room), and after that second match one side asks
// again while the other leaves, which must show "opponent left" and refuse the rematch.
const BASE = process.env.VEIL_SERVER ?? 'http://127.0.0.1:8787';
const WS_BASE = BASE.replace(/^http/, 'ws');
const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function fail(message) {
  console.error('SMOKE FAIL:', message);
  process.exit(1);
}

function connect(code, name, session) {
  const params = new URLSearchParams({ name });
  if (session) params.set('session', session);
  const ws = new WebSocket(`${WS_BASE}/api/rooms/${code}/ws?${params}`);
  const client = { ws, name, state: null, you: null, session: null, errors: [], listeners: [] };
  ws.addEventListener('message', event => {
    const msg = JSON.parse(event.data);
    if (msg.type === 'welcome') { client.you = msg.you; client.session = msg.sessionToken; }
    if (msg.type === 'state') client.state = msg.state;
    if (msg.type === 'error') client.errors.push(msg.code);
    client.listeners.forEach(fn => fn(msg));
  });
  client.opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  client.send = msg => ws.send(JSON.stringify(msg));
  return client;
}

async function waitFor(predicate, label, timeoutMs = 60000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) fail(`timeout waiting for ${label}`);
    await sleep(25);
  }
}

const created = await fetch(`${BASE}/api/rooms`, { method: 'POST' }).then(r => r.json());
if (!/^[A-Z2-9]{4}$/.test(created.code)) fail(`bad room code ${JSON.stringify(created)}`);
log('room created', created.code);

let a = connect(created.code, 'Alice');
await a.opened;
await waitFor(() => a.state, 'alice state');
if (a.you !== 'P1' || a.state.phase !== 'waiting') fail('first joiner should be P1 waiting');
const b = connect(created.code, 'Bob');
await waitFor(() => b.state && a.state.phase === 'battle', 'round start');
if (b.you !== 'P2') fail('second joiner should be P2');
log('both joined; round-1 first player', a.state.round1FirstPlayer);

const c = connect(created.code, 'Eve');
await waitFor(() => c.errors.includes('ROOM_FULL'), 'room full error');
log('third player correctly rejected: ROOM_FULL');

const clients = () => [a, b];
const byPlayer = p => clients().find(cl => cl.you === p);
let timeoutChecked = false;
let reconnected = false;
let leakChecks = 0;
let partnerChoices = 0;
let readySignals = 0;

function assertNoLeak() {
  for (const cl of clients()) {
    const other = clients().find(o => o !== cl);
    const st = cl.state;
    const otherSt = other.state;
    if (!st?.battle || !otherSt?.battle || st.phase !== 'battle' || otherSt.phase !== 'battle') continue;
    if (st.round !== otherSt.round || st.battle.laneIndex !== otherSt.battle.laneIndex) continue;
    const json = JSON.stringify(st);
    const allowed = new Set([...st.battle.myHand.flat(), ...Object.values(st.battle.myCards), ...st.usedCardIds, ...(st.battle.opponentCandidates ?? [])]);
    if (st.battle.currentLane && JSON.stringify(st.battle.opponentCandidates) !== JSON.stringify(otherSt.battle.myHand[otherSt.battle.laneIndex])) fail(`candidates mismatch for ${cl.you}`);
    if ("opponentMain" in st.battle || "opponentPartner" in st.battle) fail("opponent pick fields sent");
    for (const r of st.battle.revealed) {
      allowed.add(r.p1Card.id);
      allowed.add(r.p2Card.id);
      for (const link of [...r.p1Synergy.links, ...r.p2Synergy.links]) allowed.add(link.card.id);
    }
    for (const id of [...otherSt.battle.myHand.flat(), otherSt.battle.myMain, ...(otherSt.battle.myPartners ?? [])]) {
      if (!id || allowed.has(id)) continue;
      if (json.includes(`"${id}"`)) fail(`leak of opponent card ${id} to ${cl.you}`);
    }
    if ('hands' in st.battle || 'mains' in st.battle || 'partners' in st.battle) fail('raw server hands sent to client');
    for (const id of st.battle.myRed) if (st.battle.myPartnerOptions.includes(id)) fail(`red card ${id} offered as partner`);
    leakChecks++;
  }
}

let lastRoundLogged = 0;
let synergyLinks = 0;
const checkedLanes = new Set();
function checkLaneScores(st) {
  for (const r of st.battle?.revealed ?? []) {
    const key = `${st.round}:${r.lane}`;
    if (checkedLanes.has(key)) continue;
    checkedLanes.add(key);
    for (const side of ['p1', 'p2']) {
      const expected = r[`${side}WinRate`] + r[`${side}Synergy`].bonus;
      if (Math.abs(expected - r[`${side}Total`]) > 1e-9) fail(`lane total mismatch ${key} ${side}`);
      const sum = r[`${side}Synergy`].links.reduce((t, link) => t + link.bonus, 0);
      if (Math.abs(sum - r[`${side}Synergy`].bonus) > 1e-9) fail(`partner bonuses must stack (sum) in ${key} ${side}`);
      if (new Set(r[`${side}Synergy`].links.map(link => link.card.id)).size !== r[`${side}Synergy`].links.length) fail(`duplicate partner in ${key}`);
      for (const link of r[`${side}Synergy`].links) {
        if (![0.05, 0.04, 0.03, 0.02, 0.01].some(tier => Math.abs(tier - link.bonus) < 1e-9)) fail(`bad synergy tier ${link.bonus}`);
        synergyLinks++;
      }
    }
  }
}

while (true) {
  await sleep(40);
  assertNoLeak();
  const st = a.state;
  if (!st) continue;
  if (st.phase === 'matchEnd') break;

  if (st.phase === 'battle') {
    checkLaneScores(st);
    // Reconnect test: drop Alice in round 1 at the Mid lane and come back with her session token.
    if (!reconnected && st.round === 1 && st.battle.laneIndex === 2) {
      reconnected = true;
      const session = a.session;
      a.ws.close();
      await waitFor(() => b.state.players.P1?.connected === false, 'opponent disconnected notice');
      log('Bob sees: opponent disconnected');
      a = connect(created.code, 'Alice', session);
      await waitFor(() => a.state && b.state.players.P1?.connected, 'reconnect');
      if (a.you !== 'P1') fail('reconnect should restore P1 seat');
      log('Alice reconnected to seat', a.you, 'at lane', a.state.battle?.currentLane);
      continue;
    }
    for (const cl of clients()) {
      const view = cl.state;
      if (view?.phase !== 'battle' || !view.battle.currentLane) continue;
      const battle = view.battle;
      if (battle.myMain && !battle.needPartner) continue;
      const stage = battle.myMain ? 'partner' : 'main';
      const key = `${view.round}:${battle.laneIndex}:${stage}`;
      if (cl.lastPickKey === key) continue;
      const hand = battle.myHand;
      if (hand.length !== 5 || new Set(hand.flat()).size !== 10) fail(`expected a 10-card hand, got ${hand.flat().length}`);
      cl.lastPickKey = key;
      if (stage === 'main' && view.round === 2 && battle.laneIndex === 1 && cl.you === 'P2' && !timeoutChecked) {
        // Bob idles on this lane: after 20s the server plays a random main card (and best partner) for him.
        timeoutChecked = true;
        const startsIn = Math.max(0, (battle.turnStartsAt ?? view.serverNow) - view.serverNow);
        const t0 = Date.now() + startsIn;
        log('round 2: Bob idles on Jungle to test the 20s auto-pick…');
        await waitFor(() => b.state.battle?.revealed.length === 2 || b.state.phase !== 'battle', 'auto pick', 45000);
        const waited = (Date.now() - t0) / 1000;
        const lane = b.state.battle.revealed[1];
        const autoCard = lane.p2Card.id;
        log(`server auto-played ${autoCard} for Bob after ${waited.toFixed(1)}s (partners: ${lane.p2Synergy.links.map(l => l.card.id).join(',') || 'none'})`);
        if (!hand[1].includes(autoCard)) fail('auto-pick must be one of the lane\'s two cards');
        for (const link of lane.p2Synergy.links) if (!hand.flat().includes(link.card.id)) fail('auto partner must come from the hand');
        if (lane.p2Synergy.links.length > 1) fail('timeout must auto-pick at most one partner');
        if (waited < 19 || waited > 30) fail(`auto-pick timing off: ${waited}s`);
        break;
      }
      if (stage === 'main') {
        cl.send({ type: 'pick', cardId: hand[battle.laneIndex][cl.you === 'P1' ? 1 : 0] });
      } else {
        partnerChoices++;
        // P1 stacks every option, P2 takes none: exercises multi-partner and the empty set.
        cl.send({ type: 'partner', cardIds: cl.you === 'P1' ? [...battle.myPartnerOptions] : [] });
      }
    }
    continue;
  }

  if (st.phase === 'summary') {
    if (lastRoundLogged !== st.lastRoundNumber) {
      lastRoundLogged = st.lastRoundNumber;
      const r = st.lastRound;
      log(`round ${st.lastRoundNumber} done: P1 ${(r.p1WinRate * 100).toFixed(1)}% vs P2 ${(r.p2WinRate * 100).toFixed(1)}% → ${r.roundWinner ?? 'draw'}; synergy P1 +${(r.p1SynergyAvg * 100).toFixed(1)} / P2 +${(r.p2SynergyAvg * 100).toFixed(1)} avg`);
      if (r.revealOrder.join(',') !== 'Top,Jungle,Mid,Bot,Support') fail(`lanes out of order: ${r.revealOrder}`);
      // Ready signal: Alice presses NEXT ROUND first; Bob's view must show her as ready.
      a.send({ type: 'ready' });
      await waitFor(() => b.state.phase !== 'summary' || b.state.ready.includes(a.you), 'opponent ready notice', 10000);
      if (b.state.phase === 'summary') {
        if (b.state.ready.includes(b.you)) fail('Bob should not be ready yet');
        readySignals++;
        log('Bob sees: opponent is ready');
      }
      b.send({ type: 'ready' });
    }
  }
}

const final = a.state;
const r = final.lastRound;
log(`round ${final.lastRoundNumber} done: P1 ${(r.p1WinRate * 100).toFixed(1)}% vs P2 ${(r.p2WinRate * 100).toFixed(1)}% → ${r.roundWinner ?? 'draw'}`);
log(`MATCH END score P1 ${final.score.P1} - P2 ${final.score.P2}; winner ${final.matchWinner ?? 'draw'}`);
if (final.lastRoundNumber !== 3) fail('expected 3 rounds');
const myUsed = new Set(final.usedCardIds);
if (myUsed.size !== 15) fail(`Fearless: expected 15 used cards for this player, got ${myUsed.size} (${final.usedCardIds.join(',')})`);
if (!timeoutChecked) fail('timeout path not exercised');
if (!reconnected) fail('reconnect path not exercised');
const unexpected = [...a.errors, ...b.errors];
if (unexpected.length) fail(`server errors: ${unexpected.join(',')}`);
log(`leak checks passed: ${leakChecks}; synergy partners seen: ${synergyLinks}; manual partner choices: ${partnerChoices}`);
if (leakChecks < 20) fail(`too few leak checks: ${leakChecks}`);
if (readySignals < 2) fail(`ready notice seen ${readySignals} times, expected 2`);

// ---------- rematch: both accept ----------
const offer = a.state.rematch;
if (!offer || offer.you || offer.opponent || offer.opponentLeft || offer.closed || !offer.deadline) fail(`bad rematch offer ${JSON.stringify(offer)}`);
const offerSecs = (offer.deadline - a.state.serverNow) / 1000;
if (offerSecs < 50 || offerSecs > 61) fail(`rematch window ${offerSecs}s`);
a.send({ type: 'rematch' });
await waitFor(() => b.state.rematch?.opponent === true, 'Bob sees rematch request', 10000);
if (b.state.rematch.you) fail('Bob has not asked yet');
log('Bob sees: opponent wants a rematch');
const firstNames = JSON.stringify([a.state.players.P1?.name, a.state.players.P2?.name]);
b.send({ type: 'rematch' });
await waitFor(() => a.state.phase === 'battle' && b.state.phase === 'battle', 'rematch start', 10000);
for (const cl of [a, b]) {
  const st = cl.state;
  if (st.round !== 1 || st.score.P1 !== 0 || st.score.P2 !== 0) fail('rematch must start at round 1, 0-0');
  if (st.usedCardIds.length !== 0) fail('Fearless list must reset on rematch');
  if (st.battle.myRed.length !== 0) fail('red cards must reset on rematch');
  if (st.lastRoundNumber !== 0 || st.lastRound) fail('old results must be cleared');
  if (st.rematch) fail('no rematch offer during a match');
  if (st.roomCode !== created.code) fail('rematch must stay in the same room');
}
if (JSON.stringify([a.state.players.P1?.name, a.state.players.P2?.name]) !== firstNames) fail('rematch must keep the same players');
log('rematch started in room', created.code, '- round 1, 0-0, Fearless and red reset; first player', a.state.round1FirstPlayer);

// Play the second match quickly: first card, no partners, both ready at once.
const done2 = new Set();
while (a.state.phase !== 'matchEnd' || b.state.phase !== 'matchEnd') {
  await sleep(40);
  assertNoLeak();
  for (const cl of clients()) {
    const st = cl.state;
    if (st.phase === 'battle' && st.battle.currentLane) {
      const stage = st.battle.myMain ? (st.battle.needPartner ? 'partner' : null) : 'main';
      const key = `${st.round}:${st.battle.laneIndex}:${stage}`;
      if (!stage || done2.has(cl.you + key)) continue;
      done2.add(cl.you + key);
      if (stage === 'main') cl.send({ type: 'pick', cardId: st.battle.myHand[st.battle.laneIndex][0] });
      else cl.send({ type: 'partner', cardIds: [] });
    } else if (st.phase === 'summary' && !st.ready.includes(cl.you) && !done2.has(cl.you + 'ready' + st.round)) {
      done2.add(cl.you + 'ready' + st.round);
      cl.send({ type: 'ready' });
    }
  }
}
if (a.state.lastRoundNumber !== 3) fail('second match should also have 3 rounds');
log(`second match over: P1 ${a.state.score.P1} - P2 ${a.state.score.P2}`);

// ---------- rematch: one side leaves ----------
a.send({ type: 'rematch' });
await waitFor(() => b.state.rematch?.opponent === true, 'rematch request 2', 10000);
b.send({ type: 'leave' });
b.ws.close();
await waitFor(() => a.state.rematch?.opponentLeft === true, 'Alice sees opponent left', 10000);
log('Alice sees: opponent left (rematch no longer possible)');
a.send({ type: 'rematch' });
await waitFor(() => a.errors.includes('OPPONENT_LEFT'), 'rematch refused after leave', 10000);
if (a.state.phase !== 'matchEnd') fail('no new match may start after the opponent left');
a.errors.splice(a.errors.indexOf('OPPONENT_LEFT'), 1);
const leftover = [...a.errors, ...b.errors];
if (leftover.length) fail(`server errors: ${leftover.join(',')}`);
console.log('SMOKE OK');
a.ws.close(); b.ws.close(); c.ws.close();
process.exit(0);
