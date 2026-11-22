// Push-optimal Sokoban solver — an entry for make.fun's sokoban-solver-01-run-20261121.
//
// The idea: a generated level is a hallway with 1-4 rooms off it, 3-4 boxes a room, and a box
// pushed out of a room into the hallway can never come back, so each room is an independent
// push-optimal problem and the level's optimum is the sum of its rooms' optima. Each room is
// solved with A* over pushes (a state is the boxes plus the player's reachable region), with
// an admissible heuristic — the minimum-cost matching of boxes to goals over walking distances
// — and two deadlock prunes that never cut a solvable state: dead squares (a box that can never
// be pushed onto any goal) and frozen 2x2 blocks of walls and boxes. A* with an admissible,
// consistent heuristic returns the push-optimal solution, so a solved room is solved in exactly
// its optimum number of pushes. If A* exhausts its work budget, greedy best-first search and
// then plain BFS over pushes are tried, so a hard room still yields a valid solution.
//
// Everything is budgeted by work (state expansions), never by the clock: no Date, no
// performance.now, no randomness anywhere, so two runs write byte-identical output. Node 22
// runs this file as it is (erasable TypeScript syntax only, no dependencies).
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** [dx, dy, step letter, push letter] in a fixed order: up, down, left, right. */
const DIRS: [number, number, string, string][] = [
  [0, -1, 'u', 'U'],
  [0, 1, 'd', 'D'],
  [-1, 0, 'l', 'L'],
  [1, 0, 'r', 'R'],
];

type Level = { w: number; h: number; wall: Uint8Array; goals: number[]; boxes: number[]; player: number };
type SearchResult = { pushes: number; moves: string } | null;
type Mode = 'astar' | 'greedy' | 'bfs';
/** The shared work budget for the whole run: expansions spent so far, and the cap. */
type Budget = { used: number; limit: number };

/** A level in XSB text (# wall, space floor, . goal, $ box, * box on a goal, @ player). */
function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const wall = new Uint8Array(w * h).fill(1);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = -1;
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      const i = y * w + x;
      if (ch === '#') continue;
      wall[i] = 0;
      if (ch === '.' || ch === '*' || ch === '+') goals.push(i);
      if (ch === '$' || ch === '*') boxes.push(i);
      if (ch === '@' || ch === '+') player = i;
    }
  });
  // A square on the outermost frame is a wall whatever it shows: nothing leaves the board.
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (x === 0 || y === 0 || x === w - 1 || y === h - 1) wall[y * w + x] = 1;
  return { w, h, wall, goals, boxes: boxes.sort((a, b) => a - b), player };
}

/** The squares from which a box alone can be pushed onto some goal (pulled back from the goals over open floor). */
function liveSquares(level: Level): Uint8Array {
  const { w, wall, goals } = level;
  const live = new Uint8Array(wall.length);
  const queue = [...goals];
  for (const g of goals) live[g] = 1;
  for (let qi = 0; qi < queue.length; qi++) {
    const x = queue[qi]!;
    for (const [dx, dy] of DIRS) {
      const d = dy * w + dx;
      const y = x - d;
      if (!wall[y] && !wall[y - d] && !live[y]) {
        live[y] = 1;
        queue.push(y);
      }
    }
  }
  return live;
}

/** The squares the player reaches from `from` with `occupied` (a box mask) in the way, marked in `seen` with `stamp`; the lowest. */
function reach(level: Level, occupied: Uint8Array, from: number, seen: Int32Array, stamp: number, stack: Int32Array): number {
  const { w, wall } = level;
  let low = from;
  let n = 0;
  stack[n++] = from;
  seen[from] = stamp;
  while (n > 0) {
    const p = stack[--n]!;
    if (p < low) low = p;
    const q0 = p - w;
    const q1 = p + w;
    const q2 = p - 1;
    const q3 = p + 1;
    if (wall[q0] === 0 && occupied[q0] === 0 && seen[q0] !== stamp) { seen[q0] = stamp; stack[n++] = q0; }
    if (wall[q1] === 0 && occupied[q1] === 0 && seen[q1] !== stamp) { seen[q1] = stamp; stack[n++] = q1; }
    if (wall[q2] === 0 && occupied[q2] === 0 && seen[q2] !== stamp) { seen[q2] = stamp; stack[n++] = q2; }
    if (wall[q3] === 0 && occupied[q3] === 0 && seen[q3] !== stamp) { seen[q3] = stamp; stack[n++] = q3; }
  }
  return low;
}

/** Whether the box just pushed to `t` sits in a frozen 2 x 2 block of walls and boxes with a box off its goal. */
function frozenBlock(level: Level, occupied: Uint8Array, goal: Uint8Array, t: number): boolean {
  const { w, wall } = level;
  for (const a of [t, t - 1, t - w, t - w - 1]) {
    const b = a + 1;
    const c = a + w;
    const d = c + 1;
    if (!(wall[a] || occupied[a]) || !(wall[b] || occupied[b]) || !(wall[c] || occupied[c]) || !(wall[d] || occupied[d])) continue;
    if ((occupied[a] && !goal[a]) || (occupied[b] && !goal[b]) || (occupied[c] && !goal[c]) || (occupied[d] && !goal[d])) return true;
  }
  return false;
}

/** Walking distances from each goal over open floor (ignoring boxes), one Int32Array per goal (-1 unreachable). */
function goalDistances(level: Level): Int32Array[] {
  const { w, wall, goals } = level;
  const out: Int32Array[] = [];
  for (const g of goals) {
    const d = new Int32Array(wall.length).fill(-1);
    const q = [g];
    d[g] = 0;
    for (let qi = 0; qi < q.length; qi++) {
      const p = q[qi]!;
      const nd = d[p]! + 1;
      const nb = [p - w, p + w, p - 1, p + 1];
      for (const x of nb) if (wall[x] === 0 && d[x] < 0) { d[x] = nd; q.push(x); }
    }
    out.push(d);
  }
  return out;
}

function popcount(x: number): number {
  let c = 0;
  while (x > 0) { c += x & 1; x >>= 1; }
  return c;
}

/**
 * The minimum-cost matching of boxes to goals over walking distances (DP over subsets; Infinity when no
 * assignment exists, which means the state is unsolvable). One push moves one box one square, so the
 * matched total can fall by at most 1 a push: this is an admissible, consistent heuristic.
 */
function matchingH(boxes: number[], dist: Int32Array[], n: number): number {
  const INF = 1e9;
  const full = (1 << n) - 1;
  const dp = new Float64Array(1 << n).fill(INF);
  dp[0] = 0;
  for (let mask = 0; mask <= full; mask++) {
    const i = popcount(mask);
    if (i >= n || dp[mask] === INF) continue;
    for (let g = 0; g < n; g++) {
      if (mask & (1 << g)) continue;
      const d = dist[g]![boxes[i]!]!;
      if (d < 0) continue;
      const nm = mask | (1 << g);
      const v = dp[mask]! + d;
      if (v < dp[nm]!) dp[nm] = v;
    }
  }
  return dp[full]!;
}

/** Weaker fallback heuristic for many boxes: each box to its nearest goal, summed (still admissible). */
function sumMinH(boxes: number[], dist: Int32Array[], n: number): number {
  let s = 0;
  for (const b of boxes) {
    let m = Infinity;
    for (let g = 0; g < n; g++) {
      const d = dist[g]![b]!;
      if (d >= 0 && d < m) m = d;
    }
    if (!Number.isFinite(m)) return Infinity;
    s += m;
  }
  return s;
}

/** The shortest walk from `from` to `to` around walls and boxes, in lower LURD letters (first direction first on ties). */
function walkTo(level: Level, occupied: Uint8Array, from: number, to: number): string {
  const { w, wall } = level;
  if (from === to) return '';
  const prev = new Int32Array(wall.length).fill(-1);
  const how: string[] = new Array(wall.length);
  const queue = [from];
  prev[from] = from;
  for (let qi = 0; qi < queue.length; qi++) {
    const p = queue[qi]!;
    if (p === to) break;
    for (const [dx, dy, letter] of DIRS) {
      const q = p + dy * w + dx;
      if (wall[q] || occupied[q] || prev[q] !== -1) continue;
      prev[q] = p;
      how[q] = letter;
      queue.push(q);
    }
  }
  if (prev[to] === -1) throw new Error('walkTo: the push square is out of reach');
  let s = '';
  for (let p = to; p !== from; p = prev[p]!) s = how[p]! + s;
  return s;
}

/** The square the player stands on after `moves` (LURD, the case aside) from `from` on a board `w` wide. */
function endOf(w: number, from: number, moves: string): number {
  let p = from;
  for (const ch of moves.toLowerCase()) p += ch === 'u' ? -w : ch === 'd' ? w : ch === 'l' ? -1 : 1;
  return p;
}

/**
 * Push-optimal (astar), greedy, or plain BFS search over pushes of one (sub-)level, bounded by `cap`
 * expansions and by the run's shared work budget. A state is the boxes' squares and the player's
 * reachable region (named by its lowest square). Returns null when the budget runs out or the level
 * has no solution under the prunes.
 */
function solvePush(level: Level, mode: Mode, budget: Budget, cap: number): SearchResult {
  const { w, wall, goals } = level;
  const size = wall.length;
  const n = level.boxes.length;
  const goal = new Uint8Array(size);
  for (const g of goals) goal[g] = 1;
  const live = liveSquares(level);
  for (const b of level.boxes) if (!live[b]) return null;
  const dist = goalDistances(level);
  const useMatch = n <= 6;
  const hOf = (boxes: number[]): number => (useMatch ? matchingH(boxes, dist, n) : sumMinH(boxes, dist, n));
  const isSolved = (boxes: number[]): boolean => {
    for (const b of boxes) if (!goal[b]) return false;
    return true;
  };
  if (isSolved(level.boxes)) return { pushes: 0, moves: '' };
  const h0 = hOf(level.boxes);
  if (!Number.isFinite(h0)) return null;

  const maxExp = Math.min(cap, budget.limit - budget.used);
  if (maxExp <= 0) return null;
  // A state's key: the region's lowest square and the boxes' squares, as digits in base `size` (exact
  // while size ** (boxes + 1) stays under 2 ** 53); otherwise a string key.
  const numericKey = Math.pow(size, n + 1) < Number.MAX_SAFE_INTEGER;
  const keyOf = (boxes: number[], low: number): number | string => {
    if (numericKey) {
      let k = low;
      for (const b of boxes) k = k * size + b;
      return k;
    }
    return low + ':' + boxes.join(',');
  };

  // The states in the order found: their boxes, the player's square, and the push that made them.
  const statesBoxes: number[][] = [level.boxes.slice()];
  const statesPlayer: number[] = [level.player];
  const statesKey: (number | string)[] = [];
  const parent: number[] = [-1];
  const pushFrom: number[] = [-1];
  const pushDir: number[] = [-1];
  const gScore: number[] = [0];
  const closed = new Map<number | string, number>();
  const occupied = new Uint8Array(size);
  const seen = new Int32Array(size);
  const mark = new Int32Array(size);
  const stack = new Int32Array(size);
  let stamp = 0;

  for (const b of level.boxes) occupied[b] = 1;
  const low0 = reach(level, occupied, level.player, seen, ++stamp, stack);
  for (const b of level.boxes) occupied[b] = 0;
  const k0 = keyOf(level.boxes, low0);
  statesKey.push(k0);
  closed.set(k0, 0);

  // The open list: a binary heap on [f, h, insertion order, state], f by mode (astar: g + h, greedy: h, bfs: g).
  const heap: [number, number, number, number][] = [];
  let seq = 0;
  const less = (a: [number, number, number, number], b: [number, number, number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] < b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: [number, number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!less(heap[i]!, heap[p]!)) break;
      [heap[i], heap[p]] = [heap[p]!, heap[i]!];
      i = p;
    }
  };
  const heapPop = (): [number, number, number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && less(heap[c + 1]!, heap[c]!)) c++;
        if (!less(heap[c]!, heap[i]!)) break;
        [heap[i], heap[c]] = [heap[c]!, heap[i]!];
        i = c;
      }
    }
    return top;
  };
  const fOf = (g: number, h: number): number => (mode === 'astar' ? g + h : mode === 'greedy' ? h : g);
  heapPush([fOf(0, h0), h0, seq++, 0]);

  // Rebuild the move string for a goal state: walk to each push's square, then push.
  const reconstruct = (goalIdx: number): SearchResult => {
    const path: number[] = [];
    for (let s = goalIdx; s > 0; s = parent[s]!) path.push(s);
    path.reverse();
    let moves = '';
    let player = level.player;
    const boxes = level.boxes.slice();
    for (const s of path) {
      const from = pushFrom[s]!;
      const dir = pushDir[s]!;
      const [dx, dy, , letter] = DIRS[dir]!;
      const d = dy * w + dx;
      for (const b of boxes) occupied[b] = 1;
      moves += walkTo(level, occupied, player, from - d);
      for (const b of boxes) occupied[b] = 0;
      moves += letter;
      player = from;
      const i = boxes.indexOf(from);
      boxes[i] = from + d;
      boxes.sort((a, b) => a - b);
    }
    return { pushes: path.length, moves };
  };

  let expanded = 0;
  while (heap.length > 0) {
    const [, , , s] = heapPop();
    if (closed.get(statesKey[s]!) !== gScore[s]) continue; // superseded by a cheaper path to the same state
    const boxes = statesBoxes[s]!;
    if (isSolved(boxes)) return reconstruct(s);
    if (expanded >= maxExp) break;
    expanded++;
    budget.used++;
    const g = gScore[s]!;
    for (const b of boxes) occupied[b] = 1;
    reach(level, occupied, statesPlayer[s]!, seen, ++stamp, stack);
    const here = stamp;
    for (let bi = 0; bi < boxes.length; bi++) {
      const b = boxes[bi]!;
      for (let dir = 0; dir < 4; dir++) {
        const [dx, dy] = DIRS[dir]!;
        const d = dy * w + dx;
        const t = b + d;
        if (seen[b - d] !== here || wall[t] || occupied[t] || !live[t]) continue;
        occupied[b] = 0;
        occupied[t] = 1;
        const frozen = frozenBlock(level, occupied, goal, t);
        let next: number[] | null = null;
        let key: number | string = -1;
        let h2 = Infinity;
        if (!frozen) {
          next = boxes.slice();
          next[bi] = t;
          next.sort((x, y) => x - y);
          key = keyOf(next, reach(level, occupied, b, mark, ++stamp, stack));
          h2 = hOf(next);
        }
        occupied[t] = 0;
        occupied[b] = 1;
        if (frozen || !Number.isFinite(h2) || next === null) continue;
        const g2 = g + 1;
        const prev = closed.get(key);
        if (prev !== undefined && g2 >= prev) continue;
        if (statesBoxes.length >= 600_000) return null; // stored-state safety cap
        closed.set(key, g2);
        statesBoxes.push(next);
        statesPlayer.push(b);
        statesKey.push(key);
        parent.push(s);
        pushFrom.push(b);
        pushDir.push(dir);
        gScore.push(g2);
        const s2 = statesBoxes.length - 1;
        if (mode !== 'astar' && isSolved(next)) return reconstruct(s2);
        heapPush([fOf(g2, h2), h2, seq++, s2]);
      }
    }
    for (const b of boxes) occupied[b] = 0;
  }
  return null;
}

/**
 * The level's rooms: cut the dead squares of the player's row (the hallway: a box there reaches no goal)
 * out of the floor, and each part left that holds a box is a room, its squares, boxes and goals. Null when
 * some part holds more or fewer boxes than goals, or a box starts in the hallway: then the level is no set
 * of rooms.
 */
function roomsOf(level: Level): { squares: number[]; boxes: number[]; goals: number[]; done?: boolean }[] | null {
  const { w, wall, goals, boxes, player } = level;
  const live = liveSquares(level);
  const row = Math.floor(player / w);
  const cut = new Uint8Array(wall.length);
  for (let i = row * w; i < (row + 1) * w; i++) if (!wall[i] && !live[i]) cut[i] = 1;
  if (boxes.some((b) => cut[b])) return null;
  const part = new Int32Array(wall.length).fill(-1);
  const rooms: { squares: number[]; boxes: number[]; goals: number[]; done?: boolean }[] = [];
  for (let s = 0; s < wall.length; s++) {
    if (wall[s] || cut[s] || part[s] >= 0) continue;
    const squares = [s];
    part[s] = rooms.length;
    for (let i = 0; i < squares.length; i++) {
      for (const [dx, dy] of DIRS) {
        const q = squares[i]! + dy * w + dx;
        if (!wall[q] && !cut[q] && part[q] < 0) {
          part[q] = rooms.length;
          squares.push(q);
        }
      }
    }
    rooms.push({ squares, boxes: [], goals: [] });
  }
  for (const b of boxes) rooms[part[b]!]!.boxes.push(b);
  for (const g of goals) if (part[g]! >= 0) rooms[part[g]!]!.goals.push(g);
  if (goals.some((g) => part[g]! < 0) || rooms.some((r) => r.boxes.length !== r.goals.length)) return null;
  return rooms.filter((r) => r.boxes.length > 0);
}

/** One room's push-optimal solution: A* first, greedy best-first, then BFS, each work-bounded. */
function solveRoom(level: Level, budget: Budget): SearchResult {
  return (
    solvePush(level, 'astar', budget, 250_000) ??
    solvePush(level, 'greedy', budget, 200_000) ??
    solvePush(level, 'bfs', budget, 150_000)
  );
}

/**
 * The level solved room by room: each room's push-optimal solution in turn, the other rooms' boxes standing
 * as walls (on their goals once their room is done), the player walking on from where the last room left
 * it. A box never leaves its room, so the rooms' optima add up to the level's.
 */
function solveByRooms(level: Level, budget: Budget): SearchResult {
  const rooms = roomsOf(level);
  if (rooms === null) return null;
  let player = level.player;
  let pushes = 0;
  let moves = '';
  for (const room of rooms) {
    const wall = level.wall.slice();
    for (const other of rooms) if (other !== room) for (const b of other.done ? other.goals : other.boxes) wall[b] = 1;
    const sub: Level = {
      w: level.w,
      h: level.h,
      wall,
      goals: room.goals.slice().sort((a, b) => a - b),
      boxes: room.boxes.slice().sort((a, b) => a - b),
      player,
    };
    const solved = solveRoom(sub, budget);
    if (solved === null) return null;
    pushes += solved.pushes;
    moves += solved.moves;
    player = endOf(level.w, player, solved.moves);
    room.done = true;
  }
  return { pushes, moves };
}

/** The moves for a level: room by room, or a whole-level greedy attempt when it is no set of rooms. */
function solveLevel(text: string, budget: Budget): string {
  const level = parseLevel(text);
  const byRooms = solveByRooms(level, budget);
  if (byRooms !== null) return byRooms.moves;
  const whole = solvePush(level, 'greedy', budget, 50_000);
  return whole !== null ? whole.moves : '';
}

const budget: Budget = { used: 0, limit: 1_500_000 };
for (const id of readdirSync(I).sort()) {
  let text: string;
  try {
    text = readFileSync(join(I, id, 'level.txt'), 'utf8');
  } catch {
    continue;
  }
  let moves = '';
  try {
    moves = solveLevel(text, budget);
  } catch {
    moves = '';
  }
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
