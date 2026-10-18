// The app's RouteLabelPlacementTests.

import { describe, expect, test } from 'vitest';
import { labelAnchors } from '../src/core/labels';

const c = (latitude: number, longitude: number) => ({ latitude, longitude });

describe('route labels', () => {
  test('a route alone is labelled halfway along', () => {
    expect(Math.abs(labelAnchors([[c(52, 13), c(52, 13.1)]])[0]!.longitude - 13.05)).toBeLessThan(0.002);
  });

  test('two routes sharing their ends are labelled where they are furthest apart', () => {
    const anchors = labelAnchors([[c(52, 13), c(52, 13.1)], [c(52, 13), c(52.03, 13.05), c(52, 13.1)]]);
    expect(anchors[1]!.latitude).toBeGreaterThan(52.025);
    expect(Math.abs(anchors[1]!.longitude - 13.05)).toBeLessThan(0.01);
  });
});
