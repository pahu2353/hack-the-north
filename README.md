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
orders as usual; Jev still runs your agents. An OpenAI model now coordinates the four enemy
defenders. Titan Siege continues to use its scripted enemies. Changing the opponent starts a fresh round.

The enemy commander assigns each defender a zone and one of `hold`, `rotate`, `flank`,
`retreat`, or `retake`. It replans five seconds after an answer, or sooner when the spike is
planted. Shooting, movement, pathfinding, cover reflexes, and defusing remain normal game code.
The model sees the defenders' state, their sightings from the last eight seconds, and the public
planted-spike state. It does not receive your orders, pointer, or hidden squad positions.

Add either key to `.env.local` (keys stay on the server):

```sh
# Direct OpenAI API; preferred when both keys are present:
OPENAI_API_KEY=...
# Or reuse AI_GATEWAY_API_KEY, which is already required for Jev.

# Optional OpenAI model ID (without the "openai/" prefix):
OPENAI_BOT_MODEL=gpt-5.6-luna
```

The default opponent model is `gpt-5.6-luna` with low reasoning to keep decisions quick and
inexpensive. GPT-5/6 overrides also use low reasoning; non-reasoning models such as
`gpt-4.1-mini` omit that setting. The direct API uses
[OpenAI Structured Outputs](https://developers.openai.com/api/docs/guides/structured-outputs)
to constrain the plan; both provider paths also validate unit IDs, actions, and destinations
before applying it. Your squad still requires the existing AI Gateway configuration for live Jev.

The opponent status shows planning, model/latency, or a fallback. **Inspect enemy plan (demo)**
reveals the latest strategy and per-defender orders; leave it closed for regular play.
On timeout, invalid output, or missing credentials, scripted defenders take over and the commander
retries after ten seconds. Plans expire after twelve simulation seconds. Restarting cancels pending
requests, and responses from an older battlefield state are discarded when the objective changes.

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
| `server.ts` | Serves `public/`, proxies `POST /api/evaluate` to Jev, and relays `/api/voice` to Deepgram, keeping both keys server-side |
| `public/commander/` | Jev Commander: `main.js` (UI), `brain.js` (Jev calls), `sim.js` (game rules and bots), `world.js` (maps, pathfinding), `render.js`, `voice.js`, `gestures.js` |
| `public/index.html` | The visualizer UI (a single file, no build step) |
| `scripts/rate-limit-probe.ts` | Measures Jev's rate limit on your tier |
| `index.ts` | Minimal `generateText` example: `node --env-file=.env.local index.ts` |

## Rate limits we measured

On the free tier, Jev allowed about 5 requests and then returned 429s for several minutes. After buying AI Gateway credits there were no 429s up to TypeSafe's published limit of 1,200 requests/min. The only errors were occasional `503 service_unavailable` responses from an overloaded upstream (2–14% depending on load), which a retry fixes. Jev Commander uses about 5 Jev calls a second while all four agents are alive.

## Links

- [Jev model page](https://vercel.com/ai-gateway/models/jev)
- [AI Gateway evaluation docs](https://vercel.com/docs/ai-gateway/modalities/evaluation)
- [Guide: classify, route, and score with Jev and the AI SDK](https://vercel.com/kb/guide/typesafe-jev-and-ai-sdk)
