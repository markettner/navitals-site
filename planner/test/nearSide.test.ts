// The app's BRouterNearSideTests, on the same fixture.

import { describe, expect, test } from 'vitest';
import fixtureText from './fixtures/brouter-far-side-via.json?raw';
import { distance, distanceToLine, type Coordinate } from '../src/core/geodesy';
import { nearSideWaypoints } from '../src/core/nearSide';
import type { Waypoint } from '../src/core/route';

interface Fixture { farVia: number[]; nearVia: number[]; farLine: number[][]; nearLine: number[][] }
const fixture = JSON.parse(fixtureText) as Fixture;
const line = (points: number[][]): Coordinate[] => points.map(([longitude, latitude]) => ({ latitude, longitude }));

/** The line's own ends, with the via between them, as the app would send them. */
function waypoints(route: Coordinate[], via: number[], kind: Waypoint['kind'] = 'shaping'): Waypoint[] {
  return [{ ...route[0], kind: 'stop' }, { latitude: via[1], longitude: via[0], kind }, { ...route.at(-1)!, kind: 'stop' }];
}

/** Metres east and north of a corner in Berlin, as a coordinate. */
const at = (east: number, north: number): Coordinate => ({
  latitude: 52.5 + north / 110_540,
  longitude: 13.4 + east / (111_320 * Math.cos((52.5 * Math.PI) / 180)),
});

describe('a shaping point on the far side of a divided road', () => {
  test('An der Wuhlheide: the loop through the far carriageway moves the point to the near side', () => {
    const far = line(fixture.farLine);
    const points = waypoints(far, fixture.farVia);
    const moved = nearSideWaypoints(points, far)!;
    expect(moved).not.toBeNull();
    expect(moved[0]).toEqual(points[0]);
    expect(moved[2]).toEqual(points[2]);
    expect(moved[1].kind).toBe('shaping');
    const gap = distance(moved[1], { latitude: fixture.farVia[1], longitude: fixture.farVia[0] });
    expect(gap).toBeGreaterThan(10);
    expect(gap).toBeLessThan(40);
    // On the eastbound carriageway, south of the westbound one the point was dropped on.
    expect(moved[1].latitude).toBeLessThan(fixture.farVia[1]);
    expect(distanceToLine(line(fixture.nearLine), moved[1])).toBeLessThan(10);
  });

  test('a stop on the far side is left where it is: it must be reached', () => {
    const far = line(fixture.farLine);
    expect(nearSideWaypoints(waypoints(far, fixture.farVia, 'stop'), far)).toBeNull();
  });

  test('a point the route reaches without a detour is left where it is', () => {
    const near = line(fixture.nearLine);
    expect(nearSideWaypoints(waypoints(near, fixture.nearVia), near)).toBeNull();
  });

  test('a loop round a block, passing the point on a cross street, is a shape and stays', () => {
    const route = [at(-100, 0), at(300, 0), at(300, 30), at(300, 200), at(0, 200), at(0, 0), at(500, 0)];
    const points: Waypoint[] = [{ ...route[0], kind: 'stop' }, { ...at(300, 30), kind: 'shaping' }, { ...route[6], kind: 'stop' }];
    expect(nearSideWaypoints(points, route)).toBeNull();
  });

  test('an out-and-back after the next stop does not count against the point', () => {
    const route = [at(0, 0), at(400, 0), at(800, 0), at(800, -20), at(400, -20), at(0, -20)];
    const points: Waypoint[] = [{ ...route[0], kind: 'stop' }, { ...route[1], kind: 'shaping' },
      { ...route[2], kind: 'stop' }, { ...route[5], kind: 'stop' }];
    expect(nearSideWaypoints(points, route)).toBeNull();
  });

  test('without a shaping point between the ends there is nothing to move', () => {
    const far = line(fixture.farLine);
    const [start, , end] = waypoints(far, fixture.farVia);
    expect(nearSideWaypoints([start, end], far)).toBeNull();
  });
});
