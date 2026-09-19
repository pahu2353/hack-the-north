// OpenAI commands the opposing squad; ordinary game code executes these bounded orders.
// This module has no DOM or Jev dependency so either renderer can use it.
import { ROUND_SECONDS } from './sim.js';
import { buildGrid, dist, findPath, hasLineOfSight, nearestOpenPoint, zoneAt, zoneByName } from './world.js';

export const OPPONENT_ACTIONS = ['hold', 'rotate', 'flank', 'retreat', 'regroup', 'retake'];
export const opponentActions = team => team === 'attack'
  ? ['hold', 'push', 'flank', 'retreat', 'regroup', 'plant'] : OPPONENT_ACTIONS;
export const PLAN_LIFETIME = 12; // simulation seconds
const REPLAN_MS = 5000;
const EVENT_REPLAN_MS = 2000; // minimum time between requests triggered by combat
const EVENT_DEBOUNCE_MS = 350; // collect a burst of sightings/casualties into one plan
const REQUEST_TIMEOUT_MS = 9000;

const livingBots = game => game.units.filter(u => u.kind === 'bot' && u.alive);
const position = u => ({ x: Math.round(u.x * 10) / 10, y: Math.round(u.y * 10) / 10 });
const objectiveKey = game => game.spike.state === 'planted' ? `planted:${game.spike.site}` : 'unplanted';

// Local facts for both the immediate survival reflex and the slower commander. Nearby
// teammates can support directly or cover the same enemy from another angle.
export function defenderCombat(game, u) {
  const enemies = u.visible.filter(v => v.alive);
  return {
    visibleEnemies: enemies.length,
    nearbyAllies: livingBots(game).filter(m => m !== u && dist(u, m) <= 12
      && (hasLineOfSight(game.map, u, m) || m.visible.some(v => enemies.includes(v)))).length,
    fallingBack: !!u.botFallback,
  };
}

export function opponentSnapshot(game) {
  updateOpponentTactics(game);
  const bots = livingBots(game);
  const team = game.botTeam ?? 'defend';
  const visibleIds = new Set(bots.flatMap(u => u.visible.map(v => v.id)));
  return {
    time: Math.round(game.time * 10) / 10,
    team,
    secondsLeft: Math.max(0, Math.round(ROUND_SECONDS - game.time)),
    squad: bots.map(u => ({
      id: u.id, name: u.name, hp: Math.round(u.hp), position: position(u), zone: zoneAt(game.map, u).name,
      combat: defenderCombat(game, u),
      order: u.botOrder && u.botOrder.expiresAt > game.time
        ? { action: u.botOrder.action, zone: u.botOrder.zone } : null,
    })),
    ...(game.botRetake && { coordination: {
      phase: game.botRetake.phase, site: game.botRetake.site, zone: game.botRetake.zone,
      ready: game.botRetake.ready, required: game.botRetake.required,
    } }),
    // Never send the player's orders, cursor, or unseen units' live positions/health.
    contacts: [...game.intel[team].entries()]
      .filter(([, sighting]) => game.time - sighting.t <= 8)
      .map(([id, sighting]) => ({
        id, position: position(sighting), zone: zoneAt(game.map, sighting).name,
        age: Math.max(0, Math.round((game.time - sighting.t) * 10) / 10), visible: visibleIds.has(id),
      })),
    // A planted spike is public. Its carrier and dropped location are not.
    spike: game.spike.state === 'planted'
      ? { state: 'planted', site: game.spike.site, position: position(game.spike), secondsLeft: Math.max(0, Math.round(game.spike.timer)) }
      : team === 'attack' && game.spike.state === 'carried' ? { state: 'carried', carrierId: game.spike.carrierId }
      : team === 'attack' && game.spike.state === 'dropped' ? { state: 'dropped', position: position(game.spike) }
      : { state: 'unplanted' },
  };
}

export function validateOpponentPlan(plan, snapshot, map) {
  if (!plan || typeof plan.summary !== 'string' || !plan.summary.trim() || plan.summary.length > 240
      || !Array.isArray(plan.orders) || plan.orders.length !== snapshot.squad.length) {
    throw new Error('Opponent returned an incomplete plan');
  }
  const remaining = new Set(snapshot.squad.map(u => u.id));
  const orders = plan.orders.map(order => {
    if (!order || !remaining.delete(order.unitId) || !opponentActions(snapshot.team).includes(order.action)
        || !zoneByName(map, order.zone) || (order.action === 'retake' && snapshot.spike.state !== 'planted')
        || (order.action === 'plant' && (snapshot.spike.state === 'planted' || !map.sites.includes(order.zone)))) {
      throw new Error('Opponent returned an invalid unit, action, or destination');
    }
    return { unitId: order.unitId, action: order.action, zone: order.zone };
  });
  return { summary: plan.summary.trim(), orders };
}

export function applyOpponentPlan(game, plan) {
  for (const order of plan.orders) {
    const u = livingBots(game).find(bot => bot.id === order.unitId);
    if (!u) continue; // a defender may have died during the request
    const previous = u.botOrder;
    if (previous && previous.expiresAt > game.time && previous.action === order.action && previous.zone === order.zone) {
      // Renew an ongoing maneuver without sending a flanker back to a completed waypoint
      // or interrupting the current path/cover reflex.
      previous.expiresAt = game.time + PLAN_LIFETIME;
      continue;
    }
    // Holding a site should not pull an anchor off their existing angle into its center.
    let target = order.action === 'hold' && zoneAt(game.map, u).name === order.zone
      ? position(u) : zoneByName(game.map, order.zone).center;
    // Different arrival spots let an attacking carrier stop and plant without being shoved.
    if (u.team === 'attack' && order.action !== 'hold') {
      const slots = [[0, 0], [2.2, 0.6], [-2.2, 0.6], [0, 2.4]];
      const [dx, dy] = slots[u.slot % slots.length];
      target = nearestOpenPoint(tacticsGrid(game), { x: target.x + dx, y: target.y + dy });
    }
    const routes = game.map.routes[order.zone];
    const approach = order.action === 'flank' ? routes?.flank?.[0]
      : u.team === 'attack' && ['push', 'plant'].includes(order.action) ? routes?.push : null;
    let via = approach ? zoneByName(game.map, approach).center : null;
    // A site hit follows its Main lane, but a bot already near the site needn't backtrack.
    if (via && order.action !== 'flank' && dist(u, via) + dist(via, target) > dist(u, target) * 1.5) via = null;
    u.botOrder = {
      ...order, point: { ...target },
      via: via && { ...via },
      expiresAt: game.time + PLAN_LIFETIME,
    };
    u.pathGoal = null;
    u.coverPoint = null;
  }
  updateOpponentTactics(game);
}

// Coordinate the execution of a multi-bot retake without another model call. The commander
// still chooses who retakes; these bots gather before committing to the planted spike.
function tacticsGrid(game) {
  if (!game.grids.has('agent')) game.grids.set('agent', buildGrid(game.map, 0.7));
  return game.grids.get('agent');
}

function pathDistance(grid, from, to) {
  const path = findPath(grid, from, to);
  if (!path.length) return Infinity;
  let length = 0;
  for (const next of path) { length += dist(from, next); from = next; }
  return length;
}

function createRetake(game, members) {
  const grid = tacticsGrid(game);
  const site = zoneByName(game.map, game.spike.site);
  const link = zoneByName(game.map, game.map.routes[site.name].flank[0]);
  const hall = zoneByName(game.map, 'Top Hall');
  const threats = [...game.intel.defend.values()].filter(i => game.time - i.t < 3);
  // Use the rear hallway on the threatened side, not Top Hall's west-side zone center.
  const candidates = [
    { zone: link.name, point: link.center },
    { zone: hall.name, point: { x: site.center.x, y: hall.center.y } },
  ].map(candidate => {
    const point = nearestOpenPoint(grid, candidate.point);
    const exposed = threats.filter(t => dist(t, point) <= 45 && hasLineOfSight(game.map, t, point)).length;
    const travel = pathDistance(grid, point, game.spike) / Math.min(...members.map(u => u.speed));
    const gather = Math.max(...members.map(u => pathDistance(grid, u, point) / u.speed));
    return { ...candidate, point, travel, score: exposed * 1000 + gather + travel };
  });
  const rally = candidates.reduce((a, b) => a.score <= b.score ? a : b);
  return {
    site: site.name, phase: 'gathering', zone: rally.zone, point: rally.point,
    travel: rally.travel, ready: 0, required: 0, unitIds: [], spots: {}, reason: '',
  };
}

export function updateOpponentTactics(game) {
  const members = livingBots(game).filter(u => u.botOrder?.action === 'retake'
    && u.botOrder.expiresAt > game.time);
  if (game.opponent !== 'openai' || game.spike.state !== 'planted' || !members.length) {
    game.botRetake = null;
    return;
  }
  // A lone defender has nobody to wait for. Preserve a running retake through renewals.
  if (!game.botRetake && members.length < 2) return;
  if (!game.botRetake || game.botRetake.site !== game.spike.site) game.botRetake = createRetake(game, members);
  const group = game.botRetake;
  group.unitIds = members.map(u => u.id);
  const slots = [[0, 0], [1.8, 0], [-1.8, 0], [0, 1.8]];
  for (const u of members) {
    if (!group.spots[u.id]) {
      const [dx, dy] = slots[u.slot % slots.length];
      group.spots[u.id] = nearestOpenPoint(tacticsGrid(game), { x: group.point.x + dx, y: group.point.y + dy });
    }
  }
  group.ready = members.filter(u => dist(u, group.point) < 4 && hasLineOfSight(game.map, u, group.point)).length;
  group.required = Math.min(members.length, Math.max(2, Math.ceil(members.length * 0.75)));
  if (group.phase === 'gathering') {
    const urgent = game.spike.timer <= group.travel + 8; // travel + 6s defuse + 2s margin
    const onSpike = members.some(u => dist(u, game.spike) < 1.5 && !u.visible.some(v => v.alive));
    if (group.ready >= group.required || members.length === 1 || urgent || onSpike) {
      group.phase = 'pushing';
      group.reason = urgent ? 'Defuse deadline: move now' : onSpike ? 'Support the defuser'
        : members.length === 1 ? 'Last defender: move now' : 'Squad assembled: enter together';
      for (const u of members) u.pathGoal = null;
    }
  }
}

export function opponentDestination(game, u) {
  const order = u.botOrder;
  if (game.opponent !== 'openai' || !order || order.expiresAt <= game.time) return null;
  if (game.spike.state === 'planted' && order.action === 'retake') {
    const group = game.botRetake;
    return group?.phase === 'gathering' && group.unitIds.includes(u.id)
      ? group.spots[u.id] : position(game.spike);
  }
  if (order.via) {
    if (dist(u, order.via) >= 2) return order.via;
    order.via = null;
  }
  return order.point;
}

function combatReason(snapshot, previous) {
  if (!previous) return null;
  const previousBots = new Map(previous.squad.map(u => [u.id, u]));
  const living = new Set(snapshot.squad.map(u => u.id));
  const lost = previous.squad.filter(u => !living.has(u.id)).map(u => u.name);
  const escaping = snapshot.squad.filter(u => u.combat?.fallingBack && !previousBots.get(u.id)?.combat?.fallingBack);
  const known = new Map(previous.contacts.map(c => [c.id, c.zone]));
  const sightings = new Map();
  for (const contact of snapshot.contacts) {
    if (known.get(contact.id) === contact.zone) continue;
    sightings.set(contact.zone, (sightings.get(contact.zone) ?? 0) + 1);
  }
  return [
    ...(lost.length ? [`${lost.join(', ')} eliminated`] : []),
    ...escaping.map(u => `${u.name} taking cover`),
    ...[...sightings].map(([zone, count]) => `${count} enem${count === 1 ? 'y' : 'ies'} spotted at ${zone}`),
  ].join(' · ') || null;
}

export function createOpponentCommander({ request = (...args) => fetch(...args), now = () => performance.now() } = {}) {
  let activeGame = null;
  let pending = null;
  let nextAt = 0;
  let lastObjective = null;
  let lastSnapshot = null;
  let lastRequestedAt = -Infinity;
  let eventReadyAt = null;

  function reset() {
    pending?.abort();
    pending = null;
    activeGame = null;
    nextAt = 0;
    lastObjective = null;
    lastSnapshot = null;
    lastRequestedAt = -Infinity;
    eventReadyAt = null;
  }

  function update(game) {
    if (activeGame !== game) { reset(); activeGame = game; }
    if (game.result || game.opponent !== 'openai') {
      pending?.abort();
      return;
    }
    game.botCommander ??= { status: 'waiting', plans: 0, summary: '', reason: '', planningReason: '', model: '', error: '', orders: [] };
    const status = game.botCommander;
    const objective = objectiveKey(game);
    const snapshot = opponentSnapshot(game);
    if (!snapshot.squad.length) return;
    const currentTime = now();
    // Compare only information available to this squad with the snapshot sent in the last
    // request. Repeated sightings in the same zone do not emit new events. Changes during
    // an outstanding request remain detectable when its answer arrives.
    const eventReason = combatReason(snapshot, lastSnapshot);
    eventReadyAt = eventReason ? eventReadyAt ?? currentTime + EVENT_DEBOUNCE_MS : null;
    if (pending) return;
    // Combat events must not bypass the retry delay during an outage.
    if (status.status === 'fallback' && currentTime < nextAt) return;
    const objectiveChanged = lastObjective !== null && objective !== lastObjective;
    const eventDue = eventReadyAt !== null && currentTime >= eventReadyAt && currentTime - lastRequestedAt >= EVENT_REPLAN_MS;
    if (currentTime < nextAt && !objectiveChanged && !eventDue) return;
    const reason = !lastSnapshot ? `Opening ${snapshot.team === 'attack' ? 'attack' : 'defense'}`
      : objectiveChanged ? `Spike planted at ${snapshot.spike.site}`
      : status.status === 'fallback' ? 'Retry after commander unavailable'
      : eventReason ?? 'Routine battlefield check';
    const controller = new AbortController();
    pending = controller;
    lastObjective = objective;
    lastSnapshot = snapshot;
    lastRequestedAt = currentTime;
    eventReadyAt = null;
    status.status = 'thinking';
    status.planningReason = reason;
    const started = currentTime;
    const capturedAt = game.time;
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    // Return the promise for headless checks; the render loop deliberately doesn't await it.
    return (async () => {
      try {
        const response = await request('/api/opponent', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify(snapshot), signal: controller.signal,
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `Opponent HTTP ${response.status}`);
        if (activeGame !== game || game.result) return;
        if (controller.signal.aborted) throw new Error('Opponent request timed out');
        if (objectiveKey(game) !== objective || game.time - capturedAt > PLAN_LIFETIME) {
          status.status = 'waiting';
          nextAt = 0; // get a fresh plan; never apply a pre-plant plan to a retake
          return;
        }
        const plan = validateOpponentPlan(data.plan, snapshot, game.map);
        applyOpponentPlan(game, plan);
        Object.assign(status, {
          status: data.mock ? 'mock' : 'active', plans: status.plans + 1,
          summary: plan.summary, reason, orders: plan.orders, model: data.model,
          latency: Math.round(now() - started), error: '',
        });
        nextAt = now() + REPLAN_MS;
      } catch (error) {
        if (activeGame !== game || game.result || pending !== controller) return;
        for (const u of livingBots(game)) u.botOrder = null;
        game.botRetake = null;
        Object.assign(status, {
          status: 'fallback', orders: [], summary: '',
          error: controller.signal.aborted ? 'Opponent request timed out' : error.message,
        });
        nextAt = now() + REPLAN_MS * 2;
      } finally {
        clearTimeout(timeout);
        if (pending === controller) pending = null;
      }
    })();
  }

  return { update, reset };
}
