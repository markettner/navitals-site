// The app's BRouter request and the reading of BRouter's answer (NavitalsKit's BRouter.swift), so a
// route planned here is the route the app plans through the same points.

import { distance, length, type Coordinate } from './geodesy';
import type { Sport, Way, Waypoint } from './route';

const profiles: Record<Sport, string> = {
  cycling: 'trekking',
  road: 'fastbike',
  gravel: 'gravel',
  mountainBike: 'mtb',
  // brouter.de's copy of hiking-mountain, as the app bundles it.
  hiking: 'hiking-mountain',
};

/** The BRouter profile a sport routes with. */
export function profileFor(sport: Sport): string {
  return profiles[sport];
}

/** The sport a profile belongs to, for a GPX file that names the profile it was planned with. */
export function sportForProfile(profile: string): Sport | undefined {
  return (Object.keys(profiles) as Sport[]).find((sport) => profiles[sport] === profile);
}

/** `lonlats` as the app sends it. A stop between the first and last point goes as a meeting point
 *  (`lon,lat,m`): routed through exactly like a plain via, but never cut out as misplaced. A shaping
 *  point stays plain, so with `profileParameters` a drag that lands just off the road no longer
 *  sends the route there and back. The ends are always plain, as brouter-web sends them. */
export function lonlats(waypoints: Waypoint[]): string {
  return waypoints.map((waypoint, index) => {
    const pair = `${waypoint.longitude.toFixed(6)},${waypoint.latitude.toFixed(6)}`;
    const isMiddle = index > 0 && index < waypoints.length - 1;
    return isMiddle && waypoint.kind !== 'shaping' ? `${pair},m` : pair;
  }).join('|');
}

/** brouter-web's `profile:<name>=<value>` parameters for a request through these points.
 *  `pass2coefficient` 1 points BRouter's second search at the destination (the app measured the
 *  same routes up to 2.5× faster), and misplaced vias are corrected only when there is a shaping
 *  point for it to correct. Ferries and steps to leave out switch the profile's own `allow_…` off
 *  (gravel's are ours); nothing is sent for what is allowed. */
export function profileParameters(waypoints: Waypoint[], without: Way[] = []): Record<string, string> {
  const shaped = waypoints.slice(1, -1).some((waypoint) => waypoint.kind === 'shaping');
  const parameters: Record<string, string> = { pass2coefficient: '1' };
  if (shaped) parameters.correctMisplacedViaPoints = '1';
  for (const way of without) parameters[`allow_${way}`] = '0';
  return parameters;
}

/** A circle the route must stay out of: a road drawn blocked, a section erased, or part of an area
 *  (the app's `AvoidArea`). */
export interface AvoidArea extends Coordinate {
  /** Metres. */
  radius: number;
}

/** BRouter's `nogos`: `lon,lat,radius` per circle, as `OnDeviceBRouter` hands them to the engine. */
export function nogos(areas: AvoidArea[]): string {
  return areas.map((area) => `${area.longitude.toFixed(6)},${area.latitude.toFixed(6)},${Math.round(area.radius)}`).join('|');
}

/** The GET request for one route: 0 is the best, up to 3 the alternatives BRouter computes on
 *  request, one call each. */
export function routeURL(base: string, waypoints: Waypoint[], profile: string, alternative = 0, avoid: AvoidArea[] = [],
  without: Way[] = []): string {
  const query = new URLSearchParams({
    lonlats: lonlats(waypoints),
    profile,
    alternativeidx: String(alternative),
    format: 'geojson',
  });
  if (avoid.length) query.set('nogos', nogos(avoid));
  for (const [name, value] of Object.entries(profileParameters(waypoints, without))) {
    query.set(`profile:${name}`, value);
  }
  // `|` and `,` read better unescaped, and BRouter takes them either way.
  return `${base}?${query.toString().replaceAll('%7C', '|').replaceAll('%2C', ',').replaceAll('%3A', ':')}`;
}

/** One answer: the line, and the totals BRouter reports for it. */
export interface Track {
  coordinates: Coordinate[];
  /** Metres above sea level per coordinate; empty rather than zero-filled when BRouter had none. */
  elevations: number[];
  /** Metres. */
  length: number;
  /** Seconds, BRouter's own estimate. */
  duration: number;
  /** Metres of climbing, BRouter's `filtered ascend`. */
  ascent: number;
}

export class BRouterDecodeError extends Error {
  constructor(readonly reason: 'unreadable' | 'noLine') {
    super(reason === 'unreadable' ? 'BRouter sent something that is not a route.' : 'BRouter sent no line.');
  }
}

export function decode(text: string): Track {
  let feature: { geometry?: { coordinates?: number[][] }; properties?: Record<string, unknown> } | undefined;
  try {
    feature = JSON.parse(text)?.features?.[0];
  } catch {
    throw new BRouterDecodeError('unreadable');
  }
  if (!feature) throw new BRouterDecodeError('unreadable');
  const points = feature.geometry?.coordinates;
  if (!Array.isArray(points) || points.length < 2) throw new BRouterDecodeError('noLine');

  const properties = feature.properties ?? {};
  // BRouter writes its numbers as strings.
  const number = (key: string): number | undefined => {
    const value = Number(properties[key]);
    return properties[key] !== undefined && Number.isFinite(value) ? value : undefined;
  };
  const coordinates = points.map(([longitude, latitude]) => ({ latitude, longitude }));
  return {
    coordinates,
    elevations: points.every((point) => point.length > 2) ? points.map((point) => point[2]) : [],
    length: number('track-length') ?? length(coordinates),
    duration: number('total-time') ?? 0,
    ascent: number('filtered ascend') ?? 0,
  };
}

/** How near the line a stop must pass to count as reached, beyond the closest it comes at all. */
export const stopTolerance = 60;
/** The furthest a stop may be from the line and still count as on it: a place is often the middle
 *  of something, and BRouter snaps up to 250 m, further where the map is sparse. */
export const farthestStop = 1_000;

/** The line cut into one piece per leg at the stops, as index ranges `[start, end]` into it.
 *  Each stop is looked for after the previous one, and the first time the line comes near it wins,
 *  so an out-and-back's turning point is found on the way out. Adjacent pieces share their cut
 *  point. Null when a stop is never passed: the answer is not about these stops. */
export function legRanges(line: Coordinate[], stops: Coordinate[]): [number, number][] | null {
  if (line.length < 2 || stops.length < 2) return null;
  if (stops.length === 2) return [[0, line.length - 1]];

  const cuts = [0];
  let from = 0;
  for (const stop of stops.slice(1, -1)) {
    const index = firstApproach(stop, line, from);
    if (index === null) return null;
    cuts.push(index);
    from = index;
  }
  cuts.push(line.length - 1);
  // A stop right at an end leaves a one-point piece; it borrows its neighbour's point to stay a line.
  return cuts.slice(0, -1).map((start, i) => [start, Math.min(Math.max(cuts[i + 1], start + 1), line.length - 1)]);
}

export function legs(line: Coordinate[], stops: Coordinate[]): Coordinate[][] | null {
  return legRanges(line, stops)?.map(([start, end]) => line.slice(start, end + 1)) ?? null;
}

/** The closest point of the first pass within tolerance of `stop`, at or after `start`. */
function firstApproach(stop: Coordinate, line: Coordinate[], start: number): number | null {
  if (start >= line.length) return null;
  const distances = line.slice(start).map((point) => distance(point, stop));
  const closest = smallest(distances);
  if (closest > farthestStop) return null;
  const tolerance = closest + stopTolerance;
  let best: { index: number; distance: number } | null = null;
  for (let offset = 0; offset < distances.length; offset++) {
    if (distances[offset] <= tolerance) {
      if (!best || distances[offset] < best.distance) best = { index: start + offset, distance: distances[offset] };
    } else if (best) {
      break; // left the stop's neighbourhood again: that pass is over
    }
  }
  return best?.index ?? null;
}

/** The smallest number, without spreading a long line's distances into arguments. */
export function smallest(values: number[]): number {
  let least = Infinity;
  for (const value of values) if (value < least) least = value;
  return least;
}
