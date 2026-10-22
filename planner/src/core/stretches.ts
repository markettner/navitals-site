// Re-planning only what an edit touched (NavitalsKit's BRouterStretches.swift, plan Phase 7k).
//
// Moving one shaping point on a 165 km loop used to ask brouter.de for all 165 km again. BRouter
// searches each stretch between two neighbouring points on its own, so the rest of the line cannot
// change: the line is kept cut into its stretches, and an edit asks only for the stretches it
// touched, then splices them in.
//
// Two things look past a stretch's ends. BRouter's `correctMisplacedViaPoints` trims a spur of up
// to 400 m where the line reaches a shaping point and turns back, which needs both stretches
// meeting there; and `nearSideWaypoints` moves a shaping point by where its neighbours put the
// line. So a stretch that ends at a shaping point (stops go as meeting points, which BRouter never
// corrects) also depends on the point beyond it, and its key says so. And a window asked for again
// starts one stretch early and ends one stretch late, where nothing changed, so it can be joined to
// the line kept where the two agree. Checked on the Berliner Mauerweg (40 points): a spliced line is
// the full plan's, point for point.

import { lonlats, type AvoidArea, type Track } from './brouter';
import { climbing, distance, type Coordinate } from './geodesy';
import { reachIndices } from './nearSide';
import type { Sport, Waypoint } from './route';

/** What a stretch of BRouter's line depends on: its two points as BRouter is sent them, and the
 *  point beyond each end that is a shaping point in the middle of the plan. One per stretch, in
 *  order: stretch `s` runs from waypoint `s` to `s + 1`. */
export function stretchKeys(waypoints: Waypoint[]): string[] {
  if (waypoints.length < 2) return [];
  const points = lonlats(waypoints).split('|');
  const looksBeyond = (index: number) => index > 0 && index < waypoints.length - 1 && waypoints[index].kind === 'shaping';
  return points.slice(0, -1).map((from, s) =>
    [looksBeyond(s) ? points[s - 1] : '', from, points[s + 1], looksBeyond(s + 1) ? points[s + 2] : ''].join('>'));
}

/** The windows to ask for again, as `[first, last]` waypoints, for the stretches not known (one
 *  flag per stretch): each run of them with one known stretch before and after where there is one.
 *  Runs that would share or touch a known stretch go as one window. */
export function replanWindows(missing: boolean[]): [number, number][] {
  const runs: [number, number][] = [];
  missing.forEach((isMissing, s) => {
    if (!isMissing) return;
    const last = runs.at(-1);
    if (last && s - last[1] <= 2) last[1] = s;
    else runs.push([s, s]);
  });
  return runs.map(([first, last]) => [Math.max(first - 1, 0), Math.min(last + 2, missing.length)]);
}

/** BRouter's line through the waypoints cut at each of them, one track per stretch. Neighbours
 *  share the point they are cut at. Null when the line does not pass a waypoint. */
export function stretches(track: Track, waypoints: Waypoint[]): Track[] | null {
  if (waypoints.length < 2 || track.coordinates.length < 2) return null;
  const reached = reachIndices(waypoints, track.coordinates);
  if (!reached) return null;
  const along = distancesAlong(track.coordinates);
  const climbed = climbing(track.elevations);
  return reached.slice(0, -1).map((from, s) => slice(track, from, reached[s + 1], along, climbed));
}

/** Tracks laid end to end, each starting where the one before ends: null when one does not. */
export function joined(pieces: Track[]): Track | null {
  if (!pieces.length) return null;
  let result = pieces[0];
  for (const piece of pieces.slice(1)) {
    const end = result.coordinates.at(-1), start = piece.coordinates[0];
    if (!end || !start || end.latitude !== start.latitude || end.longitude !== start.longitude) return null;
    const elevated = (t: Track) => t.elevations.length === t.coordinates.length;
    result = {
      coordinates: [...result.coordinates, ...piece.coordinates.slice(1)],
      elevations: elevated(result) && elevated(piece) ? [...result.elevations, ...piece.elevations.slice(1)] : [],
      length: result.length + piece.length,
      duration: result.duration + piece.duration,
      ascent: result.ascent + piece.ascent,
    };
  }
  return result;
}

/** A window asked for again, joined to the line kept on either side of it.
 *
 *  `leading` is the known stretch the window starts with, `trailing` the one it ends with; null
 *  where the window starts or ends the plan. The window's own first stretch starts at a point that
 *  was in the middle of the plan, where BRouter may have trimmed a spur the window does not, so the
 *  two are joined where they first run together: the first pair of neighbouring points both have,
 *  in that order. The end is joined the same way, at the last pair. Null when they never do. */
export function spliced(window: Track, waypoints: Waypoint[], leading: Track | null, trailing: Track | null): Track | null {
  const line = window.coordinates;
  const reached = line.length >= 2 ? reachIndices(waypoints, line) : null;
  if (!reached || reached.length < 2) return null;
  let start = 0, end = line.length - 1;
  let head: Track | null = null, tail: Track | null = null;
  if (leading) {
    const kept = leading.coordinates;
    const at = positions(kept, 0, kept.length - 1);
    let found: [number, number] | null = null;
    for (let p = 0; p <= Math.min(reached[1], line.length - 2) && !found; p++) {
      const q = at.get(vertex(line[p]))?.find((q) => vertex(kept[q + 1]) === vertex(line[p + 1]));
      if (q !== undefined) found = [q, p];
    }
    if (!found) return null;
    head = part(leading, 0, found[0]);
    start = found[1];
  }
  if (trailing) {
    const kept = trailing.coordinates;
    const at = positions(kept, 1, kept.length);
    let found: [number, number] | null = null;
    for (let p = line.length - 1; p >= Math.max(reached[reached.length - 2], 1) && !found; p--) {
      const q = at.get(vertex(line[p]))?.find((q) => vertex(kept[q - 1]) === vertex(line[p - 1]));
      if (q !== undefined) found = [q, p];
    }
    if (!found) return null;
    tail = part(trailing, found[0], kept.length - 1);
    end = found[1];
  }
  if (start >= end) return null;
  return joined([head, part(window, start, end), tail].filter((piece): piece is Track => piece !== null));
}

/** The whole line from the stretches known (one per stretch, null where not) and the windows asked
 *  for the rest (`replanWindows`). Null when a window cannot be joined, or the pieces do not meet:
 *  then the plan is asked for whole. */
export function replanned(known: (Track | null)[], windows: { waypoints: [number, number]; track: Track }[],
  waypoints: Waypoint[]): Track | null {
  const pieces: Track[] = [];
  let stretch = 0;
  for (const { waypoints: [first, last], track } of [...windows].sort((a, b) => a.waypoints[0] - b.waypoints[0])) {
    if (first < stretch || last >= waypoints.length) return null;
    for (; stretch < first; stretch++) {
      const piece = known[stretch];
      if (!piece) return null;
      pieces.push(piece);
    }
    const piece = spliced(track, waypoints.slice(first, last + 1), known[first], known[last - 1]);
    if (!piece) return null;
    pieces.push(piece);
    stretch = last;
  }
  for (; stretch < known.length; stretch++) {
    const piece = known[stretch];
    if (!piece) return null;
    pieces.push(piece);
  }
  return joined(pieces);
}

/** What a stretch is only good for: the profile, the places to avoid, and the tiles it was routed
 *  over. brouter.de doesn't say which tiles those were (it renews them every few days), so a
 *  stretch is kept within the hour it was asked for. */
export function stretchContext(sport: Sport, avoid: AvoidArea[], now = Date.now()): string {
  return JSON.stringify([sport, avoid.map((a) => [a.latitude, a.longitude, a.radius]), Math.floor(now / 3_600_000)]);
}

/** The stretches of the lines planned lately, for one context: when it changes, the cache starts
 *  empty. Enough for several plans' worth of undo and redo. */
export class StretchCache {
  private context: string | null = null;
  private readonly known = new Map<string, Track>();

  constructor(readonly capacity = 600) {}

  get size(): number { return this.known.size; }

  lookUp(keys: string[], context: string): (Track | null)[] {
    this.enter(context);
    return keys.map((key) => this.known.get(key) ?? null);
  }

  store(track: Track, waypoints: Waypoint[], context: string): void {
    const cut = stretches(track, waypoints);
    if (!cut) return;
    this.enter(context);
    stretchKeys(waypoints).forEach((key, s) => {
      // Re-inserted, so the Map's order stays oldest first.
      this.known.delete(key);
      this.known.set(key, cut[s]);
    });
    for (const key of this.known.keys()) {
      if (this.known.size <= this.capacity) break;
      this.known.delete(key);
    }
  }

  private enter(context: string): void {
    if (context === this.context) return;
    this.context = context;
    this.known.clear();
  }
}

/** BRouter's line through the waypoints, asking `route` only for the stretches the cache does not
 *  know: each run of them as one window, one known stretch wider on each side, spliced into the
 *  known line. The first plan, or one where every stretch changed, is one window: the whole plan.
 *  More windows than `mostWindows` are asked for as the whole plan, one request instead of many:
 *  brouter.de counts requests, not kilometres. */
export async function routeStretches(waypoints: Waypoint[], cache: StretchCache, context: string,
  route: (waypoints: Waypoint[]) => Promise<Track>, mostWindows = Infinity): Promise<Track> {
  const known = cache.lookUp(stretchKeys(waypoints), context);
  const windows = replanWindows(known.map((track) => track === null));
  const whole = windows.length > mostWindows
    || (windows.length === 1 && windows[0][0] === 0 && windows[0][1] === waypoints.length - 1);
  let track: Track | null = null;
  if (!whole) {
    const routed = await Promise.all(windows.map(async ([first, last]) =>
      ({ waypoints: [first, last] as [number, number], track: await route(waypoints.slice(first, last + 1)) })));
    track = replanned(known, routed, waypoints);
  }
  track ??= await route(waypoints);
  cache.store(track, waypoints, context);
  return track;
}

// ---------- Cutting ----------

function distancesAlong(line: Coordinate[]): number[] {
  const along = [0];
  for (let i = 1; i < line.length; i++) along.push(along[i - 1] + distance(line[i - 1], line[i]));
  return along;
}

/** Points `from` to `to` of a track, with BRouter's length, time and climbing in proportion. */
function slice(track: Track, from: number, to: number, along: number[], climbed: number): Track {
  const total = along.at(-1) ?? 0;
  const share = total > 0 ? (along[to] - along[from]) / total : 0;
  const elevations = track.elevations.length === track.coordinates.length ? track.elevations.slice(from, to + 1) : [];
  return {
    coordinates: track.coordinates.slice(from, to + 1),
    elevations,
    length: track.length * share,
    duration: track.duration * share,
    ascent: climbed > 0 ? track.ascent * climbing(elevations) / climbed : track.ascent * share,
  };
}

function part(track: Track, from: number, to: number): Track {
  return slice(track, from, to, distancesAlong(track.coordinates), climbing(track.elevations));
}

/** A point compared exactly, as BRouter writes it: the same node in two answers is the same pair
 *  of numbers. */
function vertex(point: Coordinate): string {
  return `${point.longitude},${point.latitude}`;
}

/** Where each point of `line[from..<to]` is, by its vertex. */
function positions(line: Coordinate[], from: number, to: number): Map<string, number[]> {
  const at = new Map<string, number[]>();
  for (let i = from; i < to; i++) {
    const key = vertex(line[i]);
    const list = at.get(key);
    if (list) list.push(i); else at.set(key, [i]);
  }
  return at;
}
