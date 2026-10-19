// Where the rider is, for the blue dot, the Locate button and "My Location" as a stop.
//
// One watch for all three. It takes a fix up to five minutes old, so a browser that knows where it
// is answers at once. A fresh fix from the system can take a minute on a Mac, and MapLibre's own
// control, given `positionOptions` of ours, had lost its defaults and waited for exactly that.
// A timeout doesn't end the watch: the fix may still come, and the button says it is still looking.

import type { Coordinate } from '../core/geodesy';

export type LocationStatus = 'off' | 'locating' | 'on' | 'slow' | 'denied' | 'unavailable';

export interface Fix extends Coordinate {
  /** Metres, as the browser estimates them. */
  accuracy: number;
}

const options: PositionOptions = { enableHighAccuracy: false, maximumAge: 300_000, timeout: 15_000 };

export class LocationService {
  status = $state<LocationStatus>(typeof navigator !== 'undefined' && navigator.geolocation ? 'off' : 'unavailable');
  /** The last fix, kept while the watch pauses with the tab hidden. */
  fix = $state.raw<Fix | null>(null);

  private watch: number | null = null;
  private wanted = false;
  private askedAt = 0;
  private readonly listeners = new Set<(fix: Fix) => void>();

  constructor() {
    if (this.status === 'unavailable') return;
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
      if (document.hidden) this.stopWatching();
      else if (this.wanted) this.watchNow();
    });
  }

  get available(): boolean {
    return this.status !== 'unavailable';
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
    this.watch = navigator.geolocation.watchPosition(
      (position) => {
        if (import.meta.env.DEV && this.status !== 'on') console.debug(`First fix after ${Math.round(performance.now() - this.askedAt)} ms`);
        const fix = { latitude: position.coords.latitude, longitude: position.coords.longitude, accuracy: position.coords.accuracy };
        this.fix = fix;
        this.status = 'on';
        for (const listener of this.listeners) listener(fix);
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

  private stopWatching(): void {
    if (this.watch !== null) navigator.geolocation.clearWatch(this.watch);
    this.watch = null;
  }
}
