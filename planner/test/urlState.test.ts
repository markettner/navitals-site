// The plan in the address, held to the app's docs/ROUTE_LINK.md by its examples.

import { describe, expect, test } from 'vitest';
import { decodePlan, encodePlan, planIn, withPlan, type PlanState } from '../src/core/urlState';
import links from './fixtures/route-links.json';

type Example = { about: string; hash: string; plan: PlanState };

describe('the route link examples', () => {
  test.each((links.written as Example[]).map((example) => [example.about, example] as const))('writes %s', (_, example) => {
    expect(withPlan('', example.plan)).toBe(example.hash);
  });

  test.each(([...links.written, ...links.read] as Example[]).map((example) => [example.about, example] as const))('reads %s', (_, example) => {
    expect(planIn(`#${example.hash}`)).toEqual(example.plan);
  });

  test.each(links.rejected.map((example) => [example.about, example.hash] as const))('rejects %s', (_, hash) => {
    expect(planIn(`#${hash}`)).toBeNull();
  });
});

describe('the plan in the address', () => {
  const plan: PlanState = {
    sport: 'gravel',
    points: [
      { latitude: 52.5219184, longitude: 13.4132147, kind: 'stop' },
      { latitude: 52.493, longitude: 13.459, kind: 'shaping' },
      { latitude: 52.44, longitude: 13.645, kind: 'stop' },
    ],
    alternative: 0,
    avoid: [],
    without: [],
    name: null,
  };

  test('reads back what it writes, to a metre', () => {
    expect(encodePlan(plan)).toBe('gravel;52.52192,13.41321;52.49300,13.45900,s;52.44000,13.64500');
    const back = decodePlan(encodePlan(plan))!;
    expect(back.sport).toBe('gravel');
    expect(back.points.map((p) => p.kind)).toEqual(['stop', 'shaping', 'stop']);
    expect(back.points[0].latitude).toBeCloseTo(52.52192, 5);
  });

  test("lives beside MapLibre's view in the hash, and leaves it alone", () => {
    const hash = withPlan('#map=12/52.5/13.4', { ...plan, alternative: 1, name: 'Loop' });
    expect(hash).toBe('map=12/52.5/13.4&route=gravel;52.52192,13.41321;52.49300,13.45900,s;52.44000,13.64500&alt=1&name=Loop');
    expect(planIn(`#${hash}`)?.points).toHaveLength(3);
    expect(withPlan(`#${hash}`, null)).toBe('map=12/52.5/13.4');
    expect(withPlan(`#${hash}`, plan)).toBe('map=12/52.5/13.4&route=gravel;52.52192,13.41321;52.49300,13.45900,s;52.44000,13.64500');
  });

  test('a link that is not a plan is no plan, and ends are never bends', () => {
    expect(decodePlan('bike;52.5,13.4;52.4,13.5')).toBeNull();
    expect(decodePlan('gravel;52.5,13.4')).toBeNull();
    expect(decodePlan('gravel;52.5,13.4;95,13.5')).toBeNull();
    expect(decodePlan('gravel;52.5,13.4;52.4,13.5,x')).toBeNull();
    expect(decodePlan('gravel;52.5,;52.4,13.5')).toBeNull();
    expect(decodePlan('gravel;5e1,13.4;52.4,13.5')).toBeNull();
    expect(decodePlan(['gravel', ...Array(201).fill('52.5,13.4')].join(';'))).toBeNull();
    expect(decodePlan('gravel;52.5,13.4,s;52.4,13.5,s')?.points.map((p) => p.kind)).toEqual(['stop', 'stop']);
  });

  test('an alternative past those offered, or a circle that is not one, is left out', () => {
    expect(planIn('#route=gravel;52.5,13.4;52.4,13.5&alt=4')?.alternative).toBe(0);
    expect(planIn('#route=gravel;52.5,13.4;52.4,13.5&alt=-1')?.alternative).toBe(0);
    expect(planIn('#route=gravel;52.5,13.4;52.4,13.5&avoid=52.5,13.4,100;52.4,13.5,0')?.avoid).toEqual([]);
  });
});
