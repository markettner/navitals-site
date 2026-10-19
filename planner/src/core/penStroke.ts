// What a stroke drawn over a route means: the app's pen (NavitalsKit's PenStroke, 5 Oct).
//
// One tool for every edit a route we only have a line for needs, because an imported recording has
// the line and not the shaping points that made it:
//
// - From the route back to the route: ride this way instead. Where the stroke leaves and rejoins
//   the line is what gets replaced; the stroke in between shapes the new section. Drawn across a
//   half-loop it is a shortcut; drawn around a closed road it is a detour.
// - Along the route: erase this section. The shortest way that avoids it replaces it.
// - Across the route: blocked here. The way round it replaces the route near it.
// - Round an area: stay out of it altogether.
//
// Everything is measured in the stroke's own terms, pixels on screen, so a stroke means the same at
// every zoom.

import { distance, distanceToLine, length, project, type Coordinate } from './geodesy';
import { sample } from './labels';

export type PenEdit =
  /** Replace the route between `from` and `to` metres along it with a way through `through`. */
  | { kind: 'rideThrough'; from: number; to: number; through: Coordinate[] }
  /** Replace the route between `from` and `to` with the shortest way that avoids it. */
  | { kind: 'erase'; from: number; to: number }
  /** The route is blocked at `point`, `along` metres along it. */
  | { kind: 'blocked'; point: Coordinate; along: number }
  /** An area to stay out of altogether. */
  | { kind: 'avoidZone'; polygon: Coordinate[] };

/** How near the line, in pixels, a stroke's ends must be to count as on it. */
export const endReach = 40;
/** How near the line, in pixels, a stroke's middle must stay to count as following it. */
export const followReach = 28;
/** The share of a stroke that must follow the line for it to erase. */
export const followShare = 0.8;
/** Strokes shorter than this, in pixels, are clicks or slips and mean nothing. */
export const shortest = 24;
/** The most points of a stroke handed to the router to shape the new section. */
export const shapingPoints = 4;
/** A closed stroke encloses at least this side of a square, in pixels, to be an area. */
export const closedArea = 60;

// ---------- Areas ----------

/** Square metres enclosed by a closed line (shoelace, on a local flat projection). */
export function area(polygon: Coordinate[]): number {
  if (polygon.length < 3) return 0;
  const origin = polygon[0];
  const xs = polygon.map((p) => (p.longitude - origin.longitude) * 111_320 * Math.cos((origin.latitude * Math.PI) / 180));
  const ys = polygon.map((p) => (p.latitude - origin.latitude) * 110_540);
  let sum = 0;
  for (let i = 0; i < polygon.length; i++) {
    const j = (i + 1) % polygon.length;
    sum += xs[i] * ys[j] - xs[j] * ys[i];
  }
  return Math.abs(sum) / 2;
}

/** Whether a point lies inside a closed line (even-odd). */
export function contains(polygon: Coordinate[], point: Coordinate): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a.latitude > point.latitude) !== (b.latitude > point.latitude)
      && point.longitude < ((b.longitude - a.longitude) * (point.latitude - a.latitude)) / (b.latitude - a.latitude) + a.longitude) {
      inside = !inside;
    }
  }
  return inside;
}

/** Circles that together cover a closed area, for a router that only knows circles: a hex grid
 *  over it, each centre inside it or within a radius of its edge. */
export function coverage(polygon: Coordinate[]): { center: Coordinate; radius: number }[] {
  if (polygon.length < 3) return [];
  const radius = Math.max(40, Math.sqrt(area(polygon) / 40));
  const lats = polygon.map((p) => p.latitude), lons = polygon.map((p) => p.longitude);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats), minLon = Math.min(...lons), maxLon = Math.max(...lons);
  const midLat = (minLat + maxLat) / 2;
  const dLat = (radius * 1.5) / 110_540;
  const dLon = (radius * Math.sqrt(3)) / (111_320 * Math.cos((midLat * Math.PI) / 180));
  const ring = [...polygon, polygon[0]];
  const circles: { center: Coordinate; radius: number }[] = [];
  let row = 0;
  for (let lat = minLat - dLat; lat <= maxLat + dLat; lat += dLat, row++) {
    for (let lon = minLon - dLon + (row % 2 === 0 ? 0 : dLon / 2); lon <= maxLon + dLon; lon += dLon) {
      const center = { latitude: lat, longitude: lon };
      if (contains(polygon, center) || distanceToLine(ring, center) <= radius) circles.push({ center, radius });
    }
  }
  return circles;
}

/** The stretches of a route inside a closed area, as [from, to] distances along the route. */
export function stretches(route: Coordinate[], polygon: Coordinate[], spacing = 20): [number, number][] {
  const total = length(route);
  if (total <= 0) return [];
  const count = Math.max(2, Math.floor(total / spacing) + 1);
  const samples = sample(route, count);
  const step = total / (count - 1);
  const result: [number, number][] = [];
  let start: number | null = null;
  samples.forEach((point, index) => {
    const along = index * step;
    if (contains(polygon, point)) {
      if (start === null) start = along;
    } else if (start !== null) {
      result.push([start, along]);
      start = null;
    }
  });
  if (start !== null) result.push([start, total]);
  return result;
}

// ---------- Reading a stroke ----------

/** What `stroke` means for `route`, at `metresPerPoint`; null when it means nothing: a stroke that
 *  starts or ends away from the route and never crosses it. */
export function interpret(stroke: Coordinate[], route: Coordinate[], metresPerPoint: number): PenEdit | null {
  if (stroke.length < 2 || route.length < 2 || !(metresPerPoint > 0)) return null;
  const strokeLength = length(stroke);
  if (strokeLength < shortest * metresPerPoint) return null;

  // Closed: it ends where it began and encloses something. Read before anything else, since a
  // circle drawn around a stretch of the route also starts and ends near it.
  if (distance(stroke[0], stroke.at(-1)!) <= endReach * metresPerPoint
    && strokeLength >= 3 * endReach * metresPerPoint
    && area(stroke) >= (closedArea * metresPerPoint) ** 2) {
    return { kind: 'avoidZone', polygon: stroke };
  }

  const cumulative = cumulativeDistances(route);
  const positions = stroke.map((point) => position(point, route, cumulative));
  const first = positions[0], last = positions.at(-1)!;
  const ends = endReach * metresPerPoint;
  const follow = followReach * metresPerPoint;
  const along = Math.abs(last.along - first.along);

  // Across: short, and from one side of the line to the other close to one place on it.
  const closest = positions.reduce((best, p) => (p.distance < best.distance ? p : best));
  if (closest.distance <= follow && first.side !== last.side && along < 3 * ends && strokeLength < 220 * metresPerPoint) {
    return { kind: 'blocked', point: closest.point, along: closest.along };
  }

  if (!(first.distance <= ends && last.distance <= ends && along >= 2 * ends)) return null;
  const from = Math.min(first.along, last.along), to = Math.max(first.along, last.along);
  const following = positions.filter((p) => p.distance <= follow).length;
  if (following / positions.length >= followShare) return { kind: 'erase', from, to };

  // The stroke between its ends, in the route's direction, thinned to a few shaping points that
  // stay clear of the line (a point on it would only pull the new section back onto it).
  const forwards = first.along <= last.along;
  const ordered = forwards ? stroke : [...stroke].reverse();
  const orderedPositions = forwards ? positions : [...positions].reverse();
  const inner = ordered.slice(1, -1).filter((_, index) => orderedPositions[index + 1].distance > follow);
  return { kind: 'rideThrough', from, to, through: thinned(inner, shapingPoints) };
}

interface Position {
  point: Coordinate;
  distance: number;
  along: number;
  /** Which side of the line the stroke point lies on: true for left. */
  side: boolean;
}

function position(location: Coordinate, route: Coordinate[], cumulative: number[]): Position {
  const projection = project(route, location)!;
  const index = projection.segment;
  const next = Math.min(index + 1, route.length - 1);
  const a = route[index], b = route[next];
  const along = cumulative[index] + projection.t * (cumulative[next] - cumulative[index]);
  const cross = (b.longitude - a.longitude) * (location.latitude - a.latitude)
    - (b.latitude - a.latitude) * (location.longitude - a.longitude);
  return { point: projection.at, distance: projection.distance, along, side: cross > 0 };
}

export function cumulativeDistances(line: Coordinate[]): number[] {
  const cumulative = [0];
  for (let i = 1; i < line.length; i++) cumulative.push(cumulative[i - 1] + distance(line[i - 1], line[i]));
  return cumulative;
}

/** At most `count` points, evenly spread along the stroke. */
export function thinned(points: Coordinate[], count: number): Coordinate[] {
  if (points.length <= count || count <= 0) return points;
  return Array.from({ length: count }, (_, index) => points[Math.floor(((index + 0.5) / count) * points.length)]);
}

/** Points along the route between two distances, spaced `every` metres, short of both ends by
 *  `margin`: where to put no-go circles that erase a section but leave its ends reachable. */
export function points(route: Coordinate[], from: number, to: number, every: number, margin: number): Coordinate[] {
  const cumulative = cumulativeDistances(route);
  const result: Coordinate[] = [];
  let segment = 0;
  for (let target = from + margin; target <= to - margin; target += every) {
    while (segment < route.length - 2 && cumulative[segment + 1] < target) segment++;
    const span = cumulative[segment + 1] - cumulative[segment];
    const t = span > 0 ? (target - cumulative[segment]) / span : 0;
    const a = route[segment], b = route[segment + 1];
    result.push({ latitude: a.latitude + (b.latitude - a.latitude) * t, longitude: a.longitude + (b.longitude - a.longitude) * t });
  }
  return result;
}

/** The point `metres` along the route. */
export function cut(route: Coordinate[], metres: number): Coordinate | null {
  if (route.length === 0) return null;
  return points(route, metres, metres, 1, 0)[0] ?? (metres <= 0 ? route[0] : route.at(-1)!);
}

// ---------- Choosing among ways to ride a stroke ----------

/** How well `candidate` rides what was drawn: the mean distance from the stroke to it, plus the
 *  length it rides twice. A hand-drawn line through a forest snaps to the nearest track, and a
 *  router told to pass there rides up a dead end and back; nobody drew that. */
export function misfit(candidate: Coordinate[], stroke: Coordinate[]): number {
  if (candidate.length < 2 || stroke.length === 0) return Number.MAX_VALUE;
  const samples = sample(stroke, 40);
  const mean = samples.reduce((total, point) => total + distanceToLine(candidate, point), 0) / samples.length;
  return mean + retraced(candidate);
}

/** Metres of `line` that run back over a part of it already ridden: out-and-back spurs. */
export function retraced(line: Coordinate[], tolerance = 15): number {
  const total = length(line);
  const samples = sample(line, Math.max(2, Math.min(400, Math.floor(total / 20))));
  if (samples.length <= 4) return 0;
  const step = total / (samples.length - 1);
  let doubled = 0;
  for (let index = 4; index < samples.length; index++) {
    // Earlier than the last few samples, so following the line itself is not doubling back.
    const earlier = samples.slice(0, index - 3);
    if (earlier.length > 1 && distanceToLine(earlier, samples[index]) <= tolerance) doubled += step;
  }
  return doubled;
}
