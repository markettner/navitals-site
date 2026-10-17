// The app's RoutePositionTests, and the plan in the address.

import { describe, expect, test } from 'vitest';
import { climbing, insertionIndex, prefix, stopPositions, suffix, type Coordinate } from '../src/core/geodesy';
import { decodePlan, encodePlan, planIn, withPlan } from '../src/core/urlState';

const c = (latitude: number, longitude: number): Coordinate => ({ latitude, longitude });

describe('positions along a route', () => {
  /** East along one road to a turning point, then back west along the same road. */
  const outAndBack = [c(52.5, 13.4), c(52.5, 13.41), c(52.5, 13.42), c(52.5, 13.43), c(52.5, 13.42), c(52.5, 13.41), c(52.5, 13.4)];

  test('a stop on the way home is placed on the way home, not on the way out', () => {
    const positions = stopPositions([c(52.5, 13.4), c(52.5, 13.43), c(52.5, 13.41), c(52.5, 13.4)], outAndBack);
    expect(positions[0]).toBe(0);
    expect(positions[1]).toBeCloseTo(3, 2);
    expect(positions[2]).toBeCloseTo(5, 2);
    expect(positions[3]).toBe(6);
  });

  test('a dragged point goes between the stops the route passes either side of it', () => {
    const positions = [0, 3, 5, 6];
    expect(insertionIndex(1.5, positions)).toBe(1);
    expect(insertionIndex(4.2, positions)).toBe(2);
    expect(insertionIndex(5.5, positions)).toBe(3);
    expect(insertionIndex(0, positions)).toBe(1);
    expect(insertionIndex(6, positions)).toBe(3);
  });

  test('prefix and suffix meet exactly at the split', () => {
    const route = [c(0, 0), c(0, 1), c(0, 2)];
    const head = prefix(route, 1.5), tail = suffix(route, 1.5);
    expect(head).toHaveLength(3);
    expect(head[2].longitude).toBeCloseTo(1.5, 9);
    expect(tail).toHaveLength(2);
    expect(tail[0].longitude).toBeCloseTo(1.5, 9);
    expect(suffix(route, 1)).toHaveLength(2);
  });
});

describe('the plan in the address', () => {
  const plan = {
    sport: 'gravel' as const,
    points: [
      { latitude: 52.5219184, longitude: 13.4132147, kind: 'stop' as const },
      { latitude: 52.493, longitude: 13.459, kind: 'shaping' as const },
      { latitude: 52.44, longitude: 13.645, kind: 'stop' as const },
    ],
  };

  test('reads back what it writes, to a metre', () => {
    expect(encodePlan(plan)).toBe('gravel;52.52192,13.41321;52.49300,13.45900,s;52.44000,13.64500');
    const back = decodePlan(encodePlan(plan))!;
    expect(back.sport).toBe('gravel');
    expect(back.points.map((p) => p.kind)).toEqual(['stop', 'shaping', 'stop']);
    expect(back.points[0].latitude).toBeCloseTo(52.52192, 5);
  });

  test("lives beside MapLibre's view in the hash, and leaves it alone", () => {
    const hash = withPlan('#map=12/52.5/13.4', plan);
    expect(hash).toBe('map=12/52.5/13.4&route=gravel;52.52192,13.41321;52.49300,13.45900,s;52.44000,13.64500');
    expect(planIn(`#${hash}`)?.points).toHaveLength(3);
    expect(withPlan(`#${hash}`, null)).toBe('map=12/52.5/13.4');
  });

  test('a link that is not a plan is no plan, and ends are never bends', () => {
    expect(decodePlan('bike;52.5,13.4;52.4,13.5')).toBeNull();
    expect(decodePlan('gravel;52.5,13.4')).toBeNull();
    expect(decodePlan('gravel;52.5,13.4;95,13.5')).toBeNull();
    expect(decodePlan('gravel;52.5,13.4;52.4,13.5,x')).toBeNull();
    expect(decodePlan('gravel;52.5,13.4,s;52.4,13.5,s')?.points.map((p) => p.kind)).toEqual(['stop', 'stop']);
  });
});

describe('climbing', () => {
  test('rises count once they clear the threshold; noise on the flat does not', () => {
    expect(climbing([30, 31, 30, 32, 31, 30, 33, 30])).toBe(0);
    expect(climbing([30, 40, 35, 50])).toBe(25);
    expect(climbing([100, 90, 80, 95])).toBe(15);
    expect(climbing([])).toBe(0);
  });
});
