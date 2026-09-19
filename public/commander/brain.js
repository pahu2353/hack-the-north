// Jev brains. Two layers, both plain typed questions against a text/JSON state:
//   1. interpretCommand: one call turns a commander's order (voice, text, or hand signal)
//      into an order + target location for each of their agents.
//   2. update: every agent in contact runs its own decision loop (like Jev playing Doom):
//      its local situation in, a choice of action (and who to shoot) out, about twice a second.
// Works for either team, in the browser (bot games) or on the server (multiplayer).
import { aliveTeam, grenadeSpot, incomingGrenade, obeying, orderDestination, orderLabel, setOrder, unitById } from './sim.js';
import { dist, zoneAt, zoneByName } from './world.js';

const THINK_MS = 450;

// The orchestrator question: with a hands-free mic, most of what Jev hears is not an order.
// On labelled commands this scores chatter at 8-14% and real orders at 89-97%.
const ORDER_GATE = {
  type: 'boolean',
  instructions: 'Is the commander giving their squad an order, or just talking (thinking out loud, reacting to the game, chatting)?',
  criteria: {
    true: 'an order for the squad to carry out',
    false: 'not an order: chatter, a question, a reaction, or thinking out loud',
  },
};

const ORDERS = {
  attack: {
    push: 'go to / rush / attack / take / move to the location',
    hold: 'hold / defend / watch / stay at the location',
    flank: 'flank: swing around / go around / take the long way to hit enemies from the side',
    retreat: 'fall back / retreat / pull out',
    regroup: 'group up / stack together with the squad',
    grenade: 'throw a grenade / nade / frag the location',
    plant: 'plant the spike (only when told to plant)',
  },
  defend: {
    push: 'go to / rush / retake / attack / move to the location',
    hold: 'hold / defend / watch / stay at the location',
    flank: 'flank: swing around / go around / take the long way to hit enemies from the side',
    retreat: 'fall back / retreat / pull out',
    regroup: 'group up / stack together with the squad',
    grenade: 'throw a grenade / nade / frag the location',
    defuse: 'go defuse the planted spike (only when told to defuse)',
  },
};

// Calls Jev through the local server. The server passes its own evaluate that calls Jev directly.
async function evaluateOverHttp(state, questions, maxRetries) {
  const started = performance.now();
  const res = await fetch('/api/evaluate', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ state, questions, maxRetries }),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${data.error}`);
  return { ...data, latency: performance.now() - started };
}

export function createBrains({ evaluate = evaluateOverHttp, thinkMs = THINK_MS } = {}) {
  const stats = { calls: 0, ok: 0, failed: 0, lastError: '', latencies: [], recent: [] };
  let commandSequence = 0;
  // Track accepted orders per unit: chatter or an order for Bravo must not cancel Alpha's.
  // Explicit sequences also prevent a partial voice guess from replacing its final sentence.
  const lastAppliedCommand = new WeakMap();

  async function ask(state, questions, maxRetries = 0) {
    stats.calls++;
    stats.recent.push(Date.now());
    try {
      const result = await evaluate(state, questions, maxRetries);
      stats.ok++;
      stats.latencies.push(result.latency);
      if (stats.latencies.length > 50) stats.latencies.shift();
      return result;
    } catch (error) {
      stats.failed++;
      stats.lastError = error.message;
      throw error;
    }
  }

  // ---------- 1. commander orders ----------

  // `only` names the one agent an order is for: in the first-person view you are talking to
  // the agent you're watching, so Jev isn't asked who it addresses.
  async function interpretCommand(game, team, { text, gesture, pointer, only, seq }) {
    const squad = aliveTeam(game, team).filter(u => !only || u.name === only);
    if (!squad.length) return { plan: [], latency: 0, tokens: 0 };
    const commandId = Number.isSafeInteger(seq) && seq > 0 ? seq : commandSequence + 1;
    commandSequence = Math.max(commandSequence, commandId);
    const pointerZone = pointer ? zoneAt(game.map, pointer).name : null;
    // "Fall back to spawn" means your own spawn, so describe the two relative to this team.
    const ownSpawn = team === 'attack' ? 'Attacker Spawn' : 'Defender Spawn';
    const locations = Object.fromEntries(game.map.zones.map(z => [
      z.name,
      z.name.endsWith('Spawn')
        ? (z.name === ownSpawn ? 'your own spawn, where your squad started' : "the enemy's spawn, on their side of the map")
        : z.description,
    ]));
    if (pointer) locations.pointed = `exactly where the commander is pointing (in ${pointerZone})`;
    locations.current = 'stay where they are now';

    const questions = {};
    for (const { name } of squad) {
      const key = name.toLowerCase();
      if (!only) questions[`${key}_addressed`] = {
        type: 'boolean',
        // Wording picked by measurement: it handles orders that give different jobs to
        // different agents in one breath ("Charlie rush A, Alpha plant", "everyone else hold").
        instructions: `The commander may give different jobs to different agents in one breath. Does any part of this order apply to ${name}? Yes if ${name} is named in any clause, if no names appear at all, or if it says "everyone else" / "the rest".`,
      };
      questions[`${key}_order`] = { type: 'choice', instructions: `What is ${name} ordered to do?`, criteria: ORDERS[team] };
      questions[`${key}_target`] = { type: 'choice', instructions: `Which location is ${name}'s order about?`, criteria: locations };
    }
    questions.is_order = ORDER_GATE;
    const state = {
      commander_says: text,
      ...(only && { talking_to: only }),
      ...(gesture && { hand_signal: `${gesture.emoji} ${gesture.label}: ${gesture.meaning}` }),
      pointing_at: pointerZone ?? 'nothing',
      squad: Object.fromEntries(squad.map(u => [u.name, `in ${zoneAt(game.map, u).name}, ${Math.round(u.hp)} HP`])),
    };

    // Jev occasionally 500s on a question with no clear winner, so give it one more go.
    const result = await ask(state, questions, 2).catch(() => ask(state, questions, 2));
    const isOrder = result.answers.is_order.probability;
    if (isOrder < 0.5) {
      return { ignored: true, isOrder, plan: [], latency: result.latency, tokens: result.usage?.inputTokens };
    }
    const plan = squad.map(unit => {
      const key = unit.name.toLowerCase();
      const a = result.answers;
      const addressed = only ? 1 : a[`${key}_addressed`].probability;
      const order = a[`${key}_order`];
      const target = a[`${key}_target`];
      const skipReason = addressed < 0.5 ? 'not addressed'
        : !unit.alive ? 'agent eliminated'
        : game.result ? 'round ended'
        : commandId < (lastAppliedCommand.get(unit) ?? 0) ? 'newer order already applied'
        : null;
      const applied = skipReason === null;
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
        setOrder(game, unit, { type: order.choice, zone, point });
        lastAppliedCommand.set(unit, commandId);
        unit.action = order.choice === 'hold' ? 'hold' : 'advance';
      }
      return {
        name: unit.name,
        addressed,
        applied,
        ...(skipReason && { skipReason }),
        order: order.choice,
        orderP: order.probabilities?.[order.choice] ?? 1,
        target: target.choice === 'pointed' ? `☝ ${pointerZone}` : target.choice,
        targetP: target.probabilities?.[target.choice] ?? 1,
      };
    });
    const stale = plan.some(p => p.skipReason === 'newer order already applied') && !plan.some(p => p.applied);
    return { plan, isOrder, stale, latency: result.latency, tokens: result.usage?.inputTokens };
  }

  // ---------- 2. per-agent decision loops ----------

  function update(game, team) {
    const now = performance.now();
    aliveTeam(game, team).forEach((u, i) => {
      if (u.kind !== 'agent') return;
      u.brain ??= { pending: false, nextAt: now + (i * thinkMs) / 4 };
      if (u.brain.pending) return;
      // A fresh order is carried out, not debated: the simulation is already doing exactly
      // what the commander said. The exception is a grenade about to go off, where standing
      // there to obey would just get them killed.
      if (obeying(game, u) && !incomingGrenade(game, u)) {
        u.decision = { action: u.action, probabilities: { [u.action]: 1 }, obeying: true };
        u.brain.nextAt = now;
        return;
      }
      const tick = agentTick(game, u);
      // Nothing to decide (no contact): follow the commander's order without a Jev call.
      if (!tick) {
        if (!u.decision?.local) u.decision = { action: 'advance', probabilities: { advance: 1 }, local: true };
        u.action = 'advance';
        return;
      }
      if (u.decision?.local) {
        u.action = 'fight'; // until Jev's first answer after contact arrives
        u.decision = null;
        u.brain.nextAt = now;
      }
      if (now < u.brain.nextAt) return;
      u.brain.pending = true;
      u.brain.nextAt = now + thinkMs;
      const { state, questions, targets } = tick;
      ask(state, questions)
        .then(({ answers, latency }) => {
          if (!u.alive || game.result) return;
          const { action, target } = answers;
          if (action.choice !== u.action) u.coverPoint = null;
          u.action = action.choice;
          if (target) u.focusId = targets[target.choice] ?? null;
          else if (Object.keys(targets).length === 1) u.focusId = Object.values(targets)[0];
          u.decision = {
            action: action.choice,
            probabilities: action.probabilities ?? { [action.choice]: 1 },
            target: target?.choice ?? null,
            latency,
          };
        })
        .catch(() => {})
        .finally(() => {
          u.brain.pending = false;
        });
    });
  }

  function agentTick(game, u) {
    const enemies = u.visible.slice(0, 4).map(e => ({
      id: e.name,
      distance_m: Math.round(dist(u, e)),
      hp: Math.round(e.hp),
      shooting_at_you: e.targetId === u.id && game.time - e.lastShotAt < 1,
    }));
    const mates = aliveTeam(game, u.team).filter(m => m !== u);
    const fightingMate = mates.filter(m => m.visible.length).sort((a, b) => dist(u, a) - dist(u, b))[0];
    if (!enemies.length && !fightingMate) return null;

    const objective = orderDestination(game, u);
    const toObjective = Math.round(dist(u, objective));
    const clump = u.grenades > 0 ? grenadeSpot(game, u) : null;
    const bomb = incomingGrenade(game, u);
    const state = {
      you: {
        name: u.name,
        side: u.team === 'attack' ? 'attacker' : 'defender',
        grenades_left: u.grenades,
        hp: Math.round(u.hp),
        location: zoneAt(game.map, u).name,
        moving: u.moving,
        ...(u.team === 'attack' && { carrying_spike: game.spike.state === 'carried' && game.spike.carrierId === u.id }),
      },
      commander_order: orderLabel(u),
      meters_to_ordered_position: toObjective,
      enemies_in_sight: enemies,
      teammates: mates.map(m => ({ name: m.name, hp: Math.round(m.hp), distance_m: Math.round(dist(u, m)), in_a_fight: m.visible.length > 0 })),
      spike: spikeBriefing(game, u.team),
      ...(clump && { enemies_bunched_together: `${clump.caught} of them are standing within 5m of each other, in grenade range` }),
      ...(bomb && { grenade_about_to_go_off: `${Math.max(0, bomb.explodeAt - game.time).toFixed(1)}s, ${Math.round(Math.hypot(bomb.x - u.x, bomb.y - u.y))}m away` }),
    };
    // Each option says when it applies: Jev follows these conditions closely (6/6 on labelled
    // situations). The one that carries out the commander's order says so.
    const ordered = { hold: 'hold', grenade: 'nade' }[u.order.type] ?? 'advance';
    const carriesOut = name => (name === ordered ? 'carry out your order: ' : '');
    const actions = {
      advance: `${carriesOut('advance')}keep moving to your ordered position (${u.order.zone}, ${toObjective}m away)`,
      hold: `${carriesOut('hold')}stay put and watch this angle`,
      cover: 'break line of sight behind cover: only when you are hurt and outnumbered, and it puts your order on hold',
    };
    if (enemies.length) {
      actions.fight = clump?.caught >= 2
        ? 'stop and shoot one of them: only hurts the one you aim at'
        : 'stop and shoot the enemy in sight: standing still makes you far more accurate, but it puts your order on hold';
    }
    if (clump?.caught >= 2 && !bomb) actions.nade = `${carriesOut('nade')}throw your one grenade at the ${clump.caught} enemies bunched together: it hurts all of them at once, so it beats shooting at one`;
    if (bomb) actions.scatter = 'run clear of the grenade about to go off beside you: staying there costs most of your health';
    if (fightingMate && !enemies.length) actions.support = `go help ${fightingMate.name}, who is in a fight: when no enemy is in sight`;
    const questions = {
      action: {
        type: 'choice',
        instructions: `You are ${u.name}. Your commander ordered you to ${orderLabel(u)}, and that order outranks your own judgement: carry it out unless doing so right now would get you killed or you cannot carry it out from here. What should you do?`,
        criteria: actions,
      },
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

  return { interpretCommand, update, summary };
}

function spikeBriefing(game, team) {
  const s = game.spike;
  if (s.state === 'planted') {
    return team === 'attack'
      ? `planted on ${s.site}, ${Math.round(s.timer)}s to detonation: protect it`
      : `planted on ${s.site}, ${Math.round(s.timer)}s to detonation: defuse it (stand on it with no enemy in sight)`;
  }
  return team === 'attack' ? `${s.state}: get it planted on a site` : 'not planted yet: stop them from planting';
}

export const spikeCarrierName = game => unitById(game, game.spike.carrierId)?.name;
