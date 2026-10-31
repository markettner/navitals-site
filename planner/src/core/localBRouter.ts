// BRouter in the browser: SwiftBRouter compiled to WebAssembly, in a worker (engine/worker.js),
// streaming tiles by HTTP range (from R2, which navitals-packs' monthly run fills) and keeping them
// in the origin private file system. It plans what is within `engineReach`; a longer plan would
// mean too much to download and too much memory on a phone, and goes to brouter.de, as does whatever
// the engine can't do (no tiles there, a tile that won't load, the engine failing).
// `?engine=brouter.de` turns it off for this browser, `?engine=local` on again.

import { length, type Coordinate } from './geodesy';

/** The longest plan the engine takes, metres in straight lines between its points: all that is known
 *  of a plan before it is routed. */
export const engineReach = 150_000;

/** Whether a plan through these points is the engine's. */
export function withinEngineReach(points: Coordinate[]): boolean {
  return length(points) <= engineReach;
}

/** The engine couldn't answer: the route is brouter.de's to ask. */
export class EngineUnavailable extends Error {}

export interface EngineRequest {
  profile: string;
  alternative: number;
  /** BRouter's `lonlats`, as brouter.de gets them. */
  lonlats: string;
  /** Without the `profile:` brouter.de's names carry. */
  parameters: Record<string, string>;
  /** BRouter's `nogos`. */
  nogos: string;
}

/** What the engine is downloading: itself, or map data (`total` 0 while that isn't known yet). */
export type EngineDownload = { what: 'engine' } | { what: 'map'; done: number; total: number };

/** A download over before this is not worth a word: a warm route's few blocks, a cached engine. */
const downloadNoticeDelay = 300;

interface Running {
  worker: Worker;
  ready: Promise<void>;
}

export interface LocalBRouterOptions {
  /** URL prefix of the tiles' `index.json` and `.rd5` files. */
  tiles: string;
  /** URL prefix of the profiles and `lookups.dat`. */
  profiles: string;
  /** URL of `brouter.wasm`. */
  module: string;
  /** Told what is being downloaded for the route under way, and null when that's over. */
  onDownload?: (download: EngineDownload | null) => void;
}

export class LocalBRouter {
  private module: Promise<WebAssembly.Module> | null = null;
  private running: Running | null = null;
  /** Routes go one at a time: the engine has one thread. */
  private queue: Promise<unknown> = Promise.resolve();
  /** The engine wouldn't start (no module, no tile index): brouter.de for the rest of the visit. */
  broken = false;
  private download: EngineDownload | null = null;
  private downloadShown = false;
  private downloadTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: LocalBRouterOptions) {}

  /** The engine's answer: GeoJSON, or BRouter's reason it found no route. Rejects with
   *  EngineUnavailable when brouter.de should be asked instead. */
  route(request: EngineRequest, signal?: AbortSignal): Promise<string> {
    const turn = this.queue.then(() => this.run(request, signal)).finally(() => this.report(null));
    this.queue = turn.catch(() => undefined);
    return turn;
  }

  private async run(request: EngineRequest, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    if (this.broken) throw new EngineUnavailable('The engine is off for this visit.');
    const running = this.running ??= this.start();
    this.report({ what: 'engine' });
    try {
      await running.ready;
    } catch (error) {
      this.broken = true;
      this.stop(running);
      throw new EngineUnavailable(`The engine didn't start: ${String(error)}`);
    }
    this.report(null);
    signal?.throwIfAborted();
    const stops = request.lonlats.split('|').map((stop) => stop.split(',').slice(0, 2).map(Number));
    const fields = [request.profile, String(request.alternative), '0', request.lonlats,
      new URLSearchParams(request.parameters).toString(), request.nogos];
    const reply = await new Promise<{ type: string; text?: string; error?: string }>((resolve, reject) => {
      const abort = () => {
        // The search can't be stopped halfway: the worker goes, and the next route starts another.
        this.stop(running);
        reject(signal?.reason);
      };
      signal?.addEventListener('abort', abort, { once: true });
      running.worker.onmessage = ({ data }) => {
        if (data.type === 'downloading') {
          this.report({ what: 'map', done: data.done, total: data.total });
          return;
        }
        if (data.type === 'searching') {
          this.report(null);
          return;
        }
        signal?.removeEventListener('abort', abort);
        resolve(data);
      };
      running.worker.onerror = (event) => {
        signal?.removeEventListener('abort', abort);
        resolve({ type: 'failed', error: event.message });
      };
      running.worker.postMessage({ type: 'route', request: fields.join('\t'), stops });
    });
    if (reply.type === 'answer') return reply.text ?? '';
    if (reply.type === 'uncovered') throw new EngineUnavailable('No tiles there.');
    // A tile that wouldn't load, or the engine failing: what it holds is no longer to be trusted.
    this.stop(running);
    throw new EngineUnavailable(reply.error ?? 'The engine failed.');
  }

  private start(): Running {
    this.module ??= WebAssembly.compileStreaming(fetch(this.options.module));
    const module = this.module;
    const worker = new Worker(new URL('../engine/worker.js', import.meta.url), { type: 'module' });
    const ready = module.then((compiled) => new Promise<void>((resolve, reject) => {
      worker.onmessage = ({ data }) => (data.type === 'ready' ? resolve() : reject(new Error(data.error)));
      worker.onerror = (event) => reject(new Error(event.message));
      worker.postMessage({ type: 'init', module: compiled, tiles: this.options.tiles, profiles: this.options.profiles });
    }));
    return { worker, ready };
  }

  private report(download: EngineDownload | null): void {
    this.download = download;
    if (!download) {
      if (this.downloadTimer) clearTimeout(this.downloadTimer);
      this.downloadTimer = null;
      if (this.downloadShown) this.options.onDownload?.(null);
      this.downloadShown = false;
    } else if (this.downloadShown) {
      this.options.onDownload?.(download);
    } else {
      this.downloadTimer ??= setTimeout(() => {
        this.downloadTimer = null;
        this.downloadShown = true;
        this.options.onDownload?.(this.download);
      }, downloadNoticeDelay);
    }
  }

  private stop(running: Running): void {
    running.worker.terminate();
    if (this.running === running) this.running = null;
  }
}

const switchKey = 'navitals.planner.engine';

/** The engine, unless this browser has it switched off or there are no tiles to stream from. */
export function localBRouter(onDownload?: LocalBRouterOptions['onDownload']): LocalBRouter | undefined {
  // Set by the Pages build. In development, SwiftBRouter's web/server.mjs serves local tiles
  // (VITE_BROUTER_TILES=http://localhost:8471/tiles/), or R2 itself does: CORS allows :5173.
  const tiles: string | undefined = import.meta.env.VITE_BROUTER_TILES;
  if (!tiles || typeof Worker === 'undefined' || typeof WebAssembly === 'undefined') return undefined;
  const asked = new URLSearchParams(location.search).get('engine');
  let off = asked === 'brouter.de';
  try {
    if (asked === 'brouter.de') localStorage.setItem(switchKey, asked);
    else if (asked) localStorage.removeItem(switchKey);
    off = localStorage.getItem(switchKey) === 'brouter.de';
  } catch {
    // Without storage the switch lasts for this address.
  }
  if (off) return undefined;
  const base = import.meta.env.BASE_URL;
  return new LocalBRouter({ tiles, profiles: `${base}profiles/`, module: `${base}engine/brouter.wasm`, onDownload });
}
