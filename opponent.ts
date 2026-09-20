// Server-only OpenAI adapter. The browser receives plans, never credentials.
import { generateText, jsonSchema, Output } from 'ai';
import { MAPS } from './public/commander/world.js';
import { opponentActions, validateOpponentPlan } from './public/commander/opponent.js';
import { GRENADE, MAX_HP, RIFLE } from './public/commander/sim.js';

// Which map a snapshot belongs to is part of the snapshot, so one server serves any of them.
// Validation still has to be strict: the zone list is the map's own, not a union across maps,
// so a plan can never name a callout that doesn't exist on the map being played.
const hypot = (a: any, b: any) => Math.hypot(a.x - b.x, a.y - b.y);
const mapOf = (value: any) => MAPS[value?.mapId as keyof typeof MAPS] ?? MAPS.tactical;

export function parseOpponentSnapshot(value: any) {
  const map = mapOf(value);
  const zones = map.zones.map((z: any) => z.name);
  const finite = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
  const point = (p: any) => p && finite(p.x, 0, map.width) && finite(p.y, 0, map.height);
  const unitId = (id: unknown) => Number.isInteger(id) && Number(id) > 0 && Number(id) < 100;
  const bad = () => { throw Object.assign(new Error('Invalid opponent battlefield snapshot'), { statusCode: 400 }); };
  if (!value || !finite(value.time, 0, 600) || !finite(value.secondsLeft, 0, 600)
      || !['attack', 'defend'].includes(value.team)
      || !Array.isArray(value.squad) || value.squad.length < 1 || value.squad.length > 8
      || !Array.isArray(value.contacts) || value.contacts.length > 8
      || !Array.isArray(value.grenades) || value.grenades.length > 8 * GRENADE.carried
      || !(value.team === 'attack' ? ['carried', 'dropped', 'planted'] : ['unplanted', 'planted']).includes(value.spike?.state)) bad();
  const grenadeIds = new Set();
  const grenades = value.grenades.map((g: any) => {
    if (!g || !unitId(g.id) || grenadeIds.has(g.id) || !['attack', 'defend'].includes(g.team)
        || !point(g.position) || typeof g.landed !== 'boolean'
        || (g.landed ? !finite(g.secondsToExplosion, 0, GRENADE.fuse) : g.secondsToExplosion !== null)) bad();
    grenadeIds.add(g.id);
    return { id: g.id, team: g.team, position: { x: g.position.x, y: g.position.y },
      landed: g.landed, secondsToExplosion: g.secondsToExplosion };
  });
  const actions = opponentActions(value.team);
  const ids = new Set();
  const squad = value.squad.map((u: any) => {
    if (!u || !unitId(u.id) || ids.has(u.id) || !finite(u.hp, 1, MAX_HP) || !point(u.position)
        || !zones.includes(u.zone) || typeof u.name !== 'string' || !/^E\d{1,2}$/.test(u.name)) bad();
    ids.add(u.id);
    const combat = u.combat;
    if (combat && (!Number.isInteger(combat.visibleEnemies) || !finite(combat.visibleEnemies, 0, 8)
        || !Number.isInteger(combat.nearbyAllies) || !finite(combat.nearbyAllies, 0, 7)
        || typeof combat.fallingBack !== 'boolean')) bad();
    const opportunity = u.grenadeOpportunity;
    if (!Number.isInteger(u.grenadesLeft) || !finite(u.grenadesLeft, 0, GRENADE.carried)
        || !Number.isInteger(u.alliesWithinBlastRadius) || !finite(u.alliesWithinBlastRadius, 0, value.squad.length - 1)
        || (opportunity !== null && (!opportunity || u.grenadesLeft < 1 || !point(opportunity.position)
          || !Number.isInteger(opportunity.enemiesCaught) || !finite(opportunity.enemiesCaught, 2, 8)))
        || (u.dodgingGrenadeId !== null && !grenades.some((g: any) =>
          g.id === u.dodgingGrenadeId && g.landed && g.team !== value.team))) bad();
    return {
      id: u.id, name: u.name, hp: u.hp, maxHp: MAX_HP, position: { x: u.position.x, y: u.position.y }, zone: u.zone,
      ...(combat && { combat: { visibleEnemies: combat.visibleEnemies, nearbyAllies: combat.nearbyAllies, fallingBack: combat.fallingBack } }),
      grenadesLeft: u.grenadesLeft, alliesWithinBlastRadius: u.alliesWithinBlastRadius,
      grenadeOpportunity: opportunity ? { position: { x: opportunity.position.x, y: opportunity.position.y }, enemiesCaught: opportunity.enemiesCaught } : null,
      dodgingGrenadeId: u.dodgingGrenadeId,
      order: u.order && actions.includes(u.order.action) && zones.includes(u.order.zone)
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
  if (s.state === 'carried' && !ids.has(s.carrierId)) bad();
  if (s.state === 'dropped' && !point(s.position)) bad();
  const c = value.coordination;
  if (c && (!['gathering', 'pushing'].includes(c.phase) || !map.sites.includes(c.site)
      || value.team !== 'defend' || s.state !== 'planted'
      || !zones.includes(c.zone) || !Number.isInteger(c.ready) || !finite(c.ready, 0, squad.length)
      || !Number.isInteger(c.required) || !finite(c.required, 1, squad.length))) bad();
  return {
    mapId: map.id,
    team: value.team, time: value.time, secondsLeft: value.secondsLeft, squad, contacts, grenades,
    ...(c && { coordination: { phase: c.phase, site: c.site, zone: c.zone, ready: c.ready, required: c.required } }),
    spike: s.state === 'planted'
      ? { state: 'planted', site: s.site, position: { x: s.position.x, y: s.position.y }, secondsLeft: s.secondsLeft }
      : s.state === 'carried' ? { state: 'carried', carrierId: s.carrierId }
      : s.state === 'dropped' ? { state: 'dropped', position: { x: s.position.x, y: s.position.y } }
      : { state: 'unplanted' },
  };
}

function planSchema(snapshot: ReturnType<typeof parseOpponentSnapshot>) {
  const zones = mapOf(snapshot).zones.map((z: any) => z.name);
  return {
    type: 'object' as const, additionalProperties: false, required: ['summary', 'orders'],
    properties: {
      summary: { type: 'string' as const, description: 'A short, public description of the squad strategy, at most 240 characters.' },
      orders: {
        type: 'array' as const, minItems: snapshot.squad.length, maxItems: snapshot.squad.length,
        items: {
          type: 'object' as const, additionalProperties: false, required: ['unitId', 'action', 'zone'],
          properties: {
            unitId: { type: 'integer' as const, enum: snapshot.squad.map((u: any) => u.id) },
            action: { type: 'string' as const, enum: opponentActions(snapshot.team)
              .filter(a => a !== 'retake' || snapshot.spike.state === 'planted')
              .filter(a => a !== 'plant' || snapshot.spike.state !== 'planted') },
            zone: { type: 'string' as const, enum: zones },
          },
        },
      },
    },
  };
}

const GRENADE_INSTRUCTIONS = `Each unit starts with ${GRENADE.carried} grenade. A blast reaches ${GRENADE.radius}m,
deals up to ${GRENADE.centreDamage} damage, is blocked by walls, and never hurts the thrower's team.
grenadesLeft is your unit's remaining supply; enemy supplies are unknown. grenadeOpportunity is
a reachable cluster from current/recent sightings: bots automatically throw at two or more enemies.
alliesWithinBlastRadius counts teammates within ${GRENADE.radius}m without a wall between them.
Keep mutual support without packing everyone into one blast; use complementary nearby zones/angles
when safe, while still protecting the carrier on attack or coordinating the retake on defense.
grenades lists publicly visible current positions and teams. Airborne landing targets are unknown;
secondsToExplosion is only known after landing. A grenade in this snapshot may be gone by the time
your plan arrives. Never make the squad wait for your response to dodge it.
dodgingGrenadeId means game code is moving that bot clear of a hostile blast, then it resumes its
order after the blast. These immediate reflexes override every order, including plant and retake.
Preserve useful objectives during a brief dodge; coordinate support and the next safe approach.
Do not keep a regroup or hold objective on a currently threatened zone when a nearby safe route
preserves the objective. Grenade throwing and dodging are automatic, not commander action names.`;

const DEFEND_INSTRUCTIONS = `You command the DEFENDER bots in a fictional tactical game of Spike Rush.
The human commands the attacking squad. Win by preventing a plant until time runs out,
eliminating the attackers, or retaking and defusing a planted spike (6 seconds nearby without contact).
Give exactly one order to each living defender, using each unitId exactly once.
Orders last about 5-12 seconds. Preserve useful existing assignments; coordinate different jobs.
hold: keep the current angle if already in the zone, otherwise move there. rotate: reinforce another zone.
flank: approach a site through its Link. retreat: move toward the zone even under fire.
regroup: move to a shared safe zone even under fire, then wait there for the next coordinated order.
retake: approach the planted spike's exact position to defuse; use only after a plant.
When you assign retake to two or more bots, game code picks a nearby staging position and waits
for most of that group to assemble, then advances them together even under fire. Immediate survival
reflexes still apply. It skips waiting when the defuse deadline is close or a bot is already defusing.
The optional coordination field reports gathering/pushing and the ready/required counts.
Preserve those retake orders while they assemble or enter, unless new threats justify changing them.
Prefer a coordinated retake over sending individual bots or repeatedly changing the rally location.
Bots shoot automatically and stop for fights unless retreating/regrouping or making a coordinated retake. They immediately seek
cover at a 2:1 local disadvantage, or when hurt and outnumbered, and pause there for support.
Each defender's combat field reports current visible enemies, nearby allies within 12m who can
see the defender or share a visible enemy, and whether an emergency fallback is active.
Without contact, cover both sites with mutually supporting positions; avoid isolated forward scouts.
When 3-4 attackers are freshly seen together on one approach, prioritize keeping defenders alive
and concentrating your team against that push. Yield the site if necessary, gather at a safe Link
or rear position, then contest together. Do not feed single reinforcements into a larger group.
You may abandon an empty site when the sightings justify it; do not keep a token anchor there
while the rest die one by one. One uncertain sighting alone is not evidence of a full rush.
Before a plant, use regroup to stage the team, then assign hold/rotate/flank when support is in position.
After a plant, prefer assigning retake to a supporting group; its staging is handled automatically.
On a planted spike, allow travel time plus the 6-second defuse; do not waste the deadline regrouping far away.
React to sightings and plants. Last-known contacts are uncertain, not live wall vision.
React to the geography supplied below rather than assuming a layout.
Movement to a new zone ends at its supplied center, not at the next zone beyond it. Top Hall's center
is on the west/A side; use the coordinates when choosing a nearby retreat or rally point for B.
Do not invent unseen positions, read the player's orders, or give physics/shooting instructions.
Return a concise strategy summary (maximum 240 characters) and structured orders.`;

const ATTACK_INSTRUCTIONS = `You command the ATTACKER bots in a fictional tactical game of Spike Rush.
The human commands the defenders. Win by planting the spike on A or B and protecting it until it
detonates, or by eliminating the defenders. Plant before the round deadline. Your squad knows its
carrier and dropped spike location, but only sees enemy contacts that its own bots have spotted.
Give exactly one order to every living unit in squad, using every unitId once.
push: move to a zone; site pushes approach through their Main lane unless already nearby.
hold: keep the current angle if already there, otherwise move there.
flank: approach a site through its Link. retreat/regroup: keep moving toward the zone under fire.
plant: approach A Site or B Site through its Main lane; the carrier automatically plants after standing still for 3s
without an enemy in sight. The nearest attacker recovers a dropped spike when out of contact.
Choose one site for a concentrated attack with nearby support for the carrier. Avoid splitting
your squad into isolated duels. Only flank when the others can keep the carrier safe.
After planting, hold mutually supporting positions around that site and stop the defuse; do not
send everyone back across the map. Prefer useful existing orders instead of oscillating sites.
Bots shoot automatically and usually stop on contact. They seek cover at a 2:1 local disadvantage
or when hurt and outnumbered. Combat fields show local enemy counts, nearby support, and fallback.
Actions target the supplied zone centers, with small formation offsets. You cannot choose exact
aim, physics, or cover positions. React to the geography supplied below rather than assuming
a layout, and use the supplied zone coordinates to judge travel time.
Last-known contacts are uncertain. Do not invent unseen enemies or read the player's orders.
Return a concise strategy summary (maximum 240 characters) and structured orders.`;

// The prompt has to describe whichever map is being played, so the geography is generated from
// the map data instead of written into the instructions.
function geography(map: any) {
  const where = (c: any) => [
    c.y < map.height / 3 ? 'north' : c.y > (map.height * 2) / 3 ? 'south' : 'mid',
    c.x < map.width / 3 ? 'west' : c.x > (map.width * 2) / 3 ? 'east' : 'centre',
  ].join(' ');
  const sites = map.sites.map((name: string) => {
    const z = map.zones.find((q: any) => q.name === name);
    const route = map.routes[name] ?? {};
    const flanks = (route.flank ?? []).join(' or ');
    return `${name} sits ${where(z.center)}. Main approach: ${route.push ?? 'direct'}.`
      + (flanks ? ` Flank routes: ${flanks}.` : '');
  });
  return [
    `MAP: ${map.id}, ${map.width}m wide and ${map.height}m tall.`,
    `Attackers start in ${map.home.attack} (${where(map.zones.find((z: any) => z.name === map.home.attack).center)});`
      + ` defenders start in ${map.home.defend}.`,
    ...sites,
  ].join('\n');
}

export function mockOpponentPlan(snapshot: ReturnType<typeof parseOpponentSnapshot>) {
  const map = mapOf(snapshot);
  const sites = map.sites.map((name: string) => map.zones.find((z: any) => z.name === name));
  const recent = [...snapshot.contacts].sort((a, b) => a.age - b.age)[0];
  // Whichever site the latest sighting is closest to, rather than a hardcoded half of the map.
  const threatened = recent
    ? sites.reduce((a: any, b: any) => (hypot(b.center, recent.position) < hypot(a.center, recent.position) ? b : a)).name
    : null;
  const planted = snapshot.spike.state === 'planted';
  if (snapshot.team === 'attack') {
    const site = planted ? snapshot.spike.site
      : snapshot.squad.find((u: any) => map.sites.includes(u.order?.zone))?.order.zone ?? map.sites[map.sites.length - 1];
    return {
      summary: planted ? `Protect the spike on ${site}.` : `Push ${site} together and plant the spike.`,
      orders: snapshot.squad.map((u: any) => ({ unitId: u.id,
        action: planted ? 'hold' : u.id === snapshot.spike.carrierId ? 'plant' : 'push', zone: site })),
    };
  }
  return {
    summary: planted ? `Retake ${snapshot.spike.site} and defuse.`
      : threatened ? `Reinforce ${threatened}; keep the opposite site covered.` : 'Cover both sites and keep a rotator in Mid.',
    orders: snapshot.squad.map((u: any, i: number) => ({
      unitId: u.id,
      action: planted ? 'retake' : u.hp < MAX_HP * 0.35 ? 'retreat' : threatened && i > 0 ? 'rotate' : 'hold',
      zone: planted ? snapshot.spike.site : u.hp < MAX_HP * 0.35 ? map.home.defend
        : threatened && i > 0 ? threatened : map.patrol[i % map.patrol.length],
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
  const model = env.OPENAI_BOT_MODEL || 'gpt-5.6-sol';
  // Keep reasoning models within the real-time plan deadline and token budget.
  // Older non-reasoning models (e.g. a GPT-4.1 override) must not receive this option.
  const reasoningEffort = /^gpt-[56](?:[.-]|$)/.test(model) ? 'low' as const : undefined;
  const schema = planSchema(snapshot);
  const instructions = `${snapshot.team === 'attack' ? ATTACK_INSTRUCTIONS : DEFEND_INSTRUCTIONS}\n\n${GRENADE_INSTRUCTIONS}
All units start with ${MAX_HP} HP. Rifles deal ${RIFLE.damage} damage, need ${Math.ceil(MAX_HP / RIFLE.damage)} hits to kill,
and automatic fire is inaccurate, especially while moving. The human can manually aim one agent's
crosshair at an enemy to improve automatic shooting accuracy; its damage and fire rate are unchanged.
The agent keeps shooting normally when the crosshair is off target. Do not assume an exposed duel is safe.

${geography(mapOf(snapshot))}`;
  const inputState = JSON.stringify({ ...snapshot, zones: mapOf(snapshot).zones.map((z: any) => ({ name: z.name, center: z.center })) });
  const signal = AbortSignal.any([AbortSignal.timeout(8000), ...(callerSignal ? [callerSignal] : [])]);
  let plan: unknown;
  if (env.OPENAI_API_KEY) {
    const response = await request('https://api.openai.com/v1/responses', {
      method: 'POST', signal,
      headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model, store: false, instructions, input: inputState, max_output_tokens: 1200,
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
      model: `openai/${model}`, system: instructions, prompt: inputState,
      output: Output.object({ schema: jsonSchema(schema), name: 'defender_plan' }),
      maxOutputTokens: 1200, maxRetries: 0, abortSignal: signal,
      ...(reasoningEffort && { providerOptions: { openai: { reasoningEffort } } }),
    });
    plan = result.output;
  }
  return { plan: validateOpponentPlan(plan, snapshot, mapOf(snapshot)), model, mock: false };
}
