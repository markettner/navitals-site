// A route with one part of it replaced: an edit with the pen (the app's RouteSplice.replacing).
// Everything outside that part is kept exactly as it was, which is the point: on an imported track
// it is the only shape there is.

import type { Track } from './brouter';
import { climbing, length, type Coordinate } from './geodesy';
import { cumulativeDistances } from './penStroke';

/** `track` with the part between `from` and `to` metres along it replaced by `connector`, which runs
 *  from the first to the second. A null cut is the route's own end: the connector starts or
 *  finishes the route. Elevations are kept only if every piece has them, and the time scales with
 *  the share of the route kept (a line from a file has none, and gets none). */
export function replacing(track: Track, from: number | null, to: number | null, connector: Track): Track {
  const cumulative = cumulativeDistances(track.coordinates);
  const total = cumulative.at(-1) ?? 0;
  const head = from === null ? empty : piece(track, cumulative, 0, from);
  const tail = to === null ? empty : piece(track, cumulative, to, total);
  const coordinates = [...head.coordinates, ...connector.coordinates, ...tail.coordinates];
  const elevated = [head, connector, tail].every((part) => part.coordinates.length === 0 || part.elevations.length === part.coordinates.length);
  const elevations = elevated ? [...head.elevations, ...connector.elevations, ...tail.elevations] : [];
  const keptShare = total > 0 ? ((from ?? 0) + (total - (to ?? total))) / total : 0;
  return {
    coordinates,
    elevations,
    length: length(coordinates),
    duration: track.duration > 0 ? track.duration * keptShare + connector.duration : 0,
    ascent: elevations.length ? climbing(elevations) : track.ascent * keptShare + connector.ascent,
  };
}

const empty = { coordinates: [] as Coordinate[], elevations: [] as number[] };

/** The part of a track between two distances along it, cut exactly there, elevations with it. */
function piece(track: Track, cumulative: number[], from: number, to: number): { coordinates: Coordinate[]; elevations: number[] } {
  const line = track.coordinates;
  const heights = track.elevations.length === line.length ? track.elevations : null;
  const coordinates: Coordinate[] = [];
  const elevations: number[] = [];
  const at = (metres: number) => {
    let segment = 0;
    while (segment < line.length - 2 && cumulative[segment + 1] < metres) segment++;
    const span = cumulative[segment + 1] - cumulative[segment];
    const t = span > 0 ? Math.min(1, Math.max(0, (metres - cumulative[segment]) / span)) : 0;
    const a = line[segment], b = line[segment + 1];
    coordinates.push({ latitude: a.latitude + (b.latitude - a.latitude) * t, longitude: a.longitude + (b.longitude - a.longitude) * t });
    if (heights) elevations.push(heights[segment] + (heights[segment + 1] - heights[segment]) * t);
  };
  if (line.length < 2 || to <= from) return empty;
  at(from);
  for (let i = 0; i < line.length; i++) {
    if (cumulative[i] > from && cumulative[i] < to) {
      coordinates.push(line[i]);
      if (heights) elevations.push(heights[i]);
    }
  }
  at(to);
  return { coordinates, elevations };
}
