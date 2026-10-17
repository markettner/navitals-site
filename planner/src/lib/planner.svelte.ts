// What is being planned: the stops and shaping points, the sport, and the route BRouter made of
// them, or a line imported as it is. Every change to the plan routes it again, cancelling a
// request still on its way, and can be undone.

import { BRouterClient } from '../core/brouterClient';
import type { Track } from '../core/brouter';
import { climbing, distance, length, type Coordinate } from '../core/geodesy';
import { isLoop, sportOf, stopsOf, thinned, type GPXTrack, type NamedPoint } from '../core/gpxReader';
import { sports, type Sport, type Waypoint } from '../core/route';
import { PlaceSearch, type Place } from '../core/search';
import type { PlanState } from '../core/urlState';

export interface Stop {
  id: number;
  /** Null for a field not filled in yet. */
  place: Place | null;
  kind: 'stop' | 'shaping';
}

export type RouteState =
  | { status: 'idle' }
  | { status: 'planning'; previous: Track | null }
  | { status: 'ready'; track: Track; waypoints: Waypoint[] }
  | { status: 'failed'; message: string };

/** A route that follows its line (an imported recording): the line is the route, its ends are its
 *  stops, and the places it passes are shown but never routed to. Only "Make editable" changes it. */
export interface LineRoute {
  name: string;
  track: Track;
  places: Place[];
}

let nextID = 1;
export function newStop(place: Place | null = null, kind: Stop['kind'] = 'stop'): Stop {
  return { id: nextID++, place, kind };
}

/** A place for a point on the map, named by its coordinates until search knows better. */
export function droppedPin(point: Coordinate, kind: Stop['kind'] = 'stop'): Place {
  return {
    id: `at:${point.latitude.toFixed(5)},${point.longitude.toFixed(5)}`,
    name: kind === 'shaping' ? 'Shaping point' : `${point.latitude.toFixed(5)}, ${point.longitude.toFixed(5)}`,
    subtitle: kind === 'shaping' ? '' : 'Dropped pin', latitude: point.latitude, longitude: point.longitude, kind: 'other',
  };
}

function named(point: NamedPoint): Place {
  return { id: `gpx:${point.latitude},${point.longitude}`, name: point.name, subtitle: '', latitude: point.latitude, longitude: point.longitude, kind: 'other' };
}

/** How many shaping points "Make editable" lays along a line at most. Enough to keep a recording's
 *  way through a town; BRouter routes each stretch between them on its own. */
export const mostShapingPoints = 80;

const sportKey = 'navitals-planner-sport';

function storedSport(): Sport {
  try {
    const stored = localStorage.getItem(sportKey);
    if (sports.some((sport) => sport.id === stored)) return stored as Sport;
  } catch {
    // Storage blocked: the default it is.
  }
  return 'cycling';
}

interface Snapshot {
  stops: Stop[];
  sport: Sport;
  line: LineRoute | null;
}

export class Planner {
  stops = $state<Stop[]>([newStop(), newStop()]);
  sport = $state<Sport>(storedSport());
  /** Raw: a track is thousands of points, and nothing inside it changes. */
  route = $state.raw<RouteState>({ status: 'idle' });
  line = $state.raw<LineRoute | null>(null);
  /** Why the last file couldn't be imported, until the next one is. */
  importMessage = $state('');

  private past = $state.raw<Snapshot[]>([]);
  private future = $state.raw<Snapshot[]>([]);

  readonly search = new PlaceSearch();
  private readonly client = new BRouterClient({
    profileText: async (profile) => {
      const response = await fetch(`${import.meta.env.BASE_URL}profiles/${profile}.brf`);
      if (!response.ok) throw new Error(`No profile ${profile}.`);
      return response.text();
    },
  });
  private request: AbortController | null = null;

  get canUndo(): boolean { return this.past.length > 0; }
  get canRedo(): boolean { return this.future.length > 0; }

  /** The stops and shaping points that are filled in, as BRouter is asked for them. */
  get waypoints(): Waypoint[] {
    return this.stops.flatMap((stop) => stop.place
      ? [{ latitude: stop.place.latitude, longitude: stop.place.longitude, name: stop.place.name, kind: stop.kind }]
      : []);
  }

  /** The points a GPX export lists: the plan, or for a line its ends and the places it passes. */
  get exportWaypoints(): Waypoint[] {
    if (!this.line) return this.waypoints;
    const [start, ...rest] = this.waypoints;
    const places = this.line.places.map((place) => ({ latitude: place.latitude, longitude: place.longitude, name: place.name, kind: 'place' as const }));
    return [start, ...places, ...rest.slice(-1)];
  }

  /** What the address keeps: the sport and the points, for a planned route. A line has no plan. */
  get planState(): PlanState | null {
    const points = this.waypoints;
    if (this.line || points.length < 2) return null;
    return { sport: this.sport, points: points.map(({ latitude, longitude, kind }) => ({ latitude, longitude, kind: kind === 'shaping' ? 'shaping' : 'stop' })) };
  }

  /** The route's name, as the app names a fresh route: for where it goes, and a loop for the place
   *  it goes round by. An imported line keeps the file's name. */
  get title(): string {
    if (this.line) return this.line.name;
    const placed = this.stops.filter((stop) => stop.place && stop.kind === 'stop').map((stop) => stop.place!);
    if (placed.length < 2) return 'Route';
    const first = placed[0], last = placed.at(-1)!;
    // Within 100 m, as the app's route detail tells a loop.
    if (distance(first, last) >= 100) return last.name;
    const vias = placed.slice(1, -1);
    return vias.length ? `Loop via ${vias[0].name}` : `Loop from ${last.name}`;
  }

  // ---------- Undo ----------

  private snapshot(): Snapshot {
    return { stops: this.stops.map((stop) => ({ ...stop, place: stop.place && { ...stop.place } })), sport: this.sport, line: this.line };
  }

  /** Keeps the plan as it is now, so the change about to be made can be undone. */
  private record(): void {
    this.past = [...this.past.slice(-99), this.snapshot()];
    this.future = [];
  }

  private restore(snapshot: Snapshot): void {
    this.stops = snapshot.stops;
    this.sport = snapshot.sport;
    this.line = snapshot.line;
    if (snapshot.line) this.showLine(snapshot.line);
    else this.plan();
  }

  undo(): void {
    const previous = this.past.at(-1);
    if (!previous) return;
    this.future = [...this.future, this.snapshot()];
    this.past = this.past.slice(0, -1);
    this.restore(previous);
  }

  redo(): void {
    const next = this.future.at(-1);
    if (!next) return;
    this.past = [...this.past, this.snapshot()];
    this.future = this.future.slice(0, -1);
    this.restore(next);
  }

  // ---------- Editing the plan ----------

  setPlace(id: number, place: Place | null): void {
    const stop = this.stops.find((s) => s.id === id);
    if (!stop) return;
    this.record();
    stop.place = place;
    this.plan();
  }

  /** A point from the map: the start, a stop before the destination, or the destination. Its name
   *  comes from search when search knows one. */
  placeAt(point: Coordinate, role: 'start' | 'stop' | 'end'): void {
    if (this.line) return;
    this.record();
    let stop: Stop;
    if (role === 'stop') {
      stop = newStop(droppedPin(point));
      this.stops.splice(Math.max(this.stops.length - 1, 1), 0, stop);
    } else {
      stop = role === 'start' ? this.stops[0] : this.stops.at(-1)!;
      stop.place = droppedPin(point);
      stop.kind = 'stop';
    }
    this.plan();
    this.name(stop.id, point);
  }

  /** A bend where a drag on the line was let go, before the waypoint at `before` (an index into
   *  `waypoints`, which leaves out the fields not filled in). */
  insertShaping(point: Coordinate, before: number): void {
    const placed = this.stops.filter((stop) => stop.place);
    const next = placed[before];
    if (!next || before < 1) return;
    this.record();
    const stop = newStop(droppedPin(point, 'shaping'), 'shaping');
    this.stops.splice(this.stops.indexOf(next), 0, stop);
    this.plan();
    this.name(stop.id, point);
  }

  /** Moves a stop or bend to where its marker was dropped. */
  moveTo(id: number, point: Coordinate): void {
    const stop = this.stops.find((s) => s.id === id);
    if (!stop) return;
    this.record();
    stop.place = droppedPin(point, stop.kind);
    this.plan();
    this.name(id, point);
  }

  /** A bend promoted to a stop: the same spot and name, now arrived at. */
  makeStop(id: number): void {
    const stop = this.stops.find((s) => s.id === id);
    if (!stop || stop.kind !== 'shaping') return;
    this.record();
    stop.kind = 'stop';
    this.plan();
  }

  addStop(): void {
    this.record();
    this.stops.splice(this.stops.length - 1, 0, newStop());
  }

  remove(id: number): void {
    const index = this.stops.findIndex((stop) => stop.id === id);
    if (index < 0) return;
    this.record();
    if (this.stops.filter((stop) => stop.kind === 'stop').length <= 2 && this.stops[index].kind === 'stop') {
      this.stops[index].place = null;
    } else {
      this.stops.splice(index, 1);
      // A bend can't be an end: if one is left there, it becomes the stop.
      this.stops[0].kind = 'stop';
      this.stops[this.stops.length - 1].kind = 'stop';
    }
    this.plan();
  }

  /** Moves the stop at `from` to `to` (indices into `stops`), as a drag in the list does. */
  reorder(from: number, to: number): void {
    if (from === to) return;
    this.record();
    const [moved] = this.stops.splice(from, 1);
    this.stops.splice(to, 0, moved);
    this.stops[0].kind = 'stop';
    this.stops[this.stops.length - 1].kind = 'stop';
    this.plan();
  }

  reverse(): void {
    this.record();
    this.stops.reverse();
    if (this.line) {
      const line = this.line;
      const track = { ...line.track, coordinates: [...line.track.coordinates].reverse(), elevations: [...line.track.elevations].reverse() };
      this.line = { ...line, track, places: [...line.places].reverse() };
      this.showLine(this.line);
      return;
    }
    this.plan();
  }

  chooseSport(sport: Sport): void {
    if (sport === this.sport) return;
    this.record();
    this.sport = sport;
    try {
      localStorage.setItem(sportKey, sport);
    } catch {
      // Not remembered, which is all blocked storage costs.
    }
    // The line is the route; the sport only says how it is ridden.
    if (!this.line) this.plan();
  }

  // ---------- Opening a plan ----------

  /** A plan from the address: the points, named again by search. */
  open(state: PlanState): void {
    this.record();
    this.line = null;
    this.sport = state.sport;
    this.stops = state.points.map((point) => newStop(droppedPin(point, point.kind), point.kind));
    this.plan();
    for (const stop of this.stops) this.name(stop.id, stop.place!);
  }

  /** A GPX file, by docs/ROUTE_GPX.md: a plan is planned again through its points, for its sport
   *  when it names one; anything else is a line, kept exactly as it is. */
  import(track: GPXTrack): void {
    this.record();
    this.importMessage = '';
    const sport = sportOf(track);
    if (sport) this.sport = sport;
    if (track.plannedPoints) {
      this.line = null;
      this.stops = track.plannedPoints.map((point) => newStop(named(point), point.kind));
      this.plan();
      return;
    }
    // A line: the ends are named by the file's own waypoints there, else by search.
    const ends = stopsOf(track);
    const first = track.coordinates[0], last = track.coordinates.at(-1)!;
    const start = newStop(ends.start ? named(ends.start) : droppedPin(first));
    const finish = newStop(ends.finish ? named(ends.finish) : droppedPin(last));
    this.stops = [start, finish];
    this.line = {
      name: track.name,
      places: ends.vias.map((via) => named(via)),
      track: {
        coordinates: track.coordinates,
        elevations: track.elevations,
        length: length(track.coordinates),
        duration: 0,
        ascent: climbing(track.elevations),
      },
    };
    this.showLine(this.line);
    if (!ends.start) this.name(start.id, first);
    if (!ends.finish) {
      if (isLoop(track.coordinates) && ends.start) finish.place = { ...start.place! };
      else this.name(finish.id, last);
    }
  }

  /** A line made into a plan: shaping points laid along it, and the route planned through them.
   *  The line then snaps to BRouter's ways, which is the price of being able to change it. */
  makeEditable(): void {
    const line = this.line;
    if (!line) return;
    this.record();
    const points = thinned(line.track.coordinates, mostShapingPoints, 10);
    const start = this.stops[0], finish = this.stops.at(-1)!;
    this.stops = [start, ...points.slice(1, -1).map((point) => newStop(droppedPin(point, 'shaping'), 'shaping')), finish];
    this.line = null;
    this.plan();
  }

  private showLine(line: LineRoute): void {
    this.request?.abort();
    this.request = null;
    this.route = { status: 'ready', track: line.track, waypoints: this.waypoints };
  }

  // ---------- Routing ----------

  /** Plans the route through the points that are filled in, once there are two. */
  plan(): void {
    this.request?.abort();
    const waypoints = this.waypoints;
    if (waypoints.length < 2) {
      this.request = null;
      this.route = { status: 'idle' };
      return;
    }
    const request = new AbortController();
    this.request = request;
    const previous = this.route.status === 'ready' ? this.route.track
      : this.route.status === 'planning' ? this.route.previous : null;
    this.route = { status: 'planning', previous };
    this.client.route(waypoints, this.sport, { signal: request.signal }).then(
      (track) => {
        if (this.request === request) this.route = { status: 'ready', track, waypoints };
      },
      (error: unknown) => {
        if (this.request !== request || request.signal.aborted) return;
        this.route = { status: 'failed', message: messageFor(error) };
      },
    );
  }

  /** Names a point placed by coordinates after what search finds there: a stop by its address,
   *  a bend by its street. Only the name changes, so nothing is planned again. */
  private name(id: number, point: Coordinate): void {
    this.search.name(point).then((place) => {
      const stop = this.stops.find((s) => s.id === id);
      // Only if the stop is still that point: it may have been moved or cleared meanwhile.
      if (!place || !stop?.place || stop.place.latitude !== point.latitude || stop.place.longitude !== point.longitude) return;
      stop.place = { ...place, latitude: point.latitude, longitude: point.longitude };
    }, () => { /* the coordinates stay its name */ });
  }
}

function messageFor(error: unknown): string {
  if (error instanceof TypeError) return "Can't reach brouter.de. Check the connection and try again.";
  if (error instanceof Error && error.message) {
    // BRouter's own words for a point off its map.
    if (/not mapped/.test(error.message)) return 'A stop is too far from any road or path BRouter knows.';
    return error.message;
  }
  return 'No route was found.';
}
