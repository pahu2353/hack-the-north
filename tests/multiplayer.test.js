import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createRooms } from '../multiplayer.ts';

async function multiplayer(t) {
  const calls = [];
  const rooms = createRooms(async (state, questions) => {
    calls.push(state);
    return { latency: 1, answers: Object.fromEntries(Object.entries(questions).map(([key, q]) =>
      [key, q.type === 'boolean' ? { probability: 1 } : { choice: Object.keys(q.criteria)[0] }])) };
  });
  const server = createServer();
  server.on('upgrade', (req, socket, head) => rooms.handleUpgrade(req, socket, head, new URL(req.url, 'http://localhost')));
  const clients = [];
  t.after(async () => {
    await Promise.all(clients.map(async c => {
      if (c.ws.readyState !== WebSocket.CLOSED) {
        const closed = once(c.ws, 'close'); c.ws.close(); await closed;
      }
    }));
    if (server.listening) await new Promise(resolve => server.close(resolve));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  async function connect(code) {
    const ws = new WebSocket(`ws://127.0.0.1:${server.address().port}/api/room${code ? `?join=${code}` : ''}`);
    const messages = [];
    const waiters = [];
    ws.on('message', raw => {
      const message = JSON.parse(raw);
      const i = waiters.findIndex(w => w.predicate(message));
      if (i < 0) messages.push(message);
      else { const [w] = waiters.splice(i, 1); clearTimeout(w.timeout); w.resolve(message); }
    });
    const client = {
      ws, messages,
      send: message => ws.send(JSON.stringify(message)),
      take(predicate) {
        const i = messages.findIndex(predicate);
        if (i >= 0) return Promise.resolve(messages.splice(i, 1)[0]);
        return new Promise((resolve, reject) => {
          const waiter = { predicate, resolve, timeout: setTimeout(() => reject(new Error('Timed out waiting for multiplayer message')), 2000) };
          waiters.push(waiter);
        });
      },
    };
    clients.push(client);
    await once(ws, 'open');
    client.joined = await client.take(m => m.type === 'joined');
    return client;
  }
  return { connect, calls, rooms };
}

test('a defending host owns start controls; guest commands and forfeits follow the selected side', async t => {
  const { connect, calls } = await multiplayer(t);
  const host = await connect();
  host.send({ type: 'side', team: 'defend' });
  assert.equal((await host.take(m => m.type === 'sides')).team, 'defend');
  const guest = await connect(host.joined.code);
  assert.equal(guest.joined.team, 'attack');
  assert.equal(guest.joined.host, false);
  guest.send({ type: 'start' });
  guest.send({ type: 'side', team: 'defend' });
  guest.send({ type: 'command', id: 1, text: 'Hold' });
  assert.match((await guest.take(m => m.type === 'plan' && m.id === 1)).error, /not running/);
  assert(!guest.messages.some(m => m.type === 'started' || m.type === 'sides'));
  host.send({ type: 'start' });
  await host.take(m => m.type === 'started');
  await guest.take(m => m.type === 'started');
  const hostView = (await host.take(m => m.type === 'state')).view;
  const guestView = (await guest.take(m => m.type === 'state')).view;
  assert.equal(hostView.team, 'defend');
  assert.equal(guestView.team, 'attack');
  assert.deepEqual(hostView.units.filter(u => u.team === 'defend').map(u => u.name), ['Echo', 'Foxtrot', 'Golf', 'Hotel']);
  host.send({ type: 'side', team: 'attack' }); // cannot change a live match
  host.send({ type: 'start' }); // cannot restart a live match either
  host.send({ type: 'command', id: 2, only: 'Echo', text: 'Hold' });
  await host.take(m => m.type === 'plan' && m.id === 2);
  assert(!host.messages.some(m => m.type === 'sides' || m.type === 'started'));
  assert(calls.some(s => s.talking_to === 'Echo' && Object.keys(s.squad).join() === 'Echo'));
  guest.send({ type: 'command', id: 3, only: 'Alpha', text: 'Hold' });
  await guest.take(m => m.type === 'plan' && m.id === 3);
  assert(calls.some(s => s.talking_to === 'Alpha'));
  guest.ws.close();
  assert.equal((await host.take(m => m.type === 'state' && m.view.result)).view.result.winner, 'defend');
  assert.equal(host.ws.readyState, WebSocket.OPEN);
});

test('both clients update when sides swap, and a swapped host can start a rematch or close the room', async t => {
  const { connect } = await multiplayer(t);
  const host = await connect();
  const guest = await connect(host.joined.code);
  host.send({ type: 'side', team: 'defend' });
  assert.equal((await host.take(m => m.type === 'sides')).team, 'defend');
  assert.equal((await guest.take(m => m.type === 'sides')).team, 'attack');
  host.send({ type: 'start' });
  await host.take(m => m.type === 'started');
  guest.ws.close();
  await host.take(m => m.type === 'state' && m.view.result);
  const replacement = await connect(host.joined.code);
  assert.equal(replacement.joined.team, 'attack');
  host.send({ type: 'side', team: 'attack' });
  assert.equal((await host.take(m => m.type === 'sides')).team, 'attack');
  assert.equal((await replacement.take(m => m.type === 'sides')).team, 'defend');
  host.send({ type: 'start' });
  await replacement.take(m => m.type === 'started');
  assert.equal((await replacement.take(m => m.type === 'state')).view.team, 'defend');
  host.ws.close();
  assert.match((await replacement.take(m => m.type === 'closed')).reason, /host left/);
  assert.equal((await replacement.take(m => m.type === 'state' && m.view.result)).view.result.winner, 'defend');
});

for (const side of ['attack', 'defend']) test(`${side}: multiplayer aim assistance stays with its owner and does not fire without contact`, async t => {
  const { connect } = await multiplayer(t);
  const host = await connect();
  if (side === 'defend') {
    host.send({ type: 'side', team: side });
    await host.take(m => m.type === 'sides');
  }
  const guest = await connect(host.joined.code);
  host.send({ type: 'start' });
  await host.take(m => m.type === 'started');
  const first = (await host.take(m => m.type === 'state')).view;
  const own = first.units.filter(u => u.team === side);
  assert(own.every(u => u.hp === 150));
  const intent = { unitId: own[0].id, yaw: 0, pitch: 0 };
  // The guest cannot take a host unit, even if it supplies the host's team or damage.
  guest.send({ type: 'aim', team: side, aim: { ...intent, damage: 999 } });
  const afterInvalid = (await host.take(m => m.type === 'state' && m.view.time > first.time + 0.1)).view;
  assert(afterInvalid.units.filter(u => u.team === side).every(u => !u.manualAim));
  host.send({ type: 'aim', aim: intent });
  const active = (await host.take(m => m.type === 'state' && m.view.units.some(u => u.id === own[0].id && u.manualAim))).view;
  assert.equal(active.units.find(u => u.id === own[0].id).firing, false, 'aim input alone does not shoot into empty space');
  host.send({ type: 'aim', aim: { ...intent, unitId: own[1].id } });
  const switched = (await host.take(m => m.type === 'state' && m.view.units.some(u => u.id === own[1].id && u.manualAim))).view;
  assert.equal(switched.units.find(u => u.id === own[0].id).manualAim, false);
  host.send({ type: 'aim', aim: null });
  const released = (await host.take(m => m.type === 'state' && m.view.time > switched.time)).view;
  assert(released.units.filter(u => u.team === side).every(u => !u.manualAim));
});
