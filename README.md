# Hack the North: Jev playground

Experiments with [Jev](https://vercel.com/ai-gateway/models/jev), TypeSafe AI's evaluation model on Vercel AI Gateway:

- **Jev Commander**: command a squad of four AI agents with your voice, hand signals, and text. Jev turns each order into per-agent plans and drives every agent's split-second decisions.
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
5. For voice orders in Jev Commander, add a [Deepgram](https://deepgram.com) key to `.env.local`:
   ```
   DEEPGRAM_API_KEY=...
   ```

## Jev Commander

```sh
npm run dev    # then open http://localhost:3000/commander/ in Chrome
```

You're the commander. You don't play a unit yourself: you give orders, and Jev runs the squad.

**Scenarios**

- **Spike Rush (Valorant-style):** Alpha, Bravo, Charlie, and Delta attack against four defender bots. Plant the spike on A or B (stand on site for 3s) and hold it for 35s, or wipe the defenders. Standing still makes shots far more accurate, so good fight-or-move decisions matter.
- **Titan Siege (Commander Erwin):** Levi, Mikasa, Hange, and Armin hold the gate for 150s against five waves of small, big, and abnormal titans. Blades only kill from behind: titans telegraph each grab with a windup (red cone) and freeze while recovering (dashed ring), and that's the moment to cut the nape.

**Giving orders**

| Input | How |
| --- | --- |
| Voice | Click **Enable mic**, then hold **V** (or the talk button) and speak: "Alpha and Bravo push B, Charlie hold mid, Delta flank A." |
| Text | Type in the order box and press Enter. |
| Pointing | Click the map, or point your index finger at the camera, to mark a spot. Then say or type "push there." |
| Hand signals | Click **Enable camera**, then hold a sign for about half a second: 👍 go (push to the marked spot), ✋ hold, ✊ regroup, 👎 fall back, ✌️ split into pairs, 🤟 special (plant the spike / all-out attack). |

**How Jev is used.** Two layers, both plain typed questions:

1. **Order interpretation.** Each order (voice transcript, text, or a hand signal's meaning, plus where you're pointing) goes to Jev in one call, with three questions per agent: does the order apply to them (boolean), what order (choice: push, hold, flank, retreat, regroup, plant…), and which location (choice of map zones, or the pointed spot). The log shows what Jev decided and how confident it was.
2. **Agent brains.** Like Jev playing Doom, each agent sends its own situation to Jev about twice a second: health, order, enemies in sight, teammates in fights, and the spike or titan status. It gets back an action (fight, take cover, advance, support; or strike, flank, evade in Titan Siege) and which target to go for. Each card at the bottom shows an agent's current action probabilities.

By default, the opposing side is scripted: defenders hold posts, rotate to threatened sites, and retake the spike; titans chase the nearest scout or head for the gate. Spike Rush also has an OpenAI opponent option, described below. Hand tracking is MediaPipe's gesture recognizer running in the browser. Voice streams through the local server to Deepgram, so the key never reaches the browser.

### Bot mode: you + Jev vs OpenAI

In **Spike Rush**, choose **Opponent → OpenAI commander**, then Start. You give your squad
orders as usual; Jev still runs your agents. GPT-5.6 Sol now coordinates the four enemy
defenders. Titan Siege continues to use its scripted enemies. Changing the opponent starts a fresh round.
Your squad currently always attacks; side selection and automatic side swaps are not implemented.

The enemy commander assigns each defender a zone and one of `hold`, `rotate`, `flank`,
`retreat`, `regroup`, or `retake`. It normally replans five seconds after an answer. New sightings,
attackers spotted in a different zone, and defender casualties trigger an earlier rethink:
events are collected for 350 ms, with at least two seconds between combat-triggered requests.
An emergency fallback also prompts an early rethink so Sol can arrange support.
Planting the spike triggers a rethink as soon as any pending request finishes. Only one request
runs at a time; battlefield changes during that request are considered for the next plan.
Repeating an active order extends its lifetime while preserving flank progress, paths, and cover.
`hold` keeps a defender's position when they are already in the named zone. `regroup` moves
them to a shared rally zone even under fire, then waits for the next order.
Shooting, movement, pathfinding, cover reflexes, and defusing remain normal game code.
The model sees the defenders' state, their sightings from the last eight seconds, and the public
planted-spike state. It does not receive your orders, pointer, or hidden squad positions.

**Responding to a squad rush.** In OpenAI mode, defenders immediately seek cover when visible
attackers outnumber their local group at least two to one, or when they are below 50 HP and
outnumbered. Local support counts living allies within 12m who can see the defender or cover
one of the same enemies from another angle. This reflex runs in the simulation without waiting
for a model response. After breaking sight, they keep the escape point for up to four seconds,
resuming sooner if enough support arrives;
an explicit retreat or regroup order can take over the withdrawal.

Sol receives each defender's visible enemy count, nearby ally count, and fallback status. Its
strategy is to give ground and gather the team against a confirmed 3–4-person push, with permission
to leave the quiet site. A lone sighting should not pull everyone away, and an imminent spike
detonation takes priority over staging a distant regroup. These are commander instructions,
not a guarantee that every generated plan will be optimal. Weapon damage and accuracy are unchanged.

The default opponent model is **`gpt-5.6-sol` with low reasoning**. Run `npm run dev` normally;
no model override is needed. Low reasoning reduces planning overhead; requests time out
after eight seconds on the server.

The existing setup uses two keys in `.env.local`, both kept on the server:

| Feature | Model / processor | Key |
| --- | --- | --- |
| Your squad's order interpretation and agent decisions | `typesafe-ai/jev` | `AI_GATEWAY_API_KEY` |
| OpenAI enemy commander | `openai/gpt-5.6-sol`, low reasoning | The same `AI_GATEWAY_API_KEY` |
| Voice transcription | Deepgram `nova-3` | `DEEPGRAM_API_KEY` |
| Hand gestures | MediaPipe, locally in the browser | None |

A separate OpenAI key is optional. If `OPENAI_API_KEY` is set, the enemy commander uses the
direct OpenAI API instead of Gateway; your squad still uses Gateway for Jev. To override the
opponent model, set its OpenAI model ID without the `openai/` prefix:

```sh
# Optional; this is already the default:
OPENAI_BOT_MODEL=gpt-5.6-sol
```

GPT-5/6 overrides also use low reasoning; older non-reasoning models omit that setting.
The direct API uses
[OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
to constrain the plan; both provider paths also validate unit IDs, actions, and destinations
before applying it.

The standalone `index.ts` holiday example uses `openai/gpt-5.5` to check Gateway connectivity.
It is independent of the game and does not select the opponent model.

The opponent status shows planning, model/latency, or a fallback. **Inspect enemy plan (demo)**
reveals the latest strategy, per-defender orders, and the event that triggered the plan, such as
“E1 eliminated · 2 attackers spotted at B Main.” While a request is pending, its trigger appears
above the current plan. Leave this panel closed for regular play to keep enemy intel hidden.
Defender rows also show active escape reflexes, for example “taking cover (1 vs 4),” alongside
the order they will resume.
On timeout, invalid output, or missing credentials, scripted defenders take over and the commander
retries after ten seconds; combat and plant events respect this failure backoff.
Plans expire after twelve simulation seconds. Restarting cancels pending requests, and responses
from an older battlefield state are discarded when the objective changes.

```sh
npm run mock          # both Jev and the opponent use fake answers; no keys needed
OPPONENT_MOCK=1 npm run dev  # mock only the enemy commander; keep Jev live
npm run test:bot-mode
```

Mock opponent plans are labeled **MOCK**. The existing Jev mock generates seeded probabilities;
it is a wiring check, not a real natural-language interpreter or measure of AI skill.

For integration: `public/commander/opponent.js` owns snapshots, plan application, and the async
commander loop; `opponent.ts` owns the server adapter at `POST /api/opponent`. The only simulation
hooks are `createGame('tactical', { opponent: 'openai' })` and defender order execution. The module
has no DOM dependency, so the 3D renderer can reuse it. The player's `brain.js` is unchanged.

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
| `server.ts` | Serves `public/`, handles `/api/evaluate` (Jev) and `/api/opponent` (OpenAI), and relays `/api/voice` to Deepgram; credentials stay server-side |
| `opponent.ts` | OpenAI enemy commander: model configuration, structured plans, validation, and mock responses |
| `public/commander/` | Jev Commander: `main.js` (UI), `brain.js` (Jev calls), `opponent.js` (enemy intel and planning loop), `sim.js` (game rules and bots), `world.js` (maps, pathfinding), `render.js`, `voice.js`, `gestures.js` |
| `tests/opponent.test.js` | Bot-mode checks for plans, execution, provider requests, and failure recovery |
| `public/index.html` | The visualizer UI (a single file, no build step) |
| `scripts/rate-limit-probe.ts` | Measures Jev's rate limit on your tier |
| `index.ts` | Standalone GPT-5.5 Gateway example: `node --env-file=.env.local index.ts`; independent of the game model |

## Rate limits we measured

On the free tier, Jev allowed about 5 requests and then returned 429s for several minutes. After buying AI Gateway credits there were no 429s up to TypeSafe's published limit of 1,200 requests/min. The only errors were occasional `503 service_unavailable` responses from an overloaded upstream (2–14% depending on load), which a retry fixes. Jev Commander uses about 5 Jev calls a second while all four agents are alive.

## Links

- [Jev model page](https://vercel.com/ai-gateway/models/jev)
- [AI Gateway evaluation docs](https://vercel.com/docs/ai-gateway/modalities/evaluation)
- [Guide: classify, route, and score with Jev and the AI SDK](https://vercel.com/kb/guide/typesafe-jev-and-ai-sdk)
