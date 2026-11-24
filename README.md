# Veil Lane

Hidden-card lane duel built with Vite + TypeScript + Phaser 4 (Cloud9 x JetBrains "Sky's The Limit" 2026, Event Mini Game).
At the start of each round both players are dealt their own 10-card hand: 2 random cards for each lane, visible to them
all round. Lanes are played in order (Top → Support). Each lane, each player secretly picks one of that lane's two cards as
the MAIN card, then one synergy partner from the rest of their hand (any other lane, played or not). Per the aggregated
pro-match synergy table, a pair counts as synergy with at least 4 games together and a +6-point edge over its expected
win rate (`SYNERGY_MIN_GAMES` / `SYNERGY_MIN_EDGE`). A card's partners are ranked by edge and pay +5/+4/+3/+2/+1% by rank
(`SYNERGY_TIER`; with more than five partners the ranked list is split into five equal bands). Eligible partners glow gold
with their %. Synergy does not stack: with 2+ eligible partners you choose one, with exactly one it is used
automatically, with none the step is skipped. A chosen partner turns red for the rest of the round and can't be a partner
again (it can still be played as the main card in its own lane, with its own partner pick); red resets every round. Both
main cards go down face-down and flip together, each side's partner flies in, and lane score = matchup win rate + order
bonus (+5…+1%) + partner %. The opponent's hand, main card and partner stay hidden until the flip.
Best of 3, Fearless: a card you played as MAIN is never dealt to you again in the match.

The public Worker for this project is already deployed at
<https://veil-lane-server.jayren1121.workers.dev>. For the frontend, set
`VITE_WS_URL=wss://veil-lane-server.jayren1121.workers.dev`.

## Modes

- **Online battle**: two players on two computers. Create a room (4-character code + invite link `?room=XXXX`) or join one.
  The server (Cloudflare Worker + Durable Object) holds the hidden picks and runs the rules, so neither browser
  ever receives the opponent's unrevealed cards.
- **vs CPU** (對戰電腦): play the computer offline, no server needed. The CPU gets its own hidden 10-card hand under the
  same rules (Fearless, red partners, 20 s clock). Each lane it picks the main card with the best expected lane score
  (lane win rate + best partner %) plus a little random noise, then usually the highest-% partner (sometimes the
  runner-up). It only looks at its own hand and never at yours (`src/game/rules/cpu.ts`). After a short "thinking"
  delay its card slides down face-down, then the normal flip and partner pop play.
- **Table**: one card position per side for the current lane (opponent above, you below). Each lane's cards fly in,
  flip, partners pop in, the winner is shown, then the table is swept clear for the next lane. A lane title
  (e.g. 上路 1/5 · +5%) and a 5-dot record (green won / red lost / gold draw) show progress. Cards you already played
  stay in your hand, dimmed and tagged "已出 / PLAYED", because they can still be picked as partners.
- **Going back**: every screen except the menu has a top-left "← 返回 / BACK" button; Esc and the browser back
  button do the same (the browser back button never leaves the page). vs CPU exits straight to the menu. Online,
  leaving mid-match asks first ("確定離開？對手會獲勝") and sends `leave` to the server, which ends the match as a forfeit
  win for the opponent (recorded as a loss for the leaver); the opponent sees "你獲勝！". In a waiting room, leaving
  frees your seat.
- **Accounts**: "Sign in with Google" keeps a nickname and win/loss record. "Play as guest" (nickname only) works
  without any account, so judges can try it instantly.
- **Battle timer**: each lane has a 20-second countdown per player covering both the main card and the partner pick
  (`BATTLE_TURN_SECONDS` in `src/game/rules/constants.ts`). It turns red for the last 5 seconds; on timeout a random main
  card of the lane's two is played, then the highest-% partner. Online, the server enforces it with Durable Object alarms. vs CPU mode accepts `?seed=N` for reproducible deals (and CPU choices).

## Develop

```bash
npm install
npm test                 # vitest (rules, CPU, online match, timers, room codes, Google token checks)
npm run dev:worker       # local backend on http://localhost:8787 (wrangler dev, no Cloudflare login needed)
npm run dev              # game on http://localhost:5173
npm run smoke:online     # optional: two scripted clients play a full Bo3 against dev:worker (~80 s)
npm run build            # production build in dist/
```

Project layout:

- `src/game/rules/` – pure TypeScript rules shared by the browser and the server
- `src/game/online/` – server-authoritative online match (`match.ts`), protocol types, room codes
- `src/net/` – browser side: `onlineClient.ts` (WebSocket + reconnect), `identity.ts` (Google / guest), `googleSignIn.ts`
- `worker/` – Cloudflare Worker (`src/index.ts`), `MatchRoom` and `Accounts` SQLite Durable Objects, `wrangler.jsonc`

## Deploy (Cloudflare free plan, no credit card)

1. Create a free account at <https://dash.cloudflare.com/sign-up>.
2. Log in once from the project folder: `npx wrangler login` (a browser tab asks you to allow access).
3. (Optional) Google sign-in, see the next section, then put the client ID in `worker/wrangler.jsonc` → `vars.GOOGLE_CLIENT_ID`.
4. Deploy the backend: `npm run deploy:worker`. The first deploy asks you to pick a free `*.workers.dev` subdomain and prints
   the URL, e.g. `https://veil-lane-server.<you>.workers.dev`. Check `https://…workers.dev/api/health` returns `{"ok":true,…}`.
5. Front end on Cloudflare Pages: Dashboard → **Workers & Pages → Create → Pages → Connect to Git**, pick this repository.
   - Build command: `npm run build` — Build output directory: `dist`
   - Environment variables: `VITE_WS_URL` = the Worker URL from step 4, and (optional) `VITE_GOOGLE_CLIENT_ID`.
   - Save and deploy. Your game is at `https://<project>.pages.dev`. CORS already allows `*.pages.dev` and localhost;
     add any custom domain to `ALLOWED_ORIGINS` in `worker/wrangler.jsonc`.

Free-plan notes: the Worker uses SQLite-backed Durable Objects only (`new_sqlite_classes`) and the WebSocket Hibernation API,
so idle rooms cost nothing. Idle rooms are deleted after 2 hours.

## Google sign-in (optional, free)

1. Open <https://console.cloud.google.com/>, create a project (e.g. "Veil Lane").
2. **APIs & Services → OAuth consent screen**: choose *External*, fill the app name and your email, save. (Only the basic
   `openid`/profile scopes are used; no Google API needs to be enabled.)
3. **APIs & Services → Credentials → Create credentials → OAuth client ID** → Application type **Web application**.
4. **Authorized JavaScript origins**: add `http://localhost:5173` and `http://localhost` (local dev) and your Pages URL,
   e.g. `https://veil-lane.pages.dev`. No redirect URI is needed.
5. Copy the client ID (`….apps.googleusercontent.com`) into:
   - `VITE_GOOGLE_CLIENT_ID` (Cloudflare Pages env var, or `.env.local` for local dev), and
   - `GOOGLE_CLIENT_ID` in `worker/wrangler.jsonc`, then `npm run deploy:worker` again.

If `VITE_GOOGLE_CLIENT_ID` is empty the Google button is hidden and only guest play is offered.
The Worker verifies the Google ID token itself (RS256 signature against Google's JWKS, `aud`, `iss`, `exp`), then issues its
own session token. Only the Google account id, a nickname and win/loss counts are stored. Email addresses are not stored,
and opponents only ever see the nickname.

## Data and credits

Card names and art are original. Lane statistics are aggregated counts derived from GRID pro-match data; no raw data files
are included.

## Music credits

"Suonatore di Liuto" by Kevin MacLeod (incompetech.com)
Licensed under Creative Commons: By Attribution 4.0 License
http://creativecommons.org/licenses/by/4.0/

"Clash Defiant" by Kevin MacLeod (incompetech.com)
Licensed under Creative Commons: By Attribution 4.0 License
http://creativecommons.org/licenses/by/4.0/
