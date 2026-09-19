// Measures the rate limit for Jev through AI Gateway on this team's tier.
//
// Rate limits are a request count per time window, so instead of binary
// searching (which needs a full window reset per guess) this counts directly:
//   1. wait:    poll slowly until a request succeeds (any existing limit has reset)
//   2. ramp:    fire requests on a fixed schedule (not waiting for responses) at each
//               rate in --rates for --step-seconds, stopping at the first 429
//   3. recover: poll slowly until requests succeed again, timing the window
//
// Usage: node --env-file=.env.local scripts/rate-limit-probe.ts
//          [--rates 60,120,300,600,1200] [--step-seconds 60] [--poll-ms 15000] [--max-minutes 15]
//          [--allow-above-published]

import { parseArgs } from 'node:util';

const ENDPOINT = 'https://ai-gateway.vercel.sh/v1/evaluate';
const PUBLISHED_LIMIT_PER_MIN = 1200; // TypeSafe's own published Jev limit
const BODY = JSON.stringify({
  model: 'typesafe-ai/jev',
  state: 'ok',
  questions: { ok: { type: 'boolean', instructions: 'Is this ok?' } },
});

const { values } = parseArgs({
  options: {
    rates: { type: 'string', default: '60,120,300,600,1200' },
    'step-seconds': { type: 'string', default: '60' },
    'poll-ms': { type: 'string', default: '15000' },
    'max-minutes': { type: 'string', default: '15' },
    'allow-above-published': { type: 'boolean', default: false },
  },
});
const rates = values.rates.split(',').map(Number);
const stepMs = Number(values['step-seconds']) * 1000;
const pollMs = Number(values['poll-ms']);
const deadline = Date.now() + Number(values['max-minutes']) * 60_000;

if (!values['allow-above-published'] && rates.some(rate => rate > PUBLISHED_LIMIT_PER_MIN)) {
  throw new Error(`Rates above TypeSafe's published ${PUBLISHED_LIMIT_PER_MIN}/min need --allow-above-published`);
}
const apiKey = process.env.AI_GATEWAY_API_KEY;
if (!apiKey) throw new Error('AI_GATEWAY_API_KEY is not set; run with --env-file=.env.local');

type Result = { status: number; sentAt: number; ms: number; body: string; headers: string };

const t0 = Date.now();
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const at = (time: number) => `+${((time - t0) / 1000).toFixed(1)}s`;

async function call(): Promise<Result> {
  const sentAt = Date.now();
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: BODY,
    });
    const body = await res.text();
    const headers = [...res.headers]
      .filter(([key]) => /ratelimit|retry-after/i.test(key))
      .map(([key, value]) => `${key}=${value}`)
      .join(' ');
    return { status: res.status, sentAt, ms: Date.now() - sentAt, body, headers };
  } catch (error) {
    return { status: 0, sentAt, ms: Date.now() - sentAt, body: String(error), headers: '' };
  }
}

async function pollUntilSuccess(label: string) {
  const start = Date.now();
  console.log(`\n== ${label}: polling every ${pollMs / 1000}s until a request succeeds`);
  while (Date.now() < deadline) {
    const result = await call();
    console.log(`[${at(result.sentAt)}] ${result.status} ${result.ms}ms ${result.headers}`);
    if (result.status === 200) return Date.now() - start;
    if (result.status !== 429) throw new Error(`Unexpected ${result.status}: ${result.body}`);
    await sleep(pollMs);
  }
  return null;
}

function summarize(rate: number, results: Result[], sendMs: number) {
  const count = (status: number) => results.filter(r => r.status === status).length;
  const other = results.length - count(200) - count(429);
  const latencies = results.filter(r => r.status === 200).map(r => r.ms).sort((a, b) => a - b);
  const percentile = (p: number) =>
    latencies.length ? `${latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))]}ms` : '–';
  const achieved = Math.round(results.length / (sendMs / 60_000));
  console.log(
    `${String(rate).padStart(5)}/min target: sent ${results.length} in ${(sendMs / 1000).toFixed(0)}s (${achieved}/min)` +
      ` → 200×${count(200)} 429×${count(429)} other×${other} | p50 ${percentile(0.5)} p95 ${percentile(0.95)}`,
  );
}

// Phase 1
const waited = await pollUntilSuccess('wait');
if (waited === null) {
  console.log('\nNo request succeeded before the deadline.');
  process.exit(0);
}

// Phase 2: open-loop schedule so the send rate doesn't depend on response latency.
console.log(`\n== ramp: ${rates.join(' → ')} req/min, ${stepMs / 1000}s each, stopping at the first 429`);
const all: Result[] = [];
const run = { limited: undefined as Result | undefined, fatal: undefined as Result | undefined };
for (const rate of rates) {
  const interval = 60_000 / rate;
  const stepStart = Date.now();
  const stepResults: Result[] = [];
  const pending: Promise<void>[] = [];
  let next = stepStart;
  while (Date.now() - stepStart < stepMs && Date.now() < deadline && !run.limited && !run.fatal) {
    pending.push(call().then(result => {
      all.push(result);
      stepResults.push(result);
      if (result.status === 429 && !run.limited) {
        run.limited = result;
        console.log(`[${at(result.sentAt)}] first 429 ${result.headers}`);
      } else if ([401, 402, 403].includes(result.status)) {
        run.fatal = result;
      }
    }));
    next += interval;
    await sleep(Math.max(0, next - Date.now()));
  }
  const sendMs = Date.now() - stepStart;
  await Promise.all(pending);
  summarize(rate, stepResults, sendMs);
  if (run.limited || run.fatal || Date.now() >= deadline) break;
}

if (run.fatal) {
  console.error(`\nStopped on ${run.fatal.status}: ${run.fatal.body}`);
  process.exit(1);
}
const firstError = all.find(r => r.status !== 200 && r.status !== 429);
if (firstError) console.log(`\nFirst non-200/429 response (${firstError.status}): ${firstError.body.slice(0, 300)}`);

const limited = run.limited;
if (!limited) {
  const ok = all.filter(r => r.status === 200).length;
  console.log(`\nNo 429 across ${all.length} requests (${ok} succeeded) up to ${rates.at(-1)}/min.`);
  process.exit(0);
}
const okBefore = all.filter(r => r.status === 200 && r.sentAt <= limited.sentAt);
const okLastMinute = okBefore.filter(r => limited.sentAt - r.sentAt <= 60_000).length;
console.log(`\nFirst 429 after ${okBefore.length} successes (${okLastMinute} sent in the preceding 60s).`);
console.log(`429 body: ${limited.body.slice(0, 300)}`);

// Phase 3
const recovered = await pollUntilSuccess('recover');
console.log('\n== summary');
console.log(`successes sent in the 60s before the first 429: ${okLastMinute}`);
console.log(recovered === null ? 'did not recover before the deadline' : `recovered ${(recovered / 1000).toFixed(1)}s after the 429`);
