// What a route is made of, as the app models it (NavitalsKit's Sport and RouteWaypoint).

import type { Coordinate } from './geodesy';

/** The activities Navitals routes for, by the app's raw values, in the app's order. */
export type Sport = 'hiking' | 'cycling' | 'road' | 'gravel' | 'mountainBike';

export const sports: { id: Sport; title: string }[] = [
  { id: 'hiking', title: 'Hiking' },
  { id: 'cycling', title: 'Cycling' },
  { id: 'road', title: 'Road' },
  { id: 'gravel', title: 'Gravel' },
  { id: 'mountainBike', title: 'MTB' },
];

/** What a route can leave out beyond its avoided circles: the app's Route Options, which BRouter
 *  knows as each profile's `allow_ferries` and `allow_steps`. In the order a link lists them. */
export type Way = 'ferries' | 'steps';
export const ways: Way[] = ['ferries', 'steps'];

/** A stop is somewhere the rider is going. A shaping point is somewhere the route has been dragged
 *  through: it bends the line and is passed silently. A place is somewhere on a route that follows
 *  its line, shown but never routed to. */
export type WaypointKind = 'stop' | 'shaping' | 'place';

export interface Waypoint extends Coordinate {
  name?: string;
  kind: WaypointKind;
}
