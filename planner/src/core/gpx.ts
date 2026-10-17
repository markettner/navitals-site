// A planned route as GPX, exactly as the app writes one (NavitalsKit's GPXWriter.writeRoute), so
// the app reopens it with its stops, shaping points and sport. The contract is the app repo's
// docs/ROUTE_GPX.md; test/fixtures/navitals-route.gpx is its example, and this writer's output
// must match it byte for byte, as the app's does.

import { profileFor } from './brouter';
import type { Coordinate } from './geodesy';
import type { Sport, Waypoint } from './route';

/** Garmin's TripExtensions, which mark a route point as a via point or a shaping point. */
export const tripExtensionsNamespace = 'http://www.garmin.com/xmlschemas/TripExtensions/v1';
/** Ours, for the BRouter profile a route was planned with. */
export const navitalsNamespace = 'https://navitals.kettner.berlin/xmlschemas/gpx/1';

/** The line as an untimed track, each stop and place as a waypoint, and, for a route planned
 *  through points, those points as a `rte` marked `trp:ViaPoint` / `trp:ShapingPoint`. A route
 *  that follows its line gets no `rte`: planning it again through its ends would lose the line.
 *  `waypoints` are the route's points in order: stops, shaping points, and on a line its places. */
export function writeRoute(name: string, sport: Sport, coordinates: Coordinate[], waypoints: Waypoint[],
                           followsLine = false): string {
  const plan = followsLine ? [] : waypoints.filter((waypoint) => waypoint.kind !== 'place');
  let gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="Navitals" xmlns="http://www.topografix.com/GPX/1/1"
     xmlns:trp="${tripExtensionsNamespace}"
     xmlns:navitals="${navitalsNamespace}">
  <metadata>
    <name>${escape(name)}</name>
    <extensions><navitals:profile>${escape(profileFor(sport))}</navitals:profile></extensions>
  </metadata>
`;
  for (const waypoint of waypoints) {
    if (waypoint.kind === 'shaping') continue;
    gpx += `  <wpt lat="${coordinate(waypoint.latitude)}" lon="${coordinate(waypoint.longitude)}">`;
    if (waypoint.name !== undefined) gpx += `<name>${escape(waypoint.name)}</name>`;
    gpx += '</wpt>\n';
  }
  if (plan.length >= 2) {
    gpx += `  <rte>\n    <name>${escape(name)}</name>\n`;
    plan.forEach((point, index) => {
      // The ends are where the route goes from and to, whatever the caller called them.
      const isEnd = index === 0 || index === plan.length - 1;
      const mark = point.kind === 'shaping' && !isEnd ? '<trp:ShapingPoint/>' : '<trp:ViaPoint/>';
      gpx += `    <rtept lat="${coordinate(point.latitude)}" lon="${coordinate(point.longitude)}">`;
      if (point.name !== undefined) gpx += `<name>${escape(point.name)}</name>`;
      gpx += `<extensions>${mark}</extensions></rtept>\n`;
    });
    gpx += '  </rte>\n';
  }
  gpx += `  <trk>
    <name>${escape(name)}</name>
    <type>${sport}</type>
    <trkseg>
`;
  for (const point of coordinates) {
    gpx += `      <trkpt lat="${coordinate(point.latitude)}" lon="${coordinate(point.longitude)}"/>\n`;
  }
  gpx += `    </trkseg>
  </trk>
</gpx>
`;
  return gpx;
}

/** Seven decimals is about a centimetre: more is noise, less loses the shape of a switchback. */
function coordinate(value: number): string {
  return value.toFixed(7);
}

/** A route named "Tom & Jerry's" must not produce a file no parser will open. */
export function escape(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

/** A file name that survives every filesystem and mail client (`GPXWriter.fileName`). */
export function fileName(name: string, date: Date): string {
  const day = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const stem = name.split(/[^\p{L}\p{M}\p{N}]+/u).filter(Boolean).join('-') || 'tour';
  return `${day}-${stem}.gpx`.toLowerCase();
}
