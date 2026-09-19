# Hack the North: Jev playground

A proof-of-concept playground for [Jev](https://vercel.com/ai-gateway/models/jev), TypeSafe AI's evaluation model on Vercel AI Gateway.

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
| `server.ts` | Serves the page and proxies `POST /api/evaluate` to Jev, keeping the key server-side |
| `public/index.html` | The visualizer UI (a single file, no build step) |
| `index.ts` | Minimal `generateText` example: `node --env-file=.env.local index.ts` |

## Links

- [Jev model page](https://vercel.com/ai-gateway/models/jev)
- [AI Gateway evaluation docs](https://vercel.com/docs/ai-gateway/modalities/evaluation)
- [Guide: classify, route, and score with Jev and the AI SDK](https://vercel.com/kb/guide/typesafe-jev-and-ai-sdk)
