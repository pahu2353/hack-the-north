// Top-down canvas renderer. Draws one team's view (see teamView in sim.js): your agents in
// blue, enemies in red only while your team can see them, and fading ghosts where they were.
import { MAPS, zoneAt } from './world.js';

const THEME = {
  floor: '#0c1116', wall: '#1f2a33', wallEdge: '#3d4b56', zone: 'rgba(200, 225, 240, 0.13)',
  site: 'rgba(242, 193, 78, 0.09)', siteLetter: 'rgba(242, 193, 78, 0.42)',
};
// The minimap is a CS-style radar: pale grey geometry on near-black, and the site letters in
// yellow doing the labelling, since there's no room for callouts at that size.
const RADAR = {
  floor: '#0a0d10', wall: '#79848d', wallEdge: '#3c454d', zone: 'rgba(0, 0, 0, 0)',
  site: 'rgba(242, 193, 78, 0.10)', siteLetter: 'rgba(242, 193, 78, 0.85)',
};
const RADAR_SPAN = 44; // metres across the radar, so it reads like a scope rather than a map
const RADAR_EDGE = 0.82; // a mark sits this far out at most, inside the rim rather than under it
const RADAR_EASE = 7; // how fast, per second, the radar slides toward what you point at
const OWN = '#3d8bfd';
const ENEMY = '#ff4655';
const POINTER = '#f2c14e';

// "#rrggbb" plus an alpha, as a colour the canvas understands.
export function fade(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

// Attackers spawn at the bottom of the map, defenders at the top. Whichever side you command,
// you should be looking up the map at the enemy, so the defending view is turned around.
export const flippedFor = team => team === 'defend';
export const flipPoint = (map, p) => ({ x: map.width - p.x, y: map.height - p.y });

export function createRenderer(canvas) {
  const ctx = canvas.getContext('2d');
  // The snapshot says which map it belongs to, so one renderer serves any of them and the
  // minimap can never be drawing a different layout from the one being played.
  let map = MAPS.tactical;
  let view = { scale: 1, ox: 0, oy: 0, dpr: 1 };
  let flip = false; // whose way up the last frame was drawn, so clicks land on the right spot
  let radar = null; // { id, x, y, span, at }: where the round minimap is looking, eased

  // The css size this canvas was last fitted to. Anything that changes the box without a window
  // resize — turning agent cards on, a match filling the empty card strip, switching views —
  // has to be noticed here, or the canvas keeps its old backing store and the map is drawn
  // stretched at the wrong scale, which also puts clicks in the wrong place.
  let fitted = { width: 0, height: 0, dpr: 0 };

  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const { width, height } = canvas.getBoundingClientRect();
    // A hidden canvas measures zero. Keep the last good fit rather than dividing by it.
    if (!width || !height) return;
    fitted = { width, height, dpr };
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const scale = Math.min(width / map.width, height / map.height);
    view = { scale, ox: (width - map.width * scale) / 2, oy: (height - map.height * scale) / 2, dpr };
  }

  function refit() {
    const dpr = window.devicePixelRatio || 1;
    const { width, height } = canvas.getBoundingClientRect();
    if (width !== fitted.width || height !== fitted.height || dpr !== fitted.dpr) resize();
  }

  function toWorld(clientX, clientY) {
    const r = canvas.getBoundingClientRect();
    const p = { x: (clientX - r.left - view.ox) / view.scale, y: (clientY - r.top - view.oy) / view.scale };
    return flip ? flipPoint(map, p) : p;
  }

  // Writing on a turned-around map: the words stay the right way up.
  function label(text, x, y, stroke = false) {
    ctx.save();
    ctx.translate(x, y);
    if (flip) ctx.rotate(Math.PI);
    if (stroke) ctx.strokeText(text, 0, 0);
    ctx.fillText(text, 0, 0);
    ctx.restore();
  }

  // positions: optional Map of unit id → smoothed {x, y} (multiplayer interpolation).
  // focusId: the agent being watched, highlighted with a wide view cone. mini: minimap mode.
  function draw(teamView, { pointer, positions, focusId, mini } = {}) {
    const next = MAPS[teamView?.mapId] ?? map;
    if (next !== map) {
      map = next;
      fitted = { width: 0, height: 0, dpr: 0 }; // a new layout needs a new scale at the same size
    }
    refit();
    const { dpr } = view;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    flip = flippedFor(teamView?.team);
    // The radar is a scope: centred on the agent you're watching and zoomed in, while the full
    // map view stays fitted to its canvas. But pointing maps your hand across the whole map,
    // and a mark you can't see is a mark you can't correct, so the scope leads your hand — it
    // slides toward the mark, and only widens once sliding alone can no longer hold both.
    const scoped = mini && teamView?.units.find(u => u.id === focusId && u.alive);
    const { width, height } = canvas.getBoundingClientRect();
    let { scale: s, ox, oy } = view;
    if (scoped) {
      const me = positions?.get(scoped.id) ?? scoped;
      const mark = pointer ?? me;
      const away = Math.hypot(mark.x - me.x, mark.y - me.y);
      const span = Math.max(RADAR_SPAN, away / RADAR_EDGE);
      // How far the centre has to leave your agent to bring the mark inside the rim, capped at
      // the midpoint: past that the agent would be the one falling off, so the span grows instead.
      const reach = (span * RADAR_EDGE) / 2;
      const slide = Math.min(Math.max(0, away - reach), away / 2) / (away || 1);
      const want = { x: me.x + (mark.x - me.x) * slide, y: me.y + (mark.y - me.y) * slide, span };
      const now = performance.now();
      // Switching agent is a cut, not a pan: easing across the map would read as the radar
      // drifting rather than as a different point of view.
      const ease = radar?.id === scoped.id ? 1 - Math.exp(-RADAR_EASE * Math.min(0.25, (now - radar.at) / 1000)) : 1;
      radar = {
        id: scoped.id, at: now,
        x: radar ? radar.x + (want.x - radar.x) * ease : want.x,
        y: radar ? radar.y + (want.y - radar.y) * ease : want.y,
        span: radar ? radar.span + (want.span - radar.span) * ease : want.span,
      };
      s = Math.min(width, height) / radar.span;
      // The defending map is drawn upside down, so the centre has to be flipped with it.
      ox = width / 2 - (flip ? map.width - radar.x : radar.x) * s;
      oy = height / 2 - (flip ? map.height - radar.y : radar.y) * s;
    } else if (mini) {
      radar = null;
    }
    ctx.setTransform(dpr * s, 0, 0, dpr * s, dpr * ox, dpr * oy);
    if (flip) {
      ctx.translate(map.width / 2, map.height / 2);
      ctx.rotate(Math.PI);
      ctx.translate(-map.width / 2, -map.height / 2);
    }
    const px = 1 / s; // one screen pixel in world units
    const theme = mini ? RADAR : THEME;

    ctx.fillStyle = theme.floor;
    ctx.fillRect(0, 0, map.width, map.height);
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const z of map.zones) {
      if (!map.sites.includes(z.name)) continue;
      ctx.fillStyle = theme.site;
      ctx.fillRect(z.rect.x, z.rect.y, z.rect.w, z.rect.h);
      ctx.fillStyle = theme.siteLetter;
      ctx.font = `700 ${mini ? 9 : 7}px system-ui, sans-serif`;
      label(z.name[0], z.center.x, z.center.y - 3);
    }
    for (const w of map.walls) {
      ctx.fillStyle = theme.wall;
      ctx.fillRect(w.x, w.y, w.w, w.h);
      ctx.strokeStyle = theme.wallEdge;
      ctx.lineWidth = px;
      ctx.strokeRect(w.x, w.y, w.w, w.h);
    }
    ctx.fillStyle = theme.zone;
    ctx.font = `600 ${12 * px}px system-ui, sans-serif`;
    for (const z of mini ? [] : map.zones) {
      label(z.name.toUpperCase(), z.center.x, z.rect.h <= 6 ? z.center.y : z.rect.y + 2.2);
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

    if (teamView.prep) drawPrepLine(teamView.prep, teamView.team, px);
    for (const g of teamView.grenades ?? []) drawGrenade(g, teamView.team, px);
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

  // Setup time: the far side of the map is shaded and the line you may not cross is drawn
  // across it, with the seconds left until it opens.
  function drawPrepLine(prep, team, px) {
    const { line } = prep;
    ctx.fillStyle = 'rgba(255, 210, 74, 0.05)';
    if (team === 'attack') ctx.fillRect(0, 0, map.width, line);
    else ctx.fillRect(0, line, map.width, map.height - line);
    ctx.strokeStyle = 'rgba(255, 210, 74, 0.55)';
    ctx.lineWidth = 2 * px;
    ctx.setLineDash([2, 1.6]);
    ctx.beginPath();
    ctx.moveTo(0, line);
    ctx.lineTo(map.width, line);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = POINTER;
    ctx.font = `800 ${12 * px}px system-ui, sans-serif`;
    label(`${Math.ceil(prep.secondsLeft)}s · hold this side`, map.width / 2, line + (team === 'attack' ? 2.6 : -2.6));
  }

  // In the air it's a small dark ball; on the ground, a shrinking ring shows the blast
  // and how long is left to get out of it.
  function drawGrenade(g, team, px) {
    const mine = g.team === team;
    if (g.landed) {
      const left = Math.min(1, g.fuse / 1.2);
      ctx.fillStyle = fade(mine ? OWN : ENEMY, 0.12);
      ctx.beginPath();
      ctx.arc(g.x, g.y, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = fade(mine ? OWN : ENEMY, 0.85);
      ctx.lineWidth = 2 * px;
      ctx.setLineDash([3 * px, 3 * px]);
      ctx.beginPath();
      ctx.arc(g.x, g.y, 5 * (0.35 + 0.65 * left), 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.fillStyle = '#20242c';
    ctx.strokeStyle = mine ? OWN : ENEMY;
    ctx.lineWidth = 1.5 * px;
    ctx.beginPath();
    ctx.arc(g.x, g.y, 0.55, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
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
    label(/^E\d/.test(u.name) ? u.name.slice(1) : u.name[0], u.x, u.y + 0.5 * px);
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
      ctx.fillStyle = u.color ?? OWN;
      label(u.name, u.x, y, true);
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
    } else if (e.kind === 'blast') {
      const fade_ = e.ttl / 0.45;
      ctx.fillStyle = `rgba(255, 176, 64, ${0.45 * fade_})`;
      ctx.beginPath();
      ctx.arc(e.x, e.y, e.r * (1.15 - 0.15 * fade_), 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = `rgba(255, 120, 40, ${fade_})`;
      ctx.lineWidth = 2 * px;
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
    label(zoneAt(map, p).name, p.x, p.y - 3.4);
    ctx.globalAlpha = 1;
  }

  return { resize, draw, toWorld };
}
