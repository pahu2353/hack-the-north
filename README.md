# Commander

Command a squad of five AI agents by voice, with your hands on the map. You never control a unit
yourself — you give orders, and [Jev](https://vercel.com/ai-gateway/models/jev) turns them into
per-agent plans and split-second combat decisions.

The repo also ships a small **Jev visualizer** for poking at the model directly.

## Setup

1. Node.js 22.18+ (it runs `.ts` files directly), then `npm install`.
2. Create `.env.local` (gitignored):
   ```
   AI_GATEWAY_API_KEY=...   # Jev, via Vercel AI Gateway — required
   DEEPGRAM_API_KEY=...     # speech to text — required for voice orders
   OPENAI_API_KEY=...       # only for Hard bot matches
   ```
   Your Vercel team needs a credit card on file, or AI Gateway returns
   `403 customer_verification_required` even on free credits.
3. `npm run dev`, then open <http://localhost:3000/commander/> in Chrome.

Other ways to run it:

| Command | What it does |
| --- | --- |
| `npm run mock` | Fake, deterministic Jev answers. No keys, no credits. |
| `npm run online` | Cloudflare tunnel + server + public HTTPS link (`brew install cloudflared` once). Stop `npm run dev` first. |
| `npm run dev:lan` | Same network only. No HTTPS, so guests get no mic or camera. |
| `npm test` | All tests. Local fixtures, no API calls. |

Anyone with an `npm run online` link spends your Jev and Deepgram credits, so stop it when
you're done.

## Game rules

A best-of-three, Valorant-style. **Attackers** (Alpha–Echo) plant the spike on A or B — stand on
site for 3s — and keep it alive for 35s, or wipe the defenders. **Defenders** (Foxtrot–Juliett)
stall the plant for 100s, defuse (6s on the spike with no attacker in sight), or wipe the
attackers before the plant.

- **Health and damage.** Human squads and Easy bots have 150 HP; Hard bots have 175 HP. Rifles do
  28 damage every 0.22s — six hits to kill a human/Easy unit, seven for a Hard bot. No headshots,
  no friendly fire.
- **Accuracy.** Shooting is always automatic; there is no fire button. Standing still helps a lot.
  Base accuracy is 0.38 for humans/Easy bots and 0.50 for Hard bots, before range/movement modifiers.
  In first person, holding your crosshair on a visible enemy gives that agent 70% standing / 50%
  moving accuracy **before** distance and moving-target penalties, with no extra idle bonus.
  At 20m against a stationary enemy, that's about 45% / 32%, versus 30% for a settled human/Easy
  agent or 40% for a settled Hard bot. Looking away just means normal automatic fire.
- **Grenades.** One each. 26m throw, 6m blast, up to 85 damage at the centre, 1.5s fuse with a red
  ring showing the blast. Walls block it. Punishes squads that walk as one clump. 💣 on an agent's
  card means they still have theirs.
- **Setup phase.** Each round opens with 10s where you can move and give orders but neither squad
  may cross past its own third of the map, and nobody can shoot.
- **After the plant.** If every attacker dies, the round continues — defenders can still defuse. If
  both squads die with the spike planted, attackers win, because nobody is left to defuse.
- **Maps.** *Tactical* (the default two-site layout) or *Dust II* (long sightlines, two ways into
  each site). Your own side is always drawn at the bottom.

**Vs Bots** lets you pick a side, a map, and a difficulty: **Easy** is scripted bots, **Hard** is an
OpenAI model commanding tougher bots with sharper aim and leading grenade throws. Damage and fire
rate stay the same. **Multiplayer** uses the human stats on both sides — one player creates a game and
picks side and map, the other joins on the five-letter code or link. The server runs the match and
sends each player only what their own agents can see; your orders are never visible to your
opponent.

## Giving orders

| Input | How |
| --- | --- |
| **Voice** | Hands-free by default: the mic opens when a match starts, and each sentence becomes an order when you pause. "Alpha and Bravo push B, Charlie hold mid, Delta flank A." Switch to hold-to-talk (<kbd>V</kbd>) in the side panel. |
| **Text** | Type in the order box, press Enter. |
| **Pointing** | Click the map, or point your index finger straight up at the camera, to mark a spot — then say "push there". |
| **Aiming** | In first person, raise a fist: the crosshair follows it. Shooting stays automatic. |
| **Switch agent** | ←/→, 1–5, click the top bar, or hold your thumb out sideways hitchhiker-style to step through the squad. |
| **Switch view** | <kbd>Tab</kbd> or a pinch. <kbd>G</kbd> toggles the 3D and 2D first-person renderers. |
| **Pause / settings** | <kbd>Esc</kbd>. Agent cards, kill feed, minimap, Jev numbers and control hints are all toggleable and remembered per machine. |

Mic and camera are both required — one **Allow mic and camera** button in the side panel, remembered
after that. The mic only listens during a match, the camera feed never leaves the browser, and your
hands are ignored while a menu is open. The camera does exactly three things: point at the map, aim
in first person, and change agent. Every order is spoken or typed — an order is easier to say than
to pose, and a misread pose used to send the squad somewhere you never asked for.

**First person.** The map is the default view; switch to see one agent's eyes plus a minimap. You
don't steer with WASD — the agent keeps following orders and dodging on its own. Click the canvas
once for mouse look — or just raise a fist and the crosshair follows it, with the middle of the
camera frame straight ahead and a fist held near an edge turning that way, so you can come all the
way round. Lower your hand and the agent goes back to firing on its own; a thumb out still changes
agent without lowering it. Put an enemy under the crosshair: green crosshair means the aim bonus is
live, a white marker confirms an assisted hit. Orders given in first person address only the agent
you're watching.

## Technical background

### What is Jev?

Jev (`typesafe-ai/jev`) doesn't generate text. You hand it some **state** and a set of **typed
questions**, and it returns probabilities:

| Type | `criteria` | Answer |
| --- | --- | --- |
| `boolean` | optional `{ true, false }` descriptions | `probability` of true |
| `choice` | `{ optionKey: description }`, up to 255 | `choice` + per-option probabilities |
| `score` | ordered levels, low → high (2–10) | interpolated `score` + per-level probabilities |

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
// answers.route → { choice: 'billing', probabilities: { billing: 1, technical: 0 } }
```

It costs $0.042 per 1M input tokens with no charge for output, which is what makes it cheap enough
to call several times a second. Requests cap at 64k tokens (32k of state) and need `ai` 7.0.105+.

### How Commander uses it

Two layers, both just typed questions:

1. **Order interpretation.** Every order — a voice transcript or typed text, plus wherever you're
   pointing — goes to Jev in one call. One question asks whether it's
   an order at all, which matters with a live mic: chatter like "nice shot" scores 5–14% while real
   orders score 89–97%, so chatter is greyed out in the log and ignored. Then three questions per
   agent: does this apply to you, what order (push, hold, flank, retreat, regroup, plant, defuse),
   and where.

**Saying it the way you'd say it.** The order question knows the words people actually use — move,
push, rush, run it down, rotate, peek, take; hold, camp, watch, anchor, lock down; lurk and swing
around; fall back, get out; stack up, on me — and the place question handles how orders really come
out: a correction ("A site, no wait, B site") takes the last place named; an order about the enemy
rather than the map ("go at them", "fight fight fight") sends them to wherever your team last saw
one, inside the fog of war; a bare verb ("move", "push") carries on to where they were already
headed instead of stopping; "take a site" is the A site, not "some site"; and "camp b" walks there
first, then holds. Follow-ups work too — "keep going" carries on, "Charlie you too" copies the order
just given to someone else — while enemy callouts ("two on b") stay chatter and change nothing.

`scripts/vocab-probe.mjs` is how that was tuned: 41 labelled phrasings plus 9 follow-up and chatter
cases, scored against the live gateway. The wording went from **25/41 orders, 10/41
order-and-place and 6/9 follow-ups** to **41/41, 41/41 and 9/9**. The biggest win wasn't vocabulary
at all: the questions used to point at the squad's current orders, so Jev answered with the order
they already had whatever you said — while pushing B Site, "nade mid" came back as a grenade on B
Site. Run it after changing any question wording:

```sh
node --env-file-if-exists=.env.local scripts/vocab-probe.mjs
```
2. **Agent brains.** In a fight, each agent sends its situation to Jev about twice a second —
   health, current order, visible enemies, teammates in contact, the spike — and gets back an action
   (fight, cover, advance, hold, support, throw or dodge a grenade) and a target. Out of contact
   they just follow orders without calling Jev. Agent cards show the live probabilities.

**Memory.** Each agent holds one current objective, and every tactical request includes it. New
orders replace only the agents they address. Each input also carries the squad's current orders and
the last three accepted commands, so follow-ups like "Bravo do the same" resolve. Fresh orders get
three seconds of priority (grenade danger excepted), but the objective doesn't expire — agents can
duck into cover and then resume. Memory resets each round; there's no queue for "push A, then
rotate B".

### Speech and hands together

Waiting for a finished sentence made the squad feel sluggish — a five-second order took ~5.2s to
move anyone. So partial transcripts are interpreted while you're still talking and applied
immediately (⚡ in the log), and the finished sentence corrects them. Same recorded order: first
movement at ~1.4s instead of ~5.2s, final orders landing at the same moment as before. Every
interpretation carries a sequence number, so a slow guess can never overwrite a newer order.

Hand tracking is MediaPipe's gesture recognizer, running entirely in the browser. Voice streams
through the local server to Deepgram, so that key never reaches the client. The two inputs meet in
the same interpretation call: what you say carries whatever spot you last marked — by click or by
pointing — as its location, which is what makes "push there" mean anything.

### The Hard bot

An OpenAI model (default `gpt-5.6-sol`, override with `OPENAI_BOT_MODEL`) plans for the opposing
squad every few seconds, and replans early when it loses someone, spots an enemy entering a new
zone, or the spike drops. It only sees its own squad's sightings from the last eight seconds, and
every returned order is a validated action plus a map zone. Game code still chooses paths, cover,
throws and dodges. If the model is slow or unavailable the bots fall back to scripted tactics and
the **Enemy commander** panel says so. `npm run mock` plans without calling OpenAI.

Hard bots move at 5m/s and react in 0.25s, matching an unboosted human agent. Easy bots move at
4.5m/s and react in 0.28–0.40s. The Hard stat advantages remain active during scripted fallback.
Hard bots favor visible enemies they can finish in fewer hits, continue flanks through contact
unless survival requires cover, and give all five bots distinct arrival and retake staging positions.

Before throwing, Hard bots observe a cluster for at least 0.12s, then lead its movement through
flight time **plus** the 1.5s fuse. They use observed positions, never the player's orders or future
path. Predictions stop at walls and lose direction after contact is lost; turning or stopping after
the throw can still evade it. Easy bots and player-issued grenade locations keep their existing
targeting. These combat decisions run without waiting for OpenAI. The endpoint accepts all ten
grenades in a five-versus-five round. Difficulty still needs playtesting against human first-person aim.

## Jev visualizer

`npm run dev`, then <http://localhost:3000>. Edit state and questions on the left; each answer is
charted on the right — a meter for booleans, a distribution for choices and scores. **Live**
re-evaluates ~450ms after you stop typing, with a sparkline of the last 30 calls and a stats row
for latency, tokens and cost. The server calls Jev with `maxRetries: 0` so 429s surface
immediately, and it binds to localhost only, because it spends your credits.

## Files

| File | What it is |
| --- | --- |
| `server.ts` | Serves `public/`, proxies `/api/evaluate` to Jev and `/api/voice` to Deepgram, keeping both keys server-side |
| `opponent.ts` | The OpenAI commander: snapshot validation, per-side plan schemas, the model call |
| `multiplayer.ts` | Rooms, invite codes, the server-side match loop, per-team views over `/api/room` |
| `public/commander/` | `main.js` (UI, lobby), `brain.js` (Jev calls), `sim.js` (rules, bots, visibility), `world.js` (maps, pathfinding), `render.js` (top-down), `pov3d.js` / `pov.js` (first person, WebGL and raycaster), `voice.js`, `gestures.js` |
| `public/index.html` | The visualizer, one file, no build step |
| `scripts/vocab-probe.mjs` | Scores how well Jev reads spoken orders, against the live gateway |
| `scripts/play-online.sh` | `npm run online` |
| `scripts/rate-limit-probe.ts` | Measures Jev's rate limit on your tier |

## Rate limits

On the free tier Jev allowed about 5 requests before returning 429s for several minutes. With AI
Gateway credits we saw none up to TypeSafe's published 1,200 req/min — only occasional
`503 service_unavailable` from an overloaded upstream (2–14% under load), which a retry fixes. A
squad in a firefight makes roughly 5 Jev calls a second; a multiplayer match runs two of them.

## Links

- [Jev model page](https://vercel.com/ai-gateway/models/jev)
- [AI Gateway evaluation docs](https://vercel.com/docs/ai-gateway/modalities/evaluation)
- [Guide: classify, route, and score with Jev and the AI SDK](https://vercel.com/kb/guide/typesafe-jev-and-ai-sdk)
