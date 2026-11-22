// End-to-end smoke test against `npm run dev:worker` (default http://127.0.0.1:8787).
// Two scripted WebSocket clients create/join a room and play a full best-of-3.
// Round 2 deliberately lets one 20s battle turn expire to check the server auto-pick.
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
await waitFor(() => b.state && a.state.phase === 'draft', 'draft start');
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

function assertNoLeak() {
  for (const cl of clients()) {
    const other = clients().find(o => o !== cl);
    const st = cl.state;
    const otherSt = other.state;
    if (!st || !otherSt || st.phase !== otherSt.phase || st.round !== otherSt.round) continue;
    const json = JSON.stringify(st);
    if (st.phase === 'draft' && otherSt.draft) {
      const mine = new Set([...(Object.values(st.draft.myPicks)), ...(st.draft.candidates ?? [])]);
      for (const id of Object.values(otherSt.draft.myPicks)) {
        if (mine.has(id)) continue; // legal mirror, or still in my candidate list
        if (json.includes(`"${id}"`)) fail(`draft leak ${id}`);
      }
      leakChecks++;
    }
    if (st.phase === 'battle' && otherSt.battle) {
      const opened = new Set(st.battle.revealed.map(r => r.lane));
      const myIds = new Set(Object.values(st.battle.myCards));
      for (const [lane, id] of Object.entries(otherSt.battle.myCards)) {
        if (!opened.has(lane) && !myIds.has(id) && json.includes(`"${id}"`)) fail(`battle leak ${lane} ${id}`);
      }
      leakChecks++;
    }
  }
}

let lastRoundLogged = 0;
while (true) {
  await sleep(40);
  assertNoLeak();
  const st = a.state;
  if (!st) continue;
  if (st.phase === 'matchEnd') break;

  if (st.phase === 'draft') {
    const current = st.draft.currentPlayer;
    const actor = byPlayer(current);
    const view = actor.state;
    if (view?.phase === 'draft' && view.draft.candidates.length && view.draft.currentIndex === st.draft.currentIndex
        && actor.lastPickIndex !== `${st.round}:${view.draft.currentIndex}`) {
      actor.lastPickIndex = `${st.round}:${view.draft.currentIndex}`;
      actor.send({ type: 'pick', cardId: view.draft.candidates[0] });
    }
    // Reconnect test: drop Alice mid-draft in round 1 and come back with her session token.
    if (!reconnected && st.round === 1 && st.draft.currentIndex === 7) {
      reconnected = true;
      const session = a.session;
      a.ws.close();
      await waitFor(() => b.state.players.P1?.connected === false, 'opponent disconnected notice');
      log('Bob sees: opponent disconnected');
      a = connect(created.code, 'Alice', session);
      await waitFor(() => a.state && b.state.players.P1?.connected, 'reconnect');
      if (a.you !== 'P1') fail('reconnect should restore P1 seat');
      log('Alice reconnected to seat', a.you, 'at pick', a.state.draft?.currentIndex);
    }
    continue;
  }

  if (st.phase === 'battle') {
    const lead = byPlayer(st.battle.lead);
    const view = lead.state;
    if (view?.phase !== 'battle') continue;
    const now = view.serverNow + (Date.now() - (lead.receivedAt ?? Date.now()));
    const key = `${view.round}:${view.battle.revealed.length}`;
    if (lead.lastPlayKey === key) continue;
    if (view.round === 2 && view.battle.revealed.length === 1 && !timeoutChecked) {
      // Let this 20s turn expire: the server must open a random lane by itself.
      timeoutChecked = true;
      lead.lastPlayKey = key;
      const t0 = Date.now();
      log('round 2: lead idles to test the 20s auto-pick…');
      await waitFor(() => a.state.battle?.revealed.length === 2 || a.state.phase !== 'battle', 'auto pick', 40000);
      const waited = (Date.now() - t0) / 1000;
      log(`server auto-opened ${a.state.battle.revealed[1].lane} after ${waited.toFixed(1)}s`);
      if (waited < 20 || waited > 30) fail(`auto-pick timing off: ${waited}s`);
      continue;
    }
    if (view.battle.turnStartsAt && Date.now() < view.battle.turnStartsAt - view.serverNow + (lead.stateAt ?? 0)) continue;
    lead.lastPlayKey = key;
    await sleep(Math.max(0, (view.battle.turnStartsAt ?? 0) - view.serverNow) + 50);
    lead.send({ type: 'play', lane: view.battle.opponentHidden[0] });
    void now;
    continue;
  }

  if (st.phase === 'summary') {
    if (lastRoundLogged !== st.lastRoundNumber) {
      lastRoundLogged = st.lastRoundNumber;
      const r = st.lastRound;
      log(`round ${st.lastRoundNumber} done: P1 ${(r.p1WinRate * 100).toFixed(1)}% vs P2 ${(r.p2WinRate * 100).toFixed(1)}% → ${r.roundWinner ?? 'draw'}; order ${r.revealOrder.join(',')}`);
      a.send({ type: 'ready' });
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
const unexpected = [...a.errors, ...b.errors].filter(code => !['TOO_EARLY'].includes(code));
if (unexpected.length) fail(`server errors: ${unexpected.join(',')}`);
log(`leak checks passed: ${leakChecks}`);
console.log('SMOKE OK');
a.ws.close(); b.ws.close(); c.ws.close();
process.exit(0);
