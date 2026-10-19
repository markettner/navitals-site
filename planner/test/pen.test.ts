// The app's PenStrokeTests, for the same functions here, and the edits planned from them
// (MapScreenModel+Pen, which the app doesn't test) with a router that answers from a script.

import { describe, expect, test } from 'vitest';
import { nogos, routeURL, type AvoidArea, type Track } from '../src/core/brouter';
import { distance, length, type Coordinate } from '../src/core/geodesy';
import { avoidZone, blockRadius, planEdit, sectionAvoidance, summary, type Router } from '../src/core/penEdit';
import { coverage, interpret, misfit, points, retraced, shapingPoints, stretches } from '../src/core/penStroke';
import { matchesMyLocation } from '../src/core/search';
import { replacing } from '../src/core/splice';

const c = (latitude: number, longitude: number): Coordinate => ({ latitude, longitude });
/** A route east along a parallel, a point every ~68 m, 10 km. At 5 m per pixel a reach of 40 px is
 *  200 m. */
const route = Array.from({ length: 151 }, (_, i) => c(52, 13 + i * 0.001));
const scale = 5;

/** A circle of `radius` degrees of latitude around a point, as a finger draws it. */
const ring = (lat: number, lon: number, radius: number) =>
  Array.from({ length: 41 }, (_, step) => {
    const angle = (step / 40) * 2 * Math.PI;
    return c(lat + radius * Math.sin(angle), lon + radius * Math.cos(angle) * 1.6);
  });

describe('what a pen stroke on a route means', () => {
  test('from the route, away and back to it, is a way to ride instead', () => {
    const stroke = [c(52, 13.02), c(52.004, 13.025), c(52.009, 13.04), c(52.004, 13.055), c(52.0002, 13.06)];
    const edit = interpret(stroke, route, scale);
    if (edit?.kind !== 'rideThrough') throw new Error(`not a ride-through: ${edit?.kind}`);
    expect(Math.abs(edit.from - 1_370)).toBeLessThan(80);
    expect(Math.abs(edit.to - 4_110)).toBeLessThan(80);
    expect(edit.through.length).toBeGreaterThan(0);
    expect(edit.through.length).toBeLessThanOrEqual(shapingPoints);
    expect(edit.through.every((p) => p.latitude > 52.002)).toBe(true);
  });

  test("drawn backwards it means the same, in the route's direction", () => {
    const stroke = [c(52.0002, 13.06), c(52.004, 13.055), c(52.009, 13.04), c(52.004, 13.025), c(52, 13.02)];
    const edit = interpret(stroke, route, scale);
    if (edit?.kind !== 'rideThrough') throw new Error('not a ride-through');
    expect(edit.from).toBeLessThan(edit.to);
    expect(edit.through[0].longitude).toBeLessThan(edit.through.at(-1)!.longitude);
  });

  test('scribbled along the route, it erases that section', () => {
    const stroke = Array.from({ length: 41 }, (_, i) => c(52 + ((i + 20) % 2 === 0 ? 0.0003 : -0.0003), 13 + (i + 20) * 0.001));
    const edit = interpret(stroke, route, scale);
    if (edit?.kind !== 'erase') throw new Error('not an erase');
    expect(Math.abs(edit.from - 1_370)).toBeLessThan(80);
    expect(Math.abs(edit.to - 4_110)).toBeLessThan(80);
  });

  test('a short line across the route marks it blocked where it crosses', () => {
    const edit = interpret([c(52.001, 13.05), c(51.999, 13.0502)], route, scale);
    if (edit?.kind !== 'blocked') throw new Error('not blocked');
    expect(Math.abs(edit.point.longitude - 13.05)).toBeLessThan(0.001);
    expect(Math.abs(edit.along - 3_425)).toBeLessThan(80);
  });

  test('a stroke off the route, or a slip, means nothing', () => {
    expect(interpret([c(52.01, 13.02), c(52.02, 13.06)], route, scale)).toBeNull();
    expect(interpret([c(52, 13.02), c(52, 13.0201)], route, scale)).toBeNull();
  });

  test('no-go points for an erase stay clear of both ends', () => {
    const found = points(route, 1_000, 3_000, 400, 300);
    expect(found).toHaveLength(4);
    expect(found[0].longitude).toBeGreaterThan(13.0186);
    expect(found.at(-1)!.longitude).toBeLessThan(13.0397);
  });

  test('a way with a dead end up and back fits a stroke worse than one without', () => {
    const straight = Array.from({ length: 41 }, (_, i) => c(52, 13 + i * 0.001));
    const spurred = [...straight.slice(0, 21), c(52.0013, 13.02), c(52.0027, 13.02), c(52.0013, 13.02), c(52, 13.02), ...straight.slice(21)];
    expect(retraced(straight)).toBeLessThan(30);
    expect(retraced(spurred)).toBeGreaterThan(200);
    expect(misfit(straight, straight)).toBeLessThan(misfit(spurred, straight));
  });

  test('a closed shape is an area to avoid, wherever the route is', () => {
    const stroke = ring(52, 13.05, 0.004);
    const edit = interpret(stroke, route, scale);
    if (edit?.kind !== 'avoidZone') throw new Error('not a zone');
    expect(edit.polygon).toHaveLength(stroke.length);
    // The route runs through it for about 900 m.
    const inside = stretches(route, edit.polygon);
    expect(inside).toHaveLength(1);
    expect(Math.abs(inside[0][1] - inside[0][0] - 870)).toBeLessThan(120);
  });

  test('circles cover an area, inside and to its edge', () => {
    const circles = coverage(ring(52, 13.05, 0.004));
    expect(circles.length).toBeGreaterThan(10);
    expect(circles.length).toBeLessThan(120);
    for (const probe of [c(52, 13.05), c(52.003, 13.05), c(52, 13.0545)]) {
      expect(circles.some((circle) => distance(circle.center, probe) <= circle.radius)).toBe(true);
    }
  });
});

const track = (coordinates: Coordinate[], extra: Partial<Track> = {}): Track => ({
  coordinates, elevations: coordinates.map((_, i) => 30 + (i % 10)), length: length(coordinates), duration: length(coordinates) / 5, ascent: 0, ...extra,
});

describe('a route with a part replaced', () => {
  const original = track(route);
  // A bow north from 2 km to 4 km.
  const bow = track([c(52, 13.0294), c(52.003, 13.04), c(52.003, 13.05), c(52, 13.0588)]);

  test('keeps everything outside the part as it was, and the connector between', () => {
    const spliced = replacing(original, 2_000, 4_000, bow);
    expect(spliced.coordinates[0]).toEqual(route[0]);
    expect(spliced.coordinates.at(-1)).toEqual(route.at(-1));
    expect(spliced.coordinates.some((p) => p.latitude > 52.002)).toBe(true);
    // Nothing of the old part is left between the cuts.
    expect(spliced.coordinates.filter((p) => p.latitude === 52 && p.longitude > 13.031 && p.longitude < 13.058)).toHaveLength(0);
    expect(spliced.elevations).toHaveLength(spliced.coordinates.length);
    // Plus the few metres from each cut to the connector's ends.
    expect(Math.abs(spliced.length - (original.length - 2_000 + bow.length))).toBeLessThan(80);
  });

  test('a missing cut is the route end: the connector starts or finishes it', () => {
    expect(replacing(original, null, 4_000, bow).coordinates[0]).toEqual(bow.coordinates[0]);
    expect(replacing(original, 2_000, null, bow).coordinates.at(-1)).toEqual(bow.coordinates.at(-1));
  });

  test('a line without time gets none, and one without heights keeps none', () => {
    const line = track(route, { duration: 0, elevations: [] });
    const spliced = replacing(line, 2_000, 4_000, bow);
    expect(spliced.duration).toBe(0);
    expect(spliced.elevations).toEqual([]);
  });
});

describe('planning an edit', () => {
  const original = track(route);
  /** A router that answers with a straight line through the waypoints, and keeps what it was asked. */
  const recording = () => {
    const asked: { waypoints: Coordinate[]; avoid: AvoidArea[] }[] = [];
    const router: Router = async (waypoints, avoid) => {
      asked.push({ waypoints, avoid });
      return track(waypoints.map((w) => c(w.latitude, w.longitude)));
    };
    return { asked, router };
  };

  test('an erase avoids the section, clear of its ends, and drops it', async () => {
    const { asked, router } = recording();
    const planned = await planEdit({ kind: 'erase', from: 2_000, to: 5_000 }, [], original, [], router);
    expect(asked).toHaveLength(1);
    expect(asked[0].avoid).toEqual(sectionAvoidance(route, 2_000, 5_000));
    expect(planned.avoid.length).toBeGreaterThan(0);
    expect(planned.removed).toEqual([2_000, 5_000]);
  });

  test('a ride-through tries three ways and keeps the one nearest the stroke', async () => {
    const { asked, router } = recording();
    const through = [c(52.004, 13.025), c(52.009, 13.04), c(52.004, 13.055)];
    const stroke = [c(52, 13.02), ...through, c(52, 13.06)];
    const planned = await planEdit({ kind: 'rideThrough', from: 1_370, to: 4_110, through }, stroke, original, [], router);
    expect(asked).toHaveLength(3);
    expect(asked[0].waypoints).toHaveLength(5);
    expect(asked[1].waypoints).toHaveLength(3);
    expect(asked[2].avoid.length).toBeGreaterThan(0);
    // The straight line through every drawn point is the one that fits.
    expect(planned.track.coordinates.some((p) => p.latitude === 52.009)).toBe(true);
  });

  test('blocked looks farther away each time no way round is found', async () => {
    const spans: number[] = [];
    const router: Router = async (waypoints, avoid) => {
      expect(avoid).toEqual([{ latitude: 52, longitude: 13.05, radius: blockRadius }]);
      spans.push(distance(waypoints[0], waypoints.at(-1)!));
      if (spans.length < 3) throw new Error('No route.');
      return track(waypoints.map((w) => c(w.latitude, w.longitude)));
    };
    const planned = await planEdit({ kind: 'blocked', point: c(52, 13.05), along: 3_425 }, [], original, [], router);
    // ±400 m, ±1,500 m, then from the start to 4 km past the spot.
    expect(spans.map((s) => Math.round(s / 100) * 100)).toEqual([800, 3_000, 7_400]);
    expect(planned.removed).toBeNull();
  });

  test('a zone the route crosses is ridden round, joined outside it', async () => {
    const { asked, router } = recording();
    const zone = ring(52, 13.05, 0.004);
    const result = await avoidZone(zone, original, [], router);
    expect(result.passes).toBe(true);
    expect(asked).toHaveLength(1);
    expect(asked[0].avoid.length).toBe(result.circles.length);
    const [start, end] = [asked[0].waypoints[0], asked[0].waypoints.at(-1)!];
    expect(start.longitude).toBeLessThan(13.0436);
    expect(end.longitude).toBeGreaterThan(13.0564);
  });

  test("a zone off the route is only remembered", async () => {
    const { asked, router } = recording();
    const result = await avoidZone(ring(52.05, 13.05, 0.004), original, [], router);
    expect(result.passes).toBe(false);
    expect(asked).toHaveLength(0);
    expect(result.track).toBe(original);
  });

  test('says what it did, and by how much when it matters', () => {
    expect(summary({ kind: 'erase', from: 0, to: 1 }, -7_800)).toMatch(/^Section erased · 7.8 km shorter$/);
    expect(summary({ kind: 'blocked', point: c(0, 0), along: 0 }, 20)).toBe('Riding around the block');
    expect(summary({ kind: 'rideThrough', from: 0, to: 1, through: [] }, 340)).toBe('Riding this way · 340 m longer');
  });
});

describe('no-go circles in the request', () => {
  test('go as nogos, lon,lat,radius each', () => {
    expect(nogos([{ latitude: 52.5, longitude: 13.4, radius: 40.4 }, { latitude: 52.51, longitude: 13.41, radius: 30 }]))
      .toBe('13.400000,52.500000,40|13.410000,52.510000,30');
    const url = routeURL('https://brouter.de/brouter', [{ latitude: 52.5, longitude: 13.4, kind: 'stop' }, { latitude: 52.6, longitude: 13.5, kind: 'stop' }],
      'trekking', 0, [{ latitude: 52.55, longitude: 13.45, radius: 30 }]);
    expect(url).toContain('nogos=13.450000,52.550000,30');
    expect(routeURL('https://brouter.de/brouter', [], 'trekking')).not.toContain('nogos');
  });
});

describe('"My Location" in a stop field', () => {
  test('is offered before anything is typed, and while the text could still mean it', () => {
    for (const text of ['', '  ', 'my', 'My Loc', 'current', 'Current Position', 'loc', 'stand', 'Aktuelle', 'mein standort']) {
      expect(matchesMyLocation(text), text).toBe(true);
    }
  });

  test('goes once it means something else', () => {
    for (const text of ['m', 'Alexanderplatz', 'my house', 'locarno', 'Standort Mitte']) {
      expect(matchesMyLocation(text), text).toBe(false);
    }
  });
});
