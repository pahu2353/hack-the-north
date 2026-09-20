// Multiplayer for Jev Commander: one commander attacks, the other defends. A player creates a
// room and shares its invite code; the second player joins with it. The server runs the match
// (simulation plus both teams' Jev brains) and streams each player only what their team sees.
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { TEAMS, createGame, createMatch, otherTeam, setManualAim, stepGame, teamView } from './public/commander/sim.js';
import { createBrains } from './public/commander/brain.js';

type Team = 'attack' | 'defend';
type Brains = ReturnType<typeof createBrains>;
export type Evaluate = (state: unknown, questions: any, maxRetries: number) => Promise<{ answers: any; usage?: any; latency: number }>;

type Room = {
  code: string;
  host: WebSocket;
  players: Partial<Record<Team, WebSocket>>;
  game: any;
  match: any;
  brains: Record<Team, Brains>;
  loop: ReturnType<typeof setInterval> | null;
  next: ReturnType<typeof setTimeout> | null; // the break before the next round of the match
};

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // no 0/O or 1/I/L to misread
const MAX_ROOMS = 20; // every running match spends Jev calls
const STEP = 1 / 60;
const SNAPSHOT_MS = 50;
const THINK_MS = 600; // a bit slower than bot games: two squads share the Jev rate limit
const BREAK_MS = 7000; // time to read the scoreboard between rounds
const TEAM_LIST: Team[] = ['attack', 'defend'];

export function createRooms(evaluate: Evaluate) {
  const rooms = new Map<string, Room>();
  const wss = new WebSocketServer({ noServer: true });
  const newBrains = () => createBrains({ evaluate, thinkMs: THINK_MS });

  function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer, url: URL) {
    wss.handleUpgrade(req, socket, head, ws => {
      const code = url.searchParams.get('join')?.trim().toUpperCase();
      if (code) join(ws, code);
      else create(ws);
    });
  }

  function create(ws: WebSocket) {
    if (rooms.size >= MAX_ROOMS) return fail(ws, 'Too many games are running on this server right now.');
    let code: string;
    do code = randomCode();
    while (rooms.has(code));
    const room: Room = {
      code, host: ws, players: {}, game: null, match: null, loop: null, next: null,
      brains: { attack: newBrains(), defend: newBrains() },
    };
    rooms.set(code, room);
    seat(room, 'attack', ws);
  }

  function join(ws: WebSocket, code: string) {
    const room = rooms.get(code);
    if (!room) return fail(ws, `There's no game with code ${code}.`);
    const openTeam = TEAM_LIST.find(team => !room.players[team]);
    if (!openTeam || room.host.readyState !== WebSocket.OPEN) return fail(ws, 'That game is full or closing.');
    seat(room, openTeam, ws);
  }

  // Host ownership follows the connection, independently of the side it commands.
  function seat(room: Room, team: Team, ws: WebSocket) {
    room.players[team] = ws;
    send(ws, { type: 'joined', code: room.code, team, host: ws === room.host });
    broadcastLobby(room);
    ws.on('message', data => {
      let message: any;
      try {
        message = JSON.parse(String(data));
      } catch {
        return;
      }
      const currentTeam = TEAM_LIST.find(side => room.players[side] === ws);
      if (!currentTeam) return;
      if (message.type === 'start' && ws === room.host && room.players.attack && room.players.defend
          && (!room.game || (room.game.result && (!room.match || room.match.over)))) startMatch(room);
      else if (message.type === 'side' && ws === room.host) chooseSide(room, message.team);
      else if (message.type === 'command') command(room, currentTeam, message);
      else if (message.type === 'aim' && room.game) setManualAim(room.game, currentTeam, message.aim);
    });
    ws.on('close', () => {
      const currentTeam = TEAM_LIST.find(side => room.players[side] === ws);
      if (currentTeam) leave(room, currentTeam, ws);
    });
  }

  function chooseSide(room: Room, team: Team) {
    if (!TEAM_LIST.includes(team) || (room.game && !room.game.result) || room.players[team] === room.host) return;
    stopLoop(room);
    const other = room.players[team];
    room.players = { [team]: room.host, ...(other && { [otherTeam(team)]: other }) };
    room.game = null;
    room.match = null;
    for (const side of TEAM_LIST) send(room.players[side], { type: 'sides', team: side });
    broadcastLobby(room);
  }

  function startMatch(room: Room) {
    stopLoop(room);
    room.match = createMatch({});
    room.brains = { attack: newBrains(), defend: newBrains() };
    startRound(room);
  }

  // One round of the match. The score and everyone's totals live on room.match, so the next
  // round starts with fresh bodies and the same scorecard.
  function startRound(room: Room) {
    stopLoop(room);
    const game = createGame({ defenders: 'players', match: room.match, prep: true });
    room.game = game;
    broadcast(room, { type: 'started' });
    let last = performance.now();
    let accumulator = 0;
    let lastSnapshot = 0;
    room.loop = setInterval(() => {
      const now = performance.now();
      accumulator += Math.min(0.1, (now - last) / 1000);
      last = now;
      while (accumulator >= STEP) {
        stepGame(game, STEP);
        accumulator -= STEP;
      }
      if (!game.result) for (const team of TEAM_LIST) room.brains[team].update(game, team);
      if (now - lastSnapshot >= SNAPSHOT_MS || game.result) {
        lastSnapshot = now;
        for (const team of TEAM_LIST) {
          send(room.players[team], { type: 'state', view: teamView(game, team), jev: room.brains[team].summary() });
        }
      }
      if (game.result) {
        stopLoop(room);
        // Both commanders read the scoreboard, then the next round starts by itself.
        if (!room.match.over && room.players.attack && room.players.defend) {
          room.next = setTimeout(() => startRound(room), BREAK_MS);
        }
      }
    }, 16);
  }

  async function command(room: Room, team: Team, message: any) {
    const ws = room.players[team];
    const game = room.game;
    if (!game || game.result) return send(ws, { type: 'plan', id: message.id, error: 'The match is not running.' });
    const pointer = Number.isFinite(message.pointer?.x) && Number.isFinite(message.pointer?.y)
      ? { x: message.pointer.x, y: message.pointer.y }
      : null;
    const signal = message.gesture;
    const context = signal?.context;
    const gesture = signal ? {
      emoji: String(signal.emoji ?? ''), label: String(signal.label ?? ''), meaning: String(signal.meaning ?? ''),
      ...(context && { context: {
        name: String(context.name ?? ''),
        confidence: context.confidence,
        confidenceLevel: String(context.confidenceLevel ?? ''),
        stability: context.stability,
        stabilityLevel: String(context.stabilityLevel ?? ''),
        heldMs: context.heldMs,
        ageMs: context.ageMs,
        pointer: context.pointer && {
          active: Boolean(context.pointer.active),
          zone: String(context.pointer.zone ?? ''),
          ageMs: context.pointer.ageMs,
        },
      } }),
    } : undefined;
    const cues = message.voiceContext;
    const voiceContext = cues ? {
      volumeLevel: String(cues.volumeLevel ?? ''),
      volumeVsBaseline: cues.volumeVsBaseline,
      peakVolumeLevel: String(cues.peakVolumeLevel ?? ''),
      speechRate: String(cues.speechRate ?? ''),
      pauseLevel: String(cues.pauseLevel ?? ''),
      emphasisLevel: String(cues.emphasisLevel ?? ''),
      intensityTrend: String(cues.intensityTrend ?? ''),
      profanityLevel: ['none', 'mild', 'strong'].includes(cues.profanityLevel) ? cues.profanityLevel : 'none',
      profanityCount: Number.isFinite(cues.profanityCount) ? Math.max(0, Math.min(20, cues.profanityCount)) : 0,
    } : undefined;
    // An order given in the first-person view is for that one agent.
    const only = TEAMS[team].names.includes(message.only) ? (message.only as string) : undefined;
    try {
      const result = await room.brains[team].interpretCommand(game, team, {
        source: ['voice', 'text', 'hand'].includes(message.source) ? message.source : 'text',
        text: String(message.text ?? '').slice(0, 500),
        gesture,
        pointer,
        only,
        seq: Number(message.id) || undefined,
        voiceContext,
      });
      send(ws, { type: 'plan', id: message.id, ...result });
    } catch (error: any) {
      send(ws, { type: 'plan', id: message.id, error: error?.message ?? String(error) });
    }
  }

  function leave(room: Room, team: Team, ws: WebSocket) {
    if (room.players[team] !== ws) return;
    delete room.players[team];
    // Nobody to play the next round against.
    if (room.next) clearTimeout(room.next);
    room.next = null;
    const other = room.players[otherTeam(team) as Team];
    const game = room.game;
    if (game && !game.result) {
      // Forfeit: the loop sends the final state to whoever is still here, then stops.
      game.result = { winner: otherTeam(team), reason: `The ${TEAMS[team].label.toLowerCase()}' commander left`, time: game.time };
    }
    if (ws === room.host || !other) {
      // Without the host there's nobody to start matches, so the room closes.
      if (other) send(other, { type: 'closed', reason: 'The host left the game.' });
      setTimeout(() => {
        stopLoop(room);
        rooms.delete(room.code);
        other?.close();
      }, 200);
      return;
    }
    send(other, { type: 'opponent-left' });
    broadcastLobby(room);
  }

  function broadcastLobby(room: Room) {
    const players = { attack: Boolean(room.players.attack), defend: Boolean(room.players.defend) };
    broadcast(room, { type: 'lobby', players, running: Boolean(room.game && !room.game.result) });
  }

  function broadcast(room: Room, message: unknown) {
    for (const team of TEAM_LIST) send(room.players[team], message);
  }

  function stopLoop(room: Room) {
    if (room.loop) clearInterval(room.loop);
    if (room.next) clearTimeout(room.next);
    room.loop = null;
    room.next = null;
  }

  return { handleUpgrade, get roomCount() { return rooms.size; } };
}

function send(ws: WebSocket | undefined, message: unknown) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
}

function fail(ws: WebSocket, reason: string) {
  send(ws, { type: 'error', message: reason });
  ws.close();
}

function randomCode() {
  let code = '';
  for (let i = 0; i < 5; i++) code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return code;
}
