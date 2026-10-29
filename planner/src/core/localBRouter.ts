// BRouter in the browser: SwiftBRouter compiled to WebAssembly, in a worker (engine/worker.js),
// streaming tiles by HTTP range (from R2, which navitals-packs' monthly run fills) and keeping them
// in the origin private file system. Behind a switch while it is tried out: `?engine=local` turns it
// on for this browser, `?engine=brouter.de` off again. Whatever it can't do (no tiles there, a tile that won't load,
// the engine failing) BRouterClient asks brouter.de instead.

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
}

export class LocalBRouter {
  private module: Promise<WebAssembly.Module> | null = null;
  private running: Running | null = null;
  /** Routes go one at a time: the engine has one thread. */
  private queue: Promise<unknown> = Promise.resolve();
  /** The engine wouldn't start (no module, no tile index): brouter.de for the rest of the visit. */
  broken = false;

  constructor(private readonly options: LocalBRouterOptions) {}

  /** The engine's answer: GeoJSON, or BRouter's reason it found no route. Rejects with
   *  EngineUnavailable when brouter.de should be asked instead. */
  route(request: EngineRequest, signal?: AbortSignal): Promise<string> {
    const turn = this.queue.then(() => this.run(request, signal));
    this.queue = turn.catch(() => undefined);
    return turn;
  }

  private async run(request: EngineRequest, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    if (this.broken) throw new EngineUnavailable('The engine is off for this visit.');
    const running = this.running ??= this.start();
    try {
      await running.ready;
    } catch (error) {
      this.broken = true;
      this.stop(running);
      throw new EngineUnavailable(`The engine didn't start: ${String(error)}`);
    }
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

  private stop(running: Running): void {
    running.worker.terminate();
    if (this.running === running) this.running = null;
  }
}

const switchKey = 'navitals.planner.engine';

/** The engine, when this browser has it switched on and there are tiles to stream from. */
export function localBRouter(): LocalBRouter | undefined {
  // Set by the Pages build. In development, SwiftBRouter's web/server.mjs serves local tiles
  // (VITE_BROUTER_TILES=http://localhost:8471/tiles/), or R2 itself does: CORS allows :5173.
  const tiles: string | undefined = import.meta.env.VITE_BROUTER_TILES;
  if (!tiles || typeof Worker === 'undefined' || typeof WebAssembly === 'undefined') return undefined;
  let on = false;
  try {
    const asked = new URLSearchParams(location.search).get('engine');
    if (asked === 'local') localStorage.setItem(switchKey, 'local');
    else if (asked) localStorage.removeItem(switchKey);
    on = localStorage.getItem(switchKey) === 'local';
  } catch {
    on = new URLSearchParams(location.search).get('engine') === 'local';
  }
  if (!on) return undefined;
  const base = import.meta.env.BASE_URL;
  return new LocalBRouter({ tiles, profiles: `${base}profiles/`, module: `${base}engine/brouter.wasm` });
}
