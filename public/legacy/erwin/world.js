// Maps, geometry, line of sight, and grid pathfinding. World units are metres.

const rect = (x, y, w, h) => ({ x, y, w, h });
const zone = (name, x, y, w, h, description, center) => ({
  name,
  description,
  rect: rect(x, y, w, h),
  center: center ?? { x: x + w / 2, y: y + h / 2 },
});
const BORDER = [rect(0, 0, 80, 1), rect(0, 55, 80, 1), rect(0, 0, 1, 56), rect(79, 0, 1, 56)];

export const MAPS = {
  // Valorant-style: attackers (the squad) start at the bottom, two bomb sites at the top.
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
      zone('Attacker Spawn', 1, 44, 78, 11, 'our starting area', { x: 40, y: 51 }),
    ],
    sites: ['A Site', 'B Site'],
    // Pushes go through a site's main lane; flanks come through the link (or whichever
    // option is farther from the rest of the squad).
    routes: {
      'A Site': { push: 'A Main', flank: ['A Link'] },
      'B Site': { push: 'B Main', flank: ['B Link'] },
      Mid: { flank: ['A Link', 'B Link'] },
    },
    spawns: {
      squad: [{ x: 36, y: 51 }, { x: 40, y: 52 }, { x: 44, y: 51 }, { x: 40, y: 48 }],
      // Defender bots start on their posts; rotators move toward callouts.
      bots: [
        { x: 10, y: 8, rotate: false },
        { x: 20, y: 17, rotate: true },
        { x: 40, y: 17, rotate: true },
        { x: 70, y: 8, rotate: false },
      ],
    },
  },

  // Commander Erwin's squad holds a district gate against waves of titans from the breach.
  titan: {
    id: 'titan',
    width: 80,
    height: 56,
    walls: [
      ...BORDER,
      ...[11, 23, 35].flatMap(y => [rect(5, y, 11, 6), rect(19, y, 10, 6), rect(51, y, 10, 6), rect(64, y, 11, 6)]),
      rect(1, 52, 32, 3), rect(47, 52, 32, 3), // the inner wall either side of the gate
    ],
    gate: rect(33, 52, 14, 1.5),
    zones: [
      zone('Gate', 29, 47, 22, 5, 'the gate we must protect', { x: 40, y: 49 }),
      zone('Plaza', 1, 41, 78, 11, 'the open square in front of the gate', { x: 40, y: 45 }),
      zone('Wall Breach', 1, 1, 78, 10, 'the breach in the outer wall where titans pour in', { x: 40, y: 5 }),
      zone('Main Street', 29, 11, 22, 30, 'the wide central avenue', { x: 40, y: 26 }),
      zone('West District', 1, 11, 28, 30, 'the western blocks of houses', { x: 17, y: 20 }),
      zone('East District', 51, 11, 28, 30, 'the eastern blocks of houses', { x: 63, y: 20 }),
    ],
    routes: {
      'Wall Breach': { flank: ['West District', 'East District'] },
      'Main Street': { flank: ['West District', 'East District'] },
    },
    spawns: {
      squad: [{ x: 36, y: 47 }, { x: 40, y: 48 }, { x: 44, y: 47 }, { x: 40, y: 45 }],
    },
  },
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
