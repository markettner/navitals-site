// Copied from SwiftBRouter's web/ harness; change it there and copy it back.
//
// A minimal WASI preview1 for brouter.wasm, in a Worker. Two read-only preopened directories:
//   /segments  .rd5 tiles, from a TileStore (tiles.js)
//   /profiles  .brf profiles and lookups.dat, fetched whole
// Everything else is stdout/stderr, clocks and randomness.

const ESUCCESS = 0, EBADF = 8, EINVAL = 28, ENOENT = 44, ENOSYS = 52;
const FILETYPE_DIR = 3, FILETYPE_FILE = 4;

export class ProfileStore {
  constructor(base) { this.base = base; this.files = new Map(); }
  get(name) {
    if (this.files.has(name)) return this.files.get(name);
    const xhr = new XMLHttpRequest();
    xhr.open('GET', this.base + name, false);
    xhr.responseType = 'arraybuffer';
    xhr.send();
    const data = xhr.status === 200 ? new Uint8Array(xhr.response) : null;
    this.files.set(name, data);
    return data;
  }
}

export class WASI {
  constructor(tiles, profiles) {
    this.tiles = tiles;
    this.profiles = profiles;
    this.preopens = { 3: '/segments', 4: '/profiles' };
    this.fds = new Map(); // fd -> {dir, name, pos}
    this.nextFd = 5;
    this.memory = null;
    this.stdout = '';
    const w = this;
    const view = () => new DataView(w.memory.buffer);
    const bytes = () => new Uint8Array(w.memory.buffer);
    const str = (p, n) => new TextDecoder().decode(bytes().subarray(p, p + n));
    const size = f => f.dir === 3 ? w.tiles.size(f.name) : w.profiles.get(f.name).length;
    const exists = (dir, name) => dir === 3 ? w.tiles.size(name) !== undefined : w.profiles.get(name) !== null;
    const clean = p => p.replace(/^\.?\//, '');

    this.imports = {
      wasi_snapshot_preview1: {
        args_sizes_get(argc, bufSize) { view().setUint32(argc, 0, true); view().setUint32(bufSize, 0, true); return ESUCCESS; },
        args_get() { return ESUCCESS; },
        environ_sizes_get(n, bufSize) { view().setUint32(n, 0, true); view().setUint32(bufSize, 0, true); return ESUCCESS; },
        environ_get() { return ESUCCESS; },
        clock_res_get(id, out) { view().setBigUint64(out, 1000n, true); return ESUCCESS; },
        clock_time_get(id, precision, out) {
          const ns = id === 0 ? BigInt(Date.now()) * 1000000n : BigInt(Math.round((performance.timeOrigin + performance.now()) * 1e6));
          view().setBigUint64(out, ns, true);
          return ESUCCESS;
        },
        random_get(p, n) {
          for (let i = 0; i < n; i += 65536) crypto.getRandomValues(bytes().subarray(p + i, p + Math.min(n, i + 65536)));
          return ESUCCESS;
        },
        proc_exit(code) { throw new Error(`proc_exit(${code})`); },
        poll_oneoff() { return ENOSYS; },
        fd_fdstat_set_flags() { return ESUCCESS; },
        fd_prestat_get(fd, out) {
          const name = w.preopens[fd];
          if (!name) return EBADF;
          view().setUint32(out, 0, true);
          view().setUint32(out + 4, name.length, true);
          return ESUCCESS;
        },
        fd_prestat_dir_name(fd, p, n) {
          bytes().set(new TextEncoder().encode(w.preopens[fd]).subarray(0, n), p);
          return ESUCCESS;
        },
        fd_fdstat_get(fd, out) {
          const v = view();
          const type = fd <= 2 ? 2 : w.preopens[fd] ? FILETYPE_DIR : w.fds.has(fd) ? FILETYPE_FILE : -1;
          if (type < 0) return EBADF;
          v.setUint8(out, type);
          v.setUint16(out + 2, 0, true);
          v.setBigUint64(out + 8, 0xffffffffffffffffn, true);
          v.setBigUint64(out + 16, 0xffffffffffffffffn, true);
          return ESUCCESS;
        },
        path_filestat_get(dirfd, flags, p, n, out) {
          if (!w.preopens[dirfd]) return EBADF;
          const name = clean(str(p, n));
          let type, len = 0;
          if (name === '' || name === '.') type = FILETYPE_DIR;
          else if (exists(dirfd, name)) { type = FILETYPE_FILE; len = size({ dir: dirfd, name }); }
          else return ENOENT;
          const v = view();
          for (let i = 0; i < 64; i += 8) v.setBigUint64(out + i, 0n, true);
          v.setUint8(out + 16, type);
          v.setBigUint64(out + 24, 1n, true);
          v.setBigUint64(out + 32, BigInt(len), true);
          return ESUCCESS;
        },
        path_open(dirfd, dirflags, p, n, oflags, rightsBase, rightsInheriting, fdflags, fdOut) {
          if (!w.preopens[dirfd]) return EBADF;
          const name = clean(str(p, n));
          if (oflags & 0b1101) return EINVAL; // create, exclusive or truncate: read-only
          if (!exists(dirfd, name)) return ENOENT;
          const fd = w.nextFd++;
          w.fds.set(fd, { dir: dirfd, name, pos: 0 });
          view().setUint32(fdOut, fd, true);
          return ESUCCESS;
        },
        fd_close(fd) { return w.fds.delete(fd) ? ESUCCESS : EBADF; },
        fd_seek(fd, offset, whence, out) {
          const f = w.fds.get(fd);
          if (!f) return EBADF;
          const base = whence === 0 ? 0 : whence === 1 ? f.pos : size(f);
          f.pos = base + Number(offset);
          view().setBigUint64(out, BigInt(f.pos), true);
          return ESUCCESS;
        },
        fd_pread(fd, iovs, iovsLen, offset, nread) {
          const f = w.fds.get(fd);
          if (!f) return EBADF;
          view().setUint32(nread, w.readv(f, iovs, iovsLen, Number(offset)), true);
          return ESUCCESS;
        },
        fd_read(fd, iovs, iovsLen, nread) {
          const f = w.fds.get(fd);
          if (!f) return EBADF;
          const n = w.readv(f, iovs, iovsLen, f.pos);
          f.pos += n;
          view().setUint32(nread, n, true);
          return ESUCCESS;
        },
        fd_write(fd, iovs, iovsLen, nwritten) {
          const v = view();
          let total = 0;
          for (let i = 0; i < iovsLen; i++) {
            const p = v.getUint32(iovs + 8 * i, true), len = v.getUint32(iovs + 8 * i + 4, true);
            w.stdout += str(p, len);
            total += len;
          }
          v.setUint32(nwritten, total, true);
          return ESUCCESS;
        },
      },
    };
  }

  readv(f, iovs, iovsLen, offset) {
    const v = new DataView(this.memory.buffer);
    let total = 0;
    for (let i = 0; i < iovsLen; i++) {
      const p = v.getUint32(iovs + 8 * i, true), len = v.getUint32(iovs + 8 * i + 4, true);
      const dst = new Uint8Array(this.memory.buffer, p, len);
      let n;
      if (f.dir === 3) {
        n = this.tiles.read(f.name, offset + total, len, dst);
      } else {
        const data = this.profiles.get(f.name);
        const part = data.subarray(Math.min(offset + total, data.length), Math.min(offset + total + len, data.length));
        dst.set(part);
        n = part.length;
      }
      total += n;
      if (n < len) break;
    }
    return total;
  }

  start(instance) {
    this.memory = instance.exports.memory;
    instance.exports._initialize();
  }
}
