// The app's BRouterTests and GeodesyTests, for the same functions here.

import { describe, expect, test } from 'vitest';
import route1 from './fixtures/brouter-route1-timode3.geojson?raw';
import { BRouterDecodeError, decode, legs, lonlats, profileFor, profileParameters, routeURL, sportForProfile } from '../src/core/brouter';
import { distance } from '../src/core/geodesy';
import { sports, type Waypoint } from '../src/core/route';

const at = (latitude: number, longitude: number, kind: Waypoint['kind'] = 'stop'): Waypoint => ({ latitude, longitude, kind });

describe('geodesy', () => {
  test('matches the published geodesic between Flinders Peak and Buninyong', () => {
    const d = distance(
      { latitude: -(37 + 57 / 60 + 3.7203 / 3600), longitude: 144 + 25 / 60 + 29.5244 / 3600 },
      { latitude: -(37 + 39 / 60 + 10.1561 / 3600), longitude: 143 + 55 / 60 + 35.3839 / 3600 },
    );
    expect(Math.abs(d - 54_972.271)).toBeLessThan(0.001);
  });

  test("agrees with the app's distance on a fix-sized step", () => {
    const d = distance({ latitude: 52.52, longitude: 13.4 }, { latitude: 52.5202, longitude: 13.4 });
    expect(Math.abs(d - 22.255442631525632)).toBeLessThan(0.000_001);
  });
});

describe('BRouter request', () => {
  test('every sport routes with a BRouter profile, hiking with hiking-mountain, and back', () => {
    expect(sports.map((s) => profileFor(s.id))).toEqual(['hiking-mountain', 'trekking', 'fastbike', 'gravel', 'mtb']);
    for (const sport of sports) expect(sportForProfile(profileFor(sport.id))).toBe(sport.id);
    expect(sportForProfile('car-fast')).toBeUndefined();
  });

  test('stops in the middle are meeting points and shaping points stay plain vias', () => {
    const points = [at(52.5217277, 13.401912), at(52.5, 13.41, 'shaping'), at(52.49, 13.415), at(52.4735725, 13.4233688)];
    expect(lonlats(points)).toBe('13.401912,52.521728|13.410000,52.500000|13.415000,52.490000,m|13.423369,52.473573');
    // the ends stay plain, so a two-point request is brouter-web's
    expect(lonlats([points[0], points[3]])).toBe('13.401912,52.521728|13.423369,52.473573');
  });

  test('the second pass heads for the destination; misplaced vias are corrected only with a shaping point', () => {
    const a = at(52.52, 13.4), b = at(52.47, 13.42), shaping = at(52.5, 13.41, 'shaping'), stop = at(52.49, 13.415);
    expect(profileParameters([a, b])).toEqual({ pass2coefficient: '1' });
    expect(profileParameters([a, stop, b])).toEqual({ pass2coefficient: '1' });
    expect(profileParameters([a, shaping, stop, b])).toEqual({ pass2coefficient: '1', correctMisplacedViaPoints: '1' });
  });

  test("the request is the app's: its lonlats and profile parameters, brouter-web's other fields", () => {
    const url = new URL(routeURL('https://brouter.de/brouter',
      [at(52.5217277, 13.401912), at(52.5, 13.41, 'shaping'), at(52.4735725, 13.4233688)], 'custom_1', 2));
    expect(url.origin + url.pathname).toBe('https://brouter.de/brouter');
    expect(url.searchParams.get('lonlats')).toBe('13.401912,52.521728|13.410000,52.500000|13.423369,52.473573');
    expect(url.searchParams.get('profile')).toBe('custom_1');
    expect(url.searchParams.get('alternativeidx')).toBe('2');
    expect(url.searchParams.get('format')).toBe('geojson');
    expect(url.searchParams.get('profile:pass2coefficient')).toBe('1');
    expect(url.searchParams.get('profile:correctMisplacedViaPoints')).toBe('1');
  });
});

describe('BRouter answer', () => {
  test("an answer decodes to its line, elevations and BRouter's own totals", () => {
    const track = decode(`{"type":"FeatureCollection","features":[{"type":"Feature",
      "properties":{"creator":"BRouter-1.7.10","track-length":"6734","total-time":"1239","filtered ascend":"18"},
      "geometry":{"type":"LineString","coordinates":[[13.401958,52.521743,35.25],[13.40215,52.521524,35.5]]}}]}`);
    expect(track.coordinates).toEqual([{ latitude: 52.521743, longitude: 13.401958 }, { latitude: 52.521524, longitude: 13.40215 }]);
    expect(track.elevations).toEqual([35.25, 35.5]);
    expect(track.length).toBe(6734);
    expect(track.duration).toBe(1239);
    expect(track.ascent).toBe(18);
  });

  test('a whole answer from BRouter 1.7.10 reads in full', () => {
    const track = decode(route1);
    expect(track.coordinates).toHaveLength(398);
    expect(track.elevations).toHaveLength(398);
    expect([track.length, track.duration, track.ascent]).toEqual([6734, 1239, 18]);
  });

  test('a refusal in plain text is unreadable, not a route', () => {
    expect(() => decode('Please, retry later!')).toThrow(BRouterDecodeError);
    expect(() => decode('{"features":[{"geometry":{"coordinates":[[13,52]]}}]}')).toThrow(/no line/);
  });
});

describe('legs', () => {
  /** A line north along a meridian, one point every ~111 m. */
  const meridian = (count: number) => Array.from({ length: count }, (_, i) => ({ latitude: 52 + i * 0.001, longitude: 13 }));

  test('two stops are one leg: the whole line', () => {
    const line = meridian(10);
    expect(legs(line, [line[0], line[9]])?.map((leg) => leg.length)).toEqual([10]);
  });

  test('a middle stop cuts the line where it passes, and both legs share that point', () => {
    const line = meridian(10);
    const pieces = legs(line, [line[0], { latitude: 52.004 + 0.0001, longitude: 13.0002 }, line[9]])!;
    expect(pieces.map((leg) => leg.length)).toEqual([5, 6]);
    expect(pieces[0].at(-1)).toEqual(pieces[1][0]);
  });

  test('on an out-and-back the turning point is found on the way out, not the way back', () => {
    const out = meridian(10);
    const line = [...out, ...out.slice().reverse().slice(1)];
    expect(legs(line, [line[0], out[1], out[9], line.at(-1)!])?.map((leg) => leg.length)).toEqual([2, 9, 10]);
  });

  test('a stop in the middle of a site, 200 m off the way, is where the line comes closest', () => {
    const line = meridian(10);
    expect(legs(line, [line[0], { latitude: 52.004, longitude: 13.003 }, line[9]])?.[0]).toHaveLength(5);
  });

  test('a far stop on an out-and-back is still the turning point on the way out', () => {
    const out = meridian(10);
    const line = [...out, ...out.slice().reverse().slice(1)];
    expect(legs(line, [line[0], { latitude: 52.009, longitude: 13.003 }, line.at(-1)!])?.[0]).toHaveLength(10);
  });

  test('a stop the line never passes means the answer is not about these stops', () => {
    const line = meridian(10);
    expect(legs(line, [line[0], { latitude: 52.004, longitude: 13.1 }, line[9]])).toBeNull();
  });
});
