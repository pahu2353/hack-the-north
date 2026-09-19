// First-person view: a raycaster over the same map.walls the top-down renderer draws, so the
// 3D world and the minimap always match. Plain 2D canvas: one ray per column for the walls,
// then billboard sprites (units, spike, pings) clipped against the wall depth buffer.
import { hasLineOfSight } from './world.js';

const FOV = (90 * Math.PI) / 180;
const WALL_H = 3;
const EYE = 1.6;
const COLUMN = 2; // CSS px per ray
const FAR = 70;
const SIGHT = 45; // how far an agent can spot an enemy (matches the sim)
const LINGER = 0.4; // seconds an enemy stays drawn after slipping out of sight
const THEMES = {
  tactical: { sky: ['#6f8ba3', '#c9d3d9'], fog: [201, 211, 217], wall: [196, 168, 128], floor: ['#a08e74', '#5f5446'], trim: 0.62 },
  titan: { sky: ['#5c6470', '#b9b4a8'], fog: [185, 180, 168], wall: [150, 140, 124], floor: ['#7a7060', '#3f3a31'], trim: 0.6 },
};
const SQUAD = '#4aa3ff';
const ENEMY = '#ff4d5a';
const POINTER = '#ffd24a';

export function createPovRenderer(canvas) {
  const ctx = canvas.getContext('2d');
  let W = 0;
  let H = 0;
  let depth = new Float32Array(0);
  // Last camera, for turning clicks and pointing back into world positions.
  let cam = null;
  // When each enemy was last in view, so they don't flicker at corners.
  const lastSeen = new Map();

  function fit() {
    const dpr = window.devicePixelRatio || 1;
    const { width, height } = canvas.getBoundingClientRect();
    if (width === W && height === H && canvas.width === Math.round(width * dpr)) return dpr;
    W = width;
    H = height;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    depth = new Float32Array(Math.ceil(width / COLUMN) + 1);
    return dpr;
  }

  function draw(game, unit, camera) {
    const dpr = fit();
    if (!W || !H) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const theme = THEMES[game.mode];
    const focal = W / 2 / Math.tan(FOV / 2);
    const horizon = H / 2;
    cam = { x: camera.x, y: camera.y, angle: camera.angle, focal, horizon };
    const walls = game.gate ? [...game.map.walls, game.gate] : game.map.walls;

    // Sky and floor.
    let g = ctx.createLinearGradient(0, 0, 0, horizon);
    g.addColorStop(0, theme.sky[0]);
    g.addColorStop(1, theme.sky[1]);
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, horizon);
    g = ctx.createLinearGradient(0, horizon, 0, H);
    g.addColorStop(0, theme.floor[1]);
    g.addColorStop(1, theme.floor[0]);
    ctx.fillStyle = g;
    ctx.fillRect(0, horizon, W, H - horizon);

    // Walls, one ray per column.
    const cos = Math.cos(camera.angle);
    const sin = Math.sin(camera.angle);
    for (let i = 0, sx = 0; sx < W; i++, sx += COLUMN) {
      const offset = (sx + COLUMN / 2 - W / 2) / focal;
      // Ray direction = forward + offset * right, left unnormalised so t is perpendicular depth.
      const dx = cos - offset * sin;
      const dy = sin + offset * cos;
      const hit = castRay(walls, camera.x, camera.y, dx, dy);
      depth[i] = hit ? hit.t : Infinity;
      if (!hit) continue;
      const top = horizon - ((WALL_H - EYE) * focal) / hit.t;
      const bottom = horizon + (EYE * focal) / hit.t;
      const shade = (hit.side ? 0.78 : 1) * (hit.edge ? 0.7 : 1);
      const fog = Math.min(1, hit.t / FAR);
      ctx.fillStyle = mix(theme.wall, theme.fog, shade, fog);
      ctx.fillRect(sx, top, COLUMN + 0.5, bottom - top);
      // A darker baseboard gives walls a sense of scale.
      const trim = horizon + ((EYE - 0.25) * focal) / hit.t;
      ctx.fillStyle = mix(theme.wall, theme.fog, shade * theme.trim, fog);
      ctx.fillRect(sx, trim, COLUMN + 0.5, bottom - trim);
    }

    // Sprites, far to near.
    const sprites = [];
    const add = (x, y, drawFn) => {
      const rx = x - camera.x;
      const ry = y - camera.y;
      const z = rx * cos + ry * sin;
      if (z < 0.3 || z > FAR) return;
      sprites.push({ z, sx: W / 2 + ((-rx * sin + ry * cos) * focal) / z, drawFn });
    };
    for (const e of game.effects) {
      if (e.kind === 'death') add(e.x, e.y, s => body(s, e));
    }
    const spike = game.spike;
    if (spike && spike.state !== 'carried' && spike.state !== 'defused') add(spike.x, spike.y, s => spikeSprite(s, game));
    for (const u of game.units) {
      if (!u.alive || u === unit) continue;
      if (u.team === 'enemy' && u.kind !== 'titan' && !enemyInView(game, walls, camera, u)) continue;
      add(u.x, u.y, s => figure(s, u, game));
    }
    if (game.pointer && performance.now() - game.pointer.at < 8000) add(game.pointer.x, game.pointer.y, s => ping(s, game));
    sprites.sort((a, b) => b.z - a.z);
    for (const s of sprites) {
      ctx.save();
      if (clipToVisible(s)) s.drawFn(s);
      ctx.restore();
    }

    for (const e of game.effects) if (e.kind === 'tracer') tracer(e, walls);
    viewmodel(game, unit);
    crosshair();
  }

  // ---------- geometry ----------

  // The sim tests one ray between centres, so an enemy edging past a corner blinks in and out.
  // Here: rays to their centre and both sides, then a short grace period once sight is lost.
  function enemyInView(game, walls, camera, u) {
    const seen = lastSeen.get(u.id) ?? -Infinity;
    if (Math.hypot(u.x - camera.x, u.y - camera.y) > SIGHT) return game.time - seen < LINGER;
    const a = Math.atan2(u.y - camera.y, u.x - camera.x) + Math.PI / 2;
    const dx = Math.cos(a) * u.r * 0.8;
    const dy = Math.sin(a) * u.r * 0.8;
    const map = { walls };
    const visible = [[0, 0], [dx, dy], [-dx, -dy]]
      .some(([ox, oy]) => hasLineOfSight(map, camera, { x: u.x + ox, y: u.y + oy }));
    if (visible) lastSeen.set(u.id, game.time);
    return visible || game.time - seen < LINGER;
  }

  // Nearest wall hit along a ray (slab test against each rectangle).
  function castRay(walls, ox, oy, dx, dy) {
    let best = null;
    const ix = dx === 0 ? 1e9 : 1 / dx;
    const iy = dy === 0 ? 1e9 : 1 / dy;
    for (const r of walls) {
      const tx1 = (r.x - ox) * ix;
      const tx2 = (r.x + r.w - ox) * ix;
      const ty1 = (r.y - oy) * iy;
      const ty2 = (r.y + r.h - oy) * iy;
      const txn = Math.min(tx1, tx2);
      const tyn = Math.min(ty1, ty2);
      const near = Math.max(txn, tyn);
      const far = Math.min(Math.max(tx1, tx2), Math.max(ty1, ty2));
      if (far < near || near <= 0.01 || (best && near >= best.t)) continue;
      const side = tyn > txn; // hit a horizontal (y) face
      const along = side ? ox + dx * near - r.x : oy + dy * near - r.y;
      const length = side ? r.w : r.h;
      best = { t: near, side, edge: along < 0.12 || along > length - 0.12 };
    }
    return best;
  }

  // Project a world point at a height to the screen; null if behind the camera.
  function project(x, y, h) {
    const rx = x - cam.x;
    const ry = y - cam.y;
    const c = Math.cos(cam.angle);
    const s = Math.sin(cam.angle);
    const z = rx * c + ry * s;
    if (z < 0.3) return null;
    return { x: W / 2 + ((-rx * s + ry * c) * cam.focal) / z, y: cam.horizon + ((EYE - h) * cam.focal) / z, z };
  }

  // Clip drawing to the columns where the sprite is nearer than the wall.
  function clipToVisible(s) {
    const half = (3 * cam.focal) / s.z; // generous: wide enough for the biggest sprite
    const from = Math.max(0, Math.floor((s.sx - half) / COLUMN));
    const to = Math.min(depth.length - 1, Math.ceil((s.sx + half) / COLUMN));
    ctx.beginPath();
    let any = false;
    let runStart = -1;
    for (let i = from; i <= to + 1; i++) {
      const open = i <= to && depth[i] > s.z;
      if (open && runStart < 0) runStart = i;
      if (!open && runStart >= 0) {
        ctx.rect(runStart * COLUMN, 0, (i - runStart) * COLUMN, H);
        runStart = -1;
        any = true;
      }
    }
    if (any) ctx.clip();
    return any;
  }

  // Turn a point on the canvas into a world position: the floor under the cursor, or just
  // short of the wall it lands on.
  function toWorld(clientX, clientY) {
    if (!cam) return null;
    const r = canvas.getBoundingClientRect();
    const px = clientX - r.left;
    const py = clientY - r.top;
    const offset = (px - W / 2) / cam.focal;
    const c = Math.cos(cam.angle);
    const s = Math.sin(cam.angle);
    const dx = c - offset * s;
    const dy = s + offset * c;
    const wall = depth[Math.min(depth.length - 1, Math.max(0, Math.floor(px / COLUMN)))];
    let t = py > cam.horizon + 1 ? (EYE * cam.focal) / (py - cam.horizon) : Infinity;
    t = Math.min(t, wall - 0.6, FAR);
    return { x: cam.x + dx * t, y: cam.y + dy * t };
  }

  // ---------- sprites ----------

  function figure(s, u, game) {
    const titan = u.kind === 'titan';
    const height = titan ? u.r * 3.2 : 1.8;
    const width = titan ? u.r * 1.4 : 0.75;
    const scale = cam.focal / s.z;
    const foot = cam.horizon + EYE * scale;
    const h = height * scale;
    const w = width * scale;
    const x = s.sx;
    const fog = Math.min(1, s.z / FAR);
    const color = u.color ?? (u.team === 'squad' ? SQUAD : ENEMY);
    ctx.globalAlpha = 1 - fog * 0.6;
    // Body and head.
    ctx.fillStyle = shadeHex(color, 0.55);
    ctx.fillRect(x - w / 2, foot - h * 0.78, w, h * 0.78);
    ctx.fillStyle = color;
    ctx.fillRect(x - w / 2, foot - h * 0.78, w * 0.5, h * 0.78);
    ctx.beginPath();
    ctx.arc(x, foot - h * 0.88, h * 0.11, 0, Math.PI * 2);
    ctx.fill();
    if (u.team === 'enemy' && !titan) {
      // Valorant-style red outline on spotted enemies.
      ctx.strokeStyle = color;
      ctx.lineWidth = Math.max(1, scale * 0.06);
      ctx.strokeRect(x - w / 2, foot - h * 0.78, w, h * 0.78);
    }
    // Muzzle flash when they fire.
    if (game.time - u.lastShotAt < 0.06 && !titan) {
      ctx.fillStyle = '#fff2b0';
      ctx.beginPath();
      ctx.arc(x, foot - h * 0.6, Math.max(2, scale * 0.15), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    // Name tag for teammates, health bar for enemies.
    const tagY = foot - h - Math.max(8, scale * 0.25);
    if (u.team === 'squad') {
      ctx.font = `700 ${clamp(scale * 0.3, 10, 14)}px system-ui, sans-serif`;
      ctx.textAlign = 'center';
      ctx.fillStyle = 'rgba(10,14,20,0.6)';
      const label = u.name.toUpperCase();
      const tw = ctx.measureText(label).width + 8;
      ctx.fillRect(x - tw / 2, tagY - 9, tw, 15);
      ctx.fillStyle = color;
      ctx.fillText(label, x, tagY + 2);
    } else {
      const bw = Math.max(18, w * 1.2);
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(x - bw / 2, tagY, bw, 3);
      ctx.fillStyle = color;
      ctx.fillRect(x - bw / 2, tagY, (bw * u.hp) / u.maxHp, 3);
    }
  }

  function body(s, e) {
    const scale = cam.focal / s.z;
    const foot = cam.horizon + EYE * scale;
    ctx.globalAlpha = Math.min(1, e.ttl / 2) * 0.8;
    ctx.fillStyle = shadeHex(e.color ?? (e.team === 'squad' ? SQUAD : ENEMY), 0.4);
    ctx.fillRect(s.sx - 0.9 * scale, foot - 0.3 * scale, 1.8 * scale, 0.3 * scale);
    ctx.globalAlpha = 1;
  }

  function spikeSprite(s, game) {
    const scale = cam.focal / s.z;
    const foot = cam.horizon + EYE * scale;
    const planted = game.spike.state === 'planted';
    const size = 0.5 * scale;
    ctx.fillStyle = planted ? '#ff6b3d' : '#ffb347';
    ctx.beginPath();
    ctx.moveTo(s.sx, foot - size * 2);
    ctx.lineTo(s.sx + size / 2, foot);
    ctx.lineTo(s.sx - size / 2, foot);
    ctx.closePath();
    ctx.fill();
    if (planted && Math.sin(game.time * (10 - game.spike.timer / 5)) > 0) {
      ctx.fillStyle = 'rgba(255,107,61,0.35)';
      ctx.beginPath();
      ctx.arc(s.sx, foot - size, size * 1.6, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function ping(s, game) {
    const scale = cam.focal / s.z;
    const foot = cam.horizon + EYE * scale;
    const age = (performance.now() - game.pointer.at) / 8000;
    ctx.globalAlpha = 1 - age * 0.7;
    ctx.strokeStyle = POINTER;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(s.sx, foot);
    ctx.lineTo(s.sx, foot - 2.6 * scale);
    ctx.stroke();
    const top = foot - 2.6 * scale;
    const d = clamp(0.35 * scale, 5, 14);
    ctx.fillStyle = POINTER;
    ctx.beginPath();
    ctx.moveTo(s.sx, top - d);
    ctx.lineTo(s.sx + d, top);
    ctx.lineTo(s.sx, top + d);
    ctx.lineTo(s.sx - d, top);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  function tracer(e, walls) {
    const mid = { x: (e.x1 + e.x2) / 2, y: (e.y1 + e.y2) / 2 };
    if (!hasLineOfSight({ walls }, cam, mid)) return;
    // Clip the segment to in front of the camera before projecting.
    const c = Math.cos(cam.angle);
    const s = Math.sin(cam.angle);
    const z1 = (e.x1 - cam.x) * c + (e.y1 - cam.y) * s;
    const z2 = (e.x2 - cam.x) * c + (e.y2 - cam.y) * s;
    if (z1 < 0.3 && z2 < 0.3) return;
    let a = { x: e.x1, y: e.y1 };
    let b = { x: e.x2, y: e.y2 };
    if (z1 < 0.3 || z2 < 0.3) {
      const t = (0.3 - z1) / (z2 - z1);
      const cut = { x: e.x1 + (e.x2 - e.x1) * t, y: e.y1 + (e.y2 - e.y1) * t };
      if (z1 < 0.3) a = cut;
      else b = cut;
    }
    const pa = project(a.x, a.y, 1.4);
    const pb = project(b.x, b.y, 1.3);
    if (!pa || !pb) return;
    ctx.strokeStyle = e.color ?? (e.team === 'squad' ? 'rgb(170,215,255)' : 'rgb(255,170,150)');
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(pa.x, pa.y);
    ctx.lineTo(pb.x, pb.y);
    ctx.stroke();
  }

  // ---------- HUD in the 3D view ----------

  function viewmodel(game, u) {
    const bob = u.moving ? Math.sin(game.time * 11) * 6 : 0;
    const kick = game.time - u.lastShotAt < 0.08 ? 10 : 0;
    const x = W * 0.7;
    const y = H - 10 + Math.abs(bob) + kick;
    const s = Math.min(W, H) / 600;
    ctx.save();
    ctx.translate(x + bob, y);
    ctx.scale(s, s);
    if (game.mode === 'titan') {
      // Twin blades.
      ctx.fillStyle = '#c9d2dc';
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(60, -200);
      ctx.lineTo(75, -195);
      ctx.lineTo(40, 0);
      ctx.fill();
    } else {
      ctx.fillStyle = '#23272f';
      ctx.beginPath();
      ctx.moveTo(-10, 0);
      ctx.lineTo(40, -150);
      ctx.lineTo(80, -150);
      ctx.lineTo(130, 0);
      ctx.fill();
      ctx.fillStyle = '#353b46';
      ctx.fillRect(48, -175, 26, 40);
      ctx.fillStyle = '#e7c9a9';
      ctx.fillRect(10, -40, 70, 40); // hand
      if (kick) {
        ctx.fillStyle = 'rgba(255,236,160,0.9)';
        ctx.beginPath();
        ctx.arc(60, -185, 22, 0, Math.PI * 2);
        ctx.fill();
      }
    }
    ctx.restore();
  }

  function crosshair() {
    const cx = W / 2;
    const cy = H / 2;
    ctx.strokeStyle = 'rgba(120, 255, 190, 0.95)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      ctx.moveTo(cx + dx * 4, cy + dy * 4);
      ctx.lineTo(cx + dx * 10, cy + dy * 10);
    }
    ctx.stroke();
  }

  return { draw, toWorld };
}

// A camera that follows a unit but eases its turns, since Jev can snap an agent's facing.
export function createCamera() {
  const cam = { x: 0, y: 0, angle: 0, unitId: null };
  return {
    update(u, dt) {
      if (cam.unitId !== u.id) {
        Object.assign(cam, { x: u.x, y: u.y, angle: u.facing, unitId: u.id });
        return cam;
      }
      cam.x = u.x;
      cam.y = u.y;
      const diff = ((u.facing - cam.angle + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
      cam.angle += diff * Math.min(1, dt * 9);
      return cam;
    },
  };
}

function mix(rgb, fog, shade, f) {
  const c = rgb.map((v, i) => Math.round(v * shade * (1 - f) + fog[i] * f));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

function shadeHex(hex, k) {
  const n = parseInt(hex.slice(1), 16);
  return `rgb(${((n >> 16) & 255) * k | 0},${((n >> 8) & 255) * k | 0},${(n & 255) * k | 0})`;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
