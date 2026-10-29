// Distances and bearings, as NavitalsKit's Geodesy and RouteGeometry compute them, so a line
// measures the same on the web as in the app.

export interface Coordinate {
  latitude: number;
  longitude: number;
}

/** A latitude and longitude that are a place on the globe. */
export function isCoordinate(latitude: number, longitude: number): boolean {
  return Number.isFinite(latitude) && Number.isFinite(longitude) && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180;
}

/** Metres between two points on the WGS 84 ellipsoid, by Vincenty's inverse formula
 *  (`Geodesy.distance`). */
export function distance(from: Coordinate, to: Coordinate): number {
  const a = 6_378_137, f = 1 / 298.257223563, b = a * (1 - f);
  const radians = Math.PI / 180;
  const l = (to.longitude - from.longitude) * radians;
  const u1 = Math.atan((1 - f) * Math.tan(from.latitude * radians));
  const u2 = Math.atan((1 - f) * Math.tan(to.latitude * radians));
  const sinU1 = Math.sin(u1), cosU1 = Math.cos(u1), sinU2 = Math.sin(u2), cosU2 = Math.cos(u2);

  let lambda = l;
  let sinSigma = 0, cosSigma = 0, sigma = 0, cosSqAlpha = 0, cos2SigmaM = 0;
  // Converges in a handful of iterations for anything but near-antipodal points, where the cap
  // just settles for the last estimate: no ride spans half the planet.
  for (let i = 0; i < 200; i++) {
    const sinLambda = Math.sin(lambda), cosLambda = Math.cos(lambda);
    const east = cosU2 * sinLambda;
    const north = cosU1 * sinU2 - sinU1 * cosU2 * cosLambda;
    sinSigma = Math.sqrt(east * east + north * north);
    if (sinSigma === 0) return 0; // the same point
    cosSigma = sinU1 * sinU2 + cosU1 * cosU2 * cosLambda;
    sigma = Math.atan2(sinSigma, cosSigma);
    const sinAlpha = (cosU1 * cosU2 * sinLambda) / sinSigma;
    cosSqAlpha = 1 - sinAlpha * sinAlpha;
    // Zero on the equator, where the formula's term is undefined but the line is too.
    cos2SigmaM = cosSqAlpha !== 0 ? cosSigma - (2 * sinU1 * sinU2) / cosSqAlpha : 0;
    const c = (f / 16) * cosSqAlpha * (4 + f * (4 - 3 * cosSqAlpha));
    const previous = lambda;
    lambda = l + (1 - c) * f * sinAlpha
      * (sigma + c * sinSigma * (cos2SigmaM + c * cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)));
    if (Math.abs(lambda - previous) < 1e-12) break;
  }

  const uSq = (cosSqAlpha * (a * a - b * b)) / (b * b);
  const bigA = 1 + (uSq / 16384) * (4096 + uSq * (-768 + uSq * (320 - 175 * uSq)));
  const bigB = (uSq / 1024) * (256 + uSq * (-128 + uSq * (74 - 47 * uSq)));
  const deltaSigma = bigB * sinSigma * (cos2SigmaM + (bigB / 4) * (cosSigma * (-1 + 2 * cos2SigmaM * cos2SigmaM)
    - (bigB / 6) * cos2SigmaM * (-3 + 4 * sinSigma * sinSigma) * (-3 + 4 * cos2SigmaM * cos2SigmaM)));
  return b * bigA * (sigma - deltaSigma);
}

/** The length of a line, in metres. */
export function length(line: Coordinate[]): number {
  let total = 0;
  for (let i = 1; i < line.length; i++) total += distance(line[i - 1], line[i]);
  return total;
}

/** Initial great-circle bearing, degrees clockwise from true north (`RouteGeometry.bearing`). */
export function bearing(from: Coordinate, to: Coordinate): number {
  const φ1 = (from.latitude * Math.PI) / 180, φ2 = (to.latitude * Math.PI) / 180;
  const Δλ = ((to.longitude - from.longitude) * Math.PI) / 180;
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  const degrees = (Math.atan2(y, x) * 180) / Math.PI;
  return degrees < 0 ? degrees + 360 : degrees;
}

/** The point of segment a–b closest to `point`, and how far along the segment it lies (0...1), on
 *  a local plane in metres; null for a segment of no length. */
export function closestPoint(a: Coordinate, b: Coordinate, point: Coordinate): { point: Coordinate; t: number } | null {
  const metresPerDegreeLon = 111_320 * Math.cos((point.latitude * Math.PI) / 180);
  const metresPerDegreeLat = 110_540;
  const ax = (a.longitude - point.longitude) * metresPerDegreeLon, ay = (a.latitude - point.latitude) * metresPerDegreeLat;
  const bx = (b.longitude - point.longitude) * metresPerDegreeLon, by = (b.latitude - point.latitude) * metresPerDegreeLat;
  const dx = bx - ax, dy = by - ay;
  const lengthSquared = dx * dx + dy * dy;
  if (lengthSquared <= 0) return null;
  const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lengthSquared));
  return {
    point: { latitude: a.latitude + t * (b.latitude - a.latitude), longitude: a.longitude + t * (b.longitude - a.longitude) },
    t,
  };
}

/** How far `point` is from the nearest point of a line, by projection onto each segment. */
export function distanceToLine(line: Coordinate[], point: Coordinate): number {
  if (line.length === 0) return Infinity;
  if (line.length === 1) return distance(line[0], point);
  let best = Infinity;
  for (let i = 0; i + 1 < line.length; i++) {
    const near = closestPoint(line[i], line[i + 1], point)?.point ?? line[i];
    best = Math.min(best, distance(near, point));
  }
  return best;
}

/** Where a point falls on a line: the segment, how far along it (0...1), and how far off the line
 *  the point is, in metres (`RouteGeometry.project`). Null for an empty line. */
export function project(line: Coordinate[], point: Coordinate): { segment: number; t: number; distance: number; at: Coordinate } | null {
  if (line.length === 0) return null;
  if (line.length === 1) return { segment: 0, t: 0, distance: distance(line[0], point), at: line[0] };
  let best: { segment: number; t: number; at: Coordinate; squared: number } | null = null;
  const metresPerDegreeLon = 111_320 * Math.cos((point.latitude * Math.PI) / 180);
  const metresPerDegreeLat = 110_540;
  const toPlane = (c: Coordinate) => ({
    x: (c.longitude - point.longitude) * metresPerDegreeLon, y: (c.latitude - point.latitude) * metresPerDegreeLat,
  });
  for (let i = 0; i + 1 < line.length; i++) {
    const a = toPlane(line[i]), b = toPlane(line[i + 1]);
    const dx = b.x - a.x, dy = b.y - a.y;
    const lengthSquared = dx * dx + dy * dy;
    const t = lengthSquared === 0 ? 0 : Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / lengthSquared));
    const x = a.x + t * dx, y = a.y + t * dy;
    const squared = x * x + y * y;
    if (!best || squared < best.squared) {
      best = { segment: i, t, squared, at: { latitude: point.latitude + y / metresPerDegreeLat, longitude: point.longitude + x / metresPerDegreeLon } };
    }
  }
  return { segment: best!.segment, t: best!.t, at: best!.at, distance: distance(best!.at, point) };
}

/** The point at a fractional segment index along a line: 3.25 is a quarter of the way from the
 *  fourth point to the fifth. */
function pointAt(line: Coordinate[], position: number): Coordinate {
  const index = Math.min(Math.max(0, Math.floor(position)), line.length - 1);
  const t = position - index;
  if (t <= 0 || index + 1 >= line.length) return line[index];
  const a = line[index], b = line[index + 1];
  return { latitude: a.latitude + (b.latitude - a.latitude) * t, longitude: a.longitude + (b.longitude - a.longitude) * t };
}

/** The line up to `position`, ending exactly there (`RouteGeometry.prefix`). */
export function prefix(line: Coordinate[], position: number): Coordinate[] {
  if (line.length === 0) return [];
  const index = Math.min(Math.max(0, Math.floor(position)), line.length - 1);
  const head = line.slice(0, index + 1);
  if (position - index > 0 && index + 1 < line.length) head.push(pointAt(line, position));
  return head;
}

/** The line from `position` on, starting exactly there (`RouteGeometry.suffix`). */
export function suffix(line: Coordinate[], position: number): Coordinate[] {
  if (line.length === 0) return [];
  const index = Math.min(Math.max(0, Math.floor(position)), line.length - 1);
  if (!(position - index > 0) || index + 1 >= line.length) return line.slice(index);
  return [pointAt(line, position), ...line.slice(index + 1)];
}

/** Where each stop of a route sits along its line, as fractional segment indices, in the stops'
 *  order (`RouteGeometry.stopPositions`). Each is looked for only after the one before it, so a
 *  loop or an out-and-back doesn't pin a stop on the way home to the way out. The first is the
 *  line's start and the last its end, by definition. */
export function stopPositions(stops: Coordinate[], line: Coordinate[]): number[] {
  if (line.length < 2 || stops.length < 2) return stops.map(() => 0);
  const positions = [0];
  for (const stop of stops.slice(1, -1)) {
    const previous = positions.at(-1)!;
    const from = Math.floor(previous);
    const projection = project(line.slice(from), stop);
    positions.push(projection ? Math.max(previous, from + projection.segment + projection.t) : previous);
  }
  positions.push(line.length - 1);
  return positions;
}

/** The index in the stops a new point at `position` goes in at: after every stop the route has
 *  passed there, never before the start or after the end (`RouteGeometry.insertionIndex`). */
export function insertionIndex(position: number, positions: number[]): number {
  if (positions.length < 2) return positions.length;
  const passed = positions.filter((p) => p <= position).length;
  return Math.min(Math.max(passed, 1), positions.length - 1);
}

/** Metres climbed, counting a rise only once it is `threshold` above the last turning point, so
 *  the noise in a recording or a terrain model on a flat road doesn't add up to hills. */
export function climbing(elevations: number[], threshold = 5): number {
  if (elevations.length < 2) return 0;
  let total = 0;
  let reference = elevations[0];
  for (const elevation of elevations) {
    if (elevation - reference >= threshold) {
      total += elevation - reference;
      reference = elevation;
    } else if (reference - elevation >= threshold) {
      reference = elevation;
    }
  }
  return total;
}
