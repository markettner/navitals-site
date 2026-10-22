// A line from another planner, turned into a plan of our own: its stops, and the shaping points
// that make BRouter ride it as drawn (NavitalsKit's TrackFit.swift, decided 2026-10-22).
//
// Komoot, Strava, Garmin Connect and Ride with GPS export a line and never the points it was shaped
// by. Followed as a line, such a route could only be changed with the pen, and it imported
// differently from one planned here. Fitted, it is a plan like any other: stops to move, a sport to
// change, and a GPX that comes back as it went out.
//
// Route through the stops alone; wherever the route misses the track, put a shaping point in the
// middle of what it missed, and route again until it follows. Then take each shaping point out
// again unless the route needs it. Where BRouter will not go even through a shaping point (a ferry,
// a track across a lake, a way missing from the tiles), the fit gives up, and the caller follows
// the line as it is.

import { distance, length, type Coordinate } from './geodesy';
import { thinned } from './gpxReader';
import type { Waypoint } from './route';

/** The route follows the track where it runs within this of it: a lane, a GPS wobble. */
export const tolerance = 30;
/** A miss shorter than this is a corner cut or a junction, not another way. */
export const shortestMiss = 50;
/** Rounds of adding shaping points. Each round mends every miss at once, and a miss mended in the
 *  middle leaves at most a shorter one either side. */
export const rounds = 8;
/** Rounds in a row that may follow no more of the track before the fit gives up: a request each,
 *  where BRouter won't go through the shaping points at all (a lake, a ferry). */
export const stalledRounds = 2;
/** How much of the track the route must follow, and of the route the track, to be the same. */
export const leastCoverage = 0.97;
/** How much longer or shorter than the track the route may be. */
export const lengthTolerance = 0.03;
/** The track is thinned to this many points, the shape without a recording's one-second fixes, and
 *  then measured every `spacing` metres, so a miss along a straight is seen too. */
export const workPoints = 2000;
export const spacing = 20;
/** Room for the stops beside them in a GPX plan (`mostMarkedPoints`). */
export const mostShapingPoints = 150;

/** Routes through the waypoints, in order, and answers with the line. */
export type Router = (waypoints: Waypoint[]) => Promise<Coordinate[]>;

export interface Fit {
  /** The stops and shaping points, in the order the track passes them. */
  waypoints: Waypoint[];
  /** BRouter's line through them. */
  line: Coordinate[];
  /** The share of the track the line follows. */
  coverage: number;
  /** How many times the fit asked for a route. */
  routings: number;
}

export interface FitOptions {
  /** Whether the fit may route this many times more. Once it may not, a fit still adding shaping
   *  points gives up, and one taking them out keeps the rest. */
  mayRoute?: (routings: number) => boolean;
  signal?: AbortSignal;
  trace?: (line: string) => void;
}

/** The plan through `stops` that rides `track`, or null when there is none within the budget.
 *
 *  `stops` are the track's start, the places it passes in order, and its finish. A first routing
 *  that fails throws: there is no route here, and no fitting will change that. */
export async function fitTrack(track: Coordinate[], stops: Waypoint[], route: Router, options: FitOptions = {}): Promise<Fit | null> {
  const { signal, trace } = options;
  const mayRoute = options.mayRoute ?? (() => true);
  const work = densified(thinned(track, workPoints));
  if (work.length < 2 || stops.length < 2) return null;
  const along = alongOf(work);
  const total = along.at(-1)!;
  if (!(total > 0)) return null;

  // Where on the track each stop is: the ends at its ends, the rest in order between them.
  const anchors: { index: number; waypoint: Waypoint }[] = [{ index: 0, waypoint: stops[0] }];
  for (const stop of stops.slice(1, -1)) anchors.push({ index: nearestVertex(stop, work, anchors.at(-1)!.index), waypoint: stop });
  anchors.push({ index: work.length - 1, waypoint: stops.at(-1)! });

  let shaping = new Set<number>();
  let routings = 0;
  const waypoints = (shaping: Set<number>): Waypoint[] => {
    const bends = [...shaping].map((index) => ({
      index, order: 1, waypoint: { latitude: work[index].latitude, longitude: work[index].longitude, kind: 'shaping' as const },
    }));
    // A stop and a bend at one vertex: the stop first, it is what the rider is going to.
    return [...anchors.map(({ index, waypoint }) => ({ index, order: 0, waypoint })), ...bends]
      .sort((a, b) => a.index - b.index || a.order - b.order)
      .map((entry) => entry.waypoint);
  };
  const routed = (shaping: Set<number>) => {
    routings++;
    return route(waypoints(shaping));
  };
  /** A routing that failed for another reason than being cancelled. */
  const failed = (error: unknown) => {
    if (signal?.aborted) throw error;
    trace?.(`routing failed: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  };

  let line = await routed(shaping);
  let best = 0, stalled = 0;
  for (let round = 0; round < rounds; round++) {
    const missed = misses(work, along, line);
    trace?.(describe(work, along, line, missed, shaping.size));
    const followed = coverage(work, along, line);
    stalled = followed > best ? 0 : stalled + 1;
    best = Math.max(best, followed);
    if (stalled >= stalledRounds) break;
    let added = false;
    for (const miss of missed) {
      if (shaping.size >= mostShapingPoints) break;
      const index = middle(miss, along, shaping, anchors);
      if (index === null) continue;
      shaping.add(index);
      added = true;
    }
    if (!added || !mayRoute(1)) break;
    signal?.throwIfAborted();
    const next = await routed(shaping).catch(failed);
    if (!next) return null;
    line = next;
  }
  if (!fits(work, along, line)) {
    trace?.(`gave up: ${describe(work, along, line, misses(work, along, line), shaping.size)}`);
    return null;
  }

  // The fewest that do: each left out, and kept out when the route still follows the track from
  // the point before it to the point after. The app tries them one at a time; that is a request
  // each, and brouter.de takes 12 to 16 a minute. BRouter routes each stretch between two
  // neighbouring points on its own, so points with a kept point between them can be left out in
  // one routing and each judged on its own stretch: every other one, then the rest. The points a
  // batch leaves out are out in the next batch's routing too, so only the last batch, when it keeps
  // some, needs routing again: until then the plan is the last one routed whole.
  let fewer = shaping;
  const tried = new Set<number>();
  // A batch goes ahead only with a routing to spare for that.
  while ([...fewer].some((index) => !tried.has(index)) && mayRoute(2)) {
    signal?.throwIfAborted();
    const order = [...anchors.map((anchor) => anchor.index), ...fewer].sort((a, b) => a - b);
    const picked = new Set<number>();
    order.forEach((index, k) => {
      if (fewer.has(index) && !tried.has(index) && !picked.has(order[k - 1])) picked.add(index);
    });
    for (const index of picked) tried.add(index);
    // A routing that fails here ends the tidying: the points it would have tried stay.
    const candidate = await routed(without(fewer, picked)).catch(failed);
    if (!candidate) break;
    // Judged on the line without them all: a point's neighbours are kept points either way.
    const missed = misses(work, along, candidate);
    const left = new Set([...picked].filter((index) => {
      const k = order.indexOf(index);
      const [before, after] = [order[k - 1], order[k + 1]];
      return !missed.some(([from, to]) => from <= after && to >= before);
    }));
    trace?.(`left out ${left.size} of ${picked.size} shaping points`);
    if (left.size) fewer = without(fewer, left);
    if (left.size === picked.size && Math.abs(length(candidate) / total - 1) <= lengthTolerance) {
      shaping = fewer;
      line = candidate;
    }
  }
  if (fewer !== shaping && mayRoute(1)) {
    signal?.throwIfAborted();
    const next = await routed(fewer).catch(failed);
    if (next && fits(work, along, next)) {
      shaping = fewer;
      line = next;
    }
  }
  if (!fits(work, along, line)) return null;
  return { waypoints: waypoints(shaping), line, coverage: coverage(work, along, line), routings };
}

function without(points: Set<number>, left: Set<number>): Set<number> {
  return new Set([...points].filter((index) => !left.has(index)));
}

// ---------- Measuring ----------

function describe(work: Coordinate[], along: number[], line: Coordinate[], missed: [number, number][], shaping: number): string {
  const dense = densified(line);
  const percent = (share: number) => Math.floor(share * 1000) / 10;
  return `${shaping} shaping, line ${Math.round(length(line))} of ${Math.round(along.at(-1)!)} m, `
    + `track ${percent(coverage(work, along, line))}% / line ${percent(coverage(dense, alongOf(dense), work))}% followed, `
    + `misses [${missed.map(([from, to]) => Math.round(along[to] - along[from])).join(', ')}] m`;
}

/** Whether the line and the track are the same route: each follows the other, and their lengths
 *  agree. */
export function fits(work: Coordinate[], along: number[], line: Coordinate[]): boolean {
  if (line.length < 2) return false;
  if (Math.abs(length(line) / along.at(-1)! - 1) > lengthTolerance) return false;
  const dense = densified(line);
  return coverage(work, along, line) >= leastCoverage && coverage(dense, alongOf(dense), work) >= leastCoverage;
}

/** The share of `track`'s length within `tolerance` of `line`. */
export function coverage(track: Coordinate[], along: number[], line: Coordinate[]): number {
  const total = along.at(-1) ?? 0;
  if (!(total > 0)) return 0;
  const off = new Grid(line).misses(track);
  let missed = 0;
  for (let i = 0; i + 1 < track.length; i++) if (off[i] && off[i + 1]) missed += along[i + 1] - along[i];
  return 1 - missed / total;
}

/** The stretches of the track, as first and last vertex, that the line misses for `shortestMiss`
 *  or more. */
export function misses(track: Coordinate[], along: number[], line: Coordinate[]): [number, number][] {
  const off = new Grid(line).misses(track);
  const result: [number, number][] = [];
  let start: number | null = null;
  for (let i = 0; i < track.length; i++) {
    if (off[i]) {
      start ??= i;
      continue;
    }
    if (start !== null && along[i - 1] - along[start] >= shortestMiss) result.push([start, i - 1]);
    start = null;
  }
  if (start !== null && along[track.length - 1] - along[start] >= shortestMiss) result.push([start, track.length - 1]);
  return result;
}

/** Where a miss gets its next shaping point: halfway along it by distance or, when it already holds
 *  points the route went through and still missed the track around, halfway along the longest
 *  stretch between them. Null when every stretch is too short to be another way. */
function middle([first, last]: [number, number], along: number[], shaping: Set<number>, anchors: { index: number }[]): number | null {
  const taken = new Set([...anchors.map((anchor) => anchor.index), ...shaping]);
  const cuts = [first];
  for (let i = first; i <= last; i++) if (taken.has(i)) cuts.push(i);
  cuts.push(last);
  let from = cuts[0], to = cuts[1];
  for (let c = 1; c + 1 < cuts.length; c++) {
    if (along[cuts[c + 1]] - along[cuts[c]] > along[to] - along[from]) [from, to] = [cuts[c], cuts[c + 1]];
  }
  if (along[to] - along[from] < shortestMiss) return null;
  const halfway = (along[from] + along[to]) / 2;
  let centre = from;
  while (centre < to && along[centre] < halfway) centre++;
  // Outward from the centre, the nearer side first and the earlier of two as near.
  for (let offset = 0; offset <= to - from; offset++) {
    for (const index of [centre - offset, centre + offset]) {
      if (index >= from && index <= to && !taken.has(index)) return index;
    }
  }
  return null;
}

/** The line with a vertex at least every `spacing` metres (wider on a very long line), its own
 *  vertices kept. */
export function densified(line: Coordinate[], every = spacing): Coordinate[] {
  if (line.length === 0) return [];
  const step = Math.max(every, length(line) / 20_000);
  const result: Coordinate[] = [];
  for (let i = 0; i + 1 < line.length; i++) {
    const a = line[i], b = line[i + 1];
    result.push(a);
    const pieces = Math.ceil(distance(a, b) / step);
    for (let piece = 1; piece < pieces; piece++) {
      const t = piece / pieces;
      result.push({ latitude: a.latitude + (b.latitude - a.latitude) * t, longitude: a.longitude + (b.longitude - a.longitude) * t });
    }
  }
  result.push(line.at(-1)!);
  return result;
}

/** Distance along the line at each vertex. */
export function alongOf(line: Coordinate[]): number[] {
  const result = [0];
  for (let i = 1; i < line.length; i++) result.push(result[i - 1] + distance(line[i - 1], line[i]));
  return result;
}

/** The vertex at or after `from` closest to `point`. */
function nearestVertex(point: Coordinate, line: Coordinate[], from: number): number {
  let best = from, bestDistance = Infinity;
  for (let i = from; i < line.length; i++) {
    const d = distance(line[i], point);
    if (d < bestDistance) [best, bestDistance] = [i, d];
  }
  return best;
}

/** A line's segments filed by square, so asking whether a point is near it looks at a few segments
 *  rather than all of them. Metres on a plane through the line's first point: over a route's extent
 *  the error is far below the tolerance. */
class Grid {
  private static readonly cell = 50;
  private readonly origin: Coordinate;
  private readonly metresPerDegreeLongitude: number;
  private readonly points: { x: number; y: number }[];
  private readonly cells = new Map<string, number[]>();

  constructor(line: Coordinate[]) {
    this.origin = line[0] ?? { latitude: 0, longitude: 0 };
    this.metresPerDegreeLongitude = 111_320 * Math.cos((this.origin.latitude * Math.PI) / 180);
    this.points = line.map((c) => this.plane(c));
    for (let i = 0; i + 1 < this.points.length; i++) {
      const a = this.points[i], b = this.points[i + 1];
      for (let x = this.key(Math.min(a.x, b.x)); x <= this.key(Math.max(a.x, b.x)); x++) {
        for (let y = this.key(Math.min(a.y, b.y)); y <= this.key(Math.max(a.y, b.y)); y++) {
          const cell = `${x},${y}`;
          const list = this.cells.get(cell);
          if (list) list.push(i); else this.cells.set(cell, [i]);
        }
      }
    }
  }

  /** For each point, whether the line passes further than `tolerance` from it. */
  misses(track: Coordinate[], within = tolerance): boolean[] {
    return track.map((point) => !this.isNear(point, within));
  }

  isNear(point: Coordinate, within: number): boolean {
    const p = this.plane(point);
    const reach = Math.ceil(within / Grid.cell);
    const cx = this.key(p.x), cy = this.key(p.y);
    for (let x = cx - reach; x <= cx + reach; x++) {
      for (let y = cy - reach; y <= cy + reach; y++) {
        for (const index of this.cells.get(`${x},${y}`) ?? []) if (this.distance(p, index) <= within) return true;
      }
    }
    return false;
  }

  private plane(c: Coordinate): { x: number; y: number } {
    return { x: (c.longitude - this.origin.longitude) * this.metresPerDegreeLongitude, y: (c.latitude - this.origin.latitude) * 110_540 };
  }

  private key(metres: number): number {
    return Math.floor(metres / Grid.cell);
  }

  private distance(p: { x: number; y: number }, index: number): number {
    const a = this.points[index], b = this.points[index + 1];
    const dx = b.x - a.x, dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSquared));
    return Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y);
  }
}
