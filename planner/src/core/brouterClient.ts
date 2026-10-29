// Routing on brouter.de with our own profiles (plan Phase 7j).
//
// Each profile is uploaded once per visit (`POST /brouter/profile`, which answers with a
// `custom_<id>`) and routed with by that id. brouter.de forgets custom profiles after a while and
// then answers a route for the id with an empty 500, so on a failure the profile is uploaded again
// and the route asked once more. If an upload fails outright, brouter.de's own profile of the same
// name is used: our files are brouter.de's copies (checked 2026-10-17), but for the ferry and steps
// switches the app added to gravel, which brouter.de's gravel goes without.
//
// With the on-device engine switched on (localBRouter.ts), routes are asked of it first, and of
// brouter.de only when it can't answer.

import { BRouterDecodeError, decode, lonlats, nogos, profileFor, profileParameters, routeURL, type AvoidArea, type Track } from './brouter';
import { EngineUnavailable, type LocalBRouter } from './localBRouter';
import { nearSideWaypoints } from './nearSide';
import type { Sport, Way, Waypoint } from './route';

export const brouterBase = 'https://brouter.de/brouter';

export class RoutingError extends Error {}

export interface RouteRequestOptions {
  alternative?: number;
  /** Circles to stay out of. */
  avoid?: AvoidArea[];
  /** Ferries and steps to leave out, where there is a way round them. */
  without?: Way[];
  signal?: AbortSignal;
}

export interface BRouterClientOptions {
  base?: string;
  /** The text of a profile, by name. */
  profileText: (profile: string) => Promise<string>;
  fetch?: typeof fetch;
  /** The on-device engine, asked before brouter.de. */
  engine?: LocalBRouter;
}

export class BRouterClient {
  private readonly base: string;
  private readonly profileText: (profile: string) => Promise<string>;
  private readonly fetch: typeof fetch;
  private readonly engine?: LocalBRouter;
  /** The id brouter.de gave each uploaded profile (or will: the upload may still be on its way). */
  private readonly uploaded = new Map<string, Promise<string>>();

  constructor(options: BRouterClientOptions) {
    this.base = options.base ?? brouterBase;
    this.profileText = options.profileText;
    this.fetch = options.fetch ?? fetch.bind(globalThis);
    this.engine = options.engine;
  }

  /** BRouter's route through the waypoints for a sport. A shaping point dropped on the far side of
   *  a divided road is moved to the near side and the route asked again, once, when the first
   *  answer loops to reach it; the second answer is kept only if it is shorter. As the app does. */
  async route(waypoints: Waypoint[], sport: Sport, options: RouteRequestOptions = {}): Promise<Track> {
    let track: Track;
    try {
      track = await this.answer(waypoints, sport, options);
    } catch (error) {
      // To BRouter a ferry or steps switched off are closed, and the app's Route Options promise a
      // preference: where there is no way round, the route takes them. As the app does.
      if (options.signal?.aborted || !options.without?.length) throw error;
      options = { ...options, without: [] };
      track = await this.answer(waypoints, sport, options);
    }
    const nearSide = nearSideWaypoints(waypoints, track.coordinates);
    if (!nearSide) return track;
    try {
      const better = await this.answer(nearSide, sport, options);
      return better.length < track.length ? better : track;
    } catch (error) {
      if (options.signal?.aborted) throw error;
      return track;
    }
  }

  private async answer(waypoints: Waypoint[], sport: Sport, options: RouteRequestOptions): Promise<Track> {
    const profile = profileFor(sport);
    if (this.engine && !this.engine.broken) {
      try {
        return await this.engineAnswer(waypoints, profile, options);
      } catch (error) {
        if (!(error instanceof EngineUnavailable)) throw error;
        console.warn(`brouter.de instead of the engine: ${error.message}`);
      }
    }
    const id = await this.profileID(profile, options.signal);
    let response = await this.get(waypoints, id, options);
    let text = await response.text();
    if (!response.ok && id !== profile && !text.trim()) {
      // An empty refusal for our id: brouter.de has forgotten the profile. Upload it again and ask
      // once more. A refusal with a reason ("position not mapped …") is about the route instead.
      this.uploaded.delete(profile);
      response = await this.get(waypoints, await this.profileID(profile, options.signal), options);
      text = await response.text();
    }
    if (!response.ok) throw new RoutingError(text.trim() || `brouter.de answered ${response.status}.`);
    try {
      return decode(text);
    } catch (error) {
      // BRouter explains a refusal in plain text ("position not mapped in existing datafile").
      if (error instanceof BRouterDecodeError) throw new RoutingError(text.trim() || error.message);
      throw error;
    }
  }

  /** The engine's route: the same request and the same answer as brouter.de's, with our profiles. */
  private async engineAnswer(waypoints: Waypoint[], profile: string, options: RouteRequestOptions): Promise<Track> {
    const text = await this.engine!.route({
      profile,
      alternative: options.alternative ?? 0,
      lonlats: lonlats(waypoints),
      parameters: profileParameters(waypoints, options.without),
      nogos: nogos(options.avoid ?? []),
    }, options.signal);
    // BRouter's reason, as the engine passes on the exception: "error: java.lang.…Exception: <reason>"
    if (text.startsWith('error:')) throw new RoutingError(text.replace(/^error:\s*(?:[\w.]+Exception:\s*)?/, '').trim());
    try {
      return decode(text);
    } catch (error) {
      if (error instanceof BRouterDecodeError) throw new RoutingError(error.message);
      throw error;
    }
  }

  private get(waypoints: Waypoint[], profile: string, options: RouteRequestOptions): Promise<Response> {
    return this.fetch(routeURL(this.base, waypoints, profile, options.alternative ?? 0, options.avoid, options.without),
      { signal: options.signal });
  }

  /** Our profile's id on brouter.de, uploading it if this visit hasn't yet. */
  private profileID(profile: string, signal?: AbortSignal): Promise<string> {
    let id = this.uploaded.get(profile);
    if (!id) {
      id = this.upload(profile);
      this.uploaded.set(profile, id);
      // A failed upload is not remembered, so the next route tries again.
      id.then((value) => { if (value === profile) this.uploaded.delete(profile); });
    }
    // The upload belongs to every route that waits for it, so one route's abort doesn't cancel it.
    if (!signal) return id;
    return Promise.race([id, new Promise<never>((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    })]);
  }

  private async upload(profile: string): Promise<string> {
    try {
      const response = await this.fetch(`${this.base}/profile`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: await this.profileText(profile),
      });
      const answer = (await response.json()) as { profileid?: string; error?: string };
      if (response.ok && answer.profileid) return answer.profileid;
    } catch {
      // Falls through to brouter.de's own profile.
    }
    return profile;
  }
}
