// Jev brains. Two layers, both plain typed questions against a text/JSON state:
//   1. interpretCommand: one call turns a commander's order (voice, text, or hand signal)
//      into an order + target location for each of their agents.
//   2. update: every agent in contact runs its own decision loop (like Jev playing Doom):
//      its local situation in, a choice of action (and who to shoot) out, about twice a second.
// Works for either team, in the browser (bot games) or on the server (multiplayer).
import {
  UTILITY, UTILITY_LABEL, aliveTeam, blinded, directionPoint, enemyContact, grenadeSpot,
  heldCount, incomingGrenade, isDirection, noteCallout, obeying, orderAction, orderDestination,
  orderLabel, orderUtility, pushFeed, relativePoint, roundStatus, setOrder, setWeapon,
  throwLanding, unitById, utilitySpot,
} from './sim.js';
import { CALLOUTS, dist, zoneAt, zoneByName } from './world.js';

const THINK_MS = 450;
const VOICE_PACE = { mild: 1.08, strong: 1.18 };
// Nobody says "walk there spread out". They say it by how they say it. Urgency already comes
// back from Jev on every spoken order and until now only printed two words in the log, so the
// unspoken half of an order — how fast, how close together — is read from it here.
const TEMPO = {
  critical: { pace: 'run', spread: 'stacked' },
  high: { pace: 'run', spread: 'stacked' },
  normal: { pace: 'run', spread: 'normal' },
  low: { pace: 'walk', spread: 'spread' },
};
// How long the agent carries out an order before Jev is allowed to argue with it. A commander
// who corrected themselves mid-sentence should be re-checked sooner than one who did not.
const COMMITMENT = { uncertain: 1.5, normal: 3, confident: 4.5 };

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
// The words people actually shout. Every one of these maps onto a move the game already
// has: the vocabulary is wide so that a commander never has to think about which word the
// system knows, but the set of things that can happen stays small and composable.
const MOVE = 'go / move / push / rush / run it down / head to / get to / take / hit / rotate to / '
  + 'move up / push up / creep up / advance / get up there / work your way up / get going / '
  + 'get off your ass / go go go / shift / collapse on / take the fight to them';
const STAY = 'stay put where told: hold / hold position / hold your position / hold that angle / '
  + 'watch that angle / stop / wait / don\'t move / sit tight / freeze / defend / watch / camp / '
  + 'anchor / sit on / post up / lock down / play ("play b site" is holding it), without advancing';
const AROUND = 'flank: swing around / go around / wrap around / come from the side / take the long way / '
  + 'lurk / go the back way / hit them from behind / get behind them';
const BACK = 'fall back / retreat / pull out / pull back / get out / get out of there / back off / '
  + 'disengage / reset / bail';
const TOGETHER = 'group up / regroup / stack up / stack / on me / rally / come together with the squad';
// All three can be aimed at a place, at what the commander is pointing at ("nade here",
// "flash there"), or at a job ("help smoke for A", "smoke the way in from their spawn").
const NADE_BASE = 'throw a grenade / nade / frag / util / molly / incendiary at the location, '
  + 'or "nade here" / "frag there" at the spot being pointed at';
// A match without the kit has no flash to throw, so asking for one is asking for the closest
// thing that exists. With the kit on there is a real flash order and the word belongs to it,
// or "flash B" comes back as a grenade on B.
const NADE = NADE_BASE.replace('nade / frag', 'nade / frag / flash');
const FLASH_ORDER = 'flash / pop a flash / flash them / flash for us / blind them at the location, '
  + 'or "flash here" / "flash there" at the spot being pointed at';
const SMOKE_ORDER = 'smoke / smoke off / smoke it / smoke the way in / help smoke for a site / '
  + 'block the sightline at the location, or "smoke here" / "smoke there" at the spot being pointed at';
const PEEK_ORDER = 'peek: take a quick look and come straight back / jiggle peek / shoulder peek / '
  + 'bait a shot / check that angle without committing to it';
const KNIFE_ORDER = 'knife: take the knife out. Any mention of the knife at all means this — '
  + '"knife", "knife out", "get your knife out", "switch to knife", "melee", as well as '
  + '"go knife them", "knife that guy", "shank him", "run them down with the knife". '
  + 'The knife stays out until told otherwise. If they also said where or who, they go there too.';
// The way back. A knife stays drawn until the commander takes it back, so there has to be
// something for them to say.
const RIFLE_ORDER = 'put the knife away and get the rifle back out / guns out / gun up / '
  + 'switch back / stop knifing. Changes nothing about where they are going.';
// Peek and knife are always available — they need no equipment. The two throwables only
// exist when the match has them, so an ordinary match offers exactly what it always did
// plus the two moves the squad could always physically make and had no word for.
const ordersFor = (team, utility) => ({
  ...ORDERS[team],
  peek: PEEK_ORDER,
  knife: KNIFE_ORDER,
  rifle: RIFLE_ORDER,
  ...(utility && { grenade: NADE_BASE, flash: FLASH_ORDER, smoke: SMOKE_ORDER }),
});

const ORDERS = {
  attack: {
    push: `${MOVE} to the location, and going at the enemy to fight them`,
    hold: `${STAY} at the location`,
    flank: AROUND,
    retreat: BACK,
    regroup: TOGETHER,
    grenade: NADE,
    plant: 'plant the spike, and only when told to: plant it / get the spike down / put it down / stick it',
  },
  defend: {
    push: `${MOVE} to the location, retake it, or go at the enemy to fight them`,
    hold: `${STAY} at the location`,
    flank: AROUND,
    retreat: BACK,
    regroup: TOGETHER,
    grenade: NADE,
    defuse: 'go defuse the planted spike, and only when told to: defuse it / get it off / stop the timer',
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
    // In first person you are looking through one agent's eyes, so an order with no name on
    // it is for them. It is a default, not a lock: "everyone knife out" and "two of you go
    // A" are plainly about the squad, and hard-filtering to the watched agent threw the
    // rest of the sentence away. Everyone is asked; the watched one is who it falls to.
    const squad = aliveTeam(game, team);
    const watching = only && squad.some(u => u.name === only) ? only : null;
    if (!squad.length) return { plan: [], latency: 0, tokens: 0 };
    const roster = game.units.filter(u => u.team === team).map(u => u.name);
    // From here on the order says "Charlie", never "c": one spelling for the state Jev reads,
    // the addressing questions below, and the history a later "do the same" is resolved
    // against. This is spelling, not judgement — who the order is for is Jev's to decide.
    const said = expandAgentInitials(text ?? '', roster);
    const commandId = Number.isSafeInteger(seq) && seq > 0 ? seq : commandSequence + 1;
    commandSequence = Math.max(commandSequence, commandId);
    const previousCommands = commandHistory.get(game)?.[team] ?? [];
    const pointerZone = pointer ? zoneAt(game.map, pointer).name : null;
    // "Fall back to spawn" means your own spawn, so describe the two relative to this team.
    const ownSpawn = game.map.home[team];
    // Each place is described twice over: what it is, for an order that reasons about the
    // map, and what people call it, for one that just says "cat" or "tunnels" or "long".
    const locations = Object.fromEntries(game.map.zones.map(z => {
      const what = z.name.endsWith('Spawn')
        ? (z.name === ownSpawn ? 'your own spawn, where your squad started' : "the enemy's spawn, on their side of the map")
        : z.description;
      return [z.name, CALLOUTS[z.name] ? `${what}; called: ${CALLOUTS[z.name]}` : what];
    }));
    // Only when they actually referred to it. A marker left on the map from a minute ago
    // must not turn "pull your knife out" into an order to walk to wherever it is.
    if (pointer) locations.pointed = `exactly where the commander is pointing (in ${pointerZone}) — only when they actually refer to it, with "there", "here", "this spot", "that corner". Never pick this just because a marker exists.`;
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
    // The spike is a place too, and the only one whose position depends on who is asking.
    // Defenders can only be sent to a spike they can see, which means a planted one:
    // offering it earlier would be offering them the carrier's position.
    if (team === 'attack') {
      locations.spike = 'wherever the spike is right now: "on the bomb", "to the spike", "get the bomb"';
    } else if (game.spike.state === 'planted') {
      locations.spike = 'where the spike is planted: "on the bomb", "to the spike", "get to the bomb"';
    }

    // Every place on the map is a possible node to route through, described by what people
    // call it, so "through cat" and "via doors" resolve the same way a destination does.
    const routeNodes = Object.fromEntries(game.map.zones.map(z => [
      z.name, CALLOUTS[z.name] ? `through ${z.name} — called: ${CALLOUTS[z.name]}` : `through ${z.name}`,
    ]));

    const questions = {};
    for (const { name } of squad) {
      const key = name.toLowerCase();
      questions[`${key}_addressed`] = {
        type: 'boolean',
        // Wording picked by measurement: it handles orders that give different jobs to
        // different agents in one breath ("Charlie rush A, Alpha plant", "everyone else hold").
        instructions: `${watching ? `The commander is watching through ${watching}'s eyes, so an order that names nobody at all is for ${watching} alone — but one that speaks to the squad ("everyone", "all of you") or asks for a number of them ("two of you") still reaches the others. ` : ''}The commander may give different jobs to different agents in one breath. Does any part of this order apply to ${name}? Yes if ${name} is named in any clause, if ${name} is called by their first letter "${name[0]}" as the one being told to do something, if no names appear at all, if it addresses the whole squad ("everyone", "guys", "all of you"), or if it says "everyone else" / "the rest". A lone "A" or "B" that says where to go is the bomb site, not an agent.`,
      };
      // Both questions are about what the commander JUST said. current_orders is in the state
      // so a follow-up can be resolved, but pointing the questions at it made Jev answer with
      // the order the squad already had, whatever was said: while pushing B Site, "nade mid"
      // came back as a grenade on B Site, and "take A site" as a push to B Site.
      questions[`${key}_order`] = {
        type: 'choice',
        instructions: `What has the commander just told ${name} to do? Answer from what they said, not from the order ${name} already has. Telling them to stay somewhere once they get there ("camp b", "hold b", "watch b main", "lock down mid") is holding, not pushing, even though they have to walk there first. Only when the new words carry no instruction of their own: "keep going" / "same again" means carry on with ${name}'s own order in current_orders, and "you too" / "as well" / "same" means the order in the last of recent_commands, the one just given to someone else.`,
        criteria: ordersFor(team, game.utility),
      };
      // Which way, as opposed to where. "Mid to B through doors" and "take catwalk" name a
      // node on the way, and until now there was nothing for that half of the sentence to
      // land on — the agent pathfound straight there and the route was ignored. The options
      // are the map's own places, so the squad knows the nodes without being taught them.
      questions[`${key}_through`] = {
        type: 'choice',
        instructions: `Did the commander say which way ${name} should go — a place to go through on the way, rather than the place they are going to? "through doors", "via catwalk", "take long", "the back way past window". Answer direct unless they actually named a way through.`,
        criteria: { direct: 'no way named: go the quickest way there', ...routeNodes },
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
    // "Everyone push B" has one meaning, and asking five agents separately whether it is for
    // them is five chances to disagree and mobilise three of five. So it is asked once, as
    // its own question, and its answer overrides the individual ones. This used to be a list
    // of words matched against the text; a list of words can only ever contain the phrasings
    // somebody thought of in advance, and deciding what a sentence means is Jev's job.
    questions.addresses_everyone = {
      type: 'boolean',
      instructions: `Is this order given to the whole squad at once rather than to particular agents? Yes when it speaks to all of them — "everyone push B", "guys hold mid", "all of you", "y'all", "the team", "squad on me" — and yes when it names nobody at all. No when it names or initials any agent, and no for "everyone else" or "the rest", which mean everyone except whoever was just named.`,
    };
    // One smoke is a smoke; five smokes on one doorway is the squad's whole round spent at
    // once. A bare "smoke main" is one agent doing it, and only a command that actually
    // asks for more gets more. Score rather than a yes/no, because "three people" is a
    // number the commander said out loud and should be obeyed as one.
    questions.throw_headcount = {
      type: 'score',
      instructions: 'If this order is to throw something — a grenade, a flash or a smoke — how many of the squad should each throw one? Judge only from what the commander actually asked for.',
      criteria: [
        'one of them: the default, and what a plain "smoke main", "flash B" or "nade here" means',
        'two of them, because the commander asked for two',
        'three of them, because the commander asked for three',
        'four of them, because the commander asked for four',
        'all five of them, because the commander explicitly said everyone / all of you / all five should throw',
      ],
    };
    // Most of what a hands-free mic hears is not an order, and until now all of it was
    // thrown away. Plenty of it is information: "two on B", "they're pushing mid", "one
    // down long". That moves nobody, but it is what the squad should be watching.
    questions.is_callout = {
      type: 'boolean',
      instructions: 'Is the commander saying where the enemy is or what the enemy is doing — a sighting, a count, a direction they are coming from? Yes for "two on B", "they\'re pushing mid", "one long". No for an order, a reaction, or a question.',
    };
    questions.callout_place = {
      type: 'choice',
      instructions: 'If the commander just said where the enemy is, which place did they mean? Pick the place the enemy is being reported at, not where the squad is.',
      criteria: locations,
    };
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
      ...(watching && { watching_through: watching }),
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
    // One squad-level answer, and it wins: if the order was for all of them it was for this
    // one, whatever its own question happened to say.
    const wholeSquad = (result.answers.addresses_everyone?.probability ?? 0) > 0.5;
    const ux = voiceContext ? {
      urgency: result.answers.command_urgency?.choice ?? 'normal',
      certainty: result.answers.commander_certainty?.choice ?? 'normal',
    } : null;
    // A callout is applied even when the utterance is also an order ("they're on B, everyone
    // rotate"), because both halves are true.
    const callout = applyCallout(game, team, result.answers, { pointer, pointerZone, contact });
    if (isOrder < 0.5) {
      return { ignored: true, isOrder, plan: [], callout, latency: result.latency, tokens: result.usage?.inputTokens, ux };
    }
    // A small speed boost once Jev accepts a shouted order. The next order resets speed from
    // each unit's original value, so cues never stack.
    const pace = source === 'voice' ? voicePaceMultiplier(voiceContext) : 1;
    const tempo = TEMPO[ux?.urgency ?? 'normal'] ?? TEMPO.normal;
    // Captured before anything is overwritten: a thrower who is stood down goes back to
    // the job it had rather than to nothing.
    const wasDoing = new Map(squad.map(unit => [unit, unit.order && { ...unit.order }]));
    // Did the order pick anybody out at all? If not, and we are watching one agent, it is
    // theirs; if so, first person does not stop it reaching whoever it named.
    const addressesAnyone = wholeSquad
      || squad.some(u => (result.answers[`${u.name.toLowerCase()}_addressed`]?.probability ?? 0) > 0.5);
    const plan = squad.map(unit => {
      const key = unit.name.toLowerCase();
      const a = result.answers;
      const own = a[`${key}_addressed`]?.probability ?? 0;
      // Watching someone makes them the fallback: if the order named nobody and does not
      // speak to the squad, it is for the agent whose eyes you are using.
      const addressed = wholeSquad || (watching === unit.name && !addressesAnyone) ? 1 : own;
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
        } else if (['forward', 'back', 'spike'].includes(target.choice)) {
          // A relation, not a coordinate: the simulation works out where that actually is,
          // and falls back to standing still if there is nowhere to go.
          point = relativePoint(game, unit, target.choice) ?? { x: unit.x, y: unit.y };
          zone = zoneAt(game.map, point).name;
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
        // "Knife out" with nowhere named is a weapon switch and nothing else: it must not
        // silently send them somewhere. With a place or a target named it is both.
        if (order.choice === 'knife' && target.choice === 'current') {
          unit.knifeOrdered = true;
          setWeapon(unit, 'knife');
          lastAppliedCommand.set(unit, commandId);
          return {
            name: unit.name, addressed, applied: true, order: order.choice,
            orderP: order.probabilities?.[order.choice] ?? 1,
            target: 'knife out', targetP: 1,
          };
        }
        // "Guns out" is not somewhere to be either: it changes what is in their hands and
        // leaves the job they are already doing exactly as it was.
        if (order.choice === 'rifle') {
          unit.knifeOrdered = false;
          // Putting the knife away is not enough on its own: a standing knife order derives
          // the knife action again on the very next frame and the blade is straight back in
          // their hand. The order has to stop being a knife order too. They were sent at
          // somebody and they still go — with the rifle.
          if (unit.order.type === 'knife') {
            setOrder(game, unit, { ...unit.order, type: 'push', pace: tempo.pace, spread: tempo.spread });
          }
          setWeapon(unit, 'rifle');
          unit.action = orderAction(game, unit);
          lastAppliedCommand.set(unit, commandId);
          return {
            name: unit.name, addressed, applied: true, order: order.choice,
            orderP: order.probabilities?.[order.choice] ?? 1,
            target: 'rifle out', targetP: 1,
          };
        }
        setOrder(game, unit, {
          type: order.choice, zone, point, pace: tempo.pace, spread: tempo.spread,
          // Named nodes the commander asked them to go through, if any.
          through: a[`${key}_through`]?.choice && a[`${key}_through`].choice !== 'direct'
            ? [a[`${key}_through`].choice] : [],
        });
        unit.obeyUntil = game.time + (COMMITMENT[ux?.certainty ?? 'normal'] ?? COMMITMENT.normal);
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
    // Levels are scored from zero, so the first one is a headcount of one.
    const headcount = clampCount(Math.round(result.answers.throw_headcount?.score ?? 0) + 1);
    const stoodDown = limitThrowers(game, squad.filter((unit, i) => plan[i].applied), wasDoing, headcount);
    for (const entry of stoodDown) {
      const row = plan.find(p => p.name === entry.name);
      if (row) row.standDown = entry.reason;
    }
    assignRoles(game, squad.filter((unit, i) => plan[i].applied));
    // Roles are settled after the whole plan is known, so the log reports what was actually
    // decided rather than what each agent looked like on its own.
    plan.forEach((p, i) => {
      if (!p.applied) return;
      Object.assign(p, { role: squad[i].role, pace: squad[i].pace, spread: squad[i].order.spread });
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
    return { plan, isOrder, stale, callout, latency: result.latency, tokens: result.usage?.inputTokens, ux, paceMultiplier: pace };
  }

  const clampCount = n => Math.max(1, Math.min(5, Number.isFinite(n) ? n : 1));

  // "Smoke A" is one smoke, not five. A throw order addressed to a group is carried out by
  // however many the commander actually asked for — one unless they said otherwise — and
  // by whichever of them are in a position to make the throw: still holding one, in range,
  // with an arc that gets there. Everyone else goes back to what they were doing. Five
  // agents each spending their only smoke on one doorway is the worst thing the squad could
  // do with an order, and it is not a judgement five separate agents can make, because none
  // of them can see the other four.
  function limitThrowers(game, units, previous, headcount) {
    const throwers = units.filter(u => orderUtility(u.order.type));
    if (!throwers.length) return [];
    const groups = new Map();
    for (const u of throwers) {
      const key = `${u.order.type}:${u.order.zone}`;
      groups.set(key, [...(groups.get(key) ?? []), u]);
    }
    const standDown = (u, reason) => {
      const was = previous.get(u);
      if (was) setOrder(game, u, { ...was, pace: u.pace, spread: u.order.spread });
      else setOrder(game, u, { type: 'hold', zone: zoneAt(game.map, u).name, point: { x: u.x, y: u.y } });
      return { name: u.name, reason };
    };

    const stood = [];
    for (const group of groups.values()) {
      const kind = orderUtility(group[0].order.type);
      const label = UTILITY_LABEL[kind];
      const armed = group.filter(u => heldCount(u, kind) > 0);
      // Nobody has one left. The order cannot be carried out by anyone, and saying so is
      // far better than four agents standing in the open waiting to throw nothing.
      if (!armed.length) {
        for (const u of group) stood.push(standDown(u, `no ${label} left`));
        pushFeed(game, `No ${label}s left`, group[0].team, group[0].team);
        continue;
      }
      const scored = armed.map(u => {
        const reach = dist(u, u.order.point);
        const landing = throwLanding(game.map, u, u.order.point);
        return { u, inRange: reach <= UTILITY[kind].range, short: dist(landing, u.order.point), reach };
      // In range at all first, then whose throw actually lands closest to the spot, then
      // whoever is nearest to it.
      }).sort((a, b) => Number(b.inRange) - Number(a.inRange) || a.short - b.short || a.reach - b.reach);

      const able = scored.filter(t => t.inRange);
      if (!able.length) {
        for (const u of group) stood.push(standDown(u, 'too far to throw it'));
        continue;
      }
      const taking = able.slice(0, headcount);
      const keep = new Set(taking.map(t => t.u));
      for (const u of group) if (!keep.has(u)) stood.push(standDown(u, keep.size >= headcount ? 'someone else has it' : 'too far to throw it'));
    }
    return stood;
  }

  // Two agents sent to the same place should not be two copies of one agent. Whoever is
  // closest goes in; the next one covers them going in and arrives a beat later, watching the
  // angle rather than the floor; anyone told to hold anchors. A flank is a lurk by definition,
  // and a lurker holds fire, because a lurk that shoots the first thing it sees is just a
  // second entry. Positions decide this, not Jev: it is arithmetic, and it has to be stable.
  function assignRoles(game, units) {
    if (!units.length) return;
    const groups = new Map();
    for (const u of units) {
      if (u.order.type === 'flank') { u.role = 'lurk'; u.holdFire = true; continue; }
      const key = `${u.order.type}:${u.order.zone}`;
      groups.set(key, [...(groups.get(key) ?? []), u]);
    }
    for (const group of groups.values()) {
      if (group.length === 1) {
        group[0].role = group[0].order.type === 'hold' ? 'anchor' : 'entry';
        group[0].holdFire = false;
        continue;
      }
      const ordered = [...group].sort((a, b) => dist(a, orderDestination(game, a)) - dist(b, orderDestination(game, b)));
      ordered.forEach((u, i) => {
        u.role = u.order.type === 'hold' ? 'anchor' : i === 0 ? 'entry' : i === 1 ? 'trade' : 'anchor';
        u.holdFire = false;
        // The trade walks in behind the entry, watching, rather than racing them through
        // the door. Two bodies arriving at a corner at once is how squads lose both.
        if (u.role === 'trade') { u.pace = 'walk'; u.gaze = 'on_threat'; }
      });
    }
  }

  // Turn a sighting into something the squad acts on. Nobody is given an order and nobody
  // moves: what changes is the angle an agent holds when it has arrived somewhere and has
  // nothing else to do, which is most of a round. Saying "they're on B" and watching the
  // squad's heads turn is the whole point.
  function applyCallout(game, team, answers, { pointer, pointerZone, contact }) {
    if ((answers.is_callout?.probability ?? 0) < 0.6) return null;
    const place = answers.callout_place?.choice;
    if (!place || place === 'current') return null;
    let point;
    let zone = place;
    if (place === 'pointed' && pointer) { point = { x: pointer.x, y: pointer.y }; zone = pointerZone; }
    else if (place === 'enemy') { point = { x: contact.x, y: contact.y }; zone = zoneAt(game.map, contact).name; }
    else point = zoneByName(game.map, place)?.center;
    if (!point) return null;
    noteCallout(game, team, point);
    return { zone, confidence: answers.is_callout.probability };
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
      // This is where a squad spends most of a round, so it is also where standing frozen
      // used to come from. The order still runs; the simulation gives an agent that has
      // arrived an angle to hold, and a fresh order takes the eyes off it again.
      if (!tick) {
        u.action = orderAction(game, u);
        if (u.action !== 'hold') u.holdFire = u.role === 'lurk';
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
          const { action, target, gaze, hold_fire: holdFire, order_complete: done } = answers;
          if (action.choice !== u.action) u.coverPoint = null;
          u.action = action.choice;
          if (action.choice !== 'reposition') u.repositionPoint = null;
          if (target) u.focusId = targets[target.choice] ?? null;
          else if (Object.keys(targets).length === 1) u.focusId = Object.values(targets)[0];
          // The channels are proposals, not commands: the simulation vetoes a frame that
          // contradicts itself, the same way a reflex outranks a judgement.
          if (gaze) u.gaze = gaze.choice;
          u.holdFire = (holdFire?.probability ?? 0) > 0.6;
          // Finished means the job changes from taking ground to holding it. The order is
          // not cleared — the agent stays where it was sent — but it stops walking at it.
          if ((done?.probability ?? 0) > 0.6 && u.action === 'advance') u.action = 'hold';
          u.decision = {
            action: u.action,
            probabilities: action.probabilities ?? { [action.choice]: 1 },
            target: target?.choice ?? null,
            gaze: gaze?.choice ?? null,
            holdFire: u.holdFire,
            complete: (done?.probability ?? 0) > 0.6,
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
    const blindEnemies = u.visible.filter(e => blinded(game, e));

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
      ...(game.utility && {
        utility_left: { grenade: u.grenades, flash: u.flashes, smoke: u.smokes },
      }),
      ...(game.utility && blindEnemies.length && {
        enemies_currently_blinded: `${blindEnemies.length} of them cannot see anything right now`,
      }),
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
    const nearest = enemies[0]?.distance_m ?? Infinity;
    if (clump?.caught >= 2 && !bomb) actions.nade = `${carriesOut('nade')}throw your one grenade at the ${clump.caught} enemies bunched together: it hurts all of them at once, so it beats shooting at one`;
    // A flash and a smoke do no damage. They are the answer to an angle you cannot cross,
    // which is a different problem from an enemy you cannot kill — so they are offered when
    // there is someone holding a line on you, not when you are simply winning a fight.
    // A flash pops just past whoever you are throwing it at, and its reach is far wider than
    // that, so throwing one at someone in your face blinds you and not them. It is only a
    // choice when there is room for it to be one.
    if (game.utility && heldCount(u, 'flash') > 0 && nearest >= 10 && !bomb && !blindEnemies.length) {
      actions.flash = `${carriesOut('flash')}pop your one flash at them: it does no damage, but for a few seconds they cannot see at all, which is how you take an angle someone is holding`;
    }
    if (game.utility && heldCount(u, 'smoke') > 0 && enemies.length && !bomb && utilitySpot(game, u, 'smoke')) {
      actions.smoke = `${carriesOut('smoke')}throw your one smoke between you and them: it does no damage and blocks the sightline both ways, which is how you cross open ground or break a fight you are losing`;
    }
    if (bomb) actions.scatter = 'run clear of the grenade about to go off beside you: staying there costs most of your health';
    if (fightingMate && !enemies.length) actions.support = `go help ${fightingMate.name}, who is in a fight: when no enemy is in sight`;
    if (toObjective <= 3) actions.reposition = 'you are already where you were sent: move to a better spot on this same ground, off the angle you are being watched from and away from your teammates, without leaving';
    // Peek is for an angle you cannot see down, or one you can see down from far enough
    // away to step back out of. In a close fight it is not a choice, it is a way to die,
    // so it is not offered as one.
    if (!bomb && nearest > 12) {
      actions.peek = enemies.length
        ? `lean out across the angle for a moment and step straight back: you make ${enemies[0].id} show you where they are without standing there while they shoot`
        : 'lean out across the angle you are holding for a moment and step straight back: you find out whether anyone is watching it, and you are not there if they are';
    }
    // The knife is faster than the rifle and lethal from behind, and suicide in front of
    // anyone who can see you coming. Only worth putting to a decision when they are already
    // close enough to reach in about a second.
    if (nearest <= 6 && !bomb) {
      actions.knife = `put the rifle away and rush ${enemies[0].id} with the knife: you move faster with it out and it kills outright from behind, but you cannot shoot while you are holding it`;
    }
    const questions = {
      action: {
        type: 'choice',
        instructions: `You are ${u.name}. Your commander ordered you to ${orderLabel(u)}, and that order outranks your own judgement: carry it out unless doing so right now would get you killed or you cannot carry it out from here. What should you do?`,
        criteria: actions,
      },
      // Where the weapon points, which used to be wherever the feet last went. It is a
      // separate question because it is a separate decision: you can fall back while still
      // watching the doorway you are falling back from, and a squad that cannot do that
      // reads as a line of people staring at walls.
      gaze: {
        type: 'choice',
        instructions: `Where should ${u.name} be looking right now? This is only about where the weapon points; the feet are already doing what the action says.`,
        criteria: {
          travel: 'straight ahead, the way you are moving: when nothing in particular is worth watching',
          on_threat: 'at the enemy you can see, or where one was last seen',
          hold_angle: 'locked on the one angle an enemy would come from: when you are holding ground',
          scan: 'sweeping slowly across the angles around you: when you are holding and nothing has happened yet',
          watch_back: 'behind you, the way your squad came in: when the danger is being flanked',
        },
      },
      // Whether to give your position away. Automatic fire is the rule; choosing not to fire
      // is what makes an ambush, a lurk, and letting someone walk past possible at all.
      hold_fire: {
        type: 'boolean',
        instructions: `Should ${u.name} hold fire and stay hidden rather than shoot? Yes only when staying unseen is worth more than the damage: lurking behind them, waiting for a better moment, or letting one walk past to catch the group. No in any straight fight, and no if they have already seen you.`,
      },
      // The terminator. Nothing used to ask this, so an agent that arrived somewhere simply
      // stopped existing until an enemy appeared or a new order came.
      order_complete: {
        type: 'boolean',
        instructions: `Has ${u.name} finished what the commander asked (${orderLabel(u)})? Yes if they are where they were sent and the job is done, so the next thing to do is hold and watch the ground they took. No if they are still on their way or still doing it.`,
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
