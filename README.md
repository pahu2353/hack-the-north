# Hack the North: Jev playground

Experiments with [Jev](https://vercel.com/ai-gateway/models/jev), TypeSafe AI's evaluation model on Vercel AI Gateway:

- **Commander**: command a squad of five AI agents with your voice, hand signals, and text. Jev turns each order into per-agent plans and drives every agent's split-second decisions.
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
6. For **Hard** bot matches, add a direct OpenAI key:
   ```
   OPENAI_API_KEY=...
   ```
   The opponent prefers this key when present, otherwise uses AI Gateway. Jev still uses
   `AI_GATEWAY_API_KEY`; voice still uses `DEEPGRAM_API_KEY`. Keys stay on the server.

## Commander

```sh
npm run dev    # then open http://localhost:3000/commander/ in Chrome
```

A Valorant-style match (Spike Rush) where you're the commander. You don't play a unit yourself: you give orders, and Jev runs your five agents. Shooting is always automatic; in first-person, keeping your crosshair on an enemy improves that agent's accuracy while it follows your movement orders. Attackers (Alpha, Bravo, Charlie, Delta, Echo) win by planting the spike on A or B (stand on site for 3s) and keeping it alive for 35s, or by wiping the defenders. Defenders (Foxtrot, Golf, Hotel, India, Juliett) win by stopping the plant for 100s, defusing the spike (stand on it for 6s with no attacker in sight), or wiping the attackers before the plant. Standing still makes automatic shots far more accurate, so good fight-or-move decisions matter.

If all attackers die after planting, the round continues: surviving defenders can still defuse,
and neither side gets a point until the round is decided. If both squads die with the spike
planted, attackers win because nobody can defuse. Losing your whole squad in first-person returns
you to the map so you can follow the remaining spike timer.

**A match is a best of three.** Each round opens with **ten seconds of setup**: you can move and give orders, but neither squad may cross into more than its own third of the map (a dashed line shows how far), and nobody can shoot or throw until the round goes live. Between rounds you get the score and a scoreboard of everyone's kills, deaths and damage for the match so far. The map is always drawn with your own side at the bottom, so commanding the defence turns it around.

**Everyone starts with 150 HP.** Rifles deal 28 damage every 0.22s at most: six hits to eliminate a full-health unit. Automatic fire has 0.38 base accuracy before distance, movement and standing-still modifiers (previously 0.55). Aligning the first-person crosshair with a visible enemy raises hit probability to 90% while stationary or 80% while moving, with the same damage, range, reaction time and cooldown. Looking elsewhere keeps normal automatic shooting without the bonus. These rules apply equally to both sides, both difficulties and multiplayer. This is an initial balance pass; match difficulty still needs playtesting.

**Everyone carries one grenade**, which punishes squads walking around as one clump. It can be thrown 26m, has a 6m blast radius and deals up to 85 damage at the centre. It lands, waits a second and a half (a red ring shows the blast and time left), then goes off; walls block it. Jev throws at clusters and can scatter out of nearby grenades. One central blast now leaves a full-health agent at 65 HP. You can also order one: "nade B site", or point at the map and say "grenade there". The 💣 on an agent's card means they still have theirs.

The start screen has:

- **Vs Bots:** choose Attack or Defend, then **Easy** (scripted bots) or **Hard** (OpenAI commander). Difficulty changes the opposing commander, not its health or weapon stats. The match runs in your browser, with AI requests relayed through the server.
- **Multiplayer:** you command against another person (see below).

During a match, press **Tab** or pinch to switch between the team map and one agent's
first-person view, with a minimap. Orders in first-person address only the watched agent.

### Multiplayer

1. One player clicks **Multiplayer → Create game** and gets a five-letter invite code and link. In the lobby, the host chooses **Attack** or **Defend**.
2. The other player opens the link, or enters the code, and joins the opposite side. Changing the host's side updates both players before the match.
3. The host clicks **Start match**. Rounds of the best-of-three run one after another, with a short break on the scoreboard between them. Once the match is decided, **Rematch** keeps the sides; **Swap sides for rematch** returns both players to the lobby with their sides reversed. Sides are locked during a match, and the room creator remains the host on either side.

The server runs the match, including both teams' Jev brains, and sends each player only what their own agents can see. Enemies show up in red while they're in sight, then fade to a dashed "last seen" marker. Your orders and Jev's decisions are never sent to your opponent. If a player leaves during an unfinished match, including the break between rounds, the other wins the match by forfeit. An active round is scored once; completed rounds and their stats stay unchanged. The result explains the forfeit even if the winner was behind on points. If the host leaves, the room closes.

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
| Hand signals | Turn on the camera in the side panel, then hold a sign for about half a second: 👍 go (push to the marked spot), ✋ hold, ✊ regroup, 👎 fall back, ✌️ split into pairs, 🤟 special (attackers plant, defenders retake). |
| Switching agents | Hold your thumb out left or right, hitchhiker style. Keep holding and it keeps stepping through the squad, faster the longer you hold. Or swipe your hand, press ←/→ or 1–5, or click an agent on the top bar. |
| Switching views | Pinch your thumb and index finger, or press <kbd>Tab</kbd>. |
| First-person aiming | Shooting stays automatic. Click the 3D canvas once for mouse look, then keep your crosshair on an enemy for better accuracy. Green crosshair = aim bonus active. Esc releases the cursor. |
| Pausing | <kbd>Esc</kbd> opens the menu and holds a bot match until you resume. |
| Settings | From the menu or the pause screen: agent cards (off by default), kill feed, minimap, Jev numbers, control hints. Remembered per machine. |

**Look.** The interface is squared and dark with a single teal accent, the way a tactical
shooter's menus read; the first-person view and the radar follow CS instead — sand-and-stone
geometry in the view, and a round, player-centred radar with grey geometry and yellow site
letters.

**First-person view.** The map is the default view. Switch to first-person to see one agent's
view, with a minimap and the top bar showing who is alive on both sides. Shooting stays automatic;
there is no fire button. Click the canvas once to enable mouse look, then move the mouse to put
an enemy under the crosshair. That enemy becomes the shooting target and gets the accuracy bonus.
A green crosshair confirms alignment; a white hit marker confirms an assisted hit. Looking away
keeps the agent shooting normally at its own target, with normal accuracy. Merely entering the
view gives no bonus. Walls, range and the enemy's on-screen height still matter. There is no
headshot bonus or friendly fire. The agent still follows orders, moves and dodges; you do not
steer it with WASD. Other agents stay autonomous.

Switch agents with ←/→, 1–5, or hand signals; only the watched agent can get the aim bonus. Esc
releases the mouse, then Esc again opens the menu. Map view, menus, leaving the tab or ending the
round stop the aim assistance. In multiplayer the server validates ownership and alignment and
removes the bonus if aim updates stop for 0.6s. No AI call or click is needed to fire.

Pointing, ✌️ split and 🤟 special remain map-view only, and every order you give in first-person goes to the agent you're watching alone.
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

1. **Order interpretation.** Each order (voice transcript, text, or a hand signal's meaning, plus where you're pointing) goes to Jev in one call. One question asks whether it's an order at all, which matters with a hands-free mic: on labelled examples, chatter like "nice shot" scores 5–14% while real orders score 89–97%, so chatter is ignored and shown greyed out in the log. Three more questions per agent ask whether the order applies to them (boolean), what order (choice: push, hold, flank, retreat, regroup, plant or defuse), and which location (choice of map zones, or the pointed spot). The log shows what Jev decided and how confident it was. If replies arrive out of order, an older reply cannot replace a newer accepted order for the same agent; chatter and orders for other agents don't cancel it.
2. **Agent brains.** Like Jev playing Doom, each agent in a fight sends its situation to Jev about twice a second: health, order, enemies in sight, teammates in fights, and the spike. It gets back an action (fight, take cover, advance, hold, support, throw or dodge a grenade) and which enemy to shoot. Each card at the bottom shows an agent's current action probabilities. Out of contact, agents just follow orders without calling Jev, unless a nearby hostile grenade needs a decision. A late tactical reply for a replaced order is discarded.

**Command memory.** Each agent keeps one current objective in game state, and every Jev tactical
request includes it. New commands replace only the addressed agents' orders. Every input type
(text, partial or final voice, and hand signals) gets the squad's current orders and the last three
accepted commands to help resolve follow-ups such as "Bravo do the same." Chatter, failed requests
and replies that apply to nobody do not enter that history. Requests are remembered in submission
order even when their replies arrive out of order. Memory resets each round; there is no queue for
multi-step instructions such as "push A, then rotate B."

Fresh orders have three seconds of enforced priority, except for grenade danger. The objective
does **not** expire afterward: Jev can temporarily choose combat or cover, and agents resume their
saved destination when contact ends. "Hold B" means move to B first, then hold there. A completed
grenade order becomes "hold here." Turn on agent cards in Settings to compare **Order** with the
current action; first-person also shows both. First-person commands address only the watched agent.

**Spoken orders act early.** Waiting for a finished sentence makes the squad feel sluggish: a five-second order used to take about 5.2s to move anyone. So the partial transcript is interpreted while you're still speaking, those orders are applied straight away (shown with a ⚡ in the log), and the finished sentence corrects them. Measured on the same recorded order, the squad starts moving after about 1.4s instead of 5.2s, with the final orders landing at the same moment as before. A guess that arrives late can't overwrite newer orders: every interpretation carries a sequence number, and the server drops stale ones.

Hand tracking is MediaPipe's gesture recognizer running in the browser. Voice streams through the local server to Deepgram, so the key never reaches the browser.

**Vs Bots: choose your side and difficulty.** Attack with Alpha, Bravo, Charlie, Delta and Echo, or defend with Foxtrot, Golf, Hotel, India and Juliett. The opposing bots are E1–E5. **Next round** plays on with the same score; after the match, a rematch keeps your selected side and difficulty.

- **Easy — scripted bots** (no opponent API calls; your Jev squad still needs the Gateway key): defenders hold posts, rotate to callouts and retake; attackers push B, recover the spike and plant.
- **Hard — OpenAI commander**: an OpenAI model plans for its side every few seconds from its squad's
  own sightings, and replans when it loses someone, spots an enemy moving into a new zone, or the spike goes down.
  Defender orders are `hold`, `rotate`, `flank`, `retreat`, `regroup`, and `retake`.
  Attacker orders are `hold`, `push`, `flank`, `retreat`, `regroup`, and `plant`.
  Each order names a map zone and is validated server-side. If the
  model is slow or unavailable, the bots fall back to scripted tactics and the panel says so.
  The side panel shows its current plan and why it replanned.

It needs `OPENAI_API_KEY` or `AI_GATEWAY_API_KEY` in `.env.local`; set `OPENAI_BOT_MODEL` to
override the model (default `gpt-5.6-sol`). `npm run mock` (or `OPPONENT_MOCK=1`) plans without
calling OpenAI, and `npm run test:bot-mode` runs the opponent's tests.

The default uses low reasoning effort with an eight-second server timeout. Routine replanning
waits five seconds after the previous response, so response latency adds to the interval.
Sightings, casualties, emergency retreats, grenade use or nearby hostile landings, and plants can trigger earlier requests, with at most
one request running at a time. Each request contains the bot squad's health, positions,
orders and local combat counts, sightings from the last eight seconds, and the public planted spike state.
Attacking bots also know their own carrier and dropped spike position; defending bots do not.
It has no conversation history or memory across rounds. The returned action and zone are
executed by the bot controller: movement usually stops on contact, except during
retreat/regroup and coordinated retakes. OpenAI chooses objectives; game code chooses paths and cover.
The **Enemy commander** panel shows the model, plan, latency, and any fallback error.

On both sides, OpenAI also sees each bot's grenades remaining, nearby teammates at risk of sharing
a blast, reachable enemy clusters, and which bots are dodging. Active grenades include their public
positions, teams and remaining fuse after landing; hidden landing targets and enemy grenade supplies
are not sent. Its instructions explain blast damage, walls, safe spacing and how to support a squad
during a dodge. Throws and dodges still run immediately in game code, including while OpenAI is slow
or unavailable. Bots ignore friendly grenades and blasts blocked by walls, stay clear until a hostile
blast ends, then resume their orders. The enemy plan details show dodging and remaining grenades.
Grenade events share the existing two-second minimum request interval, debounce and failure backoff.

When OpenAI orders at least two defenders to retake, they assemble at their site's Link or rear
hallway, favoring a route protected from recent sightings. Most of the assigned group must arrive
(four of five bots) before they advance together. Waiting ends early if only one survives,
a teammate is already defusing, or the remaining spike timer approaches travel time plus the
six-second defuse and a two-second margin. Emergency cover reflexes still apply. The panel shows
the rally location and ready count; OpenAI receives the current coordination phase. Renewed
retake orders preserve progress, and cancelled or expired orders clear the rally.

Run `npm test` for all tests, including command ordering, persistent elimination knowledge,
first-person visibility and shooting, multiplayer aim ownership and side selection, attacking bots and coordinated retakes.
These tests use local fixtures without API calls; multiplayer tests open temporary localhost ports.

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
| `opponent.ts` | The OpenAI commander for either side: snapshot validation, side-specific plan schemas and prompts, and the model call |
| `multiplayer.ts` | Multiplayer rooms: invite codes, the server-side match loop, and per-team views over `/api/room` |
| `public/commander/` | Commander: `main.js` (UI, lobby), `brain.js` (Jev calls), `sim.js` (rules, bots, per-team views), `world.js` (map, pathfinding), `render.js` (top-down), `pov.js` (first-person raycaster), `voice.js`, `gestures.js` |
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
