// What is being planned: the stops and shaping points, the sport, and the route BRouter made of
// them, or a line imported as it is. Every change to the plan routes it again, cancelling a
// request still on its way, and can be undone.

import { BRouterClient } from '../core/brouterClient';
import type { AvoidArea, Track } from '../core/brouter';
import { climbing, distance, length, project, type Coordinate } from '../core/geodesy';
import { avoidZone, failure, planEdit, summary } from '../core/penEdit';
import { contains, cumulativeDistances, interpret } from '../core/penStroke';
import { isLoop, sportOf, stopsOf, thinned, unnamed, type GPXTrack, type NamedPoint } from '../core/gpxReader';
import { sports, type Sport, type Waypoint } from '../core/route';
import { routeStretches, StretchCache, stretchContext } from '../core/stretches';
import { myLocationName, PlaceSearch, SearchUnavailable, type Place } from '../core/search';
import type { PlanState } from '../core/urlState';

export interface Stop {
  id: number;
  /** Null for a field not filled in yet. */
  place: Place | null;
  kind: 'stop' | 'shaping';
  /** "My Location": the rider's position when the stop was filled in. Its place stays null until
   *  there is a fix, and then doesn't follow the rider: a plan doesn't change as they move. */
  current: boolean;
}

export type RouteState =
  | { status: 'idle' }
  | { status: 'planning'; previous: Track | null }
  /** `track` is the chosen one of `tracks`: the best route and the alternatives found so far. */
  | { status: 'ready'; track: Track; tracks: Track[]; selected: number; waypoints: Waypoint[] }
  | { status: 'failed'; message: string };

/** A route that follows its line (an imported recording): the line is the route, its ends are its
 *  stops, and the places it passes are shown but never routed to. Only "Make editable" changes it. */
export interface LineRoute {
  name: string;
  track: Track;
  places: Place[];
}

/** An area drawn with the pen to stay out of: its outline, and the circles that tell BRouter so. */
export interface Zone {
  id: number;
  outline: Coordinate[];
  circles: AvoidArea[];
}

/** What the pen is doing, or what its last stroke did. */
export type PenStatus = { kind: 'planning' } | { kind: 'applied'; text: string } | { kind: 'failed'; text: string };

/** How far from the line a stop may be and still be on it, for an edit to drop it (the app's
 *  `stopOnRouteTolerance`). */
const stopOnRoute = 400;

let nextID = 1;
export function newStop(place: Place | null = null, kind: Stop['kind'] = 'stop', current = false): Stop {
  return { id: nextID++, place, kind, current };
}

/** The place "My Location" stands for, at a fix. */
export function myLocation(point: Coordinate): Place {
  return { id: 'current-location', name: myLocationName, subtitle: '', latitude: point.latitude, longitude: point.longitude, kind: 'other' };
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

/** How many alternatives to ask for beyond the best route, as the app does (`RouteOptions`). */
export const alternatives = 2;
/** How long a plan has to rest before its alternatives are asked for. Each one costs brouter.de
 *  every search before it again, so a plan being dragged about mustn't ask on every drop. */
export const alternativesDelay = 1500;

/** How far apart the names of many bends are looked up, so a whole line's worth doesn't land on
 *  Photon at once: about a minute and a half for the most there can be. */
export const namingSpacing = 1000;

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

/** What the planner needs of the rider's location: `locate` starts finding it, and says whether it
 *  can be found at all. Fixes come back through `positionArrived`, and a refusal through
 *  `locationFailed`. */
export interface Locator {
  locate: () => 'locating' | 'blocked' | 'unavailable';
}

interface Snapshot {
  stops: Stop[];
  planName: string | null;
  sport: Sport;
  line: LineRoute | null;
  avoid: AvoidArea[];
  zones: Zone[];
}

export class Planner {
  stops = $state<Stop[]>([newStop(), newStop()]);
  sport = $state<Sport>(storedSport());
  /** Raw: a track is thousands of points, and nothing inside it changes. */
  route = $state.raw<RouteState>({ status: 'idle' });
  line = $state.raw<LineRoute | null>(null);
  /** The plan's name as it came, when it came with one: a GPX file's, or the line it was made from.
   *  It stays while the stops are edited, and goes when another plan starts. */
  planName = $state<string | null>(null);
  /** Why the last file couldn't be imported, until the next one is. */
  importMessage = $state('');
  /** Why My Location couldn't be the start, until the plan next changes. */
  locationMessage = $state('');
  /** The rider's last known position, for stops that are "My Location". */
  private position: Coordinate | null = null;
  /** Circles every route stays out of: what the pen erased, blocked or fenced off. */
  avoid = $state.raw<AvoidArea[]>([]);
  /** The areas drawn round, for the map. Their circles are in `avoid`. */
  zones = $state.raw<Zone[]>([]);
  penStatus = $state.raw<PenStatus | null>(null);
  /** The zone clicked with the pen out, offered for removal. */
  selectedZone = $state<number | null>(null);
  private penRequest: AbortController | null = null;

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
  /** The stretches of the lines planned lately: an edit asks brouter.de only for what it touched. */
  private readonly stretches = new StretchCache();
  /** The bends still waiting for their names, one lookup a second. */
  private naming: AbortController | null = null;

  constructor(private readonly locator: Locator = { locate: () => 'unavailable' }) {}

  get canUndo(): boolean { return this.past.length > 0; }

  /** Nothing chosen yet: the card shows one search field, for where to go. */
  get isEmpty(): boolean {
    return !this.line && this.stops.every((stop) => !stop.place && !stop.current);
  }

  /** A stop is "My Location" and the rider hasn't been found yet. */
  get waitingForLocation(): boolean {
    return this.stops.some((stop) => stop.current && !stop.place);
  }

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

  /** The route's name, as the app names a fresh route: the file's it came from, else for where it
   *  goes, and a loop for the place it goes round by. An imported line keeps the file's name. */
  get title(): string {
    if (this.line) return this.line.name;
    if (this.planName) return this.planName;
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
    return {
      stops: this.stops.map((stop) => ({ ...stop, place: stop.place && { ...stop.place } })),
      planName: this.planName, sport: this.sport, line: this.line, avoid: this.avoid, zones: this.zones,
    };
  }

  /** Keeps the plan as it is now, so the change about to be made can be undone. */
  private record(snapshot = this.snapshot()): void {
    this.past = [...this.past.slice(-99), snapshot];
    this.future = [];
    this.locationMessage = '';
  }

  private restore(snapshot: Snapshot): void {
    this.penRequest?.abort();
    this.penStatus = null;
    this.selectedZone = null;
    this.stops = snapshot.stops;
    this.planName = snapshot.planName;
    this.fillMyLocation();
    this.sport = snapshot.sport;
    this.line = snapshot.line;
    this.avoid = snapshot.avoid;
    this.zones = snapshot.zones;
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
    stop.current = false;
    this.plan();
  }

  /** The first pick in an empty plan: where to go, from where the rider is, as the app plans a
   *  place it was shown. Without their location the start is left to choose. */
  chooseDestination(place: Place): void {
    this.record();
    const located = this.locator.locate();
    this.stops = [newStop(null, 'stop', located === 'locating'), newStop(place)];
    this.planName = null;
    if (located === 'blocked') this.locationMessage = locationRefused;
    this.fillMyLocation();
    this.plan();
  }

  /** A stop made "My Location", from its field's suggestions. */
  useMyLocation(id: number): void {
    const stop = this.stops.find((s) => s.id === id);
    if (!stop || this.locator.locate() !== 'locating') return;
    this.record();
    stop.current = true;
    stop.kind = 'stop';
    stop.place = null;
    this.fillMyLocation();
    this.plan();
  }

  /** A fix: stops waiting for the rider's location take it, and the route is planned. A plan made
   *  already stays as it is: the planner isn't navigation. */
  positionArrived(point: Coordinate): void {
    this.position = { latitude: point.latitude, longitude: point.longitude };
    if (this.fillMyLocation()) this.plan();
  }

  /** The rider's location can't be had: stops waiting for it become fields to fill in. */
  locationFailed(): void {
    const waiting = this.stops.filter((stop) => stop.current && !stop.place);
    if (!waiting.length) return;
    for (const stop of waiting) stop.current = false;
    this.locationMessage = locationRefused;
  }

  /** Gives the stops waiting for "My Location" the last fix, if there is one; true if any took it. */
  private fillMyLocation(): boolean {
    const position = this.position;
    if (!position) return false;
    let filled = false;
    for (const stop of this.stops) {
      if (stop.current && !stop.place) {
        stop.place = myLocation(position);
        filled = true;
      }
    }
    return filled;
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
      // The destination of an empty plan is gone to from where the rider is, as from search.
      const fromHere = role === 'end' && this.isEmpty && this.locator.locate() === 'locating';
      stop = role === 'start' ? this.stops[0] : this.stops.at(-1)!;
      stop.place = droppedPin(point);
      stop.kind = 'stop';
      stop.current = false;
      if (fromHere) {
        this.stops[0].current = true;
        this.fillMyLocation();
      }
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
    stop.current = false;
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
      this.stops[index].current = false;
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
    this.naming?.abort();
    this.record();
    this.line = null;
    this.planName = null;
    this.sport = state.sport;
    this.stops = state.points.map((point) => newStop(droppedPin(point, point.kind), point.kind));
    this.plan();
    for (const stop of this.stops) this.name(stop.id, stop.place!);
  }

  /** A GPX file, by docs/ROUTE_GPX.md: a plan is planned again through its points, for its sport
   *  when it names one; anything else is a line, kept exactly as it is. */
  import(track: GPXTrack): void {
    this.naming?.abort();
    this.record();
    this.importMessage = '';
    const sport = sportOf(track);
    if (sport) this.sport = sport;
    // A file with no name of its own leaves the plan to be named for where it goes.
    this.planName = track.name !== unnamed ? track.name : null;
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
    const bends = points.slice(1, -1).map((point) => newStop(droppedPin(point, 'shaping'), 'shaping'));
    this.stops = [start, ...bends, finish];
    this.planName = line.name;
    this.line = null;
    this.plan();
    this.nameSlowly(bends.map((bend) => bend.id));
  }

  /** Names many bends one after another, `namingSpacing` apart, in the background. Bends removed
   *  meanwhile are skipped; if Photon stops answering, the rest keep their placeholder. */
  private nameSlowly(ids: number[]): void {
    this.naming?.abort();
    const naming = new AbortController();
    this.naming = naming;
    (async () => {
      for (const id of ids) {
        await new Promise((resolve) => setTimeout(resolve, namingSpacing));
        if (naming.signal.aborted) return;
        const place = this.stops.find((stop) => stop.id === id)?.place;
        if (!place) continue;
        try {
          await this.nameNow(id, place);
        } catch (error) {
          if (error instanceof SearchUnavailable) return;
        }
      }
    })();
  }

  private showLine(line: LineRoute): void {
    this.request?.abort();
    this.request = null;
    this.route = { status: 'ready', track: line.track, tracks: [line.track], selected: 0, waypoints: this.waypoints };
  }

  /** Shows one of the routes found: the best, or an alternative. */
  chooseRoute(index: number): void {
    const route = this.route;
    if (route.status !== 'ready' || !route.tracks[index] || index === route.selected) return;
    this.route = { ...route, track: route.tracks[index], selected: index };
  }

  // ---------- The pen ----------

  /** A finished stroke over the route, drawn at `metresPerPoint` (`PenStroke.interpret`): ride
   *  another way, erase a section, mark a spot blocked, or fence an area off. The edit replaces only
   *  the part of the route it touches, and from then on the route is its line, as in the app. */
  async draw(stroke: Coordinate[], metresPerPoint: number): Promise<void> {
    const route = this.route;
    if (route.status !== 'ready' || this.penStatus?.kind === 'planning') return;
    const track = route.track;
    const edit = interpret(stroke, track.coordinates, metresPerPoint);
    if (!edit) {
      this.penStatus = { kind: 'failed', text: 'Start and end on the route, scribble along it, or draw across it.' };
      return;
    }
    const before = this.snapshot();
    const request = new AbortController();
    this.penRequest = request;
    this.selectedZone = null;
    this.penStatus = { kind: 'planning' };
    const router = (waypoints: Waypoint[], avoid: AvoidArea[], signal?: AbortSignal) =>
      this.client.route(waypoints, this.sport, { avoid, signal });
    const stillCurrent = () => this.penRequest === request && this.route.status === 'ready' && this.route.track === track;
    try {
      if (edit.kind === 'avoidZone') {
        const result = await avoidZone(edit.polygon, track, this.avoid, router, request.signal);
        if (!stillCurrent()) return;
        this.record(before);
        this.zones = [...this.zones, { id: nextID++, outline: edit.polygon, circles: result.circles }];
        this.avoid = [...this.avoid, ...result.circles];
        if (!result.passes) {
          this.penStatus = { kind: 'applied', text: "No-go zone added. The route doesn't pass it." };
          return;
        }
        this.followLine(result.track, null, edit.polygon);
        this.penStatus = { kind: 'applied', text: summary(edit, result.track.length - track.length) };
        return;
      }
      const result = await planEdit(edit, stroke, track, this.avoid, router, request.signal);
      if (!stillCurrent()) return;
      this.record(before);
      this.avoid = [...this.avoid, ...result.avoid];
      this.followLine(result.track, result.removed, null);
      this.penStatus = { kind: 'applied', text: summary(edit, result.track.length - track.length) };
    } catch {
      if (request.signal.aborted || this.penRequest !== request) return;
      this.penStatus = { kind: 'failed', text: failure(edit) };
    } finally {
      if (this.penRequest === request) this.penRequest = null;
    }
  }

  /** The route becomes `track`, kept as it is from now on. The ends stay; the stops and places
   *  between them become places it passes, except those on a part no longer ridden (`removed`, in
   *  metres along the old line) or inside a zone drawn round (`fenced`). */
  private followLine(track: Track, removed: [number, number] | null, fenced: Coordinate[] | null): void {
    const old = this.route.status === 'ready' ? this.route.track.coordinates : [];
    const name = this.title;
    const passed = this.line ? this.line.places
      : this.stops.slice(1, -1).filter((stop) => stop.kind === 'stop' && stop.place).map((stop) => stop.place!);
    const cumulative = cumulativeDistances(old);
    const kept = passed.filter((place) => {
      if (fenced) return !contains(fenced, place);
      if (!removed) return true;
      const projection = project(old, place);
      if (!projection || projection.distance > stopOnRoute) return true;
      const next = Math.min(projection.segment + 1, old.length - 1);
      const along = cumulative[projection.segment] + projection.t * (cumulative[next] - cumulative[projection.segment]);
      return !(removed[0] < along && along < removed[1]);
    });
    this.stops = [this.stops[0], this.stops.at(-1)!];
    this.line = { name, track, places: kept };
    this.showLine(this.line);
  }

  /** Takes the zone offered for removal away. The route keeps its way round; the next stroke or
   *  plan may use the area. */
  removeSelectedZone(): void {
    const zone = this.zones.find((z) => z.id === this.selectedZone);
    if (!zone) return;
    this.record();
    this.zones = this.zones.filter((z) => z !== zone);
    this.avoid = this.avoid.filter((circle) => !zone.circles.includes(circle));
    this.selectedZone = null;
    this.penStatus = { kind: 'applied', text: 'No-go zone removed. The route keeps its way round; draw to change it.' };
  }

  /** A click with the pen out: the zone under it, if any, is offered for removal. */
  penClicked(point: Coordinate): void {
    this.selectedZone = [...this.zones].reverse().find((zone) => contains(zone.outline, point))?.id ?? null;
  }

  /** The pen put away: an edit still planning is dropped. */
  endDrawing(): void {
    this.penRequest?.abort();
    this.penRequest = null;
    this.penStatus = null;
    this.selectedZone = null;
  }

  // ---------- Routing ----------

  /** Plans the route through the points that are filled in, once there are two. */
  plan(): void {
    this.request?.abort();
    const waypoints = this.waypoints;
    if (waypoints.length < 2) {
      this.request = null;
      this.route = { status: 'idle' };
      // Nothing to keep out of without a route: a new one starts clean.
      this.avoid = [];
      this.zones = [];
      return;
    }
    const request = new AbortController();
    this.request = request;
    const previous = this.route.status === 'ready' ? this.route.track
      : this.route.status === 'planning' ? this.route.previous : null;
    this.route = { status: 'planning', previous };
    const avoid = this.avoid, sport = this.sport;
    // A route through shaping points is one the rider drew; there is nothing else to offer. As it
    // is one route, only the stretches the last edit touched are asked for (plan Phase 7k). A plan
    // that will have alternatives is asked for whole, as each alternative is.
    const shaped = waypoints.some((w) => w.kind === 'shaping');
    const route = (points: Waypoint[]) => this.client.route(points, sport, { avoid, signal: request.signal });
    (shaped ? routeStretches(waypoints, this.stretches, stretchContext(sport, avoid), route) : route(waypoints)).then(
      (track) => {
        if (this.request !== request) return;
        this.route = { status: 'ready', track, tracks: [track], selected: 0, waypoints };
        if (!shaped) this.findAlternatives(request, waypoints, avoid);
      },
      (error: unknown) => {
        if (this.request !== request || request.signal.aborted) return;
        this.route = { status: 'failed', message: messageFor(error) };
      },
    );
  }

  /** The alternatives, once the plan has rested, one after another, best first. A failed one only
   *  ends the search for more; one that repeats a route already found (BRouter's answer when it
   *  has nothing different) is left out. A new plan cancels the lot. */
  private findAlternatives(request: AbortController, waypoints: Waypoint[], avoid: AvoidArea[]): void {
    const signal = request.signal;
    const rested = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, alternativesDelay);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    });
    (async () => {
      await rested;
      for (let alternative = 1; alternative <= alternatives; alternative++) {
        const track = await this.client.route(waypoints, this.sport, { alternative, avoid, signal });
        const route = this.route;
        if (this.request !== request || route.status !== 'ready') return;
        if (route.tracks.some((known) => Math.abs(known.length - track.length) < 1 && known.coordinates.length === track.coordinates.length)) continue;
        this.route = { ...route, tracks: [...route.tracks, track] };
      }
    })().catch(() => { /* the alternatives found stand */ });
  }

  /** Names a point placed by coordinates after what search finds there: a stop by its address,
   *  a bend by its street. Only the name changes, so nothing is planned again. */
  private name(id: number, point: Coordinate): void {
    this.nameNow(id, point).catch(() => { /* the coordinates stay its name */ });
  }

  private async nameNow(id: number, point: Coordinate): Promise<void> {
    const place = await this.search.name(point);
    const stop = this.stops.find((s) => s.id === id);
    // Only if the stop is still that point: it may have been moved or cleared meanwhile.
    if (!place || !stop?.place || stop.place.latitude !== point.latitude || stop.place.longitude !== point.longitude) return;
    stop.place = { ...place, latitude: point.latitude, longitude: point.longitude };
  }
}

const locationRefused = 'Allow location access to plan from your location, or choose a start.';

function messageFor(error: unknown): string {
  if (error instanceof TypeError) return "Can't reach brouter.de. Check the connection and try again.";
  if (error instanceof Error && error.message) {
    // BRouter's own words for a point off its map.
    if (/not mapped/.test(error.message)) return 'A stop is too far from any road or path BRouter knows.';
    return error.message;
  }
  return 'No route was found.';
}
