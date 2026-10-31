// The on-device engine's thread: SwiftBRouter compiled to WebAssembly, reading tiles by HTTP range
// (tiles.js) through a minimal WASI (wasi.js). Both are copies of SwiftBRouter's web/ harness.
// localBRouter.ts sends the compiled module and one route at a time; a route can't be stopped
// halfway, so an abandoned one ends with the worker.
//
//   → {type: 'init', module, tiles, profiles}     tiles: URL prefix of index.json and the .rd5s
//   ← {type: 'ready'} | {type: 'failed', error}
//   → {type: 'route', request, stops}             request: the engine's tab-separated fields
//   ← {type: 'downloading', done, total}*, {type: 'searching'}, then {type: 'answer', text}
//     | {type: 'uncovered'} | {type: 'failed', error}

import { ProfileStore, WASI } from './wasi.js';
import { TileStore, tileFor } from './tiles.js';

let wasi, exports;

function route(request) {
  const bytes = new TextEncoder().encode(request);
  const p = exports.brouter_alloc(bytes.length);
  new Uint8Array(exports.memory.buffer, p, bytes.length).set(bytes);
  const out = exports.brouter_route(p, bytes.length);
  exports.brouter_free(p);
  const length = new DataView(exports.memory.buffer).getUint32(out, true);
  const text = new TextDecoder().decode(new Uint8Array(exports.memory.buffer, out + 4, length));
  exports.brouter_free(out);
  return text;
}

onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      const index = await (await fetch(data.tiles + 'index.json')).json();
      wasi = new WASI(new TileStore(data.tiles, index), new ProfileStore(data.profiles));
      const instance = await WebAssembly.instantiate(data.module, wasi.imports);
      wasi.start(instance);
      exports = instance.exports;
      postMessage({ type: 'ready' });
    } else if (data.type === 'route') {
      // A stop outside the tiles we have is brouter.de's to route.
      if (data.stops.some((stop) => !wasi.tiles.index[tileFor(stop)])) {
        postMessage({ type: 'uncovered' });
        return;
      }
      wasi.tiles.resetStats();
      wasi.tiles.onProgress = (done, total) => postMessage({ type: 'downloading', done, total });
      await wasi.tiles.prefetch(data.stops);
      postMessage({ type: 'searching' });
      let text;
      try {
        text = route(data.request);
      } finally {
        wasi.tiles.release();
      }
      postMessage({ type: 'answer', text, stats: wasi.tiles.stats });
    }
  } catch (error) {
    postMessage({ type: 'failed', error: String(error?.stack ?? error) });
  }
};
