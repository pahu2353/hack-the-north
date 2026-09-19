// Server-only OpenAI adapter. The browser receives plans, never credentials.
import { generateText, jsonSchema, Output } from 'ai';
import { MAPS } from './public/commander/world.js';
import { OPPONENT_ACTIONS, validateOpponentPlan } from './public/commander/opponent.js';

const map = MAPS.tactical;
const zones = map.zones.map(z => z.name);

export function parseOpponentSnapshot(value: any) {
  const finite = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
  const point = (p: any) => p && finite(p.x, 0, map.width) && finite(p.y, 0, map.height);
  const unitId = (id: unknown) => Number.isInteger(id) && Number(id) > 0 && Number(id) < 100;
  const bad = () => { throw Object.assign(new Error('Invalid opponent battlefield snapshot'), { statusCode: 400 }); };
  if (!value || !finite(value.time, 0, 600) || !finite(value.secondsLeft, 0, 600)
      || !Array.isArray(value.defenders) || value.defenders.length < 1 || value.defenders.length > 8
      || !Array.isArray(value.contacts) || value.contacts.length > 8
      || !['unplanted', 'planted'].includes(value.spike?.state)) bad();
  const ids = new Set();
  const defenders = value.defenders.map((u: any) => {
    if (!u || !unitId(u.id) || ids.has(u.id) || !finite(u.hp, 1, 100) || !point(u.position)
        || !zones.includes(u.zone) || typeof u.name !== 'string' || !/^E\d{1,2}$/.test(u.name)) bad();
    ids.add(u.id);
    return {
      id: u.id, name: u.name, hp: u.hp, position: { x: u.position.x, y: u.position.y }, zone: u.zone,
      order: u.order && OPPONENT_ACTIONS.includes(u.order.action) && zones.includes(u.order.zone)
        ? { action: u.order.action, zone: u.order.zone } : null,
    };
  });
  const contacts = value.contacts.map((u: any) => {
    if (!u || !unitId(u.id) || !point(u.position) || !zones.includes(u.zone)
        || !finite(u.age, 0, 8) || typeof u.visible !== 'boolean') bad();
    return { id: u.id, position: { x: u.position.x, y: u.position.y }, zone: u.zone, age: u.age, visible: u.visible };
  });
  const s = value.spike;
  if (s.state === 'planted' && (!map.sites.includes(s.site) || !point(s.position) || !finite(s.secondsLeft, 0, 35))) bad();
  return {
    time: value.time, secondsLeft: value.secondsLeft, defenders, contacts,
    spike: s.state === 'planted'
      ? { state: 'planted', site: s.site, position: { x: s.position.x, y: s.position.y }, secondsLeft: s.secondsLeft }
      : { state: 'unplanted' },
  };
}

function planSchema(snapshot: ReturnType<typeof parseOpponentSnapshot>) {
  return {
    type: 'object' as const, additionalProperties: false, required: ['summary', 'orders'],
    properties: {
      summary: { type: 'string' as const, description: 'A short, public description of the squad strategy, at most 240 characters.' },
      orders: {
        type: 'array' as const, minItems: snapshot.defenders.length, maxItems: snapshot.defenders.length,
        items: {
          type: 'object' as const, additionalProperties: false, required: ['unitId', 'action', 'zone'],
          properties: {
            unitId: { type: 'integer' as const, enum: snapshot.defenders.map((u: any) => u.id) },
            action: { type: 'string' as const, enum: OPPONENT_ACTIONS.filter(a => a !== 'retake' || snapshot.spike.state === 'planted') },
            zone: { type: 'string' as const, enum: zones },
          },
        },
      },
    },
  };
}

const INSTRUCTIONS = `You command the DEFENDER bots in a fictional tactical game of Spike Rush.
The human commands the attacking squad. Win by preventing a plant until time runs out,
eliminating the attackers, or retaking and defusing a planted spike (6 seconds nearby without contact).
Give exactly one order to each living defender, using each unitId exactly once.
Orders last about 5-12 seconds. Preserve useful existing assignments; coordinate different jobs.
hold: move to the zone and hold an angle. rotate: reinforce another zone.
flank: approach a site through its Link. retreat: move toward the zone even under fire.
retake: approach the planted spike's exact position to defuse; use only after a plant.
Bots shoot automatically, stop for fights unless retreating, and seek cover if hurt/outnumbered.
Without contact, spread coverage across A and B and keep a rotator near Mid or the Links.
React to sightings and plants. Last-known contacts are uncertain, not live wall vision.
The map is 80m wide and 56m tall. Attackers approach from the south (high y).
A is west, B is east. A Main and B Main are long south-to-site lanes.
Mid connects to A Link and B Link, which connect to their sites. Top Hall links the sites behind them.
Do not invent unseen positions, read the player's orders, or give physics/shooting instructions.
Return a concise strategy summary (maximum 240 characters) and structured orders.`;

export function mockOpponentPlan(snapshot: ReturnType<typeof parseOpponentSnapshot>) {
  const recent = [...snapshot.contacts].sort((a, b) => a.age - b.age)[0];
  const threatened = recent ? (recent.position.x < 40 ? 'A Site' : 'B Site') : null;
  const planted = snapshot.spike.state === 'planted';
  return {
    summary: planted ? `Retake ${snapshot.spike.site} and defuse.`
      : threatened ? `Reinforce ${threatened}; keep the opposite site covered.` : 'Cover both sites and keep a rotator in Mid.',
    orders: snapshot.defenders.map((u: any, i: number) => ({
      unitId: u.id,
      action: planted ? 'retake' : u.hp < 35 ? 'retreat' : threatened && i > 0 ? 'rotate' : 'hold',
      zone: planted ? snapshot.spike.site : u.hp < 35 ? 'Defender Spawn'
        : threatened && i > 0 ? threatened : ['A Site', 'A Link', 'Mid', 'B Site'][i % 4],
    })),
  };
}

export async function createOpponentPlan(input: unknown, {
  mock = false, env = process.env, request = fetch, generate = generateText, signal: callerSignal = undefined as AbortSignal | undefined,
} = {}) {
  const snapshot = parseOpponentSnapshot(input);
  if (mock) return { plan: mockOpponentPlan(snapshot), model: 'scripted mock', mock: true };
  if (!env.OPENAI_API_KEY && !env.AI_GATEWAY_API_KEY) {
    throw Object.assign(new Error('Set OPENAI_API_KEY or AI_GATEWAY_API_KEY in .env.local to enable the OpenAI opponent.'), { statusCode: 503 });
  }
  const model = env.OPENAI_BOT_MODEL || 'gpt-5.6-luna';
  // Keep reasoning models within the real-time plan deadline and token budget.
  // Older non-reasoning models (e.g. a GPT-4.1 override) must not receive this option.
  const reasoningEffort = /^gpt-[56](?:[.-]|$)/.test(model) ? 'low' as const : undefined;
  const schema = planSchema(snapshot);
  const inputState = JSON.stringify({ ...snapshot, zones: map.zones.map(z => ({ name: z.name, center: z.center })) });
  const signal = AbortSignal.any([AbortSignal.timeout(8000), ...(callerSignal ? [callerSignal] : [])]);
  let plan: unknown;
  if (env.OPENAI_API_KEY) {
    const response = await request('https://api.openai.com/v1/responses', {
      method: 'POST', signal,
      headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model, store: false, instructions: INSTRUCTIONS, input: inputState, max_output_tokens: 1200,
        ...(reasoningEffort && { reasoning: { effort: reasoningEffort } }),
        text: { format: { type: 'json_schema', name: 'defender_plan', strict: true, schema } },
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error?.message || `OpenAI HTTP ${response.status}`);
    if (data.status !== 'completed') throw new Error('OpenAI did not complete the defender plan');
    const text = data.output?.flatMap((item: any) => item.content ?? [])
      .filter((part: any) => part.type === 'output_text').map((part: any) => part.text).join('');
    if (!text) throw new Error('OpenAI returned no defender plan');
    plan = JSON.parse(text);
  } else {
    // Reuse the repo's existing Vercel AI Gateway setup when no direct OpenAI key is set.
    const result = await generate({
      model: `openai/${model}`, system: INSTRUCTIONS, prompt: inputState,
      output: Output.object({ schema: jsonSchema(schema), name: 'defender_plan' }),
      maxOutputTokens: 1200, maxRetries: 0, abortSignal: signal,
      ...(reasoningEffort && { providerOptions: { openai: { reasoningEffort } } }),
    });
    plan = result.output;
  }
  return { plan: validateOpponentPlan(plan, snapshot, map), model, mock: false };
}
