// The app's RouteGPXTests (reading) and GPXParserTests, on the same files.

import { describe, expect, test } from 'vitest';
import garminTrip from './fixtures/garmin-trip.gpx?raw';
import lineRoute from './fixtures/line-route.gpx?raw';
import navitalsRoute from './fixtures/navitals-route.gpx?raw';
import plainRoute from './fixtures/plain-route.gpx?raw';
import { GPXError, isLoop, parseGPX, simplify, sportOf, stopsOf, thinned } from '../src/core/gpxReader';
import { writeRoute } from '../src/core/gpx';
import type { Coordinate } from '../src/core/geodesy';
import { sports, type Waypoint } from '../src/core/route';

const gpx = (body: string) => `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1"
     xmlns:trp="http://www.garmin.com/xmlschemas/TripExtensions/v1">
${body}
</gpx>`;

describe('the route GPX contract, reading', () => {
  test('our own file comes back as its stops and shaping points, with its sport', () => {
    const track = parseGPX(navitalsRoute);
    expect(track.plannedPoints?.map((p) => p.kind)).toEqual(['stop', 'shaping', 'stop', 'shaping', 'stop']);
    expect(track.plannedPoints?.map((p) => p.name)).toEqual(['Alexanderplatz', 'Puschkinallee', 'Treptower Park', 'An der Wuhlheide', 'Müggelsee']);
    expect(track.plannedPoints?.[0]).toMatchObject({ latitude: 52.5219184, longitude: 13.4132147 });
    expect(track.profile).toBe('gravel');
    expect(sportOf(track)).toBe('gravel');
    expect(track.coordinates).toHaveLength(7);
    expect(track.name).toBe('Alexanderplatz to Müggelsee');
  });

  test('a route written and read again is the same plan, for every sport', () => {
    const waypoints: Waypoint[] = [
      { latitude: 52.52, longitude: 13.4, name: 'A & B', kind: 'stop' },
      { latitude: 52.5, longitude: 13.45, name: 'Bend', kind: 'shaping' },
      { latitude: 52.48, longitude: 13.5, name: 'C', kind: 'stop' },
    ];
    for (const sport of sports) {
      const track = parseGPX(writeRoute('Round trip', sport.id, waypoints, waypoints));
      expect(sportOf(track)).toBe(sport.id);
      expect(track.plannedPoints?.map((p) => [p.name, p.kind])).toEqual([['A & B', 'stop'], ['Bend', 'shaping'], ['C', 'stop']]);
    }
  });

  test("a Garmin trip's marks are read whatever their prefix, and the track beside them doesn't win", () => {
    const track = parseGPX(garminTrip);
    expect(track.plannedPoints?.map((p) => p.kind)).toEqual(['stop', 'shaping', 'stop', 'stop']);
    expect(track.plannedPoints?.map((p) => p.name)).toEqual(['Potsdam Hbf', 'Sanssouci', 'Neuer Garten', 'Potsdam Hbf']);
    expect(track.profile).toBeNull();
  });

  test('a plan without marks is all stops', () => {
    expect(parseGPX(plainRoute).plannedPoints?.map((p) => [p.name, p.kind]))
      .toEqual([['Mitte', 'stop'], ['Treptower Park', 'stop'], ['Köpenick', 'stop']]);
  });

  test('a line with places is a line, not a plan', () => {
    const track = parseGPX(lineRoute);
    expect(track.plannedPoints).toBeNull();
    expect(track.profile).toBe('trekking');
    expect(track.waypoints.map((w) => w.name)).toEqual(['Rahnsdorf', 'Strandbad', 'Müggelhort']);
  });

  test('the ends are stops even when marked as shaping points, and unnamed points get names', () => {
    const track = parseGPX(gpx(`<rte>
      <rtept lat="52.51" lon="13.37"><extensions><trp:ShapingPoint/></extensions></rtept>
      <rtept lat="52.515" lon="13.375"><extensions><trp:ShapingPoint/></extensions></rtept>
      <rtept lat="52.52" lon="13.38"><extensions><trp:ShapingPoint/></extensions></rtept></rte>`));
    expect(track.plannedPoints?.map((p) => [p.name, p.kind])).toEqual([['Point 1', 'stop'], ['Shaping point', 'shaping'], ['Point 3', 'stop']]);
  });

  test('marked points close together are still a plan', () => {
    const track = parseGPX(gpx(`<rte>
      <rtept lat="52.5100" lon="13.3700"><extensions><trp:ViaPoint/></extensions></rtept>
      <rtept lat="52.5102" lon="13.3703"><extensions><trp:ShapingPoint/></extensions></rtept>
      <rtept lat="52.5104" lon="13.3706"><extensions><trp:ViaPoint/></extensions></rtept></rte>`));
    expect(track.plannedPoints?.map((p) => p.kind)).toEqual(['stop', 'shaping', 'stop']);
  });
});

describe('GPX import', () => {
  test('a recorded track gives its name, its shape and its elevation', () => {
    const track = parseGPX(gpx(`<trk><name>Evening ride</name><trkseg>
      <trkpt lat="52.51" lon="13.37"><ele>34.5</ele><time>2026-09-17T18:00:00Z</time></trkpt>
      <trkpt lat="52.52" lon="13.38"><ele>36</ele></trkpt></trkseg></trk>`));
    expect(track.name).toBe('Evening ride');
    expect(track.coordinates).toEqual([{ latitude: 52.51, longitude: 13.37 }, { latitude: 52.52, longitude: 13.38 }]);
    expect(track.elevations).toEqual([34.5, 36]);
  });

  test('several segments join into one track; elevation is dropped unless every point has it', () => {
    const track = parseGPX(gpx(`<trk><trkseg><trkpt lat="52.51" lon="13.37"><ele>30</ele></trkpt></trkseg>
      <trkseg><trkpt lat="52.52" lon="13.38"/><trkpt lat="52.53" lon="13.39"><ele>31</ele></trkpt></trkseg></trk>`));
    expect(track.coordinates).toHaveLength(3);
    expect(track.elevations).toEqual([]);
  });

  test('a track wins over an unmarked route in the same file', () => {
    const track = parseGPX(gpx(`<rte><rtept lat="52.10" lon="13.10"/><rtept lat="52.20" lon="13.20"/></rte>
      <trk><trkseg><trkpt lat="52.51" lon="13.37"/><trkpt lat="52.52" lon="13.38"/><trkpt lat="52.53" lon="13.39"/></trkseg></trk>`));
    expect(track.coordinates).toHaveLength(3);
    expect(track.plannedPoints).toBeNull();
  });

  test("the file's own name wins over its track's, and an author's name is not it", () => {
    const trk = '<trk><name>Track 1</name><trkseg><trkpt lat="52.51" lon="13.37"/><trkpt lat="52.52" lon="13.38"/></trkseg></trk>';
    const named = parseGPX(gpx(`<metadata><author><name>A. Rider</name></author><name>Berliner Mauerweg</name></metadata>${trk}`));
    expect(named.name).toBe('Berliner Mauerweg');
    const authored = parseGPX(gpx(`<metadata><author><name>A. Rider</name></author></metadata>${trk}`));
    expect(authored.name).toBe('Track 1');
  });

  test('names come through entities and CDATA', () => {
    const track = parseGPX(gpx(`<wpt lat="52.5" lon="13.4"><name><![CDATA[Café & Co]]></name></wpt>
      <trk><name>Tom &amp; Jerry&#39;s</name><trkseg><trkpt lat="52.51" lon="13.37"/><trkpt lat="52.52" lon="13.38"/></trkseg></trk>`));
    expect(track.name).toBe("Tom & Jerry's");
    expect(track.waypoints[0].name).toBe('Café & Co');
  });

  test('a file that is not GPX, and a GPX with nothing in it, both say so', () => {
    expect(() => parseGPX('<kml></kml>')).toThrow(new GPXError('notGPX'));
    expect(() => parseGPX(gpx(''))).toThrow(new GPXError('noPoints'));
  });
});

describe('thinning and stops of a line', () => {
  /** Metres east and north of a corner in Berlin, as a coordinate. */
  const at = (east: number, north: number): Coordinate => ({
    latitude: 52.5 + north / 110_540, longitude: 13.4 + east / (111_320 * Math.cos((52.5 * Math.PI) / 180)),
  });
  const place = (name: string, east: number, north: number) => ({ ...at(east, north), name });
  const straight = (to: number) => Array.from({ length: to / 50 + 1 }, (_, i) => at(i * 50, 0));
  const outAndBack = [...straight(2000), ...straight(2000).reverse().map((p) => ({ ...p, latitude: p.latitude + 50 / 110_540 }))];

  test('simplifying keeps the corners and drops the filler', () => {
    const line = [at(0, 0), at(100, 1), at(200, 0), at(200, 100), at(200, 200)];
    expect(simplify(line, 5)).toEqual([at(0, 0), at(200, 0), at(200, 200)]);
  });

  test('thinning raises the tolerance until the line fits, and keeps its end', () => {
    const zigzag = Array.from({ length: 500 }, (_, i) => at(i * 20, i % 2 ? 30 : 0));
    const thin = thinned(zigzag, 50);
    expect(thin.length).toBeLessThanOrEqual(50);
    expect(thin[0]).toEqual(zigzag[0]);
    expect(thin.at(-1)).toEqual(zigzag.at(-1));
  });

  test('a track that ends where it began is a loop; one that ends elsewhere is not', () => {
    expect(isLoop(outAndBack)).toBe(true);
    expect(isLoop(straight(2000))).toBe(false);
    expect(isLoop([at(0, 0), at(10, 0)])).toBe(false);
  });

  test("waypoints come out in the order the track passes them, not the file's", () => {
    expect(stopsOf({ coordinates: straight(5000), waypoints: [place('Lake', 4000, 20), place('Café', 1000, -30)] }).vias.map((p) => p.name))
      .toEqual(['Café', 'Lake']);
  });

  test('a waypoint off the track is left out, and one at an end names that end', () => {
    const stops = stopsOf({ coordinates: straight(5000), waypoints: [place('Far away', 2500, 1500), place('Summit', 5000, 30), place('Car park', -20, 0)] });
    expect(stops.vias).toEqual([]);
    expect(stops.start?.name).toBe('Car park');
    expect(stops.finish?.name).toBe('Summit');
  });

  test('on a loop the turnaround is a stop, and a waypoint at the start names both ends', () => {
    const stops = stopsOf({ coordinates: outAndBack, waypoints: [place('Badestelle', 2000, 25), place('Home', 0, 10)] });
    expect(stops.vias.map((p) => p.name)).toEqual(['Badestelle']);
    expect(stops.start?.name).toBe('Home');
    expect(stops.finish?.name).toBe('Home');
    expect(stopsOf({ coordinates: outAndBack, waypoints: [] }).finish).toBeUndefined();
  });
});
