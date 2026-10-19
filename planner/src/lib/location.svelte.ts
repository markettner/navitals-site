// Where the rider is, for the dot, the Locate button and "My Location" as a stop.
//
// One watch for all three. It takes a fix up to five minutes old, so a browser that knows where it
// is answers at once. A fresh fix from the system can take a minute on a Mac, and MapLibre's own
// control, given `positionOptions` of ours, had lost its defaults and waited for exactly that.
// A timeout doesn't end the watch: the fix may still come, and the button says it is still looking.
//
// The browser's cache that `maximumAge` reads is the tab's own, so a second planner tab used to wait
// for the system all over again. Open planner tabs therefore share their fixes (a BroadcastChannel,
// in memory only), and a hidden tab keeps watching for a minute, which keeps the system's location
// warm while the rider switches between tabs.

import type { Coordinate } from '../core/geodesy';

export type LocationStatus = 'off' | 'locating' | 'on' | 'slow' | 'denied' | 'unavailable';

export interface Fix extends Coordinate {
  /** Metres, as the browser estimates them. */
  accuracy: number;
  /** When it was taken, in milliseconds since the epoch. */
  at: number;
}

const options: PositionOptions = { enableHighAccuracy: false, maximumAge: 300_000, timeout: 15_000 };
/** How old a fix from another tab may be and still stand for where the rider is. */
const sharedAge = 300_000;
/** How long a hidden tab keeps watching before it lets go. */
const hiddenGrace = 60_000;

type Message = { type: 'ask' } | { type: 'fix'; fix: Fix };

export class LocationService {
  status = $state<LocationStatus>(typeof navigator !== 'undefined' && navigator.geolocation ? 'off' : 'unavailable');
  /** The last fix, kept while the watch pauses with the tab hidden. */
  fix = $state.raw<Fix | null>(null);

  private watch: number | null = null;
  private wanted = false;
  private askedAt = 0;
  private hiddenTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly listeners = new Set<(fix: Fix) => void>();
  private readonly channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('navitals-planner-location');

  constructor() {
    if (this.status === 'unavailable') return;
    // Another tab asking gets our fix, if it is recent; another tab's fix stands for ours until
    // our own comes, if this tab wants one at all.
    if (this.channel) {
      this.channel.onmessage = (event: MessageEvent<Message>) => {
        const message = event.data;
        if (message.type === 'ask' && this.fix && Date.now() - this.fix.at < sharedAge) {
          this.channel?.postMessage({ type: 'fix', fix: this.fix } satisfies Message);
        } else if (message.type === 'fix' && this.wanted && this.status !== 'denied'
          && Date.now() - message.fix.at < sharedAge && message.fix.at > (this.fix?.at ?? 0)) {
          this.arrived(message.fix, false);
        }
      };
    }
    // Already allowed: start now, without asking, so My Location is ready when it is wanted.
    navigator.permissions?.query({ name: 'geolocation' }).then((permission) => {
      if (permission.state === 'granted') this.start();
      if (permission.state === 'denied') this.status = 'denied';
      permission.addEventListener('change', () => {
        if (permission.state === 'denied') {
          this.stopWatching();
          this.status = 'denied';
        } else if (permission.state === 'granted' && this.status === 'denied') {
          this.status = 'off';
          this.start();
        }
      });
    }).catch(() => { /* no Permissions API: wait for the rider to ask */ });
    document.addEventListener('visibilitychange', () => {
      clearTimeout(this.hiddenTimer);
      if (document.hidden) this.hiddenTimer = setTimeout(() => this.stopWatching(), hiddenGrace);
      else if (this.wanted && this.watch === null) this.watchNow();
    });
  }

  /** Starts watching, asking the browser for permission if it hasn't been given. Call it from a
   *  click or a pick, so the browser's prompt has the rider's gesture behind it. */
  start(): void {
    if (this.status === 'unavailable') return;
    this.wanted = true;
    if (this.watch === null && !document.hidden) this.watchNow();
  }

  /** Calls `listener` with every fix from now on; returns the way to stop. */
  onFix(listener: (fix: Fix) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private watchNow(): void {
    if (this.status !== 'on') this.status = 'locating';
    this.askedAt = performance.now();
    // Another planner tab may already know.
    if (!this.fix) this.channel?.postMessage({ type: 'ask' } satisfies Message);
    this.watch = navigator.geolocation.watchPosition(
      (position) => {
        if (import.meta.env.DEV && this.status !== 'on') console.debug(`First fix after ${Math.round(performance.now() - this.askedAt)} ms`);
        this.arrived({
          latitude: position.coords.latitude, longitude: position.coords.longitude,
          accuracy: position.coords.accuracy, at: position.timestamp || Date.now(),
        }, true);
      },
      (error) => {
        if (error.code === error.PERMISSION_DENIED) {
          this.wanted = false;
          this.stopWatching();
          this.status = 'denied';
        } else if (this.status !== 'on') {
          // TIMEOUT or POSITION_UNAVAILABLE: the watch goes on, and the fix may still come.
          this.status = 'slow';
        }
      },
      options,
    );
  }

  /** A fix, from this tab's watch (`own`, then shared with the others) or from another tab. */
  private arrived(fix: Fix, own: boolean): void {
    this.fix = fix;
    this.status = 'on';
    if (own) this.channel?.postMessage({ type: 'fix', fix } satisfies Message);
    for (const listener of this.listeners) listener(fix);
  }

  private stopWatching(): void {
    if (this.watch !== null) navigator.geolocation.clearWatch(this.watch);
    this.watch = null;
  }
}
