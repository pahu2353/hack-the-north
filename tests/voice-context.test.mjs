import assert from 'node:assert/strict';
import test from 'node:test';
import { createBrains } from '../public/commander/brain.js';
import { createGame } from '../public/commander/sim.js';
import { classifyProfanity, createVoiceMetrics } from '../public/commander/voice-metrics.js';

function utterance(metrics, levels, text, durationMs = 1000) {
  metrics.start(0);
  for (const level of levels) metrics.sample(level);
  metrics.stop(durationMs);
  return metrics.finish(text);
}

test('voice metrics use a personal baseline without letting one shout reset it', () => {
  const metrics = createVoiceMetrics();
  const first = utterance(metrics, Array(10).fill(0.02), 'Everyone hold position');
  assert.equal(first.volumeLevel, 'normal');
  assert.equal(first.volumeVsBaseline, 1);
  assert.ok(Math.abs(metrics.debug.baselineVolume - 0.02) < 1e-10);

  const shout = utterance(metrics, Array(10).fill(0.05), 'Everyone fall back now');
  assert.equal(shout.volumeLevel, 'very_loud');
  assert.equal(shout.peakVolumeLevel, 'very_loud');
  assert.ok(metrics.debug.baselineVolume < 0.022);
  assert.equal(metrics.debug.latestVolumeLevel, 'very_loud');
});

test('speech rate and interior pauses are classified from the completed utterance', () => {
  const metrics = createVoiceMetrics();
  const context = utterance(
    metrics,
    [0.02, 0.02, 0.02, 0.001, 0.001, 0.001, 0.001, 0.02, 0.02, 0.02],
    'Alpha and Bravo push B right now',
    2000,
  );
  assert.equal(context.pauseLevel, 'high');
  assert.equal(context.speechRate, 'fast');
  assert.equal(context.sampleCount, 10);
  assert.equal(context.utteranceDurationMs, 2000);
  assert.equal(utterance(metrics, [], 'No audio'), null);
});

test('profanity uses whole transcript words and does not mistake similar commands', () => {
  assert.deepEqual(classifyProfanity('Alpha pass through the assault lane'), { level: 'none', count: 0 });
  assert.deepEqual(classifyProfanity('What the hell? Push, damn it!'), { level: 'mild', count: 2 });
  assert.deepEqual(classifyProfanity('Fuck, push B! That is bullshit.'), { level: 'strong', count: 2 });
  const context = utterance(createVoiceMetrics(), Array(10).fill(0.02), 'Fuck, push B now');
  assert.equal(context.profanityLevel, 'strong');
  assert.equal(context.profanityCount, 1);
  assert.equal(context.volumeLevel, 'normal');
});

test('accepted urgent voice orders boost movement without stacking; chatter and later orders do not', async () => {
  let acceptOrder = false;
  const requests = [];
  const brains = createBrains({ evaluate: async (state, questions) => {
    requests.push(state);
    const answers = Object.fromEntries(Object.entries(questions).map(([id, question]) => {
      if (question.type === 'boolean') return [id, { probability: id === 'is_order' ? Number(acceptOrder) : 1 }];
      const choice = id.endsWith('_order') ? 'push'
        : id.endsWith('_target') ? 'current' : Object.keys(question.criteria)[0];
      return [id, { choice, probabilities: { [choice]: 1 } }];
    }));
    return { answers, latency: 0, usage: { inputTokens: 0 } };
  } });
  const game = createGame({ defenders: 'bots' });
  const agents = game.units.filter(unit => unit.team === 'attack' && unit.kind === 'agent');
  const baseSpeed = agents[0].speed;
  const cursed = utterance(createVoiceMetrics(), Array(10).fill(0.02), 'Fuck, push B now');
  const swearOnly = utterance(createVoiceMetrics(), Array(10).fill(0.02), 'Fuck!');
  await brains.interpretCommand(game, 'attack', { source: 'voice', text: 'Fuck!', voiceContext: swearOnly });
  assert.ok(agents.every(unit => unit.speed === baseSpeed));

  acceptOrder = true;
  const urgent = await brains.interpretCommand(game, 'attack', {
    source: 'voice', text: 'Fuck, push B now', voiceContext: cursed,
  });
  assert.equal(requests.at(-1).voice_context.profanity_level, 'strong');
  assert.equal(requests.at(-1).voice_context.profanity_count, 1);
  assert.equal(urgent.paceMultiplier, 1.18);
  assert.ok(agents.every(unit => unit.speed === baseSpeed * 1.18));

  await brains.interpretCommand(game, 'attack', { source: 'voice', text: 'Push B again', voiceContext: cursed });
  assert.ok(agents.every(unit => unit.speed === baseSpeed * 1.18));
  await brains.interpretCommand(game, 'attack', { source: 'text', text: 'Hold position' });
  assert.ok(agents.every(unit => unit.speed === baseSpeed));

  const loudMetrics = createVoiceMetrics();
  utterance(loudMetrics, Array(10).fill(0.02), 'Baseline voice');
  const loud = utterance(loudMetrics, Array(10).fill(0.05), 'Push B now');
  assert.equal(loud.profanityLevel, 'none');
  const loudOrder = await brains.interpretCommand(game, 'attack', {
    source: 'voice', text: 'Push B now', voiceContext: loud,
  });
  assert.equal(loudOrder.paceMultiplier, 1.18);
  assert.ok(agents.every(unit => unit.speed === baseSpeed * 1.18));
});

test('voice adds UX questions to the existing command call; typed orders stay unchanged', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body);
    requests.push(body);
    const answers = Object.fromEntries(Object.entries(body.questions).map(([id, question]) => {
      if (question.type === 'boolean') return [id, { probability: id === 'clarification_needed' ? 0.8 : 1 }];
      const choice = id === 'command_urgency' ? 'high'
        : id === 'commander_certainty' ? 'confident'
          : id.endsWith('_target') ? 'current' : Object.keys(question.criteria)[0];
      return [id, { choice, probabilities: { [choice]: 1 } }];
    }));
    return { ok: true, json: async () => ({ answers, usage: { inputTokens: 100 } }) };
  };

  try {
    const brains = createBrains();
    const game = createGame({ defenders: 'bots' });
    const voiceContext = utterance(createVoiceMetrics(), Array(10).fill(0.02), 'Everyone hold position');
    const voiceResult = await brains.interpretCommand(game, 'attack', { source: 'voice', text: 'Everyone hold position', voiceContext });
    assert.equal(requests.length, 1);
    assert.deepEqual(Object.keys(requests[0].state.voice_context), [
      'volume_level', 'volume_vs_baseline', 'peak_volume_level', 'speech_rate',
      'pause_level', 'emphasis_level', 'intensity_trend',
      'profanity_level', 'profanity_count',
    ]);
    assert.ok(requests[0].state.situation.seconds_remaining > 0);
    assert.deepEqual(requests[0].state.recent_commands, []);
    assert.deepEqual(Object.keys(requests[0].questions).filter(key =>
      ['command_urgency', 'commander_certainty', 'clarification_needed'].includes(key)),
    ['command_urgency', 'commander_certainty', 'clarification_needed']);
    assert.deepEqual(voiceResult.ux, { urgency: 'high', certainty: 'confident', clarificationRecommended: true });

    const typedResult = await brains.interpretCommand(game, 'attack', { source: 'text', text: 'Everyone hold mid' });
    assert.equal(requests.length, 2);
    assert.equal(requests[1].state.voice_context, undefined);
    assert.equal(requests[1].questions.command_urgency, undefined);
    assert.equal(typedResult.ux, null);

  } finally {
    globalThis.fetch = originalFetch;
  }
});
