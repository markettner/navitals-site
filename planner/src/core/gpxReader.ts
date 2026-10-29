// Reading a GPX file, as the app does (NavitalsKit's GPXParser and GPXTrack; docs/ROUTE_GPX.md).
//
// The richest information wins: the track's `navitals:plan`, or else route points marked
// `trp:ViaPoint` / `trp:ShapingPoint` (a Garmin, a file of ours from before the plan moved into the
// track), are a plan, whatever else the file holds; a few unmarked route points far apart and no track are a plan of
// stops (brouter-web, Kurviger); anything else is a line, with the file's waypoints near it as
// stops on it (`stopsOf`), which the planner then fits a plan to (`trackFit.ts`). A deliberately
// small reader: the elements a route needs, and nothing else.

import { distance, isCoordinate, length, project, type Coordinate } from './geodesy';
import { sportForProfile } from './brouter';
import type { Sport, WaypointKind } from './route';

export interface NamedPoint extends Coordinate {
  name: string;
}

export interface PlannedPoint extends NamedPoint {
  kind: Exclude<WaypointKind, 'place'>;
}

export interface GPXTrack {
  name: string;
  coordinates: Coordinate[];
  /** Metres per coordinate when every point had one; empty otherwise, never zero-filled. */
  elevations: number[];
  /** Named points the file marked: places along the route. */
  waypoints: NamedPoint[];
  /** The points the route was planned through, when the file holds a plan. */
  plannedPoints: PlannedPoint[] | null;
  /** The BRouter profile it says it was planned with (`navitals:profile`). */
  profile: string | null;
  /** What the track says it is for (`trk/type`): Komoot writes its sport there, as
   *  `touring_bicycle`, `racebike` or `hike`. */
  activity: string | null;
}

export class GPXError extends Error {
  constructor(readonly reason: 'notGPX' | 'noPoints') {
    super(reason === 'notGPX' ? "That file isn't a GPX track." : 'That GPX file has no track in it.');
  }
}

/** At most this many route points, this far apart on average, are stops rather than a line. */
export const mostPlannedStops = 50;
export const sparsestLine = 400;
/** At most this many marked route points are a plan; shaping points sit close, so no spacing rule. */
export const mostMarkedPoints = 200;
/** Start and finish closer than this are one place: the track is a loop. */
export const loopTolerance = 100;
/** A waypoint further than this from the line is somewhere bookmarked, not somewhere the route goes.
 *  Closer, it is a stop where the line passes nearest: Komoot puts a lake's highlight on the water
 *  and a viewpoint up its side path, and a stop out there would send the route to it and back,
 *  which the file's route never did. */
export const stopTolerance = 1000;
/** The name of a file that gives none. */
export const unnamed = 'Imported route';

interface Point extends Coordinate {
  elevation?: number;
  name?: string;
  kind?: 'stop' | 'shaping';
}

export function parseGPX(text: string): GPXTrack {
  const segments: Point[][] = [];
  const filePoints: Point[] = [];
  /** The points of the track's `navitals:plan`, each with its kind; the first plan only. */
  const planPoints: Point[] = [];
  const waypoints: NamedPoint[] = [];
  let name: string | undefined;
  /** `metadata/name`: the file's name for what it holds, where our writers put the route's name. */
  let metadataName: string | undefined;
  let profile: string | null = null;
  let activity: string | null = null;
  let sawGPX = false;

  let context: 'none' | 'track' | 'trackPoint' | 'routePoint' | 'waypoint' = 'none';
  let wantsName = false;
  let inMetadata = false;
  /** How deep inside `metadata`: its own `<name>` is at 1, an author's (`author/name`) deeper. */
  let metadataDepth = 0;
  let inPlan = false;
  let pending: Point | null = null;
  let pendingName: string | undefined;
  let textBuffer = '';

  for (const token of tokens(text)) {
    if (token.type === 'text') {
      textBuffer += token.text;
      continue;
    }
    // An element's name without its prefix, whatever prefix the file bound the namespace to.
    const local = token.name.split(':').pop()!;
    if (token.type === 'open') {
      textBuffer = '';
      if (inMetadata) metadataDepth++;
      switch (token.name) {
        case 'gpx': sawGPX = true; break;
        case 'trk': context = 'track'; wantsName = name === undefined; break;
        case 'trkseg': segments.push([]); break;
        case 'rte': wantsName = name === undefined; break;
        case 'metadata': inMetadata = true; metadataDepth = 0; break;
        case 'trkpt': case 'rtept': case 'wpt': {
          const latitude = coordinate(token.attributes.lat), longitude = coordinate(token.attributes.lon);
          if (!isCoordinate(latitude, longitude)) throw new Error(`A point at ${token.attributes.lat},${token.attributes.lon} is off the globe.`);
          pending = { latitude, longitude };
          pendingName = undefined;
          context = token.name === 'trkpt' ? 'trackPoint' : token.name === 'rtept' ? 'routePoint' : 'waypoint';
          break;
        }
        default:
          if (context === 'routePoint' && pending) {
            if (local === 'ViaPoint') pending.kind = 'stop';
            else if (local === 'ShapingPoint') pending.kind = 'shaping';
          } else if (context === 'track' && local === 'plan') {
            inPlan = planPoints.length === 0;
          } else if (context === 'track' && local === 'point' && inPlan) {
            const { lat, lon, kind, name: pointName } = token.attributes;
            const latitude = coordinate(lat), longitude = coordinate(lon);
            if (!isCoordinate(latitude, longitude)) throw new Error(`A plan point at ${lat},${lon} is off the globe.`);
            planPoints.push({ latitude, longitude, name: pointName || undefined, kind: kind === 'shaping' ? 'shaping' : 'stop' });
          }
      }
      if (!token.selfClosing) continue;
    }
    // A closing tag, or an element that opened and closed at once.
    const value = textBuffer.trim();
    textBuffer = '';
    const depth = metadataDepth;
    if (inMetadata && token.name !== 'metadata') metadataDepth--;
    switch (token.name) {
      case 'name':
        if (context === 'trackPoint' || context === 'routePoint' || context === 'waypoint') pendingName = value;
        else if (inMetadata) { if (depth === 1 && value) metadataName = value; }
        else if (wantsName && value) { name = value; wantsName = false; }
        break;
      case 'ele': {
        const elevation = Number(value);
        if (pending && value && Number.isFinite(elevation)) pending.elevation = elevation;
        break;
      }
      case 'trkpt':
        if (pending) {
          if (segments.length === 0) segments.push([]);
          segments.at(-1)!.push(pending);
        }
        pending = null;
        context = 'track';
        break;
      case 'rtept':
        if (pending) filePoints.push({ ...pending, name: pendingName });
        pending = null;
        context = 'none';
        break;
      case 'wpt':
        if (pending) waypoints.push({ latitude: pending.latitude, longitude: pending.longitude, name: pendingName || 'Waypoint' });
        pending = null;
        context = 'none';
        break;
      case 'type':
        if (context === 'track' && activity === null && value) activity = value;
        break;
      case 'trk': case 'rte':
        context = 'none';
        wantsName = false;
        break;
      case 'metadata':
        inMetadata = false;
        break;
      default:
        if (inMetadata && local === 'profile' && value) profile = value;
        if (local === 'plan') inPlan = false;
    }
  }
  if (!sawGPX) throw new GPXError('notGPX');

  // A recorded track is the most faithful thing in the file; a planned route is next best.
  const recorded = segments.filter((segment) => segment.length > 0);
  const source = recorded.length ? recorded.flat() : filePoints;
  // Our own plan, in the track, else the route points: a Garmin trip, brouter-web, or a file of
  // ours written before the plan moved out of its `rte`.
  const routePoints = planPoints.length >= 2 ? planPoints : filePoints;
  if (source.length < 2) throw new GPXError('noPoints');

  let isPlan: boolean;
  if (routePoints.some((point) => point.kind)) {
    // Marked points say outright that they are a plan; the track beside them is how it was routed.
    isPlan = routePoints.length >= 2 && routePoints.length <= mostMarkedPoints;
  } else {
    // Unmarked, a few points far apart are a plan; many close together are a line.
    isPlan = recorded.length === 0 && routePoints.length >= 2 && routePoints.length <= mostPlannedStops
      && length(routePoints) / (routePoints.length - 1) >= sparsestLine;
  }
  const last = routePoints.length - 1;
  const elevations = source.map((point) => point.elevation);
  return {
    // The file's own name for the route (docs/ROUTE_GPX.md), else its track's or route's.
    name: metadataName ?? name ?? unnamed,
    coordinates: source.map(({ latitude, longitude }) => ({ latitude, longitude })),
    // Partial elevation is not elevation: if any point lacks it the profile is dropped.
    elevations: elevations.every((e) => e !== undefined) ? (elevations as number[]) : [],
    waypoints,
    plannedPoints: isPlan ? routePoints.map((point, index) => {
      // The ends are stops whatever the file says: a route can't start at a bend.
      const kind = point.kind === 'shaping' && index > 0 && index < last ? 'shaping' : 'stop';
      return {
        latitude: point.latitude, longitude: point.longitude, kind,
        name: point.name || (kind === 'shaping' ? 'Shaping point' : `Point ${index + 1}`),
      };
    }) : null,
    profile,
    activity,
  };
}

/** The sport to plan a file's route with, when it names a profile or an activity we know. Our own
 *  profile first: it says exactly how the route was planned. */
export function sportOf(track: Pick<GPXTrack, 'profile' | 'activity'>): Sport | undefined {
  return (track.profile ? sportForProfile(track.profile) : undefined)
    ?? (track.activity ? sportForActivity(track.activity) : undefined);
}

/** Komoot's sports (with their e-bike twins), and the plain words other exporters use
 *  (`GPXTrack.sport(forActivity:)`). */
export function sportForActivity(activity: string): Sport | undefined {
  switch (activity.toLowerCase().replace(/^e_/, '')) {
    case 'touring_bicycle': case 'citybike': case 'cycling': case 'biking': return 'cycling';
    case 'racebike': case 'road_cycling': return 'road';
    case 'mtb_easy': case 'gravel': return 'gravel';
    case 'mtb': case 'mtb_advanced': return 'mountainBike';
    case 'hike': case 'hiking': case 'mountaineering': case 'jogging': case 'running': case 'walking': return 'hiking';
    default: return undefined;
  }
}

/** Whether a track ends where it began. */
export function isLoop(line: Coordinate[]): boolean {
  return line.length > 2 && distance(line[0], line.at(-1)!) <= loopTolerance;
}

/** The file's waypoints sorted into the stops of a line (`GPXTrack.stops`): one at either end names
 *  that end, the ones near the line between are moved onto it, in the order the track passes them,
 *  and one nowhere near the line is left out. A file lists its waypoints in any order: Komoot writes
 *  the destination first. */
export function stopsOf(track: Pick<GPXTrack, 'coordinates' | 'waypoints'>): { start?: NamedPoint; vias: NamedPoint[]; finish?: NamedPoint } {
  const line = track.coordinates;
  if (line.length === 0) return { vias: [] };
  const first = line[0], last = line.at(-1)!;
  let start: NamedPoint | undefined, finish: NamedPoint | undefined;
  const along: { position: number; place: NamedPoint }[] = [];
  for (const waypoint of track.waypoints) {
    if (distance(waypoint, first) <= loopTolerance && !start) {
      start = waypoint;
    } else if (distance(waypoint, last) <= loopTolerance && !finish) {
      finish = waypoint;
    } else {
      const projection = project(line, waypoint);
      if (projection && projection.distance <= stopTolerance) {
        along.push({ position: projection.segment + projection.t, place: { ...waypoint, ...projection.at } });
      }
    }
  }
  if (isLoop(line)) {
    start = start ?? finish;
    finish = start;
  }
  return { start, vias: along.sort((a, b) => a.position - b.position).map((a) => a.place), finish };
}

/** Ramer–Douglas–Peucker, so a long recording becomes a few points without losing a switchback. */
export function simplify(line: Coordinate[], tolerance: number): Coordinate[] {
  if (line.length <= 2) return line;
  const keep = new Array<boolean>(line.length).fill(false);
  keep[0] = keep[line.length - 1] = true;
  const stack: [number, number][] = [[0, line.length - 1]];
  while (stack.length) {
    const [first, lastIndex] = stack.pop()!;
    if (lastIndex <= first + 1) continue;
    let farthest = first, farthestDistance = 0;
    const chord = [line[first], line[lastIndex]];
    for (let i = first + 1; i < lastIndex; i++) {
      const d = project(chord, line[i])?.distance ?? 0;
      if (d > farthestDistance) { farthest = i; farthestDistance = d; }
    }
    if (farthestDistance <= tolerance) continue;
    keep[farthest] = true;
    stack.push([first, farthest], [farthest, lastIndex]);
  }
  return line.filter((_, i) => keep[i]);
}

/** Thins a line to at most `limit` points, raising the tolerance until it fits; past the largest
 *  tolerance it is sampled evenly along its whole length (`GPXParser.thinned`). */
export function thinned(line: Coordinate[], limit: number, startTolerance = 2): Coordinate[] {
  let tolerance = startTolerance;
  let result = simplify(line, tolerance);
  while (result.length > limit && tolerance < 200) {
    tolerance *= 2;
    result = simplify(line, tolerance);
  }
  if (result.length <= limit || limit < 2) return result;
  const lastIndex = result.length - 1;
  return Array.from({ length: limit }, (_, i) => result[Math.floor((i * lastIndex) / (limit - 1))]);
}

// ---------- A small XML tokenizer: tags, attributes and text, with entities and CDATA ----------

type Token =
  | { type: 'open'; name: string; attributes: Record<string, string>; selfClosing: boolean }
  | { type: 'close'; name: string }
  | { type: 'text'; text: string };

const tokenPattern = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<[?!][\s\S]*?>|<(\/?)([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
const attributePattern = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;

/** A `lat` or `lon` attribute's number; NaN when it is missing or empty, which `Number` reads as 0. */
function coordinate(text: string | undefined): number {
  return text === undefined || !text.trim() ? NaN : Number(text);
}

function* tokens(xml: string): Generator<Token> {
  for (const match of xml.matchAll(tokenPattern)) {
    const [, cdata, closing, name, attributes, selfClosing, text] = match;
    if (cdata !== undefined) yield { type: 'text', text: cdata };
    else if (text !== undefined) yield { type: 'text', text: decode(text) };
    else if (name !== undefined) {
      if (closing) yield { type: 'close', name };
      else {
        const parsed: Record<string, string> = {};
        for (const [, key, double, single] of (attributes ?? '').matchAll(attributePattern)) parsed[key] = decode(double ?? single);
        yield { type: 'open', name, attributes: parsed, selfClosing: Boolean(selfClosing) };
      }
    }
  }
}

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, code: string) => {
    if (code[0] === '#') return String.fromCodePoint(code[1].toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : Number(code.slice(1)));
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[code.toLowerCase()];
  });
}
