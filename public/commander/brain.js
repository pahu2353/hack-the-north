// Jev brains. Two layers, both plain typed questions against a text/JSON state:
//   1. interpretCommand: one call turns a commander's order (voice, text, or hand signal)
//      into an order + target location for each of their agents.
//   2. update: every agent in contact runs its own decision loop (like Jev playing Doom):
//      its local situation in, a choice of action (and who to shoot) out, about twice a second.
// Works for either team, in the browser (bot games) or on the server (multiplayer).
import { aliveTeam, directionPoint, enemyContact, grenadeSpot, incomingGrenade, isDirection, obeying, orderAction, orderDestination, orderLabel, roundStatus, setOrder, unitById } from './sim.js';
import { dist, zoneAt, zoneByName } from './world.js';

const THINK_MS = 450;
const VOICE_PACE = { mild: 1.08, strong: 1.18 };

// Words that start an instruction. A lone letter counts as an agent's initial only when one of
// these follows it, which is what keeps "a" the article out of it: "throw a nade", "make a
// push" and "take a peek" all put the letter after a verb rather than before one.
const ORDER_WORDS = ['push', 'rush', 'hit', 'take', 'go', 'move', 'head', 'run',
  'hold', 'camp', 'watch', 'lock', 'sit', 'stay', 'guard', 'anchor', 'post', 'defend',
  'flank', 'rotate', 'retake', 'swing', 'lurk', 'peek', 'wrap', 'split', 'stack',
  'retreat', 'fall', 'regroup', 'group', 'back', 'attack', 'clear',
  'plant', 'defuse', 'nade', 'grenade', 'throw', 'frag', 'cover', 'support', 'help', 'follow'];

// Agents answer to their initial as well as their name: "c hold mid", "a and b push B".
// On this map A and B are also the two bomb sites, so position decides which is meant — an
// agent is the subject of a clause, a site is where the clause sends them. "a push b" is
// Alpha going to B; "push a" is the whole squad going to A.
export function expandAgentInitials(text, roster) {
  if (!text || !roster.length) return text;
  // An initial two agents share names neither of them, so it stays a letter and Jev decides.
  const counts = new Map();
  for (const name of roster) counts.set(name[0].toLowerCase(), (counts.get(name[0].toLowerCase()) ?? 0) + 1);
  const unique = roster.filter(name => counts.get(name[0].toLowerCase()) === 1);
  if (!unique.length) return text;
  const initials = unique.map(name => name[0].toLowerCase()).join('');
  const ref = `(?:\\b(?:${roster.join('|')})\\b|\\b[${initials}]\\b)`;
  // One agent, or several joined by commas and "and".
  const run = `${ref}(?:(?:\\s*(?:,|and)\\s*|\\s+)${ref})*`;
  // Only at the start of a clause: anything else is a letter doing some other job.
  const clause = new RegExp(`(^|[,.;!?]\\s*|\\b(?:and|then|also|plus)\\s+)(${run})(?=\\s+(?:${ORDER_WORDS.join('|')})\\b)`, 'gi');
  const lone = new RegExp(`\\b[${initials}]\\b`, 'gi');
  const named = new Map(unique.map(name => [name[0].toLowerCase(), name]));
  return text.replace(clause, (whole, before, addressed) =>
    before + addressed.replace(lone, letter => named.get(letter.toLowerCase())));
}

// Ways of addressing the whole squad at once, and the two phrasings that instead mean
// "all of you except whoever I just named", which only Jev can resolve against the clause
// that named them.
const SQUAD_ADDRESS = /\b(everyone|everybody|guys|all of you|y'?all|the team|the squad|all agents)\b/i;
const ALL_BUT_ADDRESS = /\b(everyone|everybody)\s+else\b|\bthe\s+rest\b/i;

function voicePaceMultiplier(context) {
  if (!context) return 1;
  const volume = context.volumeLevel === 'very_loud' ? VOICE_PACE.strong
    : context.volumeLevel === 'loud' ? VOICE_PACE.mild : 1;
  return Math.max(volume, VOICE_PACE[context.profanityLevel] ?? 1);
}

// The orchestrator question: with a hands-free mic, most of what Jev hears is not an order.
// Saying the quiet part out loud ("a plain statement is still an order") matters: without it,
// "Alpha and Bravo hold B site" reads as a description of what they are doing and scores 23%.
const orderGate = names => ({
  type: 'boolean',
  instructions: `The commander is speaking to their squad (${names.join(', ')}) during a match. Anything that tells one or more of them where to be or what to do is an order, even when it is phrased as a plain statement: "${names[0]} and ${names[1]} hold B site" is an order to hold B site, not a description. A short follow-up to the last command is an order too, even on its own: "you too", "${names[2]} as well", "same", "keep going". So are terse game calls that say where to go or what to do: "peek a main", "rotate b", "lurk b". Calling out what the enemy is doing ("two on b", "they're pushing mid") is not an order. Is this an order, or is the commander just talking (reacting, asking, thinking out loud)?`,
  criteria: {
    true: 'an order: it tells at least one of them where to go, what to hold, or what to do',
    false: 'not an order: a reaction, a question, or thinking out loud',
  },
});

// The words people actually shout, not the tidy ones. Each list was grown from phrasings that
// came back wrong: "rotate to a" was read as a flank, "camp b" as a push, "on me" as a push.
const MOVE = 'go / move / push / rush / run it down / head to / get to / take / hit / rotate to / peek / shift';
const STAY = 'stay put where told: hold / stop / wait / defend / watch / camp / anchor / sit on / lock down, without advancing';
const AROUND = 'flank: swing around / go around / lurk / take the long way to hit them from the side';
const BACK = 'fall back / retreat / pull out / get out / back off / reset';
const TOGETHER = 'group up / regroup / stack up / on me / come together with the squad';
const NADE = 'throw a grenade / nade / frag / flash the location';
const ORDERS = {
  attack: {
    push: `${MOVE} to the location, and going at the enemy to fight them`,
    hold: `${STAY} at the location`,
    flank: AROUND,
    retreat: BACK,
    regroup: TOGETHER,
    grenade: NADE,
    plant: 'plant the spike (only when told to plant)',
  },
  defend: {
    push: `${MOVE} to the location, retake it, or go at the enemy to fight them`,
    hold: `${STAY} at the location`,
    flank: AROUND,
    retreat: BACK,
    regroup: TOGETHER,
    grenade: NADE,
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
  const commandHistory = new WeakMap();

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
  async function interpretCommand(game, team, { source, text, gesture, pointer, direction, voiceContext, only, seq }) {
    const squad = aliveTeam(game, team).filter(u => !only || u.name === only);
    if (!squad.length) return { plan: [], latency: 0, tokens: 0 };
    // "Everyone push B", "guys hold mid". Otherwise Jev is asked once per agent whether the
    // order is for them: five questions, and five chances to disagree with itself about a
    // phrase that has one meaning. Nobody named and the squad addressed as a whole is not a
    // judgement call, so it is settled here and those questions are never asked. Dead agents
    // count as named: "Alpha and everyone push" is a mix, whether or not Alpha is still up.
    const roster = game.units.filter(u => u.team === team).map(u => u.name);
    // From here on the order says "Charlie", never "c": one spelling for the state Jev reads,
    // the addressing test below, and the history a later "do the same" is resolved against.
    const said = expandAgentInitials(text ?? '', roster);
    const namesSomeone = roster.some(name => new RegExp(`\\b${name}\\b`, 'i').test(said));
    const wholeSquad = !only && !namesSomeone && SQUAD_ADDRESS.test(said) && !ALL_BUT_ADDRESS.test(said);
    const commandId = Number.isSafeInteger(seq) && seq > 0 ? seq : commandSequence + 1;
    commandSequence = Math.max(commandSequence, commandId);
    const previousCommands = commandHistory.get(game)?.[team] ?? [];
    const pointerZone = pointer ? zoneAt(game.map, pointer).name : null;
    // "Fall back to spawn" means your own spawn, so describe the two relative to this team.
    const ownSpawn = game.map.home[team];
    const locations = Object.fromEntries(game.map.zones.map(z => [
      z.name,
      z.name.endsWith('Spawn')
        ? (z.name === ownSpawn ? 'your own spawn, where your squad started' : "the enemy's spawn, on their side of the map")
        : z.description,
    ]));
    if (pointer) locations.pointed = `exactly where the commander is pointing (in ${pointerZone})`;
    // "At them" is a place too: wherever the enemy was last seen. Without it, an order about
    // the enemy rather than the map has nowhere to land.
    const contact = enemyContact(game, team);
    locations.enemy = contact.seenAgo === null
      ? 'at the enemy: nobody has been seen, so towards their side of the map'
      : `at the enemy: where they were last seen, in ${zoneAt(game.map, contact).name}`;
    locations.current = 'stay exactly where they are now, going nowhere';
    // A direction is a pointer given in words rather than with a hand. The client resolves it
    // against whatever the commander is looking at and sends that angle, so these only exist
    // while it does: without a view there is no "right" to mean, and the options stay out of
    // the way rather than competing with the callouts for every other order.
    if (direction) Object.assign(locations, {
      forward: 'a short step forward from where they are standing: "forward", "up", "ahead", "move up"',
      back: 'a short step backwards from where they are standing: "back", "down", "behind", "back up"',
      left: 'a short step to the left of where they are standing, from the commander\'s point of view',
      right: 'a short step to the right of where they are standing, from the commander\'s point of view',
    });

    const questions = {};
    for (const { name } of squad) {
      const key = name.toLowerCase();
      if (!only && !wholeSquad) questions[`${key}_addressed`] = {
        type: 'boolean',
        // Wording picked by measurement: it handles orders that give different jobs to
        // different agents in one breath ("Charlie rush A, Alpha plant", "everyone else hold").
        instructions: `The commander may give different jobs to different agents in one breath. Does any part of this order apply to ${name}? Yes if ${name} is named in any clause, if ${name} is called by their first letter "${name[0]}" as the one being told to do something, if no names appear at all, if it addresses the whole squad ("everyone", "guys", "all of you"), or if it says "everyone else" / "the rest". A lone "A" or "B" that says where to go is the bomb site, not an agent.`,
      };
      // Both questions are about what the commander JUST said. current_orders is in the state
      // so a follow-up can be resolved, but pointing the questions at it made Jev answer with
      // the order the squad already had, whatever was said: while pushing B Site, "nade mid"
      // came back as a grenade on B Site, and "take A site" as a push to B Site.
      questions[`${key}_order`] = {
        type: 'choice',
        instructions: `What has the commander just told ${name} to do? Answer from what they said, not from the order ${name} already has. Telling them to stay somewhere once they get there ("camp b", "hold b", "watch b main", "lock down mid") is holding, not pushing, even though they have to walk there first. Only when the new words carry no instruction of their own: "keep going" / "same again" means carry on with ${name}'s own order in current_orders, and "you too" / "as well" / "same" means the order in the last of recent_commands, the one just given to someone else.`,
        criteria: ORDERS[team],
      };
      questions[`${key}_target`] = {
        type: 'choice',
        // Each line below is a phrasing that was measured going wrong: two places in one
        // breath, the sites being called A and B (so "a site" is not "some site"), orders
        // about the enemy rather than a place, and falling back to nowhere in particular.
        instructions: `Where does what the commander just said send ${name}? Take the place from their words:
- Two places, or a correction ("A site, no, B site" / "A or B" / "A site... B site"): the last one they land on wins.
- The sites, mains and links are named A and B. "a site", "the a site", "a main", "a link" mean the A one, never "some site", and a bare letter ("rush b", "lurk b", "go a") means that site.
- An order about the enemy rather than a place on the map ("at them", "push them", "fight", "kill them", "go at the enemy"): the enemy.
- Falling back or retreating with no place named: their own spawn.
- A direction instead of a place ("move right", "shift left", "back up", "everyone forward"): that direction. "up" and "ahead" mean forward; "down" and "behind" mean back. Only when they name a direction; a bare verb is not one.
- No place named at all ("move", "push", "go go go"): keep where ${name} is already headed in current_orders.
- "you too" / "as well" / "same": the place named in the last of recent_commands, the one just given to someone else, not ${name}'s own.
- "current" only when told to stop or stay put with no place named at all ("stop", "wait", "hold"). An order to hold or camp a named place ("hold b", "lock down mid") sends them to that place.`,
        criteria: locations,
      };
    }
    questions.is_order = orderGate(squad.map(u => u.name));
    if (voiceContext) {
      questions.command_urgency = {
        type: 'choice',
        instructions: 'How urgent is this order? Combine its wording, observable voice cues, profanity, remaining time, and game situation. Profanity can reinforce an explicit urgent order, but swearing alone or casual joking does not make speech an order or prove emotion. Loudness alone is not urgency.',
        criteria: {
          low: 'casual or low priority',
          normal: 'ordinary command without time pressure',
          high: 'needs prompt attention',
          critical: 'immediate action is needed in the current situation',
        },
      };
      questions.commander_certainty = {
        type: 'choice',
        instructions: 'How certain is the commander about the order? Consider direct wording, corrections, hedging, and observed pauses; do not infer an emotion.',
        criteria: {
          uncertain: 'hesitant, self-correcting, or unsure',
          normal: 'clear enough without strong certainty cues',
          confident: 'direct and unambiguous',
        },
      };
    }
    const status = voiceContext ? roundStatus(game, team) : null;
    const state = {
      commander_says: said,
      ...(only && { talking_to: only }),
      ...(source && { command_source: source }),
      ...(gesture && { hand_signal: `${gesture.emoji} ${gesture.label}: ${gesture.meaning}` }),
      pointing_at: pointerZone ?? 'nothing',
      squad: Object.fromEntries(squad.map(u => [u.name, `in ${zoneAt(game.map, u).name}, ${Math.round(u.hp)}/${u.maxHp} HP`])),
      current_orders: Object.fromEntries(aliveTeam(game, team).map(u => [u.name, orderLabel(u)])),
      recent_commands: previousCommands.map(command => command.text),
      ...(voiceContext && {
        voice_context: {
          volume_level: voiceContext.volumeLevel,
          volume_vs_baseline: Math.round(voiceContext.volumeVsBaseline * 100) / 100,
          peak_volume_level: voiceContext.peakVolumeLevel,
          speech_rate: voiceContext.speechRate,
          pause_level: voiceContext.pauseLevel,
          emphasis_level: voiceContext.emphasisLevel,
          intensity_trend: voiceContext.intensityTrend,
          profanity_level: voiceContext.profanityLevel ?? 'none',
          profanity_count: voiceContext.profanityCount ?? 0,
        },
        situation: {
          side: team,
          seconds_remaining: Math.max(0, Math.round(status.clock)),
          status: status.label,
        },
      }),
    };

    // Jev occasionally 500s on a question with no clear winner, so give it one more go.
    const result = await ask(state, questions, 2).catch(() => ask(state, questions, 2));
    const isOrder = result.answers.is_order.probability;
    const ux = voiceContext ? {
      urgency: result.answers.command_urgency?.choice ?? 'normal',
      certainty: result.answers.commander_certainty?.choice ?? 'normal',
    } : null;
    if (isOrder < 0.5) {
      return { ignored: true, isOrder, plan: [], latency: result.latency, tokens: result.usage?.inputTokens, ux };
    }
    // A small speed boost once Jev accepts a shouted order. The next order resets speed from
    // each unit's original value, so cues never stack.
    const pace = source === 'voice' ? voicePaceMultiplier(voiceContext) : 1;
    const plan = squad.map(unit => {
      const key = unit.name.toLowerCase();
      const a = result.answers;
      const addressed = only || wholeSquad ? 1 : a[`${key}_addressed`].probability;
      const order = a[`${key}_order`];
      const target = a[`${key}_target`];
      const skipReason = addressed < 0.5 ? 'not addressed'
        : !unit.alive ? 'agent eliminated'
        : game.result ? 'round ended'
        : commandId < (lastAppliedCommand.get(unit) ?? 0) ? 'newer order already applied'
        : null;
      const applied = skipReason === null;
      if (applied) {
        unit.commandBaseSpeed ??= unit.speed;
        unit.speed = unit.commandBaseSpeed * pace;
        let point;
        let zone = target.choice;
        if (target.choice === 'pointed' && pointer) {
          point = { x: pointer.x, y: pointer.y };
          zone = pointerZone;
        } else if (target.choice === 'enemy') {
          point = { x: contact.x, y: contact.y };
          zone = zoneAt(game.map, contact).name;
        } else if (isDirection(target.choice)) {
          // Per agent: "everyone move right" steps each of them right from their own spot.
          point = direction ? directionPoint(game, unit, direction.yaw, target.choice) : { x: unit.x, y: unit.y };
          zone = zoneAt(game.map, point).name;
        } else if (target.choice === 'current' || target.choice === 'pointed') {
          point = { x: unit.x, y: unit.y };
          zone = zoneAt(game.map, unit).name;
        } else {
          point = zoneByName(game.map, target.choice).center;
        }
        setOrder(game, unit, { type: order.choice, zone, point });
        lastAppliedCommand.set(unit, commandId);
        unit.action = orderAction(game, unit);
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
    if (plan.some(p => p.applied)) {
      // Read the latest history after awaiting Jev: requests may complete out of order.
      // Remember accepted commands in submission order, separately for each side and round.
      const history = commandHistory.get(game) ?? {};
      history[team] = [...(history[team] ?? []).filter(command => command.id !== commandId), { id: commandId, text: said }]
        .sort((a, b) => a.id - b.id).slice(-3);
      commandHistory.set(game, history);
    }
    const stale = plan.some(p => p.skipReason === 'newer order already applied') && !plan.some(p => p.applied);
    return { plan, isOrder, stale, latency: result.latency, tokens: result.usage?.inputTokens, ux, paceMultiplier: pace };
  }

  // ---------- 2. per-agent decision loops ----------

  function update(game, team) {
    const now = performance.now();
    aliveTeam(game, team).forEach((u, i) => {
      if (u.kind !== 'agent') return;
      u.brain ??= { pending: false, nextAt: now + (i * thinkMs) / 4 };
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
        u.action = orderAction(game, u);
        if (!u.decision?.local || u.decision.action !== u.action) {
          u.decision = { action: u.action, probabilities: { [u.action]: 1 }, local: true };
        }
        return;
      }
      if (u.brain.pending) return;
      if (u.decision?.local) {
        u.action = 'fight'; // until Jev's first answer after contact arrives
        u.decision = null;
        u.brain.nextAt = now;
      }
      if (now < u.brain.nextAt) return;
      u.brain.pending = true;
      u.brain.nextAt = now + thinkMs;
      const { state, questions, targets } = tick;
      const order = u.order;
      ask(state, questions)
        .then(({ answers, latency }) => {
          if (!u.alive || game.result || u.order !== order) return;
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
      max_hp: e.maxHp,
      shooting_at_you: e.targetId === u.id && game.time - e.lastShotAt < 1,
    }));
    const mates = aliveTeam(game, u.team).filter(m => m !== u);
    const fightingMate = mates.filter(m => m.visible.length).sort((a, b) => dist(u, a) - dist(u, b))[0];
    const bomb = incomingGrenade(game, u);
    if (!enemies.length && !fightingMate && !bomb) return null;

    const objective = orderDestination(game, u);
    const toObjective = Math.round(dist(u, objective));
    const clump = u.grenades > 0 ? grenadeSpot(game, u) : null;
    const state = {
      you: {
        name: u.name,
        side: u.team === 'attack' ? 'attacker' : 'defender',
        grenades_left: u.grenades,
        hp: Math.round(u.hp),
        max_hp: u.maxHp,
        location: zoneAt(game.map, u).name,
        moving: u.moving,
        ...(u.team === 'attack' && { carrying_spike: game.spike.state === 'carried' && game.spike.carrierId === u.id }),
      },
      commander_order: orderLabel(u),
      meters_to_ordered_position: toObjective,
      enemies_in_sight: enemies,
      teammates: mates.map(m => ({ name: m.name, hp: Math.round(m.hp), max_hp: m.maxHp, distance_m: Math.round(dist(u, m)), in_a_fight: m.visible.length > 0 })),
      spike: spikeBriefing(game, u.team),
      ...(clump && { enemies_bunched_together: `${clump.caught} of them are standing within 5m of each other, in grenade range` }),
      ...(bomb && { grenade_about_to_go_off: `${Math.max(0, bomb.explodeAt - game.time).toFixed(1)}s, ${Math.round(Math.hypot(bomb.x - u.x, bomb.y - u.y))}m away` }),
    };
    // Each option says when it applies: Jev follows these conditions closely (6/6 on labelled
    // situations). The one that carries out the commander's order says so.
    const ordered = orderAction(game, u);
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
