// OpenAI commands the defenders; ordinary game code executes these bounded orders.
// This module has no DOM or Jev dependency so either renderer can use it.
import { dist, hasLineOfSight, zoneAt, zoneByName } from './world.js';

export const OPPONENT_ACTIONS = ['hold', 'rotate', 'flank', 'retreat', 'regroup', 'retake'];
export const PLAN_LIFETIME = 12; // simulation seconds
const REPLAN_MS = 5000;
const EVENT_REPLAN_MS = 2000; // minimum time between requests triggered by combat
const EVENT_DEBOUNCE_MS = 350; // collect a burst of sightings/casualties into one plan
const REQUEST_TIMEOUT_MS = 9000;

const defenders = game => game.units.filter(u => u.kind === 'bot' && u.team === 'enemy' && u.alive);
const position = u => ({ x: Math.round(u.x * 10) / 10, y: Math.round(u.y * 10) / 10 });
const objectiveKey = game => game.spike.state === 'planted' ? `planted:${game.spike.site}` : 'unplanted';

// Local facts for both the immediate survival reflex and the slower commander. Nearby
// teammates can support directly or cover the same enemy from another angle.
export function defenderCombat(game, u) {
  const enemies = u.visible.filter(v => v.alive);
  return {
    visibleEnemies: enemies.length,
    nearbyAllies: defenders(game).filter(m => m !== u && dist(u, m) <= 12
      && (hasLineOfSight(game.map, u, m) || m.visible.some(v => enemies.includes(v)))).length,
    fallingBack: !!u.botFallback,
  };
}

export function opponentSnapshot(game) {
  const bots = defenders(game);
  const visibleIds = new Set(bots.flatMap(u => u.visible.map(v => v.id)));
  return {
    time: Math.round(game.time * 10) / 10,
    secondsLeft: Math.max(0, Math.round(game.roundTime - game.time)),
    defenders: bots.map(u => ({
      id: u.id, name: u.name, hp: Math.round(u.hp), position: position(u), zone: zoneAt(game.map, u).name,
      combat: defenderCombat(game, u),
      order: u.botOrder && u.botOrder.expiresAt > game.time
        ? { action: u.botOrder.action, zone: u.botOrder.zone } : null,
    })),
    // Never send the player's orders, cursor, or unseen units' live positions/health.
    contacts: [...game.enemyIntel.entries()]
      .filter(([, sighting]) => game.time - sighting.t <= 8)
      .map(([id, sighting]) => ({
        id, position: position(sighting), zone: zoneAt(game.map, sighting).name,
        age: Math.max(0, Math.round((game.time - sighting.t) * 10) / 10), visible: visibleIds.has(id),
      })),
    // A planted spike is public. Its carrier and dropped location are not.
    spike: game.spike.state === 'planted'
      ? { state: 'planted', site: game.spike.site, position: position(game.spike), secondsLeft: Math.max(0, Math.round(game.spike.timer)) }
      : { state: 'unplanted' },
  };
}

export function validateOpponentPlan(plan, snapshot, map) {
  if (!plan || typeof plan.summary !== 'string' || !plan.summary.trim() || plan.summary.length > 240
      || !Array.isArray(plan.orders) || plan.orders.length !== snapshot.defenders.length) {
    throw new Error('Opponent returned an incomplete plan');
  }
  const remaining = new Set(snapshot.defenders.map(u => u.id));
  const orders = plan.orders.map(order => {
    if (!order || !remaining.delete(order.unitId) || !OPPONENT_ACTIONS.includes(order.action)
        || !zoneByName(map, order.zone) || (order.action === 'retake' && snapshot.spike.state !== 'planted')) {
      throw new Error('Opponent returned an invalid unit, action, or destination');
    }
    return { unitId: order.unitId, action: order.action, zone: order.zone };
  });
  return { summary: plan.summary.trim(), orders };
}

export function applyOpponentPlan(game, plan) {
  for (const order of plan.orders) {
    const u = defenders(game).find(bot => bot.id === order.unitId);
    if (!u) continue; // a defender may have died during the request
    const previous = u.botOrder;
    if (previous && previous.expiresAt > game.time && previous.action === order.action && previous.zone === order.zone) {
      // Renew an ongoing maneuver without sending a flanker back to a completed waypoint
      // or interrupting the current path/cover reflex.
      previous.expiresAt = game.time + PLAN_LIFETIME;
      continue;
    }
    // Holding a site should not pull an anchor off their existing angle into its center.
    const target = order.action === 'hold' && zoneAt(game.map, u).name === order.zone
      ? position(u) : zoneByName(game.map, order.zone).center;
    const flankZone = order.action === 'flank' ? game.map.routes[order.zone]?.flank?.[0] : null;
    u.botOrder = {
      ...order, point: { ...target },
      via: flankZone ? { ...zoneByName(game.map, flankZone).center } : null,
      expiresAt: game.time + PLAN_LIFETIME,
    };
    u.pathGoal = null;
    u.coverPoint = null;
  }
}

export function opponentDestination(game, u) {
  const order = u.botOrder;
  if (game.opponent !== 'openai' || !order || order.expiresAt <= game.time) return null;
  if (game.spike.state === 'planted' && order.action === 'retake') return position(game.spike);
  if (order.via) {
    if (dist(u, order.via) >= 2) return order.via;
    order.via = null;
  }
  return order.point;
}

function combatReason(snapshot, previous) {
  if (!previous) return null;
  const previousDefenders = new Map(previous.defenders.map(u => [u.id, u]));
  const living = new Set(snapshot.defenders.map(u => u.id));
  const lost = previous.defenders.filter(u => !living.has(u.id)).map(u => u.name);
  const escaping = snapshot.defenders.filter(u => u.combat?.fallingBack && !previousDefenders.get(u.id)?.combat?.fallingBack);
  const known = new Map(previous.contacts.map(c => [c.id, c.zone]));
  const sightings = new Map();
  for (const contact of snapshot.contacts) {
    if (known.get(contact.id) === contact.zone) continue;
    sightings.set(contact.zone, (sightings.get(contact.zone) ?? 0) + 1);
  }
  return [
    ...(lost.length ? [`${lost.join(', ')} eliminated`] : []),
    ...escaping.map(u => `${u.name} taking cover`),
    ...[...sightings].map(([zone, count]) => `${count} attacker${count === 1 ? '' : 's'} spotted at ${zone}`),
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
    if (game.result || game.mode !== 'tactical' || game.opponent !== 'openai') {
      pending?.abort();
      return;
    }
    game.botCommander ??= { status: 'waiting', plans: 0, summary: '', reason: '', planningReason: '', model: '', error: '', orders: [] };
    const status = game.botCommander;
    const objective = objectiveKey(game);
    const snapshot = opponentSnapshot(game);
    if (!snapshot.defenders.length) return;
    const currentTime = now();
    // Compare only information available to defenders with the snapshot sent in the last
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
    const reason = !lastSnapshot ? 'Opening defense'
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
        for (const u of defenders(game)) u.botOrder = null;
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
