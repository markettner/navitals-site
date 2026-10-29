// The rider's own names for stops: the app's PlaceNamesTests and its renamed-route contract example.

import { describe, expect, test } from 'vitest';
import renamedRoute from './fixtures/renamed-route.gpx?raw';
import { writeRoute } from '../src/core/gpx';
import { parseGPX } from '../src/core/gpxReader';
import type { Waypoint } from '../src/core/route';
import { geocoded, renamed, type Place } from '../src/core/search';

const square: Place = {
  id: 'W:4711', name: 'Garnisonkirchplatz 2', subtitle: 'Mitte, Berlin',
  latitude: 52.5231, longitude: 13.4028, kind: 'address',
};

describe('renaming a place', () => {
  test("a rename keeps the place's own name, and a blank one gives it back", () => {
    const home = renamed(square, '  Home ');
    expect(home.name).toBe('Home');
    expect(home.originalName).toBe('Garnisonkirchplatz 2');
    expect(renamed(home, 'Office').originalName).toBe('Garnisonkirchplatz 2');
    expect(renamed(home, '')).toEqual(square);
    expect(renamed(home, 'Garnisonkirchplatz 2')).toEqual(square);
  });

  test('"My Location" is not a name a stop can take', () => {
    expect(renamed(square, 'My Location')).toEqual(square);
  });

  test("a late lookup names the place underneath, not over the rider's name", () => {
    const pin: Place = { id: 'at:1', name: '52.52310, 13.40280', subtitle: 'Dropped pin', latitude: 52.5231, longitude: 13.4028, kind: 'other' };
    const found = geocoded(renamed(pin, 'Bench'), square);
    expect(found.name).toBe('Bench');
    expect(found.originalName).toBe('Garnisonkirchplatz 2');
    expect(geocoded(pin, square)).toEqual(square);
  });
});

describe('renamed stops in route GPX', () => {
  const waypoints: Waypoint[] = [
    { latitude: 52.5219184, longitude: 13.4132147, name: 'Home', originalName: 'Alexanderplatz', kind: 'stop' },
    { latitude: 52.493, longitude: 13.459, name: 'Puschkinallee', kind: 'shaping' },
    { latitude: 52.488, longitude: 13.472, name: 'Picnic', originalName: 'Treptower Park', kind: 'stop' },
    { latitude: 52.46, longitude: 13.53, name: 'An der Wuhlheide', kind: 'shaping' },
    { latitude: 52.44, longitude: 13.645, name: 'Müggelsee', kind: 'stop' },
  ];
  const line = [
    [52.5219184, 13.4132147], [52.505, 13.44], [52.493, 13.459], [52.488, 13.472],
    [52.46, 13.53], [52.45, 13.59], [52.44, 13.645],
  ].map(([latitude, longitude]) => ({ latitude, longitude }));

  test("are written exactly as the contract's example", () => {
    expect(writeRoute('Home to Müggelsee', 'gravel', line, waypoints)).toBe(renamedRoute);
  });

  test('come back with both names', () => {
    const planned = parseGPX(renamedRoute).plannedPoints!;
    expect(planned.map((point) => point.name)).toEqual(['Home', 'Puschkinallee', 'Picnic', 'An der Wuhlheide', 'Müggelsee']);
    expect(planned.map((point) => point.originalName)).toEqual(['Alexanderplatz', undefined, 'Treptower Park', undefined, undefined]);
  });
});
