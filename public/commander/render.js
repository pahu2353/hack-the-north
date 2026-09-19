// Top-down canvas renderer. Draws one team's view (see teamView in sim.js): your agents in
// blue, enemies in red only while your team can see them, and fading ghosts where they were.
import { MAPS, zoneAt } from './world.js';

const THEME = {
  floor: '#161a21', wall: '#2d333f', wallEdge: '#414958', zone: 'rgba(255,255,255,0.13)',
  site: 'rgba(255, 196, 64, 0.07)', siteLetter: 'rgba(255, 196, 64, 0.35)',
};
const OWN = '#4aa3ff';
const ENEMY = '#ff5d5d';
const POINTER = '#ffd24a';

// "#rrggbb" plus an alpha, as a colour the canvas understands.
export function fade(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d');
  const map = MAPS.tactical;
  let view = { scale: 1, ox: 0, oy: 0, dpr: 1 };

  function resize() {
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

  // positions: optional Map of unit id → smoothed {x, y} (multiplayer interpolation).
  // focusId: the agent being watched, highlighted with a wide view cone. mini: minimap mode.
  function draw(teamView, { pointer, positions, focusId, mini } = {}) {
    const { scale: s, ox, oy, dpr } = view;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * ox, dpr * oy);
    const px = 1 / s; // one screen pixel in world units

    ctx.fillStyle = THEME.floor;
    ctx.fillRect(0, 0, map.width, map.height);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const z of map.zones) {
      if (!map.sites.includes(z.name)) continue;
      ctx.fillStyle = THEME.site;
      ctx.fillRect(z.rect.x, z.rect.y, z.rect.w, z.rect.h);
      ctx.fillStyle = THEME.siteLetter;
      ctx.font = '700 7px system-ui, sans-serif';
      ctx.fillText(z.name[0], z.center.x, z.center.y - 3);
    }
    for (const w of map.walls) {
      ctx.fillStyle = THEME.wall;
      ctx.fillRect(w.x, w.y, w.w, w.h);
      ctx.strokeStyle = THEME.wallEdge;
      ctx.lineWidth = px;
      ctx.strokeRect(w.x, w.y, w.w, w.h);
    }
    ctx.fillStyle = THEME.zone;
    ctx.font = `600 ${12 * px}px system-ui, sans-serif`;
    for (const z of mini ? [] : map.zones) {
      ctx.fillText(z.name.toUpperCase(), z.center.x, z.name === 'Top Hall' ? z.center.y : z.rect.y + 2.2);
    }
    if (!teamView) return;

    const at = u => positions?.get(u.id) ?? u;
    const own = teamView.units.filter(u => u.team === teamView.team);
    const enemies = teamView.units.filter(u => u.team !== teamView.team);

    // Order line for the agent you're watching, in their colour.
    const focus = own.find(u => u.id === focusId && u.alive);
    if (focus?.dest) {
      const p = at(focus);
      ctx.setLineDash([4 * px, 4 * px]);
      ctx.lineWidth = 1.5 * px;
      ctx.strokeStyle = fade(focus.color ?? OWN, 0.5);
      ctx.beginPath();
      ctx.moveTo(p.x, p.y);
      ctx.lineTo(focus.dest.x, focus.dest.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    drawSpike(teamView.spike, teamView.time, px);
    for (const e of teamView.effects) drawEffect(e, teamView.team, px);
    for (const g of teamView.ghosts) drawGhost(g, px);
    if (focus) drawFocus({ ...focus, ...at(focus) }, px);
    for (const u of enemies) drawSoldier({ ...u, ...at(u) }, u.color ?? ENEMY, px);
    for (const u of own) if (u.alive) drawSoldier({ ...u, ...at(u) }, u.color ?? OWN, px, true);
    // Names last, so no dot is drawn over them. The minimap is too small to label.
    if (!mini) drawNames(own.filter(u => u.alive).map(u => ({ ...u, ...at(u) })), px);
    if (pointer) drawPointer(pointer, px);
  }

  function drawSpike(spike, time, px) {
    if (!spike || !['planted', 'dropped'].includes(spike.state)) return;
    ctx.save();
    ctx.translate(spike.x, spike.y);
    ctx.rotate(Math.PI / 4);
    ctx.fillStyle = spike.state === 'planted' ? '#ff6b3d' : '#ffb347';
    ctx.fillRect(-0.6, -0.6, 1.2, 1.2);
    ctx.restore();
    if (spike.state !== 'planted') return;
    const pulse = 1.6 + Math.sin(time * (10 - spike.timer / 5)) * 0.3;
    ctx.strokeStyle = 'rgba(255,107,61,0.8)';
    ctx.lineWidth = 2 * px;
    ctx.beginPath();
    ctx.arc(spike.x, spike.y, pulse, 0, Math.PI * 2);
    ctx.stroke();
    if (spike.defuse > 0) ring(spike.x, spike.y, 2.4, spike.defuse, '#9be37a', px);
  }

  function ring(x, y, r, fraction, color, px) {
    ctx.strokeStyle = color;
    ctx.lineWidth = 3 * px;
    ctx.beginPath();
    ctx.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * fraction);
    ctx.stroke();
  }

  function drawSoldier(u, color, px, own = false) {
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
    ring(u.x, u.y, u.r + 0.55, u.hp / u.maxHp, u.hp / u.maxHp > 0.4 ? '#5bd17a' : '#ffb347', px);

    ctx.fillStyle = '#0b0d11';
    ctx.font = `800 ${11 * px}px system-ui, sans-serif`;
    ctx.fillText(/^E\d/.test(u.name) ? u.name.slice(1) : u.name[0], u.x, u.y + 0.5 * px);
    if (!own) return;

    if (u.carrying) {
      ctx.fillStyle = '#ffb347';
      ctx.fillRect(u.x + 0.7, u.y - 1.3, 0.7, 0.7);
      if (u.plantProgress > 0) ring(u.x, u.y, u.r + 1.1, u.plantProgress, '#ffb347', px);
    }
  }

  // Each name sits directly under its own dot, always at the same offset, in that agent's
  // colour: a dot on the map and a chip on the top bar are then obviously the same agent.
  // Stacked agents overlap; the dark outline is what keeps them readable.
  function drawNames(units, px) {
    ctx.font = `700 ${10 * px}px system-ui, sans-serif`;
    ctx.lineWidth = 3 * px;
    for (const u of units) {
      const y = u.y + u.r + 1.35;
      ctx.strokeStyle = 'rgba(8, 10, 14, 0.9)';
      ctx.strokeText(u.name, u.x, y);
      ctx.fillStyle = u.color ?? OWN;
      ctx.fillText(u.name, u.x, y);
    }
  }

  // The agent you're watching: a wide view cone and a gold ring.
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

  function drawGhost(g, px) {
    ctx.strokeStyle = `rgba(255,93,93,${0.6 * (1 - g.age / 3)})`;
    ctx.lineWidth = 1.5 * px;
    ctx.setLineDash([3 * px, 3 * px]);
    ctx.beginPath();
    ctx.arc(g.x, g.y, 0.8, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  function drawEffect(e, team, px) {
    if (e.kind === 'tracer') {
      ctx.strokeStyle = e.team === team ? 'rgba(140,200,255,0.9)' : 'rgba(255,140,120,0.9)';
      ctx.lineWidth = 1.5 * px;
      ctx.beginPath();
      ctx.moveTo(e.x1, e.y1);
      ctx.lineTo(e.x2, e.y2);
      ctx.stroke();
    } else if (e.kind === 'death') {
      ctx.strokeStyle = e.team === team ? 'rgba(74,163,255,0.5)' : 'rgba(255,93,93,0.5)';
      ctx.lineWidth = 2 * px;
      const r = 0.6;
      ctx.beginPath();
      ctx.moveTo(e.x - r, e.y - r);
      ctx.lineTo(e.x + r, e.y + r);
      ctx.moveTo(e.x + r, e.y - r);
      ctx.lineTo(e.x - r, e.y + r);
      ctx.stroke();
    }
  }

  function drawPointer(p, px) {
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
    ctx.fillText(zoneAt(map, p).name, p.x, p.y - 3.4);
    ctx.globalAlpha = 1;
  }

  return { resize, draw, toWorld };
}
