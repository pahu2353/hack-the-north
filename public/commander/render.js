// Top-down canvas renderer.
import { orderDestination } from './sim.js';
import { zoneAt } from './world.js';

const THEMES = {
  tactical: {
    floor: '#161a21', wall: '#2d333f', wallEdge: '#414958', zone: 'rgba(255,255,255,0.13)',
    site: 'rgba(255, 196, 64, 0.07)', siteLetter: 'rgba(255, 196, 64, 0.35)',
  },
  titan: {
    floor: '#1d1b17', wall: '#3a352c', wallEdge: '#504838', zone: 'rgba(255,240,210,0.13)',
    site: 'rgba(0,0,0,0)', siteLetter: 'rgba(0,0,0,0)',
  },
};
const SQUAD = '#4aa3ff';
const ENEMY = '#ff5d5d';
const TITAN = { small: '#d7a07a', big: '#b8745a', abnormal: '#e3b95c' };
const POINTER = '#ffd24a';

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d');
  let view = { scale: 1, ox: 0, oy: 0 };

  function resize(map) {
    const dpr = window.devicePixelRatio || 1;
    const { width, height } = canvas.getBoundingClientRect();
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const scale = Math.min(width / map.width, height / map.height);
    view = { scale, ox: (width - map.width * scale) / 2, oy: (height - map.height * scale) / 2, dpr };
  }

  function toWorld(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    return { x: (clientX - r.left - view.ox) / view.scale, y: (clientY - r.top - view.oy) / view.scale };
  }

  // opts.focusId: the agent being watched (highlighted, with a wide view cone).
  // opts.mini: minimap mode, with no text labels.
  function draw(game, opts = {}) {
    const { map } = game;
    const theme = THEMES[game.mode];
    const { scale: s, ox, oy, dpr } = view;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * ox, dpr * oy);
    const px = 1 / s; // one screen pixel in world units

    ctx.fillStyle = theme.floor;
    ctx.fillRect(0, 0, map.width, map.height);

    // Sites get a tint and a big letter.
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const z of map.zones) {
      if (!map.sites?.includes(z.name)) continue;
      ctx.fillStyle = theme.site;
      ctx.fillRect(z.rect.x, z.rect.y, z.rect.w, z.rect.h);
      ctx.fillStyle = theme.siteLetter;
      ctx.font = '700 7px system-ui, sans-serif';
      ctx.fillText(z.name[0], z.center.x, z.center.y - 3);
    }

    for (const w of map.walls) {
      ctx.fillStyle = theme.wall;
      ctx.fillRect(w.x, w.y, w.w, w.h);
      ctx.strokeStyle = theme.wallEdge;
      ctx.lineWidth = px;
      ctx.strokeRect(w.x, w.y, w.w, w.h);
    }

    // Zone labels go on top of the walls so buildings never hide them.
    ctx.fillStyle = theme.zone;
    ctx.font = `600 ${12 * px}px system-ui, sans-serif`;
    for (const z of opts.mini ? [] : map.zones) {
      if (game.gate && z.name === 'Gate') continue; // the gate itself is labelled
      const labelY = z.name === 'Top Hall' ? z.center.y : z.rect.y + 2.2;
      ctx.fillText(z.name.toUpperCase(), z.center.x, labelY);
    }

    if (game.gate) drawGate(game.gate, px);

    // Order line for the agent you're watching. Drawing all four at once was a web of dashes.
    const lead = game.units.find(u => u.id === opts.focusId && u.alive && u.team === 'squad');
    if (lead) {
      const dest = orderDestination(game, lead);
      ctx.setLineDash([4 * px, 4 * px]);
      ctx.lineWidth = 1.5 * px;
      ctx.strokeStyle = fade(lead.color, 0.5);
      ctx.beginPath();
      ctx.moveTo(lead.x, lead.y);
      ctx.lineTo(dest.x, dest.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (game.spike) drawSpike(game, px);

    for (const e of game.effects) drawEffect(e, px);

    // Enemies: bots only when the squad can see them (fog of war); titans always.
    for (const u of game.units) {
      if (u.team !== 'enemy' || !u.alive) continue;
      if (u.kind === 'titan') drawTitan(u, px);
      else {
        const intel = game.squadIntel.get(u.id);
        if (intel && game.time - intel.t < 0.15) drawSoldier(u, u.color, px);
        else if (intel && game.time - intel.t < 3) drawGhost(intel, game.time - intel.t, px, u.color);
      }
    }
    const focus = game.units.find(u => u.id === opts.focusId && u.alive);
    if (focus) drawFocus(focus, px);
    for (const u of game.units) {
      if (u.team === 'squad' && u.alive) drawSoldier(u, u.color, px, opts.mini ? null : game);
    }

    if (game.pointer && performance.now() - game.pointer.at < 8000) drawPointer(game, px);
  }

  function drawGate(gate, px) {
    ctx.fillStyle = '#6d4c2c';
    ctx.fillRect(gate.x, gate.y, gate.w, gate.h);
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillRect(gate.x, gate.y + gate.h + 0.3, gate.w, 0.6);
    ctx.fillStyle = gate.hp / gate.maxHp > 0.35 ? '#5bd17a' : ENEMY;
    ctx.fillRect(gate.x, gate.y + gate.h + 0.3, (gate.w * gate.hp) / gate.maxHp, 0.6);
    ctx.fillStyle = 'rgba(255,240,210,0.8)';
    ctx.font = `700 ${12 * px}px system-ui, sans-serif`;
    ctx.fillText('GATE', gate.x + gate.w / 2, gate.y + gate.h / 2);
  }

  function drawSpike(game, px) {
    const spike = game.spike;
    if (spike.state === 'carried') return; // drawn on the carrier
    ctx.save();
    ctx.translate(spike.x, spike.y);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = spike.state === 'planted' ? '#ff6b3d' : '#ffb347';
    ctx.fillRect(-0.6, -0.6, 1.2, 1.2);
    ctx.restore();
    if (spike.state === 'planted') {
      const pulse = 1.6 + Math.sin(game.time * (10 - spike.timer / 5)) * 0.3;
      ctx.strokeStyle = 'rgba(255,107,61,0.8)';
      ctx.lineWidth = 2 * px;
      ctx.beginPath();
      ctx.arc(spike.x, spike.y, pulse, 0, Math.PI * 2);
      ctx.stroke();
      if (spike.defuse > 0) ring(spike.x, spike.y, 2.4, spike.defuse / 6, ENEMY, px);
    }
  }

  function ring(x, y, r, fraction, color, px) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 3 * px;
    ctx.beginPath();
    ctx.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * fraction);
    ctx.stroke();
  }

  function drawSoldier(u, color, px, game) {
    // Facing wedge
    ctx.fillStyle = fade(color, 0.14);
    ctx.beginPath();
    ctx.moveTo(u.x, u.y);
    ctx.arc(u.x, u.y, 4, u.facing - 0.35, u.facing + 0.35);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = color;
    ctx.strokeStyle = '#0b0d11';
    ctx.lineWidth = 2 * px;
    ctx.beginPath();
    ctx.arc(u.x, u.y, u.r + 0.15, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // HP ring
    ring(u.x, u.y, u.r + 0.55, u.hp / u.maxHp, u.hp / u.maxHp > 0.4 ? '#5bd17a' : '#ffb347', px);

    ctx.fillStyle = '#0b0d11';
    ctx.font = `800 ${11 * px}px system-ui, sans-serif`;
    ctx.fillText(u.team === 'squad' ? u.name[0] : u.name.slice(1), u.x, u.y + 0.5 * px);

    if (!game) return;
    const carrying = game.spike?.state === 'carried' && game.spike.carrierId === u.id;
    if (carrying) {
      ctx.fillStyle = '#ffb347';
      ctx.fillRect(u.x + 0.7, u.y - 1.3, 0.7, 0.7);
      if (game.spike.progress > 0) ring(u.x, u.y, u.r + 1.1, game.spike.progress / 3, '#ffb347', px);
    }
  }

  function drawFocus(u, px) {
    ctx.fillStyle = 'rgba(255, 210, 74, 0.16)';
    ctx.beginPath();
    ctx.moveTo(u.x, u.y);
    ctx.arc(u.x, u.y, 14, u.facing - Math.PI / 4, u.facing + Math.PI / 4);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = POINTER;
    ctx.lineWidth = 2 * px;
    ctx.beginPath();
    ctx.arc(u.x, u.y, u.r + 1.2, 0, Math.PI * 2);
    ctx.stroke();
  }

  function drawGhost(intel, age, px, color = ENEMY) {
    ctx.strokeStyle = fade(color, 0.6 * (1 - age / 3));
    ctx.lineWidth = 1.5 * px;
    ctx.setLineDash([3 * px, 3 * px]);
    ctx.beginPath();
    ctx.arc(intel.x, intel.y, 0.8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function drawTitan(t, px) {
    const color = t.color ?? TITAN[t.class];
    // Telegraph: a grab cone while winding up; a dim ring while frozen in recovery.
    if (t.status === 'windup') {
      ctx.fillStyle = 'rgba(255, 80, 60, 0.28)';
      ctx.beginPath();
      ctx.moveTo(t.x, t.y);
      ctx.arc(t.x, t.y, t.r + t.reach, t.facing - 1.2, t.facing + 1.2);
      ctx.closePath();
      ctx.fill();
    } else if (t.status === 'recovering') {
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.35)';
      ctx.lineWidth = 2 * px;
      ctx.setLineDash([2 * px, 3 * px]);
      ctx.beginPath();
      ctx.arc(t.x, t.y, t.r + 0.5, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.fillStyle = color;
    ctx.strokeStyle = '#0b0d11';
    ctx.lineWidth = 2 * px;
    ctx.beginPath();
    ctx.arc(t.x, t.y, t.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    // Face (front) and nape (back): the weak spot the scouts go for.
    const fx = Math.cos(t.facing);
    const fy = Math.sin(t.facing);
    ctx.fillStyle = '#0b0d11';
    for (const side of [-1, 1]) {
      ctx.beginPath();
      ctx.arc(t.x + fx * t.r * 0.55 - fy * side * t.r * 0.3, t.y + fy * t.r * 0.55 + fx * side * t.r * 0.3, t.r * 0.1, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.fillStyle = '#ff3b3b';
    ctx.beginPath();
    ctx.arc(t.x - fx * t.r * 0.72, t.y - fy * t.r * 0.72, Math.max(0.25, t.r * 0.18), 0, Math.PI * 2);
    ctx.fill();
    // HP bar
    const w = t.r * 2;
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(t.x - w / 2, t.y - t.r - 0.9, w, 0.35);
    ctx.fillStyle = ENEMY;
    ctx.fillRect(t.x - w / 2, t.y - t.r - 0.9, (w * t.hp) / t.maxHp, 0.35);
  }

  function drawEffect(e, px) {
    if (e.kind === 'tracer') {
      ctx.strokeStyle = fade(e.color ?? (e.team === 'squad' ? SQUAD : ENEMY), 0.9);
      ctx.lineWidth = 1.5 * px;
      ctx.beginPath();
      ctx.moveTo(e.x1, e.y1);
      ctx.lineTo(e.x2, e.y2);
      ctx.stroke();
    } else if (e.kind === 'slash') {
      ctx.strokeStyle = e.nape ? '#ffffff' : 'rgba(200,220,255,0.7)';
      ctx.lineWidth = (e.nape ? 4 : 2) * px;
      ctx.beginPath();
      ctx.arc(e.x, e.y, e.r, 0, Math.PI * 2 * (1 - e.ttl / 0.25) + 0.5);
      ctx.stroke();
    } else if (e.kind === 'grab') {
      ctx.fillStyle = e.hit === false ? `rgba(255,255,255,${e.ttl * 0.6})` : `rgba(255,80,60,${e.ttl})`;
      ctx.beginPath();
      ctx.arc(e.x, e.y, e.r, 0, Math.PI * 2);
      ctx.fill();
    } else if (e.kind === 'death') {
      ctx.strokeStyle = fade(e.color ?? (e.team === 'squad' ? SQUAD : ENEMY), 0.5);
      ctx.lineWidth = 2 * px;
      const r = Math.max(0.6, e.r * 0.8);
      ctx.beginPath();
      ctx.moveTo(e.x - r, e.y - r);
      ctx.lineTo(e.x + r, e.y + r);
      ctx.moveTo(e.x + r, e.y - r);
      ctx.lineTo(e.x - r, e.y + r);
      ctx.stroke();
    }
  }

  function drawPointer(game, px) {
    const p = game.pointer;
    const age = (performance.now() - p.at) / 8000;
    ctx.globalAlpha = 1 - age * 0.7;
    ctx.strokeStyle = POINTER;
    ctx.lineWidth = 2 * px;
    ctx.beginPath();
    ctx.arc(p.x, p.y, 1.6, 0, Math.PI * 2);
    ctx.moveTo(p.x - 2.6, p.y);
    ctx.lineTo(p.x + 2.6, p.y);
    ctx.moveTo(p.x, p.y - 2.6);
    ctx.lineTo(p.x, p.y + 2.6);
    ctx.stroke();
    ctx.fillStyle = POINTER;
    ctx.font = `700 ${12 * px}px system-ui, sans-serif`;
    ctx.fillText(zoneAt(game.map, p).name, p.x, p.y - 3.4);
    ctx.globalAlpha = 1;
  }

  return { resize, draw, toWorld };
}

// "#rrggbb" plus an alpha, as a colour the canvas understands.
export function fade(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

