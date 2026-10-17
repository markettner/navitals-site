// What is being planned: the stops, the sport, and the route BRouter made of them. Every change to
// the stops or the sport plans again, cancelling a request still on its way.

import { BRouterClient } from '../core/brouterClient';
import type { Track } from '../core/brouter';
import { distance, type Coordinate } from '../core/geodesy';
import { sports, type Sport, type Waypoint } from '../core/route';
import { PlaceSearch, type Place } from '../core/search';

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

let nextID = 1;
export function newStop(place: Place | null = null, kind: Stop['kind'] = 'stop'): Stop {
  return { id: nextID++, place, kind };
}

/** A place for a point on the map, named by its coordinates until search knows better. */
export function droppedPin(point: Coordinate): Place {
  return {
    id: `at:${point.latitude.toFixed(5)},${point.longitude.toFixed(5)}`,
    name: `${point.latitude.toFixed(5)}, ${point.longitude.toFixed(5)}`,
    subtitle: 'Dropped pin', latitude: point.latitude, longitude: point.longitude, kind: 'other',
  };
}

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

export class Planner {
  stops = $state<Stop[]>([newStop(), newStop()]);
  sport = $state<Sport>(storedSport());
  /** Raw: a track is thousands of points, and nothing inside it changes. */
  route = $state.raw<RouteState>({ status: 'idle' });

  readonly search = new PlaceSearch();
  private readonly client = new BRouterClient({
    profileText: async (profile) => {
      const response = await fetch(`${import.meta.env.BASE_URL}profiles/${profile}.brf`);
      if (!response.ok) throw new Error(`No profile ${profile}.`);
      return response.text();
    },
  });
  private request: AbortController | null = null;

  /** The stops that are filled in, as BRouter is asked for them. */
  get waypoints(): Waypoint[] {
    return this.stops.flatMap((stop) => stop.place
      ? [{ latitude: stop.place.latitude, longitude: stop.place.longitude, name: stop.place.name, kind: stop.kind }]
      : []);
  }

  /** The route's name, as the app names a fresh route: for where it goes, and a loop for the place
   *  it goes round by. */
  get title(): string {
    const named = this.stops.filter((stop) => stop.place && stop.kind === 'stop').map((stop) => stop.place!);
    if (named.length < 2) return 'Route';
    const first = named[0], last = named.at(-1)!;
    // Within 100 m, as the app's route detail tells a loop.
    if (distance(first, last) >= 100) return last.name;
    const vias = named.slice(1, -1);
    return vias.length ? `Loop via ${vias[0].name}` : `Loop from ${last.name}`;
  }

  setPlace(id: number, place: Place | null): void {
    const stop = this.stops.find((s) => s.id === id);
    if (!stop) return;
    stop.place = place;
    this.plan();
  }

  /** A point from the map: the start, a stop before the destination, or the destination. Its name
   *  comes from search when search knows one. */
  placeAt(point: Coordinate, role: 'start' | 'stop' | 'end'): void {
    const place = droppedPin(point);
    let stop: Stop;
    if (role === 'stop') {
      stop = newStop(place);
      this.stops.splice(Math.max(this.stops.length - 1, 1), 0, stop);
      this.plan();
    } else {
      stop = role === 'start' ? this.stops[0] : this.stops.at(-1)!;
      this.setPlace(stop.id, place);
    }
    this.name(stop.id, point);
  }

  /** Moves a stop to where its marker was dragged. */
  moveTo(id: number, point: Coordinate): void {
    this.setPlace(id, droppedPin(point));
    this.name(id, point);
  }

  addStop(): void {
    this.stops.splice(this.stops.length - 1, 0, newStop());
  }

  remove(id: number): void {
    if (this.stops.length <= 2) {
      this.setPlace(id, null);
      return;
    }
    this.stops = this.stops.filter((stop) => stop.id !== id);
    this.plan();
  }

  /** Moves the stop at `from` to `to`, as a drag in the list does. */
  reorder(from: number, to: number): void {
    if (from === to) return;
    const [moved] = this.stops.splice(from, 1);
    this.stops.splice(to, 0, moved);
    this.plan();
  }

  reverse(): void {
    this.stops.reverse();
    this.plan();
  }

  chooseSport(sport: Sport): void {
    if (sport === this.sport) return;
    this.sport = sport;
    try {
      localStorage.setItem(sportKey, sport);
    } catch {
      // Not remembered, which is all blocked storage costs.
    }
    this.plan();
  }

  /** Plans the route through the stops that are filled in, once there are two. */
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

  /** Gives a stop placed by coordinates the name search finds for the point. */
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
