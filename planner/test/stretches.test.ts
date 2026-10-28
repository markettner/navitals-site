// Re-planning only the stretches an edit touched, as the app does (BRouterStretchesTests.swift):
// the keys, the windows, cutting and splicing, the Berliner Mauerweg's real case, and what is asked
// of brouter.de.

import { describe, expect, test } from 'vitest';
import fixtureText from './fixtures/brouter-mauerweg-replan.json?raw';
import type { Track } from '../src/core/brouter';
import { length, type Coordinate } from '../src/core/geodesy';
import type { Waypoint } from '../src/core/route';
import {
  joined, replanned, replanWindows, routeStretches, spliced, StretchCache, stretchContext, stretches, stretchKeys,
} from '../src/core/stretches';

const point = (latitude: number, longitude: number, kind: Waypoint['kind'] = 'stop'): Waypoint => ({ latitude, longitude, kind });

/** Stop, shaping, shaping, stop, stop. */
const plan = [point(52.50, 13.30), point(52.51, 13.31, 'shaping'), point(52.52, 13.32, 'shaping'),
  point(52.53, 13.33), point(52.54, 13.34)];

const changed = (a: Waypoint[], b: Waypoint[]) => {
  const before = stretchKeys(a), after = stretchKeys(b);
  return before.map((key, s) => key !== after[s]);
};

describe('stretch keys', () => {
  test('a stretch is its two points as BRouter is sent them, and the point beyond a shaping end', () => {
    const keys = stretchKeys(plan);
    expect(keys).toHaveLength(4);
    expect(keys[0]).toBe('>13.300000,52.500000>13.310000,52.510000>13.320000,52.520000');
    expect(keys[1]).toBe('13.300000,52.500000>13.310000,52.510000>13.320000,52.520000>13.330000,52.530000,m');
    // Between two stops nothing looks past the ends: BRouter never corrects a meeting point.
    expect(keys[3]).toBe('>13.330000,52.530000,m>13.340000,52.540000>');
  });

  test('moving a shaping point changes its stretches and the ones that reach past a shaping end to it', () => {
    const moved = plan.map((p) => ({ ...p }));
    moved[2].latitude += 0.001;
    expect(changed(plan, moved)).toEqual([true, true, true, false]);
  });

  test('moving a stop changes its own two stretches, and those reaching past a shaping end to it', () => {
    let moved = plan.map((p) => ({ ...p }));
    moved[4].longitude += 0.001;
    expect(changed(plan, moved)).toEqual([false, false, false, true]);
    moved = plan.map((p) => ({ ...p }));
    moved[3].longitude += 0.001;
    expect(changed(plan, moved)).toEqual([false, true, true, true]);
  });

  test('the keys are the app\'s', () => {
    // Same points, same strings as `BRouter.stretchKeys`: before, from, to, after.
    const keys = stretchKeys([point(52.5162535, 13.3774033), point(52.5390094, 13.3774683, 'shaping'), point(52.5351967, 13.3896203)]);
    expect(keys).toEqual(['>13.377403,52.516253>13.377468,52.539009>13.389620,52.535197', '13.377403,52.516253>13.377468,52.539009>13.389620,52.535197>']);
  });
});

describe('windows', () => {
  test('each run of unknown stretches is asked for with one known stretch on either side', () => {
    expect(replanWindows([false, false, true, true, false, false, false])).toEqual([[1, 5]]);
    expect(replanWindows([true, false, false, false])).toEqual([[0, 2]]);
    expect(replanWindows([false, false, false, true])).toEqual([[2, 4]]);
    expect(replanWindows([true, true, true])).toEqual([[0, 3]]);
    expect(replanWindows([false, false, false])).toEqual([]);
    expect(replanWindows([false, true, false, true, false, false])).toEqual([[0, 5]]);
    expect(replanWindows([true, false, false, true, false, false, false])).toEqual([[0, 2], [2, 5]]);
  });
});

/** A track along a parallel, one point every 0.001°, with heights. */
function track(points = 11, from = 13.3): Track {
  const coordinates = Array.from({ length: points }, (_, i) => ({ latitude: 52.5, longitude: from + i * 0.001 }));
  return { coordinates, elevations: coordinates.map((_, i) => 30 + i * 10), length: length(coordinates), duration: (points - 1) * 10, ascent: (points - 1) * 10 };
}

const on = (line: Coordinate[], index: number, kind: Waypoint['kind'] = 'shaping') => point(line[index].latitude, line[index].longitude, kind);

describe('cutting and joining', () => {
  test('cut at its waypoints and joined again, a track is what it was', () => {
    const whole = track();
    const cut = stretches(whole, [0, 3, 6, 10].map((i) => on(whole.coordinates, i)));
    expect(cut?.map((s) => s.coordinates.length)).toEqual([4, 4, 5]);
    expect(cut?.[1].elevations).toEqual([60, 70, 80, 90]);
    const again = joined(cut!);
    expect(again?.coordinates).toEqual(whole.coordinates);
    expect(again?.elevations).toEqual(whole.elevations);
    expect(again?.length).toBeCloseTo(whole.length, 6);
    expect(again?.duration).toBeCloseTo(whole.duration, 6);
    expect(again?.ascent).toBeCloseTo(whole.ascent, 6);
  });

  test('pieces that do not meet are not joined', () => {
    expect(joined([track(4), track(4, 13.4)])).toBeNull();
  });

  test('a window is joined where it first and last runs with the line kept', () => {
    // The window starts with a spur north (a correction the kept line had made) and bends south
    // on the way.
    const kept = track(21);
    const line = kept.coordinates;
    const waypoints = [0, 5, 10, 15, 20].map((i) => on(line, i));
    const known = stretches(kept, waypoints)!;
    const north = { latitude: 52.5005, longitude: line[5].longitude };
    const window = [north, ...line.slice(5, 16)].map((p, i) => (i === 8 || i === 9 ? { ...p, latitude: p.latitude - 0.002 } : p));
    const routed: Track = { coordinates: window, elevations: [], length: length(window), duration: 0, ascent: 0 };
    const piece = spliced(routed, [{ ...north, kind: 'shaping' }, waypoints[2], waypoints[3]], known[1], known[2])!;
    expect(piece.coordinates[0]).toEqual(line[5]);
    expect(piece.coordinates.at(-1)).toEqual(line[15]);
    expect(piece.coordinates).not.toContainEqual(north);
    expect(piece.coordinates.filter((p) => p.latitude < 52.5)).toHaveLength(2);
    expect(piece.coordinates).toHaveLength(11);
  });
});

interface Mauerweg {
  oldPoints: [number, number, string][];
  newPoints: [number, number, string][];
  old: number[][];
  expected: number[][];
  window: number[][];
  narrow: number[][];
}
const mauerweg = JSON.parse(fixtureText) as Mauerweg;
const points = (list: Mauerweg['oldPoints']) => list.map(([latitude, longitude, kind]) => point(latitude, longitude, kind === 'shaping' ? 'shaping' : 'stop'));
const line = (list: number[][]): Track => {
  const coordinates = list.map(([longitude, latitude]) => ({ latitude, longitude }));
  return { coordinates, elevations: [], length: length(coordinates), duration: 0, ascent: 0 };
};

describe('the Berliner Mauerweg', () => {
  // Shaping points 28–36 of docs/demo-routes/berliner-mauerweg.gpx, before and after moving point
  // 32 by 140 m, as SwiftBRouter routed them: `old` and `expected` are cut from the two full plans,
  // `window` is points 29–35 of the moved plan alone, `narrow` points 31–33.
  const before = points(mauerweg.oldPoints), after = points(mauerweg.newPoints);
  const cut = stretches(line(mauerweg.old), before)!;

  test('the moved point\'s window spliced in is the full plan, point for point', () => {
    const known = new Map(stretchKeys(before).map((key, s) => [key, cut[s]]));
    const lookedUp = stretchKeys(after).map((key) => known.get(key) ?? null);
    expect(lookedUp.map((t) => t === null)).toEqual([false, false, true, true, true, true, false, false]);
    expect(replanWindows(lookedUp.map((t) => t === null))).toEqual([[1, 7]]);
    const whole = replanned(lookedUp, [{ waypoints: [1, 7], track: line(mauerweg.window) }], after);
    expect(whole?.coordinates).toEqual(line(mauerweg.expected).coordinates);
  });

  test('the window from the moved point\'s neighbours alone does not reach the unchanged line', () => {
    // The full plan trims a spur at point 33, which a window ending there cannot know about.
    expect(spliced(line(mauerweg.narrow), after.slice(3, 6), cut[3], cut[4])).toBeNull();
  });
});

describe('asking brouter.de', () => {
  /** A stand-in for brouter.de: straight lines between the points, ten vertices a stretch, so a
   *  stretch is the same whichever request it is part of. Records what it was asked for. */
  function router() {
    const asked: Waypoint[][] = [];
    const route = async (waypoints: Waypoint[]): Promise<Track> => {
      asked.push(waypoints);
      const coordinates: Coordinate[] = [waypoints[0]].map(({ latitude, longitude }) => ({ latitude, longitude }));
      for (let s = 1; s < waypoints.length; s++) {
        const a = waypoints[s - 1], b = waypoints[s];
        for (let i = 1; i <= 10; i++) {
          coordinates.push({ latitude: a.latitude + (b.latitude - a.latitude) * i / 10, longitude: a.longitude + (b.longitude - a.longitude) * i / 10 });
        }
      }
      return { coordinates, elevations: [], length: length(coordinates), duration: 0, ascent: 0 };
    };
    return { asked, route };
  }
  const shaped = Array.from({ length: 9 }, (_, i) => point(52.5 + i * 0.01, 13.3 + (i % 2) * 0.01, i % 3 && i < 8 ? 'shaping' : 'stop'));

  test('the first plan is asked for whole; a moved point, only its window', async () => {
    const brouter = router(), cache = new StretchCache(), context = stretchContext('cycling', []);
    await routeStretches(shaped, cache, context, brouter.route);
    expect(brouter.asked).toEqual([shaped]);

    const moved = shaped.map((p) => ({ ...p }));
    moved[4].latitude += 0.003;
    const result = await routeStretches(moved, cache, context, brouter.route);
    // Point 4 is a shaping point between shaping point 5 and stop 3: stretches 3–5 change, and the
    // window adds one known stretch either side.
    expect(brouter.asked[1]).toEqual(moved.slice(2, 8));
    expect(result.coordinates).toEqual((await router().route(moved)).coordinates);
    expect(result.length).toBeCloseTo(length(result.coordinates), 6);
  });

  test('undo asks nothing: every stretch of the plan before is still known', async () => {
    const brouter = router(), cache = new StretchCache(), context = stretchContext('cycling', []);
    const moved = shaped.map((p) => ({ ...p }));
    moved[4].latitude += 0.003;
    await routeStretches(shaped, cache, context, brouter.route);
    await routeStretches(moved, cache, context, brouter.route);
    const back = await routeStretches(shaped, cache, context, brouter.route);
    expect(brouter.asked).toHaveLength(2);
    expect(back.coordinates).toEqual((await router().route(shaped)).coordinates);
  });

  test('another sport, places or ways to avoid, or hour starts afresh', async () => {
    const brouter = router(), cache = new StretchCache();
    await routeStretches(shaped, cache, stretchContext('cycling', []), brouter.route);
    await routeStretches(shaped, cache, stretchContext('gravel', []), brouter.route);
    await routeStretches(shaped, cache, stretchContext('gravel', [{ latitude: 52.5, longitude: 13.3, radius: 30 }]), brouter.route);
    await routeStretches(shaped, cache, stretchContext('gravel', [{ latitude: 52.5, longitude: 13.3, radius: 30 }], ['ferries']), brouter.route);
    const hour = 3_600_000;
    expect(stretchContext('gravel', [], [], 5 * hour)).not.toBe(stretchContext('gravel', [], [], 6 * hour));
    expect(brouter.asked).toHaveLength(4);
    expect(brouter.asked.every((asked) => asked.length === shaped.length)).toBe(true);
  });

  test('more windows than allowed are one request for the whole plan', async () => {
    const brouter = router(), cache = new StretchCache(), context = stretchContext('cycling', []);
    const long = Array.from({ length: 20 }, (_, i) => point(52.5 + i * 0.01, 13.3 + (i % 2) * 0.01, i % 19 ? 'shaping' : 'stop'));
    await routeStretches(long, cache, context, brouter.route);
    const moved = long.map((p) => ({ ...p }));
    moved[3].latitude += 0.003;
    moved[15].latitude += 0.003;
    await routeStretches(moved, cache, context, brouter.route);
    expect(brouter.asked).toHaveLength(3);
    moved[3].latitude += 0.003;
    moved[15].latitude += 0.003;
    const result = await routeStretches(moved, cache, context, brouter.route, 1);
    expect(brouter.asked).toHaveLength(4);
    expect(brouter.asked[3]).toEqual(moved);
    expect(result.coordinates).toEqual((await router().route(moved)).coordinates);
  });

  test('the cache keeps the newest stretches', async () => {
    const cache = new StretchCache(5);
    await routeStretches(shaped, cache, 'x', router().route);
    expect(cache.size).toBe(5);
    // The last five stretches of the plan are the ones kept.
    expect(cache.lookUp(stretchKeys(shaped), 'x').map((t) => t !== null)).toEqual([false, false, false, true, true, true, true, true]);
  });
});
