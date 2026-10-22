// Fitting a track into a plan, as the app does (TrackFitTests.swift), in a world where every
// straight line is a road.

import { describe, expect, test } from 'vitest';
import type { Coordinate } from '../src/core/geodesy';
import type { Waypoint } from '../src/core/route';
import { alongOf, fitTrack, leastCoverage, misses, type Router } from '../src/core/trackFit';

const perDegreeLon = 111_320 * Math.cos((52.52 * Math.PI) / 180);

/** A point `east` and `north` metres from a Berlin origin. */
const at = (east: number, north: number): Coordinate => ({ latitude: 52.52 + north / 110_540, longitude: 13.40 + east / perDegreeLon });

const stop = (c: Coordinate, name: string): Waypoint => ({ latitude: c.latitude, longitude: c.longitude, name, kind: 'stop' });

/** A line through the corners, a point every 10 m. */
function path(corners: [number, number][]): Coordinate[] {
  const result: Coordinate[] = [];
  for (let c = 0; c + 1 < corners.length; c++) {
    const [a, b] = [corners[c], corners[c + 1]];
    const steps = Math.max(1, Math.floor(Math.hypot(b[0] - a[0], b[1] - a[1]) / 10));
    for (let step = 0; step < steps; step++) {
      const t = step / steps;
      result.push(at(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t));
    }
  }
  const [east, north] = corners.at(-1)!;
  result.push(at(east, north));
  return result;
}

/** The route is the waypoints joined up. */
const straight: Router = async (waypoints) => waypoints.map(({ latitude, longitude }) => ({ latitude, longitude }));

const ends = (track: Coordinate[]) => [stop(track[0], 'A'), stop(track.at(-1)!, 'B')];

describe('fitting a track into a plan', () => {
  test('a track the stops alone already give needs no shaping point', async () => {
    const track = path([[0, 0], [3000, 0]]);
    const fit = await fitTrack(track, ends(track), straight);
    expect(fit?.waypoints.filter((w) => w.kind === 'shaping')).toHaveLength(0);
    expect(fit?.routings).toBe(1);
  });

  test('a bend gets shaping points until the route follows it, and only those it needs stay', async () => {
    const track = path([[0, 0], [2000, 0], [2000, 2000], [4000, 2000]]);
    const fit = (await fitTrack(track, ends(track), straight))!;
    expect(fit.coverage).toBeGreaterThanOrEqual(leastCoverage);
    const shaping = fit.waypoints.filter((w) => w.kind === 'shaping').length;
    expect(shaping).toBeGreaterThanOrEqual(2);
    expect(shaping).toBeLessThanOrEqual(6);
    expect([fit.waypoints[0].name, fit.waypoints.at(-1)!.name]).toEqual(['A', 'B']);
    expect(fit.waypoints.slice(1, -1).every((w) => w.kind === 'shaping')).toBe(true);
  });

  test("stops in the middle stay stops, in the track's order, with shaping points between them", async () => {
    const track = path([[0, 0], [2000, 0], [2000, 2000], [0, 2000]]);
    const fit = (await fitTrack(track, [stop(track[0], 'A'), stop(at(2000, 1000), 'Lake'), stop(track.at(-1)!, 'B')], straight))!;
    expect(fit.waypoints.filter((w) => w.kind === 'stop').map((w) => w.name)).toEqual(['A', 'Lake', 'B']);
    expect(fit.coverage).toBeGreaterThanOrEqual(leastCoverage);
  });

  test('where the route will not go through a shaping point, the fit gives up', async () => {
    const track = path([[0, 0], [2000, 0], [2000, 2000], [4000, 2000]]);
    // BRouter on a lake: shaping points are ignored, and the route cuts across.
    let routings = 0;
    const ignoring: Router = async (waypoints) => {
      routings++;
      return waypoints.filter((w) => w.kind === 'stop');
    };
    expect(await fitTrack(track, ends(track), ignoring)).toBeNull();
    // Two rounds that follow no more of the track than the first, and it stops asking.
    expect(routings).toBe(3);
  });

  test('no route at all is an error, not a failed fit', async () => {
    const track = path([[0, 0], [3000, 0]]);
    await expect(fitTrack(track, ends(track), async () => { throw new Error('No tiles'); })).rejects.toThrow('No tiles');
  });

  test('a fit out of budget while still adding shaping points gives up; one taking them out keeps the rest', async () => {
    const track = path([[0, 0], [2000, 0], [2000, 2000], [4000, 2000]]);
    expect(await fitTrack(track, ends(track), straight, { mayRoute: () => false })).toBeNull();
    // Out of budget at the first shaping point taken out: every one added stays.
    let previous = 0, removing = false;
    const watching: Router = (waypoints) => {
      const shaping = waypoints.filter((w) => w.kind === 'shaping').length;
      if (shaping < previous) removing = true;
      previous = shaping;
      return straight(waypoints);
    };
    const kept = (await fitTrack(track, ends(track), watching, { mayRoute: () => !removing }))!;
    const fewest = (await fitTrack(track, ends(track), straight))!;
    expect(kept.coverage).toBeGreaterThanOrEqual(leastCoverage);
    expect(kept.waypoints.length).toBeGreaterThan(fewest.waypoints.length);
  });

  test('a fit cancelled stops with the cancellation', async () => {
    const track = path([[0, 0], [2000, 0], [2000, 2000], [4000, 2000]]);
    const controller = new AbortController();
    const cancelled: Router = (waypoints) => { controller.abort(); return straight(waypoints); };
    await expect(fitTrack(track, ends(track), cancelled, { signal: controller.signal })).rejects.toThrow();
  });

  test('a miss is a run of the track the line passes far from, long enough to be another way', () => {
    const track = path([[0, 0], [1000, 0]]);
    const line = path([[0, 0], [300, 0], [300, 100], [500, 100], [500, 0], [1000, 0]]);
    const along = alongOf(track);
    const found = misses(track, along, line);
    expect(found).toHaveLength(1);
    expect(along[found[0][0]]).toBeGreaterThan(300);
    expect(along[found[0][1]]).toBeLessThan(500);
  });
});
