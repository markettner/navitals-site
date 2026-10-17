// Distances and bearings, as NavitalsKit's Geodesy and RouteGeometry compute them, so a line
// measures the same on the web as in the app.

export interface Coordinate {
  latitude: number;
  longitude: number;
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
