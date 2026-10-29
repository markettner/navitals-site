// Copied from SwiftBRouter's web/ harness (branch wasm-spike); change it there and copy it back.
//
// BRouter tiles streamed by HTTP range, the browser's StreamedTiles (Navitals/Routing/StreamedTiles.swift).
//
// Before a route is searched, the corridor along its legs (BRouterCorridor) is fetched in one go,
// six requests at a time, so the search rarely waits. What the search still reads that the
// corridor missed is fetched then and there, synchronously (allowed in a worker), in aligned 1 MB
// chunks. Blocks are kept in the origin private file system when it offers synchronous access
// handles (workers in Safari and Chrome), so a second visit to an area fetches nothing; otherwise
// in memory for the page's life.
//
// A tile's file is named by its version, so blocks of two builds of a tile never mix.

const BLOCK = 65536;
const READ_AHEAD = 16 * BLOCK; // what a read mid-search fetches at least, aligned
const RUN_BLOCKS = 64; // at most 4 MB per request
const PARALLEL = 6;
const BUDGET = 150 * 1024 * 1024; // corridor bytes fetched ahead, at most
const DIR = 'brouter-tiles';

class Tile {
  constructor(name, size, version, path = name) {
    this.name = name;
    this.path = path; // where it is under the store's base: the bucket names builds apart
    this.size = size;
    this.version = version;
    this.count = Math.ceil(size / BLOCK);
    this.bits = new Uint8Array((this.count + 7) >> 3);
    this.memory = new Map(); // block -> bytes, when there is no file
    this.file = null; // FileSystemSyncAccessHandle
    this.bitsFile = null;
  }
  has(b) { return (this.bits[b >> 3] >> (b & 7)) & 1; }

  /** Bytes of consecutive blocks starting at `first`. */
  store(first, data) {
    if (this.file) this.file.write(data, { at: first * BLOCK });
    for (let i = 0; i * BLOCK < data.length; i++) {
      if (!this.file) this.memory.set(first + i, data.subarray(i * BLOCK, Math.min((i + 1) * BLOCK, data.length)));
      this.bits[(first + i) >> 3] |= 1 << ((first + i) & 7);
    }
    this.dirty = true;
  }

  /** Copies [offset, offset + dst.length), all of it present, into dst. */
  load(offset, dst) {
    if (this.file) { this.file.read(dst, { at: offset }); return; }
    let done = 0;
    while (done < dst.length) {
      const at = offset + done, b = Math.floor(at / BLOCK), block = this.memory.get(b);
      const part = block.subarray(at - b * BLOCK, Math.min(block.length, at - b * BLOCK + dst.length - done));
      dst.set(part, done);
      done += part.length;
    }
  }

  bytes(offset, length) {
    const out = new Uint8Array(length);
    this.load(offset, out);
    return out;
  }

  missing(offset, length) {
    const first = Math.floor(offset / BLOCK), last = Math.min(this.count - 1, Math.floor((offset + Math.max(length, 1) - 1) / BLOCK));
    const out = [];
    for (let b = first; b <= last; b++) if (!this.has(b)) out.push(b);
    return out;
  }

  flush() {
    if (!this.dirty) return;
    this.dirty = false;
    if (this.bitsFile) { this.bitsFile.write(this.bits, { at: 0 }); this.bitsFile.flush(); this.file.flush(); }
  }
}

/** Consecutive blocks grouped, each group one request of at most RUN_BLOCKS. */
function runs(blocks) {
  const out = [];
  for (const b of [...new Set(blocks)].sort((x, y) => x - y)) {
    const r = out[out.length - 1];
    if (r && r[1] === b - 1 && r[1] - r[0] + 1 < RUN_BLOCKS) r[1] = b;
    else out.push([b, b]);
  }
  return out;
}

export class TileStore {
  /** index: {name: {size, version, key?}}; base: the tiles' URL prefix, key the file's path under it (default: name) */
  constructor(base, index, { persist = true } = {}) {
    this.base = base;
    this.index = index;
    this.persist = persist && typeof FileSystemSyncAccessHandle !== 'undefined';
    this.tiles = new Map();
    this.resetStats();
  }

  resetStats() {
    this.misses = [];
    this.stats = { prefetchMs: 0, prefetchRequests: 0, prefetchBytes: 0, requests: 0, bytes: 0, waitMs: 0 };
  }

  size(name) { return this.index[name]?.size; }

  tile(name) {
    let t = this.tiles.get(name);
    if (!t) {
      const { size, version, key } = this.index[name];
      this.tiles.set(name, t = new Tile(name, size, version, key));
    }
    return t;
  }

  /**
   * Opens a tile's file in the private file system, carrying over blocks already in memory.
   * Handles are exclusive, and Safari keeps a page it navigated away from alive in its
   * back-forward cache, worker and all: so they are held only for a route (`release`), and an
   * open that finds them taken is tried again for a while.
   */
  async open(t) {
    if (!this.persist || t.file) return;
    for (let attempt = 0; ; attempt++) {
      try {
        await this.openOnce(t);
        t.openFailed = undefined;
        return;
      } catch (e) {
        if (attempt >= 10) {
          t.openFailed = String(e); // still taken: this route keeps the tile in memory
          console.warn(`tile ${t.name} stays in memory: ${e}`);
          return;
        }
        await new Promise(r => setTimeout(r, 100));
      }
    }
  }

  async openOnce(t) {
    {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(DIR, { create: true });
      const base = `${t.name}.${t.version}`;
      const file = await (await dir.getFileHandle(base + '.rd5', { create: true })).createSyncAccessHandle();
      const bitsFile = await (await dir.getFileHandle(base + '.blocks', { create: true })).createSyncAccessHandle();
      const bits = new Uint8Array(t.bits.length);
      if (file.getSize() === t.size && bitsFile.getSize() === bits.length) {
        bitsFile.read(bits, { at: 0 });
      } else {
        file.truncate(0); file.truncate(t.size);
        bitsFile.truncate(0); bitsFile.truncate(bits.length);
      }
      for (const [b, data] of t.memory) file.write(data, { at: b * BLOCK });
      for (let i = 0; i < bits.length; i++) t.bits[i] |= bits[i];
      t.memory.clear();
      t.storedBlocks = bits.reduce((n, x) => { while (x) { n += x & 1; x >>= 1; } return n; }, 0);
      t.file = file;
      t.bitsFile = bitsFile;
      t.dirty = true;
      t.flush();
    }
  }

  /** Closes every file, so another page or tab can open them; the next route opens them again. */
  release() {
    for (const t of this.tiles.values()) {
      if (!t.file) continue;
      t.flush();
      t.file.close(); t.bitsFile.close();
      t.file = t.bitsFile = null;
      t.bits.fill(0); // what is stored is read back from the file on opening
    }
  }

  /** Empties the cache, the private file system's copy too. */
  async clear() {
    for (const t of this.tiles.values()) { t.file?.close(); t.bitsFile?.close(); }
    this.tiles.clear();
    if (this.persist) {
      try { await (await navigator.storage.getDirectory()).removeEntry(DIR, { recursive: true }); } catch (e) { console.warn(`cache not cleared: ${e}`); }
    }
  }

  flush() { for (const t of this.tiles.values()) t.flush(); }

  // The engine's reads

  /** Copies [offset, offset + len) of tile `name` into dst, fetching what is missing. */
  read(name, offset, len, dst) {
    const t = this.tile(name);
    const end = Math.min(offset + len, t.size);
    if (offset >= end) return 0;
    if (t.missing(offset, end - offset).length) {
      // a read the corridor missed is rarely the last one nearby: fetch the aligned chunk round it
      (this.misses ??= []).push({ t, offset });
      const from = Math.floor(offset / READ_AHEAD) * READ_AHEAD;
      const to = Math.min(Math.ceil(end / READ_AHEAD) * READ_AHEAD, t.size);
      for (const [a, b] of runs(t.missing(from, to - from))) this.fetchSync(t, a, b);
    }
    t.load(offset, dst.subarray(0, end - offset));
    return end - offset;
  }

  /** Where the search's own fetches landed: [{tile, lon, lat, inCorridor}] (diagnostics). */
  explainMisses(boxes) {
    const out = [];
    for (const { t, offset } of this.misses ?? []) {
      const ends = sectionEnds(t.bytes(0, 200));
      const section = ends.findIndex(e => e > offset);
      const start = section > 0 ? ends[section - 1] : 200;
      const [west, south] = southWest(t.name);
      const lon0 = west + Math.floor(section / 5), lat0 = south + section % 5;
      if (section < 0 || section === 24 && offset >= ends[23]) { out.push({ tile: t.name, what: 'tail' }); continue; }
      const rel = offset - start;
      if (rel < 4096) { out.push({ tile: t.name, what: 'index', lon0, lat0 }); continue; }
      const table = new Uint8Array(4096);
      this.read(t.name, start, 4096, table);
      const position = i => ((table[i * 4] << 24) >>> 0) + (table[i * 4 + 1] << 16) + (table[i * 4 + 2] << 8) + table[i * 4 + 3];
      let i = 0;
      while (i < 1024 && position(i) <= rel) i++;
      const lon = lon0 + ((i % 32) + 0.5) / 32, lat = lat0 + (Math.floor(i / 32) + 0.5) / 32;
      out.push({ tile: t.name, what: 'cell', lon: +lon.toFixed(3), lat: +lat.toFixed(3),
                 inCorridor: boxes.some(b => lon >= b[0] && lon <= b[2] && lat >= b[1] && lat <= b[3]) });
    }
    return out;
  }

  fetchSync(t, first, last) {
    const from = first * BLOCK, to = Math.min((last + 1) * BLOCK, t.size) - 1;
    const t0 = performance.now();
    const xhr = new XMLHttpRequest();
    xhr.open('GET', this.base + t.path, false);
    xhr.responseType = 'arraybuffer';
    xhr.setRequestHeader('Range', `bytes=${from}-${to}`);
    xhr.send();
    const data = this.checked(t, xhr.status, xhr.getResponseHeader('Content-Range'), xhr.response, from, to);
    this.stats.waitMs += performance.now() - t0;
    this.stats.requests++;
    this.stats.bytes += data.length;
    t.store(first, data);
  }

  /** The answer must be the tile the index describes: a different size means it changed under us. */
  checked(t, status, contentRange, buffer, from, to) {
    const total = Number(contentRange?.split('/')[1]);
    const data = new Uint8Array(buffer);
    if (status !== 206 || total !== t.size || data.length !== to - from + 1) {
      throw new Error(`range ${from}-${to} of ${t.name}: HTTP ${status}, ${contentRange}, ${data.length} bytes`);
    }
    return data;
  }

  // The corridor

  /** Fetches the given block runs, PARALLEL requests at a time. */
  async fetchRuns(work) {
    let next = 0;
    const worker = async () => {
      while (next < work.length) {
        const [t, first, last] = work[next++];
        const from = first * BLOCK, to = Math.min((last + 1) * BLOCK, t.size) - 1;
        const r = await fetch(this.base + t.path, { headers: { Range: `bytes=${from}-${to}` } });
        const data = this.checked(t, r.status, r.headers.get('Content-Range'), await r.arrayBuffer(), from, to);
        t.store(first, data);
        this.stats.prefetchRequests++;
        this.stats.prefetchBytes += data.length;
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, work.length) }, worker));
  }

  /** Fetches whatever of these [tile, offset, length] ranges is missing. */
  async ensure(ranges) {
    const work = [];
    for (const [t, offset, length] of ranges) for (const [a, b] of runs(t.missing(offset, length))) work.push([t, a, b]);
    await this.fetchRuns(work);
  }

  /** Fetches the corridor along `stops` ([[lon, lat], …]), up to BUDGET. */
  async prefetch(stops, margins) {
    const t0 = performance.now();
    const boxes = corridor(stops, margins);
    const names = [];
    for (const box of boxes) {
      for (const n of namesCovering(box).map(n => n + '.rd5')) if (this.index[n] && !names.includes(n)) names.push(n);
    }
    const tiles = names.map(n => this.tile(n));
    await Promise.all(tiles.map(t => this.open(t)));

    // what the cells' positions take: the header, the checksum table at the end (the engine checks
    // it on opening), and the index of every section a box touches
    await this.ensure(tiles.map(t => [t, 0, 200]));
    const ends = new Map(tiles.map(t => [t, sectionEnds(t.bytes(0, 200))]));
    const sections = [];
    for (const box of boxes) {
      for (const t of tiles) {
        for (const s of touchedSections(t.name, box)) {
          if (!sections.some(x => x.t === t && x.section === s.section)) sections.push({ t, ...s });
        }
      }
    }
    const indexSize = 32 * 32 * 4;
    const sectionStart = (t, section) => section > 0 ? ends.get(t)[section - 1] : 200;
    await this.ensure([
      ...tiles.map(t => [t, ends.get(t)[24], t.size - ends.get(t)[24]]),
      ...sections.filter(s => ends.get(s.t)[s.section] > sectionStart(s.t, s.section))
        .map(s => [s.t, sectionStart(s.t, s.section), indexSize]),
    ]);

    // the cells, box by box from the start, until the budget
    const planned = new Map(tiles.map(t => [t, new Set()]));
    let bytes = 0;
    corridor: for (const box of boxes) {
      for (const t of tiles) {
        for (const s of touchedSections(t.name, box)) {
          const start = sectionStart(t, s.section);
          if (ends.get(t)[s.section] <= start) continue;
          const table = t.bytes(start, indexSize);
          const position = i => ((table[i * 4] << 24) >>> 0) + (table[i * 4 + 1] << 16) + (table[i * 4 + 2] << 8) + table[i * 4 + 3];
          const cell = (v, origin) => Math.min(31, Math.max(0, Math.floor((v - origin) * 32)));
          const c0 = cell(box[0], s.lon), c1 = cell(box[2], s.lon);
          for (let row = cell(box[1], s.lat); row <= cell(box[3], s.lat); row++) {
            const firstCell = row * 32 + c0, lastCell = row * 32 + c1;
            const from = firstCell === 0 ? indexSize : position(firstCell - 1), to = position(lastCell);
            if (to <= from) continue;
            for (const b of t.missing(start + from, to - from)) {
              if (!planned.get(t).has(b)) { planned.get(t).add(b); bytes += BLOCK; }
            }
          }
          if (bytes >= BUDGET) break corridor; // past it, the search fetches what it reads
        }
      }
    }
    const work = [];
    for (const [t, blocks] of planned) for (const [a, b] of runs([...blocks])) work.push([t, a, b]);
    await this.fetchRuns(work);
    this.flush();
    this.stats.prefetchMs = performance.now() - t0;
  }
}

// Tile geometry

/** The 25 section end offsets of a tile, from its 200-byte header. */
function sectionEnds(header) {
  const out = [];
  for (let i = 0; i < 25; i++) {
    let v = 0;
    for (let k = 2; k < 8; k++) v = v * 256 + header[i * 8 + k]; // the low 48 bits
    out.push(v);
  }
  return out;
}

function southWest(name) {
  const [a, b] = name.replace(/\.rd5$/, '').split('_');
  return [(a[0] === 'W' ? -1 : 1) * Number(a.slice(1)), (b[0] === 'S' ? -1 : 1) * Number(b.slice(1))];
}

/** The 1° sections of a tile that a box touches. */
function touchedSections(name, box) {
  const [west, south] = southWest(name);
  const out = [];
  for (let lon = west; lon < west + 5; lon++) {
    if (!(lon + 1 > box[0] && lon < box[2])) continue;
    for (let lat = south; lat < south + 5; lat++) {
      if (lat + 1 > box[1] && lat < box[3]) out.push({ section: (lon - west) * 5 + (lat - south), lon, lat });
    }
  }
  return out;
}

const tileName = (lon, lat) => `${lon < 0 ? 'W' : 'E'}${Math.abs(lon)}_${lat < 0 ? 'S' : 'N'}${Math.abs(lat)}`;

/** The tile a point lies in, as the index names it. */
export function tileFor([lon, lat]) {
  return tileName(Math.floor(lon / 5) * 5, Math.floor(lat / 5) * 5) + '.rd5';
}

/** BRouterTileManifest.names(covering:) */
function namesCovering(box) {
  const w = Math.floor(box[0] / 5) * 5, s = Math.floor(box[1] / 5) * 5;
  const e = Math.floor((box[2] - 1e-9) / 5) * 5, n = Math.floor((box[3] - 1e-9) / 5) * 5;
  const out = [];
  for (let lon = w; lon <= e; lon += 5) for (let lat = s; lat <= n; lat += 5) out.push(tileName(lon, lat));
  return out;
}

// BRouterCorridor (NavitalsKit): a band along each leg, as a run of overlapping boxes in route order

// Wider than the app's band (0.15, 10–20 km): a read the corridor missed stalls the search for a
// round trip, one at a time. Measured in Safari on 8 fixture routes round Berlin, cold, 50 ms per
// request and 50 Mbit/s: 15% took 6.4–7.2 s for the mid routes (more than half waiting mid-search),
// 30% 5.0–6.4 s (fastbike and mtb still waiting 3–5 s), 50% 4.4–5.6 s, nearly all of it the ~20 MB.
// The minimum only matters for legs under 10 km: 20 km made a 2.5 km city route fetch 10 MB, all of
// Berlin. Short Berlin routes at 50 ms and 10 Mbit/s: 2.5 km took 8.9 s with 20 km, 3.0–3.9 s with
// 5 km (3.3 MB); only mtb on 10 km started waiting mid-search (3 s), at 3 km already on 5 km.
const MARGIN_SHARE = 0.5, MIN_MARGIN = 5000, MAX_MARGIN = 40000;

function distance([lon1, lat1], [lon2, lat2]) {
  const r = Math.PI / 180, dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(h));
}

function box(a, b, margin) {
  const perDegree = 111320;
  const lat = margin / perDegree;
  const widest = Math.min(89, Math.max(Math.abs(a[1]), Math.abs(b[1])));
  const lon = margin / (perDegree * Math.cos(widest * Math.PI / 180));
  return [Math.min(a[0], b[0]) - lon, Math.min(a[1], b[1]) - lat, Math.max(a[0], b[0]) + lon, Math.max(a[1], b[1]) + lat];
}

/** margins: [share of the leg, minimum m, maximum m], the app's by default */
export function corridor(stops, [share, minMargin, maxMargin] = [MARGIN_SHARE, MIN_MARGIN, MAX_MARGIN]) {
  if (stops.length === 0) return [];
  if (stops.length === 1) return [box(stops[0], stops[0], minMargin)];
  const out = [];
  for (let i = 0; i + 1 < stops.length; i++) {
    const a = stops[i], b = stops[i + 1];
    const length = distance(a, b);
    const margin = Math.min(maxMargin, Math.max(minMargin, length * share));
    const pieces = Math.max(1, Math.ceil(length / (margin / 2)));
    const at = f => [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
    for (let p = 0; p < pieces; p++) out.push(box(at(p / pieces), at((p + 1) / pieces), margin));
  }
  return out;
}
