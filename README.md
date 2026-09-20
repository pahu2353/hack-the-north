# Hack the North: Jev playground

Experiments with [Jev](https://vercel.com/ai-gateway/models/jev), TypeSafe AI's evaluation model on Vercel AI Gateway:

- **Commander**: command a squad of four AI agents with your voice, hand signals, and text. Jev turns each order into per-agent plans and drives every agent's split-second decisions.
- **Jev visualizer**: a playground for Jev's typed questions and probability answers.

## What is Jev?

Jev (`typesafe-ai/jev`) doesn't generate text. You give it some **state** (a string, object, or array) and a set of **typed questions**, and it returns probabilities:

| Question type | `criteria` | Answer |
| --- | --- | --- |
| `boolean` | optional `{ true, false }` descriptions | `probability` of true |
| `choice` | `{ optionKey: description }` (up to 255) | `choice` + `probabilities` per option |
| `score` | ordered levels, lowest → highest (2–10) | interpolated `score` + `probabilities` per level |

```ts
import { experimental_evaluate as evaluate } from 'ai';

const { answers } = await evaluate({
  model: 'typesafe-ai/jev',
  state: 'My card was charged twice for one order.',
  questions: {
    route: {
      type: 'choice',
      instructions: 'Route this support ticket.',
      criteria: { billing: 'payment problems', technical: 'bugs' },
    },
  },
});
// answers.route → { type: 'choice', choice: 'billing', probabilities: { billing: 1, technical: 0 } }
```

Pricing is $0.042 per 1M input tokens, with no charge for output. A request can be up to 64k tokens, and the state is capped at 32k of those. `experimental_evaluate` requires `ai` 7.0.105 or newer.

## Setup

1. Install Node.js 22.18 or later, which runs `.ts` files directly.
2. Run `npm install`.
3. Put your AI Gateway key in `.env.local`. This file is gitignored.
   ```
   AI_GATEWAY_API_KEY=...
   ```
   To create a key with the Vercel CLI, run `npx vercel@latest login`, then:
   `npx vercel@latest --scope <team-slug> ai-gateway api-keys create --name hack-the-north`
4. **Add a credit card to your Vercel team.** Without one, AI Gateway rejects every request with `403 customer_verification_required`, even though the free credits don't charge the card.
5. For voice orders in Commander, add a [Deepgram](https://deepgram.com) key to `.env.local`:
   ```
   DEEPGRAM_API_KEY=...
   ```

## Commander

```sh
npm run dev    # then open http://localhost:3000/commander/ in Chrome
```

A Valorant-style round (Spike Rush) where you're the commander. You don't play a unit yourself: you give orders, and Jev runs your four agents. Attackers (Alpha, Bravo, Charlie, Delta) win by planting the spike on A or B (stand on site for 3s) and keeping it alive for 35s, or by wiping the defenders. Defenders (Echo, Foxtrot, Golf, Hotel) win by stopping the plant for 100s, defusing the spike (stand on it for 6s with no attacker in sight), or wiping the attackers. Standing still makes shots far more accurate, so good fight-or-move decisions matter.

The start screen has:

- **Vs Bots:** you attack; four scripted defender bots hold posts, rotate to threatened sites, and retake the spike. The match runs in your browser.
- **Multiplayer:** you command against another person (see below).
- **3D:** a toggle for a 3D view. The button is there, but the 3D view isn't built yet.

### Multiplayer

1. One player clicks **Multiplayer → Create game**. They command the attackers and get a five-letter invite code and link.
2. The other player opens the link, or clicks **Multiplayer**, types the code, and joins as the defenders.
3. The host clicks **Start match**. After a round, the host can start a rematch.

The server runs the match, including both teams' Jev brains, and sends each player only what their own agents can see. Enemies show up in red while they're in sight, then fade to a dashed "last seen" marker. Your orders and Jev's decisions are never sent to your opponent. If a player leaves mid-round, the other wins by forfeit; if the host leaves, the room closes.

**Play online with one command.** To give friends anywhere a link:

```sh
npm run online
```

This opens a free Cloudflare tunnel (install it once with `brew install cloudflared`), starts the game server, prints a public `https://….trycloudflare.com` link, and opens the game in your browser. Invite links automatically use the public address, even though you play from `localhost`. Because the link is HTTPS, your friend's mic and camera work too. Ctrl+C stops everything, and the link stops working. The next run gets a new random link, and a brand-new link can take a minute to start working. Anyone with the link can use your Jev and Deepgram credits, so stop it when you're done. Stop `npm run dev` first (or use `PORT=3001 npm run online`), since both use port 3000.

**Same network, no tunnel.** `npm run dev:lan` lets other machines on your network join, and the invite link uses your network address automatically. Browsers only allow the mic and camera on HTTPS or localhost, so over a plain network address the guest can type orders and click the map but can't use voice or hand signals.

**Giving orders**

| Input | How |
| --- | --- |
| Voice | Hands-free: the mic turns on when a match starts, and each sentence becomes an order when you pause. Just say "Alpha and Bravo push B, Charlie hold mid, Delta flank A." The squad acts on the first clause while you're still talking (see below). **Mute** stops it; it only listens during matches. |
| Text | Type in the order box and press Enter. |
| Pointing | Click the map, or point your index finger **straight up** at the camera, to mark a spot. Then say or type "push there." A finger held sideways or down does nothing. |
| Hand signals | Click **Enable camera**, then hold a sign for about half a second: 👍 go (push to the marked spot), ✋ hold, ✊ regroup, 👎 fall back, ✌️ split into pairs, 🤟 special (attackers plant, defenders retake). |
| Switching agents | Hold your thumb out left or right, hitchhiker style. Keep holding and it keeps stepping through the squad, faster the longer you hold. Or swipe your hand, press ←/→ or 1–4, or click an agent on the top bar. |
| Switching views | Pinch your thumb and index finger, or press <kbd>Tab</kbd>. |
| Pausing | <kbd>Esc</kbd> opens the menu and holds a bot match until you resume. |
| Settings | From the menu or the pause screen: agent cards (off by default), kill feed, minimap, Jev numbers, control hints. Remembered per machine. |

**Look.** The interface is squared and dark with a single teal accent, the way a tactical
shooter's menus read; the first-person view and the radar follow CS instead — sand-and-stone
geometry in the view, and a round, player-centred radar with grey geometry and yellow site
letters.

**First-person view.** The map is the default view. Switch to first-person and you watch over one
agent's shoulder: their view of the map drawn in 3D, a minimap, and the top bar showing who is
alive on both sides. It's for monitoring, not aiming, so pointing, ✌️ split and 🤟 special are
map-view only, and every order you give in first-person goes to the agent you're watching alone.
You see only what that agent sees, while the map shows everything your team sees. Each agent has
their own shade (yours blue, theirs red) on the bar, the map, in 3D and on their card. The top bar
keeps both full squads on screen all match, in one strip: a red cross once you know they're down,
and dimmed while nobody on your team can see them.

**Mic and camera.** Both are required to play: you command the squad by voice and hand signal.
The side panel has one **Allow mic and camera** button. Your answer is
remembered on that machine (in `localStorage`), so later visits turn them back on without asking,
and the button disappears once both are running. The mic only listens during matches, the camera
never leaves the browser, and hand signals are ignored while a menu is open. Left alone,
attackers rush the nearer site and shoot what they meet; defenders hold their posts.

**How Jev is used.** Two layers, both plain typed questions:

1. **Order interpretation.** Each order (voice transcript, text, or a hand signal's meaning, plus where you're pointing) goes to Jev in one call. One question asks whether it's an order at all, which matters with a hands-free mic: on labelled examples, chatter like "nice shot" scores 5–14% while real orders score 89–97%, so chatter is ignored and shown greyed out in the log. Three more questions per agent ask whether the order applies to them (boolean), what order (choice: push, hold, flank, retreat, regroup, plant or defuse), and which location (choice of map zones, or the pointed spot). The log shows what Jev decided and how confident it was.
2. **Agent brains.** Like Jev playing Doom, each agent in a fight sends its situation to Jev about twice a second: health, order, enemies in sight, teammates in fights, and the spike. It gets back an action (fight, take cover, advance, hold, support) and which enemy to shoot. Each card at the bottom shows an agent's current action probabilities. Out of contact, agents just follow orders without calling Jev.

**Spoken orders act early.** Waiting for a finished sentence makes the squad feel sluggish: a five-second order used to take about 5.2s to move anyone. So the partial transcript is interpreted while you're still speaking, those orders are applied straight away (shown with a ⚡ in the log), and the finished sentence corrects them. Measured on the same recorded order, the squad starts moving after about 1.4s instead of 5.2s, with the final orders landing at the same moment as before. A guess that arrives late can't overwrite newer orders: every interpretation carries a sequence number, and the server drops stale ones.

Hand tracking is MediaPipe's gesture recognizer running in the browser. Voice streams through the local server to Deepgram, so the key never reaches the browser.

**Legacy: Titan Siege.** The earlier Commander Erwin scenario (Levi, Mikasa, Hange, and Armin holding a gate against waves of titans) lives on as a standalone snapshot at `/legacy/erwin/` (`public/legacy/erwin/`).

**Vs Bots: who commands the defenders.** Choosing **Vs Bots** asks which opponent you want:

- **Scripted bots** (no key needed): hold posts, rotate to callouts, retake the spike.
- **OpenAI commander**: an OpenAI model plans the defense every few seconds from the defenders'
  own sightings, and replans when it loses someone, spots a push, or the spike goes down. Orders
  are bounded (`hold`, `rotate`, `flank`, `retreat`, `regroup`, `retake` plus a zone) and
  validated server-side, so a bad answer can never move a defender somewhere illegal. If the
  model is slow or unavailable, the bots fall back to scripted tactics and the panel says so.
  The side panel shows its current plan and why it replanned.

It needs `OPENAI_API_KEY` or `AI_GATEWAY_API_KEY` in `.env.local`; set `OPENAI_BOT_MODEL` to
override the model (default `gpt-5.6-sol`). `npm run mock` (or `OPPONENT_MOCK=1`) plans without
calling OpenAI, and `npm run test:bot-mode` runs the opponent's tests.

## Jev visualizer

```sh
npm run dev    # http://localhost:3000, restarts on server changes
npm run mock   # fake, deterministic answers; no API key or credit needed
```

You edit the state and questions on the left. On the right, each answer is drawn as a chart:

- **boolean**: a probability meter.
- **choice**: the distribution across options, with the chosen option highlighted.
- **score**: the distribution across levels, plus a marker for the interpolated score.

With **Live** on, it re-evaluates about 450 ms after you stop typing. Only one request runs at a time. Each question gets a sparkline of how its answer moved over the last 30 calls. The stats row shows latency, input tokens, and cost. Any `ratelimit`/`retry-after` response headers show up under the stats row.

The server calls Jev with `maxRetries: 0`, so errors such as 429s appear immediately instead of being retried. It listens on `localhost` only, because it spends your Gateway credits.

## Files

| File | What it is |
| --- | --- |
| `server.ts` | Serves `public/`, proxies `POST /api/evaluate` to Jev, and relays `/api/voice` to Deepgram, keeping both keys server-side |
| `opponent.ts` | The OpenAI commander for the defender bots: snapshot validation, the plan schema, and the model call |
| `multiplayer.ts` | Multiplayer rooms: invite codes, the server-side match loop, and per-team views over `/api/room` |
| `public/commander/` | Commander: `main.js` (UI, lobby), `brain.js` (Jev calls), `sim.js` (rules, bots, per-team views), `world.js` (map, pathfinding), `render.js` (top-down), `pov.js` (first-person raycaster), `voice.js`, `gestures.js` |
| `public/legacy/erwin/` | The Titan Siege (Commander Erwin) version, kept as a standalone snapshot |
| `public/index.html` | The visualizer UI (a single file, no build step) |
| `scripts/play-online.sh` | `npm run online`: tunnel + server + public link in one go |
| `scripts/rate-limit-probe.ts` | Measures Jev's rate limit on your tier |
| `index.ts` | Minimal `generateText` example: `node --env-file=.env.local index.ts` |

## Rate limits we measured

On the free tier, Jev allowed about 5 requests and then returned 429s for several minutes. After buying AI Gateway credits there were no 429s up to TypeSafe's published limit of 1,200 requests/min. The only errors were occasional `503 service_unavailable` responses from an overloaded upstream (2–14% depending on load), which a retry fixes. In Commander, each squad in a firefight makes about 5 Jev calls a second (a multiplayer match runs two squads, with each agent thinking a little less often to stay well under the limit).

## Links

- [Jev model page](https://vercel.com/ai-gateway/models/jev)
- [AI Gateway evaluation docs](https://vercel.com/docs/ai-gateway/modalities/evaluation)
- [Guide: classify, route, and score with Jev and the AI SDK](https://vercel.com/kb/guide/typesafe-jev-and-ai-sdk)
