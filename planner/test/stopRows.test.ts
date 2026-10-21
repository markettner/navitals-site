// The app's StopListRowsTests.

import { describe, expect, test } from 'vitest';
import { stopRows, type StopRow } from '../src/core/stopRows';

/** `S` a stop, `b` a shaping point. */
const kinds = (pattern: string) => [...pattern].map((c) => c === 'b');
const point = (index: number): StopRow => ({ type: 'point', index });
const fold = (index: number, count: number, open = false): StopRow => ({ type: 'fold', index, count, open });

describe('stop list rows', () => {
  test('a short list is never folded, however many bends it has', () => {
    // A loop with a start, an end and three bends between.
    expect(stopRows(kinds('SbbbS'))).toEqual([0, 1, 2, 3, 4].map(point));
    expect(stopRows(kinds('SbbbbbbS'))).toEqual([0, 1, 2, 3, 4, 5, 6, 7].map(point));
  });

  test('in a long list, two or more bends in a row fold into one row; one alone stays', () => {
    expect(stopRows(kinds('SbSbbSbbbS'))).toEqual([
      point(0), point(1), point(2), fold(3, 2), point(5), fold(6, 3), point(9),
    ]);
  });

  test('an open run keeps its row and lists its bends after it', () => {
    expect(stopRows(kinds('SbbSbbbSSS'), (index) => index === 4)).toEqual([
      point(0), fold(1, 2), point(3), fold(4, 3, true), point(4), point(5), point(6), point(7), point(8), point(9),
    ]);
  });
});
