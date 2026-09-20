// Maps, geometry, line of sight, and grid pathfinding. World units are metres.

const rect = (x, y, w, h) => ({ x, y, w, h });
const zone = (name, x, y, w, h, description, center) => ({
  name,
  description,
  rect: rect(x, y, w, h),
  center: center ?? { x: x + w / 2, y: y + h / 2 },
});
const BORDER = [rect(0, 0, 80, 1), rect(0, 55, 80, 1), rect(0, 0, 1, 56), rect(79, 0, 1, 56)];

// A layout this size is unreadable written as a wall list, and the walls are not the
// interesting part anyway — the callouts are. So a generated map is authored as the open
// space: every area a player can stand in, named the way players name it, and everything
// else is solid. Walls fall out as the complement, merged into as few rectangles as the
// shape allows so line-of-sight stays cheap.
function rectsFromMask(mask, w, h) {
  const used = new Uint8Array(w * h);
  const out = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x] || used[y * w + x]) continue;
      let rw = 0;
      while (x + rw < w && mask[y * w + x + rw] && !used[y * w + x + rw]) rw++;
      let rh = 1;
      grow: while (y + rh < h) {
        for (let k = 0; k < rw; k++) {
          if (!mask[(y + rh) * w + x + k] || used[(y + rh) * w + x + k]) break grow;
        }
        rh++;
      }
      for (let yy = y; yy < y + rh; yy++) for (let xx = x; xx < x + rw; xx++) used[yy * w + xx] = 1;
      out.push(rect(x, y, rw, rh));
    }
  }
  return out;
}

function carved({ areas, ...rest }) {
  const { width, height } = rest;
  const mask = new Uint8Array(width * height).fill(1);
  for (const [, x, y, w, h] of areas) {
    for (let yy = Math.max(0, y); yy < Math.min(height, y + h); yy++) {
      for (let xx = Math.max(0, x); xx < Math.min(width, x + w); xx++) mask[yy * width + xx] = 0;
    }
  }
  return {
    ...rest,
    walls: rectsFromMask(mask, width, height),
    zones: areas.map(([name, x, y, w, h, description, center]) => zone(name, x, y, w, h, description, center)),
  };
}

export const MAPS = {
  // Valorant-style: attackers start at the bottom, two bomb sites at the top.
  tactical: {
    id: 'tactical',
    width: 80,
    height: 56,
    walls: [
      ...BORDER,
      rect(24, 7, 32, 7), // block between defender spawn and the links
      rect(14, 21, 18, 23), // between A Main and Mid
      rect(48, 21, 18, 23), // between Mid and B Main
      rect(1, 20, 5, 2), rect(74, 20, 5, 2), // site chokes
      rect(8, 10, 3, 3), rect(15, 14, 2, 4), rect(4, 16, 3, 2), // A site cover
      rect(69, 10, 3, 3), rect(63, 14, 2, 4), rect(73, 16, 3, 2), // B site cover
      rect(37, 28, 6, 2), // mid cover
      rect(6, 32, 2, 3), rect(72, 32, 2, 3), // lane cover
      rect(20, 48, 4, 2), rect(56, 48, 4, 2), // lobby cover
    ],
    // First match wins in zoneAt, so specific zones come before the ones they overlap.
    zones: [
      zone('Defender Spawn', 30, 1, 20, 6, 'where the defenders start'),
      zone('A Site', 1, 6, 23, 15, 'the A bomb site', { x: 12, y: 14 }),
      zone('B Site', 56, 6, 23, 15, 'the B bomb site', { x: 67, y: 14 }),
      zone('Top Hall', 1, 1, 78, 6, 'the defenders\' rotation hallway behind both sites', { x: 12, y: 3.5 }),
      zone('A Link', 24, 14, 8, 7, 'the connector between Mid and A Site'),
      zone('B Link', 48, 14, 8, 7, 'the connector between Mid and B Site'),
      zone('Mid', 32, 14, 16, 30, 'the middle of the map', { x: 40, y: 34 }),
      zone('A Main', 1, 21, 13, 23, 'the long corridor into A Site', { x: 10, y: 30 }),
      zone('B Main', 66, 21, 13, 23, 'the long corridor into B Site', { x: 70, y: 30 }),
      zone('Attacker Spawn', 1, 44, 78, 11, 'where the attackers start', { x: 40, y: 51 }),
    ],
    sites: ['A Site', 'B Site'],
    // Pushes go through a site's main lane; flanks come through the link (or whichever
    // option is farther from the rest of the squad).
    routes: {
      'A Site': { push: 'A Main', flank: ['A Link'] },
      'B Site': { push: 'B Main', flank: ['B Link'] },
      Mid: { flank: ['A Link', 'B Link'] },
    },
    rotateSpots: [{ x: 16, y: 10 }, { x: 64, y: 10 }],
    // Named posts the rest of the game refers to by role rather than by literal name, so a
    // second map doesn't need every caller to know its callouts.
    home: { attack: 'Attacker Spawn', defend: 'Defender Spawn' },
    fallback: 'Top Hall',
    patrol: ['A Site', 'A Link', 'Mid', 'B Site'],
    spawns: {
      attack: [{ x: 34, y: 51 }, { x: 38, y: 52 }, { x: 42, y: 52 }, { x: 46, y: 51 }, { x: 40, y: 48 }],
      // Defenders start on their posts. Bot rotators move to whichever site a callout threatens.
      defend: [
        { x: 10, y: 8, rotate: false },
        { x: 20, y: 16, rotate: true },
        { x: 40, y: 16, rotate: true },
        { x: 60, y: 16, rotate: true },
        { x: 70, y: 8, rotate: false },
      ],
    },
  },

  // Dust II, rebuilt as layout rather than art: the callouts, their adjacency and roughly
  // their proportions. The real map is about 4500 Hammer units across, which at Source's
  // 1 unit ≈ 1.9 cm is ~86 m, so it fits this engine's metre grid at close to true scale and
  // the existing movement speeds and round timer carry over unchanged.
  //
  // Sightlines are what make it play like Dust II: Long A is a 34 m corridor, Mid runs the
  // height of the map, and both sites are reachable two ways so a commander has a real
  // rotation problem. Areas are listed specific-first, because zoneAt takes the first match.
  dust2: carved({
    id: 'dust2',
    width: 88,
    height: 88,
    areas: [
      ['Pit', 74, 22, 10, 10, 'the sunken corner of A site at the end of Long'],
      ['Mid Doors', 40, 38, 10, 6, 'the double doors partway down Mid'],
      ['Window', 24, 18, 10, 10, 'the window room overlooking B from the CT side'],
      ['B Doors', 24, 12, 12, 8, 'the doors from CT spawn into B'],
      ['Long Doors', 66, 56, 8, 8, 'the double doors from T side into Long A'],
      ['Catwalk', 48, 30, 14, 10, 'the raised walkway from Mid up to A short'],
      ['A Short', 58, 26, 10, 8, 'the short route into A site from Catwalk'],
      ['Top Mid', 40, 14, 10, 14, 'the CT end of Mid'],
      ['CT Mid', 54, 8, 12, 12, 'the connector from CT spawn across to A'],
      ['A Site', 60, 12, 22, 18, 'the A bomb site', { x: 70, y: 21 }],
      ['B Site', 6, 8, 20, 16, 'the B bomb site', { x: 15, y: 16 }],
      ['CT Spawn', 34, 4, 22, 12, 'where the defenders start'],
      ['Long A', 70, 28, 14, 34, 'the long corridor up the east side into A site', { x: 77, y: 46 }],
      ['Mid', 40, 26, 10, 46, 'the middle of the map, top to bottom', { x: 45, y: 52 }],
      ['B Tunnels', 12, 22, 14, 36, 'the tunnels running up the west side into B', { x: 19, y: 42 }],
      ['Lower Tunnels', 20, 56, 18, 18, 'the tunnel mouth out of T spawn toward B'],
      ['Outside Long', 58, 62, 18, 10, 'the open ground between T spawn and Long doors'],
      ['T Spawn', 34, 70, 28, 14, 'where the attackers start', { x: 48, y: 77 }],
    ],
    sites: ['A Site', 'B Site'],
    routes: {
      'A Site': { push: 'Long A', flank: ['A Short', 'CT Mid'] },
      'B Site': { push: 'B Tunnels', flank: ['B Doors'] },
      Mid: { flank: ['Catwalk', 'Top Mid'] },
    },
    spawns: {
      // One post per agent: the squad is as big as the map says, so both maps field five.
      attack: [{ x: 40, y: 75 }, { x: 44, y: 77 }, { x: 48, y: 79 }, { x: 52, y: 77 }, { x: 48, y: 74 }],
      // One anchor per site, three rotators on the CT-side connectors between them.
      defend: [
        { x: 70, y: 21, rotate: false },
        { x: 45, y: 11, rotate: true },
        { x: 59, y: 14, rotate: true },
        { x: 45, y: 22, rotate: true },
        { x: 15, y: 16, rotate: false },
      ],
    },
    rotateSpots: [{ x: 15, y: 16 }, { x: 70, y: 21 }],
    home: { attack: 'T Spawn', defend: 'CT Spawn' },
    fallback: 'CT Spawn',
    patrol: ['A Site', 'A Short', 'Mid', 'B Site'],
  }),
};

export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const angleTo = (a, b) => Math.atan2(b.y - a.y, b.x - a.x);
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export function angleDiff(a, b) {
  const d = Math.abs(a - b) % (Math.PI * 2);
  return d > Math.PI ? Math.PI * 2 - d : d;
}

export function zoneAt(map, point) {
  const inside = map.zones.find(({ rect: r }) =>
    point.x >= r.x && point.x <= r.x + r.w && point.y >= r.y && point.y <= r.y + r.h);
  return inside ?? map.zones.reduce((best, z) => (dist(z.center, point) < dist(best.center, point) ? z : best));
}

export const zoneByName = (map, name) => map.zones.find(z => z.name === name);

// Liang–Barsky segment/rectangle intersection.
function segmentHitsRect(x1, y1, x2, y2, r) {
  let t0 = 0;
  let t1 = 1;
  const dx = x2 - x1;
  const dy = y2 - y1;
  const p = [-dx, dx, -dy, dy];
  const q = [x1 - r.x, r.x + r.w - x1, y1 - r.y, r.y + r.h - y1];
  for (let i = 0; i < 4; i++) {
    if (p[i] === 0) {
      if (q[i] < 0) return false;
      continue;
    }
    const t = q[i] / p[i];
    if (p[i] < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
  }
  return true;
}

export const hasLineOfSight = (map, a, b) => !map.walls.some(w => segmentHitsRect(a.x, a.y, b.x, b.y, w));

// Would a unit of radius r standing here be inside a wall? The same closest-point test the
// collision pass uses to push one back out, asked before the step instead of after it.
export const blockedAt = (map, x, y, r) => map.walls.some(w =>
  Math.hypot(x - clamp(x, w.x, w.x + w.w), y - clamp(y, w.y, w.y + w.h)) < r);

// Nearest wall on a ray. Shared by first-person drawing and crosshair targeting.
// Direction can be unnormalised (the renderer needs perpendicular depth).
export function castRay(walls, ox, oy, dx, dy) {
  let best = null;
  for (const r of walls) {
    if (dx === 0 && (ox < r.x || ox > r.x + r.w)) continue;
    if (dy === 0 && (oy < r.y || oy > r.y + r.h)) continue;
    const tx1 = dx === 0 ? -Infinity : (r.x - ox) / dx;
    const tx2 = dx === 0 ? Infinity : (r.x + r.w - ox) / dx;
    const ty1 = dy === 0 ? -Infinity : (r.y - oy) / dy;
    const ty2 = dy === 0 ? Infinity : (r.y + r.h - oy) / dy;
    const txn = Math.min(tx1, tx2), tyn = Math.min(ty1, ty2);
    const near = Math.max(txn, tyn);
    const far = Math.min(Math.max(tx1, tx2), Math.max(ty1, ty2));
    if (far < near || near <= 0.01 || (best && near >= best.t)) continue;
    const side = tyn > txn;
    const along = side ? ox + dx * near - r.x : oy + dy * near - r.y;
    const length = side ? r.w : r.h;
    best = { t: near, side, edge: along < 0.12 || along > length - 0.12 };
  }
  return best;
}

// ---------- grid pathfinding ----------

export function buildGrid(map, clearance) {
  const cols = map.width;
  const rows = map.height;
  const blocked = new Uint8Array(cols * rows);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = col + 0.5;
      const y = row + 0.5;
      blocked[row * cols + col] = map.walls.some(w =>
        x > w.x - clearance && x < w.x + w.w + clearance && y > w.y - clearance && y < w.y + w.h + clearance) ? 1 : 0;
    }
  }
  return { cols, rows, blocked };
}

const cellOf = (grid, p) =>
  clamp(Math.floor(p.y), 0, grid.rows - 1) * grid.cols + clamp(Math.floor(p.x), 0, grid.cols - 1);
const centerOf = (grid, cell) => ({ x: (cell % grid.cols) + 0.5, y: Math.floor(cell / grid.cols) + 0.5 });

function nearestOpenCell(grid, p) {
  const start = cellOf(grid, p);
  if (!grid.blocked[start]) return start;
  const sc = start % grid.cols;
  const sr = Math.floor(start / grid.cols);
  for (let radius = 1; radius < 12; radius++) {
    let best = -1;
    let bestDistance = Infinity;
    for (let dr = -radius; dr <= radius; dr++) {
      for (let dc = -radius; dc <= radius; dc++) {
        if (Math.max(Math.abs(dr), Math.abs(dc)) !== radius) continue;
        const r = sr + dr;
        const c = sc + dc;
        if (r < 0 || c < 0 || r >= grid.rows || c >= grid.cols || grid.blocked[r * grid.cols + c]) continue;
        const d = Math.hypot(c + 0.5 - p.x, r + 0.5 - p.y);
        if (d < bestDistance) {
          bestDistance = d;
          best = r * grid.cols + c;
        }
      }
    }
    if (best >= 0) return best;
  }
  return -1;
}

export function nearestOpenPoint(grid, p) {
  const cell = nearestOpenCell(grid, p);
  if (cell < 0) return p;
  return grid.blocked[cellOf(grid, p)] ? centerOf(grid, cell) : p;
}

export function walkableLine(grid, a, b) {
  const steps = Math.ceil(dist(a, b) / 0.4);
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    if (grid.blocked[cellOf(grid, { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t })]) return false;
  }
  return true;
}

const NEIGHBOURS = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2]];

// A* over the grid, then string-pulled into as few straight segments as possible.
export function findPath(grid, from, to) {
  const start = nearestOpenCell(grid, from);
  const goal = nearestOpenCell(grid, to);
  if (start < 0 || goal < 0) return [];
  const { cols, rows, blocked } = grid;
  const gx = goal % cols;
  const gy = Math.floor(goal / cols);
  const g = new Float32Array(cols * rows).fill(Infinity);
  const parent = new Int32Array(cols * rows).fill(-1);
  const closed = new Uint8Array(cols * rows);
  const heap = new MinHeap();
  const h = cell => {
    const dx = Math.abs((cell % cols) - gx);
    const dy = Math.abs(Math.floor(cell / cols) - gy);
    return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
  };
  g[start] = 0;
  heap.push(start, h(start));
  while (heap.size) {
    const cell = heap.pop();
    if (cell === goal) break;
    if (closed[cell]) continue;
    closed[cell] = 1;
    const c = cell % cols;
    const r = Math.floor(cell / cols);
    for (const [dc, dr, cost] of NEIGHBOURS) {
      const nc = c + dc;
      const nr = r + dr;
      if (nc < 0 || nr < 0 || nc >= cols || nr >= rows) continue;
      const next = nr * cols + nc;
      if (blocked[next] || closed[next]) continue;
      if (dc && dr && (blocked[r * cols + nc] || blocked[nr * cols + c])) continue; // no corner cutting
      const score = g[cell] + cost;
      if (score < g[next]) {
        g[next] = score;
        parent[next] = cell;
        heap.push(next, score + h(next));
      }
    }
  }
  if (start !== goal && parent[goal] < 0) return [];

  const cells = [];
  for (let cell = goal; cell !== -1 && cell !== start; cell = parent[cell]) cells.push(cell);
  const points = cells.reverse().map(cell => centerOf(grid, cell));
  const end = blocked[cellOf(grid, to)] ? centerOf(grid, goal) : to;
  points.push(end);

  const smoothed = [];
  let anchor = from;
  let i = 0;
  while (i < points.length) {
    let far = i;
    for (let j = points.length - 1; j > i; j--) {
      if (walkableLine(grid, anchor, points[j])) {
        far = j;
        break;
      }
    }
    smoothed.push(points[far]);
    anchor = points[far];
    i = far + 1;
  }
  return smoothed;
}

class MinHeap {
  items = [];
  priorities = [];
  get size() {
    return this.items.length;
  }
  push(item, priority) {
    const { items, priorities } = this;
    items.push(item);
    priorities.push(priority);
    let i = items.length - 1;
    while (i > 0) {
      const up = (i - 1) >> 1;
      if (priorities[up] <= priorities[i]) break;
      [items[up], items[i]] = [items[i], items[up]];
      [priorities[up], priorities[i]] = [priorities[i], priorities[up]];
      i = up;
    }
  }
  pop() {
    const { items, priorities } = this;
    const top = items[0];
    const lastItem = items.pop();
    const lastPriority = priorities.pop();
    if (items.length) {
      items[0] = lastItem;
      priorities[0] = lastPriority;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < items.length && priorities[l] < priorities[m]) m = l;
        if (r < items.length && priorities[r] < priorities[m]) m = r;
        if (m === i) break;
        [items[m], items[i]] = [items[i], items[m]];
        [priorities[m], priorities[i]] = [priorities[i], priorities[m]];
        i = m;
      }
    }
    return top;
  }
}
