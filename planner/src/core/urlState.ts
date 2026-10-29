// The plan in the page's address, so a link reopens it with no server (the app's
// docs/ROUTE_LINK.md): the sport, then each point as `lat,lon`, a shaping point marked `,s`. Five
// decimals is about a metre. Beside it, when there is one: the route chosen among those offered,
// the circles it keeps out of, the ferries and steps it leaves out, and its name.
//
//   #map=12/52.5/13.4&route=gravel;52.52192,13.41321;52.49300,13.45900,s;52.44000,13.64500&alt=1&name=Loop
//
// Points have no names, so links stay short; search names them again when the link opens.

import type { AvoidArea } from './brouter';
import { isCoordinate, type Coordinate } from './geodesy';
import { sports, ways, type Sport, type Way } from './route';

export const routeParameter = 'route';
const keys = [routeParameter, 'alt', 'avoid', 'without', 'name'];
const maxPoints = 200;
const maxAlternative = 3;

export interface PlanState {
  sport: Sport;
  points: (Coordinate & { kind: 'stop' | 'shaping' })[];
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
    if (plan.name) parameters.set('name', plan.name);
  }
  // URLSearchParams escapes `/`, `;` and `,`; the hash reads better without, and needs none of it.
  return parameters.toString().replaceAll('%2F', '/').replaceAll('%3B', ';').replaceAll('%2C', ',');
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
  return plan;
}
