import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrains, expandAgentInitials } from '../public/commander/brain.js';
import { createGame } from '../public/commander/sim.js';

const ATTACK = ['Alpha', 'Bravo', 'Charlie', 'Delta', 'Echo'];
const DEFEND = ['Foxtrot', 'Golf', 'Hotel', 'India', 'Juliett'];

test('an agent can be called by its initial when it is the one being told to act', () => {
  const same = (input, expected, roster = ATTACK) =>
    assert.equal(expandAgentInitials(input, roster), expected, input);

  same('a push b', 'Alpha push b');
  same('c hold mid', 'Charlie hold mid');
  same('a and b push B site', 'Alpha and Bravo push B site');
  same('c, d flank A', 'Charlie, Delta flank A');
  same('d go b main', 'Delta go b main');
  same('a b push mid', 'Alpha Bravo push mid');
  // A second clause is addressed the same way as the first.
  same('alpha push A, b hold mid', 'alpha push A, Bravo hold mid');
  same('bravo plant then e cover', 'bravo plant then Echo cover');
  // Defenders have their own five letters, and no clash with the site names.
  same('f hold b, g rotate', 'Foxtrot hold b, Golf rotate', DEFEND);
  same('g and h retake a', 'Golf and Hotel retake a', DEFEND);
  same('j defuse', 'Juliett defuse', DEFEND);
});

test('a letter that is not naming an agent is left alone', () => {
  const same = (input, roster = ATTACK) =>
    assert.equal(expandAgentInitials(input, roster), input, input);

  // A and B are the bomb sites. Where a clause sends people is a place, not a person.
  same('push a');
  same('hold a site');
  same('b site push');
  same('rotate to b');
  // "a" is also an article, and it lands right in front of an order word.
  same('make a push on B');
  same('throw a nade at mid');
  same('take a peek at long');
  same('we need a regroup');
  // "i" is also a pronoun.
  same('i think we should hold', DEFEND);
  // Nothing to expand.
  same('everyone push b');
  same('nice shot');
});

test('the order Jev reads, and the history it resolves follow-ups against, use full names', async () => {
  const pending = [];
  const brains = createBrains({ evaluate: (state, questions) => new Promise(resolve => {
    pending.push({ state, questions, resolve });
  }) });
  const game = createGame();
  const run = brains.interpretCommand(game, 'attack', { source: 'text', text: 'c push B site' });
  assert.equal(pending[0].state.commander_says, 'Charlie push B site');
  // A name appears, so this is not a whole-squad order and Jev is still asked agent by agent.
  assert.equal(Object.keys(pending[0].questions).filter(k => k.endsWith('_addressed')).length, 5);
  const answers = Object.fromEntries(Object.keys(pending[0].questions).map(key => {
    if (key === 'is_order') return [key, { probability: 1 }];
    const [, kind] = key.split('_');
    const charlie = key.startsWith('charlie');
    return [key, kind === 'addressed' ? { probability: charlie ? 1 : 0 }
      : { choice: kind === 'order' ? 'push' : 'B Site' }];
  }));
  pending[0].resolve({ answers, latency: 1 });
  await run;

  // The follow-up sees "Charlie push B site", not "c push B site".
  brains.interpretCommand(game, 'attack', { source: 'text', text: 'Delta do the same' });
  assert.deepEqual(pending[1].state.recent_commands, ['Charlie push B site']);
});

test('initials work for whichever squad is being commanded', () => {
  // F-J belong to the defenders; on the attacking squad they name nobody.
  assert.equal(expandAgentInitials('g rotate a', ATTACK), 'g rotate a');
  assert.equal(expandAgentInitials('g rotate a', DEFEND), 'Golf rotate a');
});

test('an initial two agents would share is left as a letter', () => {
  const clashing = ['Alpha', 'Anvil', 'Charlie'];
  assert.equal(expandAgentInitials('a push b', clashing), 'a push b');
  // The unambiguous ones in the same squad still work.
  assert.equal(expandAgentInitials('c push b', clashing), 'Charlie push b');
});
