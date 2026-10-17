// The plan in the page's address, so a link reopens it with no server: the sport, then each point
// as `lat,lon`, a shaping point marked `,s`. Five decimals is about a metre.
//
//   #map=12/52.5/13.4&route=gravel;52.52192,13.41321;52.49300,13.45900,s;52.44000,13.64500
//
// Names stay out, so links stay short; search names the points again when the link opens.

import type { Coordinate } from './geodesy';
import { sports, type Sport } from './route';

export const routeParameter = 'route';

export interface PlanState {
  sport: Sport;
  points: (Coordinate & { kind: 'stop' | 'shaping' })[];
}

export function encodePlan(plan: PlanState): string {
  return [plan.sport, ...plan.points.map((point) =>
    `${point.latitude.toFixed(5)},${point.longitude.toFixed(5)}${point.kind === 'shaping' ? ',s' : ''}`)].join(';');
}

/** The plan a link holds, or null for one that isn't a plan (mistyped, cut off, or from elsewhere). */
export function decodePlan(text: string): PlanState | null {
  const [sport, ...fields] = text.split(';');
  if (!sports.some((s) => s.id === sport) || fields.length < 2) return null;
  const points: PlanState['points'] = [];
  for (const field of fields) {
    const parts = field.split(',');
    const latitude = Number(parts[0]), longitude = Number(parts[1]);
    if (parts.length < 2 || parts.length > 3 || (parts.length === 3 && parts[2] !== 's')
      || !Number.isFinite(latitude) || !Number.isFinite(longitude)
      || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) return null;
    points.push({ latitude, longitude, kind: parts.length === 3 ? 'shaping' : 'stop' });
  }
  // A route can't start or end at a bend.
  points[0].kind = 'stop';
  points[points.length - 1].kind = 'stop';
  return { sport: sport as Sport, points };
}

/** The hash with the plan set, or taken out, leaving MapLibre's `map=` and anything else alone. */
export function withPlan(hash: string, plan: PlanState | null): string {
  const parameters = new URLSearchParams(hash.replace(/^#/, ''));
  if (plan) parameters.set(routeParameter, encodePlan(plan));
  else parameters.delete(routeParameter);
  // URLSearchParams escapes `/`, `;` and `,`; the hash reads better without, and needs none of it.
  return parameters.toString().replaceAll('%2F', '/').replaceAll('%3B', ';').replaceAll('%2C', ',');
}

export function planIn(hash: string): PlanState | null {
  const text = new URLSearchParams(hash.replace(/^#/, '')).get(routeParameter);
  return text ? decodePlan(text) : null;
}
