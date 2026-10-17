// A shaping point dropped on the far side of a divided road (NavitalsKit's BRouterNearSide.swift).
//
// A drag that lands on the other carriageway, or on the parallel cycle track across it, is snapped
// by BRouter to that side. One-way, it can only be reached by riding past, turning, coming back
// along the far side and turning again: a loop BRouter's own correction doesn't see. The sign is in
// the line: between the point's neighbours the route passes close to it heading the other way, and
// only reaches it after a detour many times that gap. The point moves to the closest such pass.

import { bearing, closestPoint, distance, type Coordinate } from './geodesy';
import { farthestStop, smallest } from './brouter';
import type { Waypoint } from './route';

/** How far from a shaping point the route may pass, on the way there or back, for the point to
 *  count as dropped on the far side. A dual carriageway with a cycle track each side is 15–35 m
 *  from track to track. */
export const nearSideReach = 50;
/** The shortest detour taken as a mistake rather than a shape, and how many times the gap. */
const nearSideShortestDetour = 150;
const nearSideDetourRatio = 4;
/** How far from opposite the route's heading where it passes may be from its heading at the point. */
const nearSideOpposite = 45;

/** The waypoints with each shaping point dropped on the far side of a road moved to where the route
 *  already passes it, or null when there is none. Stops are never moved: they must be reached. */
export function nearSideWaypoints(waypoints: Waypoint[], line: Coordinate[]): Waypoint[] | null {
  if (waypoints.length < 3 || line.length < 2) return null;
  if (!waypoints.slice(1, -1).some((waypoint) => waypoint.kind === 'shaping')) return null;
  const reached = reachIndices(waypoints, line);
  if (!reached) return null;
  const along = [0];
  for (let i = 1; i < line.length; i++) along.push(along[i - 1] + distance(line[i - 1], line[i]));

  const moved = waypoints.map((waypoint) => ({ ...waypoint }));
  let changed = false;
  for (let k = 1; k < waypoints.length - 1; k++) {
    if (waypoints[k].kind !== 'shaping') continue;
    const point = waypoints[k];
    const at = reached[k];
    const heading = bearing(line[Math.max(at - 1, 0)], line[Math.min(at + 1, line.length - 1)]);
    let best: { point: Coordinate; gap: number } | null = null;
    const end = Math.max(reached[k + 1], reached[k - 1] + 1);
    for (let segment = reached[k - 1]; segment < end; segment++) {
      if (segment + 1 >= line.length) continue;
      const a = line[segment], b = line[segment + 1];
      const near = closestPoint(a, b, point);
      if (!near) continue;
      const gap = distance(near.point, point);
      if (gap > nearSideReach) continue;
      const detour = Math.abs(along[segment] + near.t * (along[segment + 1] - along[segment]) - along[at]);
      if (detour < Math.max(nearSideShortestDetour, nearSideDetourRatio * gap)) continue;
      const turn = Math.abs(bearing(a, b) - heading) % 360;
      if (Math.min(turn, 360 - turn) < 180 - nearSideOpposite) continue;
      if (!best || gap < best.gap) best = { point: near.point, gap };
    }
    if (best) {
      moved[k].latitude = best.point.latitude;
      moved[k].longitude = best.point.longitude;
      changed = true;
    }
  }
  return changed ? moved : null;
}

/** Where the line reaches each waypoint, in order: the ends, and for each point between them the
 *  first vertex after the previous one that is as close as the line comes (within 2 m). BRouter puts
 *  the point it snapped a via to on its line, so that vertex is the via itself. */
export function reachIndices(waypoints: Waypoint[], line: Coordinate[]): number[] | null {
  const reached = [0];
  let from = 0;
  for (const waypoint of waypoints.slice(1, -1)) {
    if (from >= line.length) return null;
    const distances = line.slice(from).map((point) => distance(point, waypoint));
    const closest = smallest(distances);
    if (closest > farthestStop) return null;
    const offset = distances.findIndex((d) => d <= closest + 2);
    if (offset < 0) return null;
    from += offset;
    reached.push(from);
  }
  reached.push(line.length - 1);
  return reached;
}
