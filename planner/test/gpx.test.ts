// The app's RouteGPXTests for the writer: the same examples, byte for byte.

import { describe, expect, test } from 'vitest';
import lineRoute from './fixtures/line-route.gpx?raw';
import navitalsRoute from './fixtures/navitals-route.gpx?raw';
import { escape, fileName, writeRoute } from '../src/core/gpx';
import type { Waypoint } from '../src/core/route';

/** The route in navitals-route.gpx (the app's RouteGPXSample): Alexanderplatz to the Müggelsee on
 *  gravel, with a stop at Treptower Park and a shaping point on either side of it. */
const sampleWaypoints: Waypoint[] = [
  { latitude: 52.5219184, longitude: 13.4132147, name: 'Alexanderplatz', kind: 'stop' },
  { latitude: 52.493, longitude: 13.459, name: 'Puschkinallee', kind: 'shaping' },
  { latitude: 52.488, longitude: 13.472, name: 'Treptower Park', kind: 'stop' },
  { latitude: 52.46, longitude: 13.53, name: 'An der Wuhlheide', kind: 'shaping' },
  { latitude: 52.44, longitude: 13.645, name: 'Müggelsee', kind: 'stop' },
];
const sampleLine = [
  [52.5219184, 13.4132147], [52.505, 13.44], [52.493, 13.459], [52.488, 13.472],
  [52.46, 13.53], [52.45, 13.59], [52.44, 13.645],
].map(([latitude, longitude]) => ({ latitude, longitude }));

describe('route GPX', () => {
  test("a planned route is written exactly as the contract's example", () => {
    expect(writeRoute('Alexanderplatz to Müggelsee', 'gravel', sampleLine, sampleWaypoints)).toBe(navitalsRoute);
  });

  // GPX can't say a `rte` and a `trk` are one route, so Komoot and Preview offered a file with both
  // as two. The plan rides in the track instead.
  test('a planned route is one track, with no rte beside it', () => {
    const gpx = writeRoute('Alexanderplatz to Müggelsee', 'gravel', sampleLine, sampleWaypoints);
    expect(gpx).not.toContain('<rte>');
    expect(gpx.split('<trk>')).toHaveLength(2);
    expect(gpx).toContain('<navitals:plan>');
  });

  test("a route that follows its line is written exactly as the contract's example, with no plan", () => {
    const waypoints: Waypoint[] = [
      { latitude: 52.44, longitude: 13.63, name: 'Rahnsdorf', kind: 'stop' },
      { latitude: 52.44, longitude: 13.645, name: 'Strandbad', kind: 'place' },
      { latitude: 52.4346, longitude: 13.657, name: 'Müggelhort', kind: 'stop' },
    ];
    const line = [[52.44, 13.63], [52.44, 13.6375], [52.44, 13.645], [52.4373, 13.645], [52.4346, 13.645], [52.4346, 13.657]]
      .map(([latitude, longitude]) => ({ latitude, longitude }));
    const gpx = writeRoute('Müggelsee shore', 'cycling', line, waypoints, true);
    expect(gpx).toBe(lineRoute);
    expect(gpx).not.toContain('<rte>');
    expect(gpx).not.toContain('navitals:plan');
  });

  test('the ends are via points even when a caller calls them shaping points', () => {
    const gpx = writeRoute('Ends', 'road', sampleLine, sampleWaypoints.map((w) => ({ ...w, kind: 'shaping' as const })));
    const kinds = [...gpx.matchAll(/kind="(\w+)"/g)].map((m) => m[1]);
    expect(kinds).toEqual(['via', 'shaping', 'shaping', 'shaping', 'via']);
  });

  test('a name with XML in it does not produce a broken file', () => {
    expect(escape(`Tom & Jerry's <"ride">`)).toBe('Tom &amp; Jerry&apos;s &lt;&quot;ride&quot;&gt;');
    const gpx = writeRoute(`Tom & Jerry's`, 'cycling', sampleLine, sampleWaypoints);
    expect(isWellFormed(gpx)).toBe(true);
  });

  test('file names survive every filesystem', () => {
    expect(fileName('Alexanderplatz to Müggelsee', new Date(2026, 9, 17))).toBe('2026-10-17-alexanderplatz-to-müggelsee.gpx');
    expect(fileName('  ///  ', new Date(2026, 0, 2))).toBe('2026-01-02-tour.gpx');
  });
});

/** Well-formedness without a DOM: no stray `&`, and every tag that opens closes, in order. */
function isWellFormed(xml: string): boolean {
  const open: string[] = [];
  for (const [, close, name, selfClosing] of xml.matchAll(/<(\/?)([\w:]+)[^>]*?(\/?)>/g)) {
    if (selfClosing) continue;
    if (!close) open.push(name);
    else if (open.pop() !== name) return false;
  }
  return open.length === 0 && !/&(?!amp;|lt;|gt;|quot;|apos;)/.test(xml);
}
