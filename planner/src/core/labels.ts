// Where to pin each route's label on a map that shows several (NavitalsKit's RouteLabelPlacement):
// on the stretch where it differs most from the others, so a label is plainly about the line it
// sits on, as Apple Maps does.

import { distance, length, type Coordinate } from './geodesy';

/** One point on each route. A route alone gets its midpoint; among others, the point of its middle
 *  part farthest from all the others. Labels already placed count against a point until it is a
 *  fifth of the route away from them, so two routes that part only briefly don't get both labels
 *  on that one stretch. */
export function labelAnchors(routes: Coordinate[][]): (Coordinate | null)[] {
  const samples = routes.map((route) => sample(route, 160));
  const placed: Coordinate[] = [];
  return routes.map((_, index) => {
    const own = samples[index];
    if (own.length === 0) return null;
    // The ends are shared by every route, and a label there is about none of them.
    const from = Math.floor((own.length * 15) / 100);
    const middle = own.slice(from, Math.max(from + 1, Math.floor((own.length * 85) / 100)));
    const others = samples.filter((_, i) => i !== index).flat();
    if (others.length === 0) return own[Math.floor(own.length / 2)];
    // A fifth of the route apart is apart at the zoom that shows the whole route.
    const spacing = Math.max(1, length(own) * 0.2);
    const score = (point: Coordinate) => clearance(point, others) * Math.min(1, clearance(point, placed) / spacing);
    let best = middle[0], bestScore = -Infinity;
    for (const point of middle) {
      const s = score(point);
      if (s > bestScore) { best = point; bestScore = s; }
    }
    placed.push(best);
    return best;
  });
}

function clearance(point: Coordinate, others: Coordinate[]): number {
  let least = Infinity;
  for (const other of others) least = Math.min(least, distance(point, other));
  return least;
}

/** `count` points spaced evenly along a line, by distance. */
export function sample(line: Coordinate[], count: number): Coordinate[] {
  if (line.length <= 1) return line;
  const cumulative = [0];
  for (let i = 1; i < line.length; i++) cumulative.push(cumulative[i - 1] + distance(line[i - 1], line[i]));
  const total = cumulative.at(-1)!;
  if (total <= 0) return [line[0]];
  const points: Coordinate[] = [];
  let segment = 0;
  for (let step = 0; step < count; step++) {
    const target = (total * step) / (count - 1);
    while (segment < line.length - 2 && cumulative[segment + 1] < target) segment++;
    const span = cumulative[segment + 1] - cumulative[segment];
    const t = span > 0 ? (target - cumulative[segment]) / span : 0;
    const a = line[segment], b = line[segment + 1];
    points.push({ latitude: a.latitude + (b.latitude - a.latitude) * t, longitude: a.longitude + (b.longitude - a.longitude) * t });
  }
  return points;
}
