// The app's RoutePositionTests.

import { describe, expect, test } from 'vitest';
import { climbing, insertionIndex, prefix, stopPositions, suffix, type Coordinate } from '../src/core/geodesy';

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

describe('climbing', () => {
  test('rises count once they clear the threshold; noise on the flat does not', () => {
    expect(climbing([30, 31, 30, 32, 31, 30, 33, 30])).toBe(0);
    expect(climbing([30, 40, 35, 50])).toBe(25);
    expect(climbing([100, 90, 80, 95])).toBe(15);
    expect(climbing([])).toBe(0);
  });
});
