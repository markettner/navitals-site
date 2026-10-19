// Planning what a pen stroke asked for (the app's MapScreenModel+Pen): the new section of route,
// spliced into the old one, and the circles the router was told to stay out of. Each edit replaces
// only the part of the route it touches and keeps the rest as it was, so it works on an imported
// line whose shape no list of stops could reproduce.

import type { AvoidArea, Track } from './brouter';
import { length, type Coordinate } from './geodesy';
import { contains, coverage, cut, misfit, points, stretches, type PenEdit } from './penStroke';
import type { Waypoint } from './route';
import { replacing } from './splice';

/** One route between waypoints, staying out of `avoid`: brouter.de, or a fake in the tests. */
export type Router = (waypoints: Waypoint[], avoid: AvoidArea[], signal?: AbortSignal) => Promise<Track>;

export interface PlannedEdit {
  /** The whole route after the edit. */
  track: Track;
  /** Circles the edit adds to the plan, so later plans keep to it. */
  avoid: AvoidArea[];
  /** The part of the old route no longer ridden, in metres along it: its stops go. */
  removed: [number, number] | null;
}

/** How big a blocked spot is, and how far either side of it a way round is looked for, nearest
 *  first: a blocked lane is usually a block away from a way round, sometimes a village. */
export const blockRadius = 30;
export const detourSpans = [400, 1_500, 4_000];

/** The route after a ride-through, erase or blocked edit. Throws when no way was found. */
export async function planEdit(edit: Exclude<PenEdit, { kind: 'avoidZone' }>, stroke: Coordinate[], track: Track,
                               avoid: AvoidArea[], router: Router, signal?: AbortSignal): Promise<PlannedEdit> {
  const line = track.coordinates;
  const total = length(line);
  const connector = (from: number, to: number, through: Coordinate[], extra: AvoidArea[]): Promise<Track> => {
    const start = cut(line, from), end = cut(line, to);
    if (!start || !end) return Promise.reject(new Error('No route.'));
    const waypoints: Waypoint[] = [
      { ...start, kind: 'stop' },
      ...through.map((point) => ({ latitude: point.latitude, longitude: point.longitude, kind: 'shaping' as const })),
      { ...end, kind: 'stop' },
    ];
    return router(waypoints, [...avoid, ...extra], signal);
  };
  const splice = (from: number, to: number, piece: Track) =>
    replacing(track, from > 5 ? from : null, to < total - 5 ? to : null, piece);

  switch (edit.kind) {
    case 'rideThrough': {
      // A drawn line is a sketch, not a list of places to visit: try riding through all of it,
      // through its middle, and simply not along the part it replaces, and keep the one that rides
      // closest to what was drawn without doubling back.
      const { from, to, through } = edit;
      const candidates: { through: Coordinate[]; avoid: AvoidArea[] }[] = [{ through, avoid: [] }];
      if (through.length > 1) candidates.push({ through: [through[Math.floor(through.length / 2)]], avoid: [] });
      candidates.push({ through: [], avoid: sectionAvoidance(line, from, to) });
      let best: { track: Track; misfit: number } | null = null;
      let lastError: unknown = new Error('No route.');
      for (const candidate of candidates) {
        try {
          const found = await connector(from, to, candidate.through, candidate.avoid);
          const fit = misfit(found.coordinates, stroke);
          if (!best || fit < best.misfit) best = { track: found, misfit: fit };
        } catch (error) {
          if (signal?.aborted) throw error;
          lastError = error;
        }
      }
      if (!best) throw lastError;
      return { track: splice(from, to, best.track), avoid: [], removed: [from, to] };
    }
    case 'erase': {
      const extra = sectionAvoidance(line, edit.from, edit.to);
      const found = await connector(edit.from, edit.to, [], extra);
      return { track: splice(edit.from, edit.to, found), avoid: extra, removed: [edit.from, edit.to] };
    }
    case 'blocked': {
      const extra = [{ ...edit.point, radius: blockRadius }];
      let lastError: unknown = new Error('No route.');
      for (const span of detourSpans) {
        const from = Math.max(0, edit.along - span), to = Math.min(total, edit.along + span);
        try {
          return { track: splice(from, to, await connector(from, to, [], extra)), avoid: extra, removed: null };
        } catch (error) {
          if (signal?.aborted) throw error;
          lastError = error;
        }
      }
      throw lastError;
    }
  }
}

/** A closed shape: circles that keep the router out of it, and the route with every stretch inside
 *  it replaced by a way round, joined outside the zone, last stretch first so the distances to the
 *  earlier ones stay true. `passes` is false when the route never entered it, and the route is then
 *  as it was. */
export async function avoidZone(polygon: Coordinate[], track: Track, avoid: AvoidArea[], router: Router,
                                signal?: AbortSignal): Promise<{ track: Track; circles: AvoidArea[]; passes: boolean }> {
  const circles = coverage(polygon).map(({ center, radius }) => ({ ...center, radius }));
  const inside = stretches(track.coordinates, polygon);
  if (!inside.length) return { track, circles, passes: false };
  let current = track;
  for (const stretch of [...inside].reverse()) {
    current = await detour(stretch, current, polygon, [...avoid, ...circles], router, signal);
  }
  return { track: current, circles, passes: true };
}

async function detour(stretch: [number, number], track: Track, polygon: Coordinate[], avoid: AvoidArea[],
                      router: Router, signal?: AbortSignal): Promise<Track> {
  const line = track.coordinates;
  const total = length(line);
  let lastError: unknown = new Error('No route.');
  for (const margin of detourSpans) {
    let from = Math.max(0, stretch[0] - margin), to = Math.min(total, stretch[1] + margin);
    // A join inside the zone would make the router ignore the zone there.
    while (from > 0 && contains(polygon, cut(line, from)!)) from = Math.max(0, from - 200);
    while (to < total && contains(polygon, cut(line, to)!)) to = Math.min(total, to + 200);
    const start = cut(line, from), end = cut(line, to);
    if (!start || !end) continue;
    try {
      const connector = await router([{ ...start, kind: 'stop' }, { ...end, kind: 'stop' }], avoid, signal);
      return replacing(track, from > 5 ? from : null, to < total - 5 ? to : null, connector);
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error;
    }
  }
  throw lastError;
}

/** Circles along a section of the route, clear of its ends, so a way round cannot use it. */
export function sectionAvoidance(line: Coordinate[], from: number, to: number): AvoidArea[] {
  const span = to - from;
  return points(line, from, to, Math.max(120, span / 15), Math.min(250, span * 0.15)).map((point) => ({ ...point, radius: 40 }));
}

const tenths = new Intl.NumberFormat(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });

function distanceText(metres: number): string {
  return metres < 1000 ? `${Math.round(metres / 10) * 10} m` : `${tenths.format(metres / 1000)} km`;
}

/** What an edit did, as the pen bar says it: "Riding this way · 7.8 km shorter". */
export function summary(edit: PenEdit, change: number): string {
  const what = { rideThrough: 'Riding this way', erase: 'Section erased', blocked: 'Riding around the block', avoidZone: 'Riding around the zone' }[edit.kind];
  if (Math.abs(change) < 50) return what;
  return `${what} · ${distanceText(Math.abs(change))} ${change < 0 ? 'shorter' : 'longer'}`;
}

export function failure(edit: PenEdit): string {
  return {
    rideThrough: 'No way found along that line.',
    erase: 'No way found around that section.',
    blocked: 'No way found around that spot.',
    avoidZone: 'No way found around that area.',
  }[edit.kind];
}
