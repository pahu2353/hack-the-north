// How well does Jev read the way people actually give orders? Each case is a phrasing a
// commander might shout and the order + place it should come out as. Run it against the real
// gateway to score a wording change instead of guessing at one:
//
//   node --env-file-if-exists=.env.local scripts/vocab-probe.mjs
//   node --env-file-if-exists=.env.local scripts/vocab-probe.mjs "fight fight fight"   (one case)
import { experimental_evaluate as evaluate } from 'ai';
import { createBrains } from '../public/commander/brain.js';
import { createGame, setOrder, teamUnits } from '../public/commander/sim.js';
import { zoneByName } from '../public/commander/world.js';

const ask = async (state, questions, maxRetries = 0) => {
  const t0 = performance.now();
  const r = await evaluate({
    model: 'typesafe-ai/jev',
    state: typeof state === 'string' ? state : JSON.stringify(state),
    questions,
    maxRetries,
  });
  return { answers: r.answers, usage: r.usage, latency: performance.now() - t0 };
};

// Every case starts from the same position: the squad pushing B Site, nothing in sight, and
// the enemy last seen on A Site. That makes "carry on" and "go at them" different answers.
const CASES = [
  // Saying two places: the one they land on is the order.
  { text: 'everyone go a site or b site', order: 'push', target: 'B Site' },
  { text: 'everyone go to a site, no wait, b site', order: 'push', target: 'B Site' },
  { text: 'a site. actually b site', order: 'push', target: 'B Site' },
  // A bare verb with no place: keep doing what you were told, do not stop.
  { text: 'everyone move', order: 'push', target: 'B Site' },
  { text: 'move', order: 'push', target: 'B Site' },
  { text: 'push', order: 'push', target: 'B Site' },
  { text: 'go go go', order: 'push', target: 'B Site' },
  // A direction instead of a place. "up"/"ahead" are forward, "down"/"behind" are back.
  { text: 'everyone move right', order: 'push', target: 'right' },
  { text: 'shift left', order: 'push', target: 'left' },
  { text: 'move up', order: 'push', target: 'forward' },
  { text: 'everyone forward', order: 'push', target: 'forward' },
  { text: 'back up', order: ['push', 'retreat', 'hold'], target: 'back' },
  { text: 'everyone down', order: ['push', 'retreat', 'hold'], target: 'back' },
  // At the enemy, wherever that is.
  { text: 'go towards the enemy', order: 'push', target: 'enemy' },
  { text: 'move towards the enemy', order: 'push', target: 'enemy' },
  { text: 'fight fight fight', order: 'push', target: 'enemy' },
  { text: 'everyone attack them', order: 'push', target: 'enemy' },
  { text: 'kill them', order: 'push', target: 'enemy' },
  { text: 'push them', order: 'push', target: 'enemy' },
  // Ordinary phrasings that should not have needed a manual.
  { text: 'get to mid', order: 'push', target: 'Mid' },
  { text: 'head to b main', order: 'push', target: 'B Main' },
  { text: 'take a site', order: 'push', target: 'A Site' },
  { text: 'rush b', order: 'push', target: 'B Site' },
  { text: 'everyone hold', order: 'hold', target: 'current' },
  { text: 'stay where you are', order: 'hold', target: 'current' },
  { text: 'stop', order: 'hold', target: 'current' },
  { text: 'fall back', order: 'retreat', target: 'Attacker Spawn' },
  { text: 'swing around through a link', order: 'flank', target: ['A Link', 'A Site'] },
  { text: 'nade mid', order: 'grenade', target: 'Mid' },
  { text: 'group up', order: 'regroup', target: ['current', 'Mid', 'B Site'] },
  // Game words that were misread before: a rotate is not a flank, camping is not a push.
  { text: 'rotate to a', order: 'push', target: 'A Site' },
  { text: 'camp b site', order: 'hold', target: 'B Site' },
  { text: 'hold b', order: 'hold', target: 'B Site' },
  { text: 'lock down mid', order: 'hold', target: 'Mid' },
  { text: 'watch b main', order: 'hold', target: 'B Main' },
  { text: 'wait', order: 'hold', target: 'current' },
  { text: 'peek a main', order: 'push', target: 'A Main' },
  { text: 'everyone lurk b', order: 'flank', target: 'B Site' },
  { text: 'run it down mid', order: 'push', target: 'Mid' },
  { text: 'back to spawn', order: 'retreat', target: 'Attacker Spawn' },
  { text: 'get out of there', order: 'retreat', target: ['Attacker Spawn', 'current'] },
  { text: 'on me', order: 'regroup', target: null },
  { text: 'charge them', order: 'push', target: 'enemy' },
  { text: 'frag them out', order: 'grenade', target: 'enemy' },
  { text: 'throw a nade at a site', order: 'grenade', target: 'A Site' },
  { text: 'plant it on b', order: 'plant', target: 'B Site' },
];

// Follow-ups lean on what was said a moment ago, and chatter must still be ignored: the
// wording that makes an order out of "you too" must not make one out of a callout.
const MEMORY = [
  { text: 'Bravo, do the same as Alpha', who: 'Bravo', want: 'hold A Site' },
  { text: 'keep going', who: 'Bravo', want: 'push Mid' },
  { text: 'Charlie you too', who: 'Charlie', want: 'hold A Site', after: ['Alpha hold A site'] },
  { text: 'nice shot', who: 'Bravo', want: 'ignored' },
  { text: 'oh my god they are everywhere', who: 'Bravo', want: 'ignored' },
  { text: 'what do you think we should do', who: 'Bravo', want: 'ignored' },
  { text: 'two on b', who: 'Bravo', want: 'ignored' },
  { text: 'they are pushing mid', who: 'Bravo', want: 'ignored' },
  { text: 'i think they went a', who: 'Bravo', want: 'ignored' },
];

function scenario() {
  const game = createGame({ defenders: 'bots', playerTeam: 'attack' });
  const site = zoneByName(game.map, 'B Site');
  for (const u of teamUnits(game, 'attack')) {
    Object.assign(u, { x: 40, y: 34 }); // mid, on the way to B
    setOrder(game, u, { type: 'push', zone: 'B Site', point: site.center });
  }
  // The enemy was seen on A Site a moment ago, so "at the enemy" has an answer.
  for (const e of teamUnits(game, 'defend')) game.intel.attack.set(e.id, { x: 12, y: 14, t: game.time });
  return game;
}

// Commanding from the top-down map as the attackers: forward is up the screen, which is -y.
const MAP_VIEW = { yaw: -Math.PI / 2 };

// null means the place does not matter for that order (regroup goes to the squad, wherever it is).
const wanted = (value, expected) =>
  expected === null || (Array.isArray(expected) ? expected.includes(value) : value === expected);
const brains = createBrains({ evaluate: ask });
const only = process.argv.slice(2);
const cases = only.length ? CASES.filter(c => only.some(a => c.text.includes(a))) : CASES;
let orderHits = 0;
let bothHits = 0;

for (const c of cases) {
  const game = scenario();
  const result = await brains.interpretCommand(game, 'attack', { source: 'voice', text: c.text, direction: MAP_VIEW });
  const alpha = result.plan?.find(p => p.name === 'Alpha');
  if (result.ignored || !alpha) {
    console.log(`${'MISS'.padEnd(5)} "${c.text}" → not an order (gate ${Math.round(result.isOrder * 100)}%)`);
    continue;
  }
  const orderOk = wanted(alpha.order, c.order);
  const targetOk = wanted(alpha.target, c.target);
  orderHits += orderOk;
  bothHits += orderOk && targetOk;
  const mark = orderOk && targetOk ? 'ok' : orderOk ? 'half' : 'MISS';
  console.log(`${mark.padEnd(5)} "${c.text}" → ${alpha.order} ${alpha.target} `
    + `(${Math.round(alpha.orderP * 100)}%/${Math.round(alpha.targetP * 100)}%)`
    + (orderOk && targetOk ? '' : `   want ${c.order} ${JSON.stringify(c.target)}`));
}
console.log(`\norder right: ${orderHits}/${cases.length}   order and place right: ${bothHits}/${cases.length}`);

if (!only.length) {
  // Alpha holds A Site, the rest push Mid, so "do the same" has something to copy.
  const scene = () => {
    const game = createGame({ defenders: 'bots', playerTeam: 'attack' });
    teamUnits(game, 'attack').forEach((u, i) => {
      Object.assign(u, { x: 40, y: 34 });
      const [type, zone] = i === 0 ? ['hold', 'A Site'] : ['push', 'Mid'];
      setOrder(game, u, { type, zone, point: zoneByName(game.map, zone).center });
    });
    return game;
  };
  let memoryHits = 0;
  console.log('');
  for (const c of MEMORY) {
    const game = scene();
    for (const earlier of c.after ?? []) await brains.interpretCommand(game, 'attack', { source: 'voice', text: earlier, direction: MAP_VIEW });
    const result = await brains.interpretCommand(game, 'attack', { source: 'voice', text: c.text, direction: MAP_VIEW });
    const row = result.plan?.find(p => p.name === c.who);
    const got = result.ignored ? 'ignored' : row?.applied ? `${row.order} ${row.target}` : `${row?.order} ${row?.target} (not addressed)`;
    memoryHits += got === c.want;
    console.log(`${(got === c.want ? 'ok' : 'MISS').padEnd(5)} "${c.text}" \u2192 ${c.who}: ${got}`
      + `   gate ${Math.round(result.isOrder * 100)}%${got === c.want ? '' : `   want ${c.want}`}`);
  }
  console.log(`\nfollow-ups and chatter right: ${memoryHits}/${MEMORY.length}`);
}
