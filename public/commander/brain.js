// Jev brains. Two layers, both plain typed questions against a text/JSON state:
//   1. interpretCommand: one call turns a commander order (voice, text, or hand signal)
//      into an order + target location for each squad member.
//   2. think: every squad member runs its own decision loop (like Jev playing Doom):
//      its local situation in, a choice of action (and who to target) out, several times a second.
import { SQUADS, aliveSquad, orderDestination, orderLabel, setOrder, unitById } from './sim.js';
import { angleDiff, angleTo, dist, zoneAt, zoneByName } from './world.js';

const THINK_MS = 450;
// Until Jev's first answer arrives after contact starts, agents default to this.
const CONTACT_DEFAULT = { tactical: 'fight', titan: 'flank' };

const ORDERS = {
  tactical: {
    push: 'go to / rush / attack / take / move to the location',
    hold: 'hold / defend / watch / stay at the location',
    flank: 'take a side route to hit enemies from an unexpected angle',
    retreat: 'fall back / retreat / pull out',
    regroup: 'group up / stack together with the squad',
    plant: 'plant the spike (only when told to plant)',
  },
  titan: {
    attack: 'hunt / kill / cut down titans at the location',
    hold: 'hold / defend / stay at the location',
    flank: 'circle around to hit titans from behind',
    retreat: 'fall back toward the gate',
    regroup: 'group up / stack together with the squad',
    protect: 'defend the gate',
  },
};

const PRIORITIES = {
  any: 'no particular titan type',
  small: 'small titans',
  big: 'big titans',
  abnormal: 'abnormal titans',
};

export function createBrains() {
  const stats = { calls: 0, ok: 0, failed: 0, lastError: '', latencies: [], recent: [] };

  async function evaluate(state, questions, maxRetries = 0) {
    const started = performance.now();
    stats.calls++;
    stats.recent.push(Date.now());
    try {
      const res = await fetch('/api/evaluate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ state, questions, maxRetries }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(`HTTP ${res.status}: ${data.error}`);
      stats.ok++;
      const latency = performance.now() - started;
      stats.latencies.push(latency);
      if (stats.latencies.length > 50) stats.latencies.shift();
      return { ...data, latency };
    } catch (error) {
      stats.failed++;
      stats.lastError = error.message;
      throw error;
    }
  }

  // ---------- 1. commander orders ----------

  // `only` names the one agent the order is for (first-person view); otherwise Jev works out
  // who each order addresses.
  async function interpretCommand(game, { text, gesture, only }) {
    const names = only ? [only] : aliveSquad(game).map(u => u.name);
    const pointer = game.pointer && performance.now() - game.pointer.at < 8000 ? game.pointer : null;
    const pointerZone = pointer ? zoneAt(game.map, pointer).name : null;
    const locations = Object.fromEntries(game.map.zones.map(z => [z.name, z.description]));
    if (pointer) locations.pointed = `exactly where the commander is pointing (in ${pointerZone})`;
    locations.current = 'stay where they are now';

    const questions = {};
    for (const name of names) {
      const key = name.toLowerCase();
      if (!only) questions[`${key}_addressed`] = {
        type: 'boolean',
        // Tested against alternatives: this phrasing got 24/24 addressee checks right.
        instructions: `Does this order apply to ${name}? It does if ${name}'s name appears in it, or if it names no one (orders without names are for the whole squad).`,
      };
      questions[`${key}_order`] = { type: 'choice', instructions: `What is ${name} ordered to do?`, criteria: ORDERS[game.mode] };
      questions[`${key}_target`] = { type: 'choice', instructions: `Which location is ${name}'s order about?`, criteria: locations };
      if (game.mode === 'titan') {
        questions[`${key}_priority`] = { type: 'choice', instructions: `Which titans should ${name} go after first?`, criteria: PRIORITIES };
      }
    }
    const state = {
      commander_says: text,
      ...(only && { talking_to: only }),
      ...(gesture && { hand_signal: `${gesture.emoji} ${gesture.label}: ${gesture.meaning}` }),
      pointing_at: pointerZone ?? 'nothing',
      squad: Object.fromEntries(aliveSquad(game).map(u => [u.name, `in ${zoneAt(game.map, u).name}, ${Math.round(u.hp)} HP`])),
    };

    const result = await evaluate(state, questions, 2);
    const plan = names.map(name => {
      const key = name.toLowerCase();
      const a = result.answers;
      const addressed = only ? 1 : a[`${key}_addressed`].probability;
      const order = a[`${key}_order`];
      const target = a[`${key}_target`];
      const priority = a[`${key}_priority`];
      const unit = game.units.find(u => u.name === name);
      const applied = addressed >= 0.5 && unit.alive;
      if (applied) {
        let point;
        let zone = target.choice;
        if (target.choice === 'pointed' && pointer) {
          point = { x: pointer.x, y: pointer.y };
          zone = pointerZone;
        } else if (target.choice === 'current' || target.choice === 'pointed') {
          point = { x: unit.x, y: unit.y };
          zone = zoneAt(game.map, unit).name;
        } else {
          point = zoneByName(game.map, target.choice).center;
        }
        setOrder(game, unit, { type: order.choice, zone, point, priority: priority?.choice ?? 'any' });
        unit.action = order.choice === 'hold' ? 'hold' : 'advance';
      }
      return {
        name,
        addressed,
        applied,
        order: order.choice,
        orderP: order.probabilities?.[order.choice] ?? 1,
        target: target.choice === 'pointed' ? `☝ ${pointerZone}` : target.choice,
        targetP: target.probabilities?.[target.choice] ?? 1,
        priority: priority?.choice,
      };
    });
    return { plan, latency: result.latency, tokens: result.usage?.inputTokens };
  }

  // ---------- 2. per-agent decision loops ----------

  function update(game) {
    const now = performance.now();
    aliveSquad(game).forEach((u, i) => {
      u.brain ??= { pending: false, nextAt: now + (i * THINK_MS) / 4, calls: 0, failed: 0 };
      if (u.brain.pending) return;
      const tick = game.mode === 'tactical' ? tacticalTick(game, u) : titanTick(game, u);
      // Nothing to decide (no contact): follow the commander's order without a Jev call.
      if (!tick) {
        if (!u.decision?.local) u.decision = { action: 'advance', probabilities: { advance: 1 }, local: true };
        u.action = 'advance';
        return;
      }
      if (u.decision?.local) {
        u.action = CONTACT_DEFAULT[game.mode];
        u.decision = null;
        u.brain.nextAt = now; // think right away when contact starts
      }
      if (now < u.brain.nextAt) return;
      u.brain.pending = true;
      u.brain.nextAt = now + THINK_MS;
      const { state, questions, targets } = tick;
      u.brain.calls++;
      evaluate(state, questions)
        .then(({ answers, latency }) => {
          if (!u.alive || game.result) return;
          const { action, target } = answers;
          if (action.choice !== u.action) u.coverPoint = null;
          u.action = action.choice;
          if (target) u.focusId = targets[target.choice] ?? null;
          else if (targets && Object.keys(targets).length === 1) u.focusId = Object.values(targets)[0];
          u.decision = {
            action: action.choice,
            probabilities: action.probabilities ?? { [action.choice]: 1 },
            target: target?.choice ?? null,
            latency,
            at: game.time,
          };
        })
        .catch(() => {
          u.brain.failed++;
        })
        .finally(() => {
          u.brain.pending = false;
        });
    });
  }

  function tacticalTick(game, u) {
    const objective = orderDestination(game, u);
    const toObjective = Math.round(dist(u, objective));
    const enemies = u.visible.slice(0, 4).map(e => ({
      id: e.name,
      distance_m: Math.round(dist(u, e)),
      hp: Math.round(e.hp),
      shooting_at_you: e.targetId === u.id && game.time - e.lastShotAt < 1,
    }));
    const mates = aliveSquad(game).filter(m => m !== u);
    const fightingMate = mates.filter(m => m.visible.length).sort((a, b) => dist(u, a) - dist(u, b))[0];
    const spike = game.spike;
    const state = {
      you: {
        name: u.name,
        hp: Math.round(u.hp),
        location: zoneAt(game.map, u).name,
        moving: u.moving,
        carrying_spike: spike.state === 'carried' && spike.carrierId === u.id,
      },
      commander_order: orderLabel(u),
      meters_to_ordered_position: toObjective,
      enemies_in_sight: enemies,
      teammates: mates.map(m => ({ name: m.name, hp: Math.round(m.hp), distance_m: Math.round(dist(u, m)), in_a_fight: m.visible.length > 0 })),
      spike: spike.state === 'planted' ? `planted on ${spike.site}, ${Math.round(spike.timer)}s to detonation — defend it` : spike.state,
    };
    if (!enemies.length && !fightingMate) return null;
    // Each option says when it applies: Jev follows these conditions closely (tested on labelled situations).
    const actions = {
      advance: `keep moving to your ordered position (${u.order.zone}, ${toObjective}m away): when no enemy is in sight`,
      hold: 'stay put and watch this angle: when no enemy is in sight but one could appear',
      cover: 'break line of sight behind cover: when you are hurt and outnumbered',
    };
    if (enemies.length) actions.fight = 'stop and shoot the enemy: whenever an enemy is in sight (standing still makes you far more accurate)';
    if (fightingMate && !enemies.length) actions.support = `go help ${fightingMate.name}, who is in a fight: when no enemy is in sight`;
    const questions = {
      action: { type: 'choice', instructions: `You are ${u.name}. What should you do right now?`, criteria: actions },
    };
    if (enemies.length >= 2) {
      questions.target = {
        type: 'choice',
        instructions: 'Which enemy should you shoot first?',
        criteria: Object.fromEntries(enemies.map(e => [e.id, `${e.distance_m}m away, ${e.hp} HP${e.shooting_at_you ? ', shooting at you' : ''}`])),
      };
    }
    const targets = Object.fromEntries(u.visible.slice(0, 4).map(e => [e.name, e.id]));
    return { state, questions, targets };
  }

  function titanTick(game, u) {
    const objective = orderDestination(game, u);
    const toObjective = Math.round(dist(u, objective));
    const titans = u.visible.slice(0, 4).map(t => ({
      id: t.name,
      type: t.class,
      doing: { walking: 'walking', windup: 'winding up a grab', recovering: 'recovering from a grab: frozen and open' }[t.status],
      distance_m: Math.round(dist(u, t) - t.r),
      hp: Math.round(t.hp),
      facing_you: angleDiff(t.facing, angleTo(t, u)) < 1.2,
      you_are_behind_it: angleDiff(t.facing, angleTo(t, u)) > 1.9,
      within_its_reach: dist(u, t) - t.r <= t.reach + 1,
    }));
    const gateThreat = game.units.some(t => t.alive && t.kind === 'titan' && t.y > game.gate.y - 8);
    const state = {
      you: { name: u.name, hp: Math.round(u.hp), location: zoneAt(game.map, u).name },
      commander_order: orderLabel(u),
      commander_priority: u.order.priority === 'any' ? 'none' : `${u.order.priority} titans first`,
      meters_to_ordered_position: toObjective,
      titans_nearby: titans,
      gate: `${Math.round(game.gate.hp)} / ${game.gate.maxHp} HP${gateThreat ? ', titans are at the gate' : ''}`,
      squadmates: aliveSquad(game).filter(m => m !== u).map(m => ({ name: m.name, hp: Math.round(m.hp), distance_m: Math.round(dist(u, m)) })),
    };
    if (!titans.length) return null;
    // Each option says when it applies: Jev follows these conditions closely (8/8 on labelled situations).
    const actions = {
      strike: 'cut the titan\'s nape now: only when you are behind it or it is frozen recovering from a grab',
      flank: 'circle around behind the titan out of its reach: when it is facing you or walking toward you and your HP is above 40',
      evade: 'retreat out of reach: when your HP is below 40, or two or more titans are within 6m of you',
    };
    if (toObjective > 5) actions.advance = `ignore the titans and move to your ordered position (${u.order.zone}, ${toObjective}m away): only when no titan is close to you`;
    if (gateThreat) actions.protect = 'rush back to defend the gate: when titans are attacking it and you are far from it';
    const questions = {
      action: { type: 'choice', instructions: `You are ${u.name} of the Scout Regiment. What should you do right now?`, criteria: actions },
    };
    if (titans.length >= 2) {
      questions.target = {
        type: 'choice',
        instructions: 'Which titan should you go after?',
        criteria: Object.fromEntries(titans.map(t => [t.id, `${t.type} titan, ${t.distance_m}m away, ${t.hp} HP, ${t.doing}${t.you_are_behind_it ? ', you are behind it' : t.facing_you ? ', facing you' : ''}`])),
      };
    }
    const targets = Object.fromEntries(u.visible.slice(0, 4).map(t => [t.name, t.id]));
    return { state, questions, targets };
  }

  function summary() {
    const cutoff = Date.now() - 60_000;
    stats.recent = stats.recent.filter(t => t > cutoff);
    const sorted = [...stats.latencies].sort((a, b) => a - b);
    return {
      perMinute: stats.recent.length,
      ok: stats.ok,
      failed: stats.failed,
      p50: sorted.length ? Math.round(sorted[Math.floor(sorted.length / 2)]) : null,
      lastError: stats.lastError,
    };
  }

  return { interpretCommand, update, summary, stats };
}

// For the spike carrier's name in hand-signal orders.
export const spikeCarrierName = game => unitById(game, game.spike?.carrierId)?.name;
