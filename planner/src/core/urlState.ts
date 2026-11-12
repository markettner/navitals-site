// The plan in the page's address, so a link reopens it with no server (the app's
// docs/ROUTE_LINK.md): the sport, then each point as `lat,lon`, a shaping point marked `,s`. Five
// decimals is about a metre. Beside it, when there is one: the route chosen among those offered,
// the circles it keeps out of, the ferries and steps it leaves out, the stops' names and its name.
//
//   #map=12/52.5/13.4&route=gravel;52.52192,13.41321;52.49300,13.45900,s;52.44000,13.64500&alt=1&names=Alexanderplatz;;&name=Loop
//
// `names` has one entry to a point, empty for a bend or a stop with no name of its own: search
// names those again when the link opens.

import type { AvoidArea } from './brouter';
import { myLocationName } from './search';
import { isCoordinate, type Coordinate } from './geodesy';
import { sports, ways, type Sport, type Way } from './route';

export const routeParameter = 'route';
const keys = [routeParameter, 'alt', 'avoid', 'without', 'names', 'name'];
const maxPoints = 200;
const maxAlternative = 3;

export interface PlanState {
  sport: Sport;
  /** A stop's `name` is the one it shows, when it has one of its own. */
  points: (Coordinate & { kind: 'stop' | 'shaping'; name?: string })[];
  /** Which of the routes offered: 0 the best. */
  alternative: number;
  avoid: AvoidArea[];
  /** Ferries and steps, when the route leaves them out (the app's Route Options). */
  without: Way[];
  name: string | null;
}

export function encodePlan(plan: Pick<PlanState, 'sport' | 'points'>): string {
  return [plan.sport, ...plan.points.map((point) =>
    `${point.latitude.toFixed(5)},${point.longitude.toFixed(5)}${point.kind === 'shaping' ? ',s' : ''}`)].join(';');
}

/** The plan a link's `route` holds, or null for one that isn't a plan (mistyped, cut off, or from
 *  elsewhere). Nothing beside it yet: `planIn` reads that. */
export function decodePlan(text: string): PlanState | null {
  const [sport, ...fields] = text.split(';');
  if (!sports.some((s) => s.id === sport) || fields.length < 2 || fields.length > maxPoints) return null;
  const points: PlanState['points'] = [];
  for (const field of fields) {
    const parts = field.split(',');
    const latitude = number(parts[0]), longitude = number(parts[1]);
    if (parts.length < 2 || parts.length > 3 || (parts.length === 3 && parts[2] !== 's')
      || !isCoordinate(latitude, longitude)) return null;
    points.push({ latitude, longitude, kind: parts.length === 3 ? 'shaping' : 'stop' });
  }
  // A route can't start or end at a bend.
  points[0].kind = 'stop';
  points[points.length - 1].kind = 'stop';
  return { sport: sport as Sport, points, alternative: 0, avoid: [], without: [], name: null };
}

/** A plain decimal, as written here: no exponent, no sign but minus, nothing empty (which Number
 *  reads as 0). Anything else is NaN. */
function number(text: string | undefined): number {
  return text !== undefined && /^-?\d+(\.\d+)?$/.test(text) ? Number(text) : NaN;
}

/** The circles of `avoid`, or none if any of them isn't one: a route that avoids only some of
 *  what it was planned to is a different route. */
function decodeAvoid(text: string | null): AvoidArea[] {
  if (!text) return [];
  const circles: AvoidArea[] = [];
  for (const field of text.split(';')) {
    const parts = field.split(',').map(number);
    if (parts.length !== 3 || !isCoordinate(parts[0], parts[1]) || !(parts[2] > 0)) return [];
    circles.push({ latitude: parts[0], longitude: parts[1], radius: parts[2] });
  }
  return circles;
}

/** A value as URLSearchParams writes it, but leaving `/` and `,` as they are, and `;` too
 *  outside `names`, where it parts the names. */
function encoded(text: string, keepingSemicolons = true): string {
  const value = new URLSearchParams({ v: text }).toString().slice(2).replaceAll('%2F', '/').replaceAll('%2C', ',');
  return keepingSemicolons ? value.replaceAll('%3B', ';') : value;
}

function decoded(text: string): string {
  const spaced = text.replaceAll('+', ' ');
  try {
    return decodeURIComponent(spaced);
  } catch {
    return spaced;
  }
}

/** Names that stand for no place of their own: the sender's position, and the app's pin search
 *  hadn't named yet (the app's `RouteLink.placeholderNames`). */
const placeholderNames = [myLocationName, 'Dropped Pin'];

/** A stop's name as a link carries it: none for a bend, a blank one, or a placeholder. */
function linkName(point: PlanState['points'][number]): string | undefined {
  const name = point.name?.trim();
  return point.kind === 'stop' && name && !placeholderNames.includes(name) ? name : undefined;
}

/** The hash with the plan set, or taken out, leaving MapLibre's `map=` and anything else alone. */
export function withPlan(hash: string, plan: PlanState | null): string {
  const parameters = new URLSearchParams(hash.replace(/^#/, ''));
  for (const key of keys) parameters.delete(key);
  if (plan) {
    parameters.set(routeParameter, encodePlan(plan));
    if (plan.alternative > 0) parameters.set('alt', String(plan.alternative));
    if (plan.avoid.length) {
      parameters.set('avoid', plan.avoid.map((circle) =>
        `${circle.latitude.toFixed(5)},${circle.longitude.toFixed(5)},${Math.round(circle.radius)}`).join(';'));
    }
    const without = ways.filter((way) => plan.without.includes(way));
    if (without.length) parameters.set('without', without.join(','));
  }
  // URLSearchParams escapes `/`, `;` and `,`; the hash reads better without, and needs none of it.
  const parts = parameters.toString() ? [parameters.toString().replaceAll('%2F', '/').replaceAll('%3B', ';').replaceAll('%2C', ',')] : [];
  if (plan) {
    // Written by hand: inside a name, `;` stays escaped.
    const names = plan.points.map(linkName);
    if (names.some(Boolean)) parts.push(`names=${names.map((name) => name ? encoded(name, false) : '').join(';')}`);
    if (plan.name) parts.push(`name=${encoded(plan.name)}`);
  }
  return parts.join('&');
}

/** The first `names` of a hash as written, before decoding: a `;` inside a name is `%3B`. */
function rawNames(hash: string): string | null {
  for (const pair of hash.split('&')) {
    const at = pair.indexOf('=');
    if (decoded(at < 0 ? pair : pair.slice(0, at)) === 'names') return at < 0 ? '' : pair.slice(at + 1);
  }
  return null;
}

export function planIn(hash: string): PlanState | null {
  const parameters = new URLSearchParams(hash.replace(/^#/, ''));
  const text = parameters.get(routeParameter);
  const plan = text ? decodePlan(text) : null;
  if (!plan) return null;
  const alternative = parameters.get('alt');
  if (alternative && /^\d$/.test(alternative) && Number(alternative) <= maxAlternative) plan.alternative = Number(alternative);
  plan.avoid = decodeAvoid(parameters.get('avoid'));
  // A word this planner doesn't know is passed over: something a later app leaves out.
  const without = (parameters.get('without') ?? '').split(',');
  plan.without = ways.filter((way) => without.includes(way));
  plan.name = parameters.get('name') || null;
  // One name to a point, or none at all: names on the wrong points are worse than none.
  const names = rawNames(hash.replace(/^#/, ''))?.split(';');
  if (names?.length === plan.points.length) {
    plan.points.forEach((point, index) => {
      const name = linkName({ ...point, name: decoded(names[index]) });
      if (name) point.name = name;
    });
  }
  return plan;
}

/** The map's view in the address, as MapLibre writes it: `map=zoom/lat/lng[/bearing[/pitch]]`. */
export interface MapViewState {
  zoom: number;
  latitude: number;
  longitude: number;
  bearing: number;
  pitch: number;
}

export function viewIn(hash: string): MapViewState | null {
  const parts = (new URLSearchParams(hash.replace(/^#/, '')).get('map') ?? '').split('/').map(number);
  if (parts.length < 3 || parts.length > 5 || parts.some(Number.isNaN)) return null;
  const [zoom, latitude, longitude, bearing = 0, pitch = 0] = parts;
  return isCoordinate(latitude, longitude) ? { zoom, latitude, longitude, bearing, pitch } : null;
}

/** The hash with the map's view set and every other part left exactly as it was written.
 *  MapLibre's own `hash` option writes the address back decoded, which breaks a name holding
 *  `&`, `+`, `#` or, in `names`, `;`. */
export function withView(hash: string, view: string): string {
  const parts = hash.replace(/^#/, '').split('&').filter(Boolean);
  const index = parts.findIndex((part) => decoded(part.split('=')[0]) === 'map');
  if (index >= 0) parts[index] = `map=${view}`;
  else parts.push(`map=${view}`);
  return parts.join('&');
}
