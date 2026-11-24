# Veil Lane

Hidden-card lane duel built with Vite + TypeScript + Phaser 4 (Cloud9 x JetBrains "Sky's The Limit" 2026, Event Mini Game).
Lanes are played in order (Top → Support). Each lane, both players are dealt their own two random cards and secretly
play one. A card that synergizes with cards you already played glows gold and shows its bonus: per the aggregated
pro-match synergy table, a card's best partner adds +5%, then +4/+3/+2/+1% (`SYNERGY_TIER`). When the lane flips, the
partner cards pop out and add their bonus on screen. A card can serve as a synergy partner only once per round (it can still
be played as a main card), and this resets every round. Lane score = matchup win rate + order bonus (+5…+1%) + synergy.
Best of 3, Fearless: a card you played is never dealt to you again in the match.

The public Worker for this project is already deployed at
<https://veil-lane-server.jayren1121.workers.dev>. For the frontend, set
`VITE_WS_URL=wss://veil-lane-server.jayren1121.workers.dev`.

## Modes

- **Online battle**: two players on two computers. Create a room (4-character code + invite link `?room=XXXX`) or join one.
  The server (Cloudflare Worker + Durable Object) holds the hidden picks and runs the rules, so neither browser
  ever receives the opponent's unrevealed cards.
- **Local 2-player**: the original hot-seat mode, no server needed.
- **Accounts**: "Sign in with Google" keeps a nickname and win/loss record. "Play as guest" (nickname only) works
  without any account, so judges can try it instantly.
- **Battle timer**: each lane pick has a 20-second countdown per player (`BATTLE_TURN_SECONDS` in
  `src/game/rules/constants.ts`). It turns red for the last 5 seconds; on timeout one of the two offered cards is played
  at random. Online, the server enforces it with Durable Object alarms. Local mode accepts `?seed=N` for reproducible deals.

## Develop

```bash
npm install
npm test                 # vitest (rules, online match, timers, room codes, Google token checks)
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
