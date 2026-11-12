// The plan in the address, held to the app's docs/ROUTE_LINK.md by its examples.

import { describe, expect, test } from 'vitest';
import { decodePlan, encodePlan, planIn, viewIn, withPlan, withView, type PlanState } from '../src/core/urlState';
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

  test("stops' own names travel; bends', blank ones and placeholders don't", () => {
    const named: PlanState = {
      ...plan,
      points: [
        { ...plan.points[0], name: 'My Location' },
        { ...plan.points[1], name: 'Puschkinallee' },
        { ...plan.points[2], name: ' ' },
      ],
    };
    expect(withPlan('', named)).not.toContain('names=');
    named.points[0].name = 'Dropped Pin';
    named.points[2].name = 'Home';
    const hash = withPlan('#map=12/52.5/13.4', named);
    expect(hash).toBe('map=12/52.5/13.4&route=gravel;52.52192,13.41321;52.49300,13.45900,s;52.44000,13.64500&names=;;Home');
    expect(planIn(`#${hash}`)?.points.map((point) => point.name)).toEqual([undefined, undefined, 'Home']);
    // Set again, the plan replaces the names it had.
    expect(withPlan(`#${hash}`, plan)).toBe('map=12/52.5/13.4&route=gravel;52.52192,13.41321;52.49300,13.45900,s;52.44000,13.64500');
  });

  test('an alternative past those offered, or a circle that is not one, is left out', () => {
    expect(planIn('#route=gravel;52.5,13.4;52.4,13.5&alt=4')?.alternative).toBe(0);
    expect(planIn('#route=gravel;52.5,13.4;52.4,13.5&alt=-1')?.alternative).toBe(0);
    expect(planIn('#route=gravel;52.5,13.4;52.4,13.5&avoid=52.5,13.4,100;52.4,13.5,0')?.avoid).toEqual([]);
  });
});

describe("the map's view in the address", () => {
  test('replaces only its own part, leaving names exactly as written', () => {
    const hash = 'route=road;52.5,13.4;52.4,13.5&names=Caf%C3%A9%3B+Bar;&name=S%C3%BCd+%26+West';
    expect(withView(hash, '12/52.5/13.4')).toBe(`${hash}&map=12/52.5/13.4`);
    expect(withView(`map=11/52/13&${hash}`, '12.5/52.5/13.4/30')).toBe(`map=12.5/52.5/13.4/30&${hash}`);
    const plan = planIn(`#${withView(hash, '12/52.5/13.4')}`)!;
    expect(plan.points.map((point) => point.name)).toEqual(['Café; Bar', undefined]);
    expect(plan.name).toBe('Süd & West');
  });

  test("reads MapLibre's format, and nothing else", () => {
    expect(viewIn('#map=12.26/52.50952/13.39723')).toEqual({ zoom: 12.26, latitude: 52.50952, longitude: 13.39723, bearing: 0, pitch: 0 });
    expect(viewIn('#map=12/52.5/13.4/-20.5/45')).toEqual({ zoom: 12, latitude: 52.5, longitude: 13.4, bearing: -20.5, pitch: 45 });
    expect(viewIn('#map=12/95/13.4')).toBeNull();
    expect(viewIn('#map=12//13.4')).toBeNull();
    expect(viewIn('#route=road;52.5,13.4;52.4,13.5')).toBeNull();
  });
});
