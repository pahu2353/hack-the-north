import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { createOpponentPlan } from './opponent.ts';
import {
  experimental_evaluate as evaluate,
  type Experimental_EvaluationQuestion as EvaluationQuestion,
} from 'ai';

const MODEL = 'typesafe-ai/jev';
const PORT = Number(process.env.PORT ?? 3000);
const MOCK = process.env.JEV_MOCK === '1';
const PUBLIC_DIR = fileURLToPath(new URL('./public/', import.meta.url));
const DEEPGRAM_URL = 'wss://api.deepgram.com/v1/listen';
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
};

type EvaluateRequest = {
  state: unknown;
  questions: Record<string, EvaluationQuestion>;
  maxRetries?: number;
};

const server = createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    if (req.method === 'POST' && pathname === '/api/evaluate') {
      await handleEvaluate(req, res);
      return;
    }
    if (req.method === 'POST' && pathname === '/api/opponent') {
      await handleOpponent(req, res);
      return;
    }
    if (req.method === 'GET' && pathname === '/commander') {
      res.writeHead(302, { location: '/commander/' });
      res.end();
      return;
    }
    if (req.method === 'GET' && (await serveStatic(decodeURIComponent(pathname), res))) return;
    sendJson(res, 404, { error: 'Not found' });
  } catch (error) {
    sendJson(res, 500, { error: String(error) });
  }
});

async function handleOpponent(req: IncomingMessage, res: ServerResponse) {
  const controller = new AbortController();
  res.on('close', () => { if (!res.writableEnded) controller.abort(); });
  const started = performance.now();
  try {
    let snapshot: unknown;
    try {
      snapshot = JSON.parse(await readBody(req, 16_384));
    } catch {
      sendJson(res, 400, { error: 'Opponent snapshot must be JSON under 16 KB' });
      return;
    }
    const result = await createOpponentPlan(snapshot, {
      mock: MOCK || process.env.OPPONENT_MOCK === '1', signal: controller.signal,
    });
    if (!res.destroyed) sendJson(res, 200, { ...result, latencyMs: Math.round(performance.now() - started) });
  } catch (error: any) {
    if (!res.destroyed) sendJson(res, error.statusCode ?? 502, { error: error.message ?? 'Opponent planning failed' });
  }
}

async function handleEvaluate(req: IncomingMessage, res: ServerResponse) {
  let body: EvaluateRequest;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    sendJson(res, 400, { error: 'Request body must be JSON' });
    return;
  }
  if (!body.questions || Object.keys(body.questions).length === 0) {
    sendJson(res, 400, { error: 'Add at least one question' });
    return;
  }

  const started = performance.now();
  try {
    const result = MOCK
      ? await mockEvaluate(JSON.stringify(body.state), body.questions)
      : await evaluate({
          model: MODEL,
          state: body.state as string,
          questions: body.questions,
          // No retries by default so failures (e.g. 429s) surface immediately; callers opt in (max 2).
          maxRetries: Math.min(2, Math.max(0, Number(body.maxRetries) || 0)),
        });
    sendJson(res, 200, {
      model: MODEL,
      mock: MOCK,
      answers: result.answers,
      usage: result.usage,
      latencyMs: Math.round(performance.now() - started),
      rateLimit: pickRateLimitHeaders(result.response?.headers),
    });
  } catch (error: any) {
    sendJson(res, error?.statusCode ?? 500, {
      error: error?.message ?? String(error),
      // Prefer the Gateway's own error type (e.g. customer_verification_required) over the SDK wrapper's.
      type: error?.cause?.data?.error?.type ?? error?.type,
      latencyMs: Math.round(performance.now() - started),
      rateLimit: pickRateLimitHeaders(error?.cause?.responseHeaders),
    });
  }
}

// Serves files under public/, reading on every request so edits show up without a restart.
async function serveStatic(pathname: string, res: ServerResponse) {
  const route = pathname.endsWith('/') ? `${pathname}index.html` : pathname;
  const file = normalize(join(PUBLIC_DIR, route));
  if (!file.startsWith(PUBLIC_DIR)) return false;
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': CONTENT_TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
    return true;
  } catch {
    return false;
  }
}

// Relays browser microphone audio to Deepgram's streaming API so the key stays server-side
// (this key can't mint short-lived browser tokens). Audio frames and control messages
// (KeepAlive / Finalize / CloseStream) go up; transcripts come back down.
const voiceServer = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname !== '/api/voice') {
    socket.destroy();
    return;
  }
  voiceServer.handleUpgrade(req, socket, head, client => relayVoice(client, url.searchParams.getAll('keyterm')));
});

function relayVoice(client: WebSocket, keyterms: string[]) {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) {
    client.close(1011, 'DEEPGRAM_API_KEY is not set');
    return;
  }
  const params = new URLSearchParams({
    model: 'nova-3',
    encoding: 'linear16',
    sample_rate: '16000',
    interim_results: 'true',
    smart_format: 'true',
    endpointing: '300',
  });
  for (const term of keyterms.slice(0, 50)) params.append('keyterm', term);
  const upstream = new WebSocket(`${DEEPGRAM_URL}?${params}`, { headers: { Authorization: `Token ${key}` } });
  const queued: (Buffer | string)[] = [];

  upstream.on('open', () => {
    for (const message of queued.splice(0)) upstream.send(message);
    client.send(JSON.stringify({ type: 'Ready' }));
  });
  upstream.on('message', (data, isBinary) => {
    if (client.readyState === WebSocket.OPEN) client.send(isBinary ? data : data.toString());
  });
  upstream.on('unexpected-response', (_req, res) => client.close(1011, `Deepgram HTTP ${res.statusCode}`));
  upstream.on('error', () => client.close(1011, 'Deepgram connection failed'));
  upstream.on('close', () => client.close());

  client.on('message', (data, isBinary) => {
    const message = isBinary ? (data as Buffer) : data.toString();
    if (upstream.readyState === WebSocket.OPEN) upstream.send(message);
    else queued.push(message);
  });
  client.on('close', () => {
    if (upstream.readyState === WebSocket.OPEN) upstream.close();
    else upstream.terminate();
  });
}

function pickRateLimitHeaders(headers?: Record<string, string>) {
  if (!headers) return undefined;
  const picked = Object.entries(headers).filter(([key]) => /ratelimit|retry-after/i.test(key));
  return picked.length > 0 ? Object.fromEntries(picked) : undefined;
}

// Deterministic fake answers (seeded by state + question id) so the UI can be
// exercised without AI Gateway access. Enabled with JEV_MOCK=1.
async function mockEvaluate(state: string, questions: Record<string, EvaluationQuestion>) {
  const answers: Record<string, unknown> = {};
  for (const [id, question] of Object.entries(questions)) {
    const random = seededRandom(`${state}|${id}`);
    if (question.type === 'boolean') {
      answers[id] = { type: 'boolean', probability: random() };
      continue;
    }
    const keys = Array.isArray(question.criteria)
      ? question.criteria.map((_, index) => String(index))
      : Object.keys(question.criteria);
    const weights = keys.map(() => random() ** 3);
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    const probabilities = Object.fromEntries(keys.map((key, i) => [key, weights[i] / total]));
    answers[id] =
      question.type === 'choice'
        ? {
            type: 'choice',
            choice: keys[weights.indexOf(Math.max(...weights))],
            probabilities,
          }
        : {
            type: 'score',
            score: keys.reduce((sum, key, i) => sum + i * probabilities[key], 0),
            probabilities,
          };
  }
  await new Promise(resolve => setTimeout(resolve, 40 + Math.random() * 80));
  const inputTokens = Math.ceil((state.length + JSON.stringify(questions).length) / 4);
  return {
    answers,
    usage: { inputTokens, outputTokens: 0, totalTokens: inputTokens },
    response: undefined as { headers?: Record<string, string> } | undefined,
  };
}

function seededRandom(seed: string) {
  // FNV-1a hash into a mulberry32 PRNG.
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash = Math.imul(hash ^ seed.charCodeAt(i), 16777619);
  }
  return () => {
    hash = (hash + 0x6d2b79f5) | 0;
    let t = Math.imul(hash ^ (hash >>> 15), 1 | hash);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function readBody(req: IncomingMessage, maxBytes = Infinity) {
  let body = '';
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maxBytes) throw new Error('Request body is too large');
    body += chunk;
  }
  return body;
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

// Bound to localhost only: this server spends your AI Gateway credits.
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Jev visualizer → http://localhost:${PORT}${MOCK ? '  (mock mode)' : ''}`);
  console.log(`Jev Commander  → http://localhost:${PORT}/commander/`);
});
