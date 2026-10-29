// The brouter.de client against a stand-in server: uploads, a forgotten profile, refusals, and the
// app's second request for a shaping point on the far side of the road. And the on-device engine
// in front of it, stood in for: what it is asked, and when brouter.de is asked instead.

import { describe, expect, test } from 'vitest';
import fixtureText from './fixtures/brouter-far-side-via.json?raw';
import { BRouterClient, RoutingError } from '../src/core/brouterClient';
import { EngineUnavailable, type EngineRequest, type LocalBRouter } from '../src/core/localBRouter';
import type { Waypoint } from '../src/core/route';

type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response>;

/** A fetch that records every request and answers through `handler`. */
function server(handler: Handler) {
  const requests: { url: URL; method: string }[] = [];
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    requests.push({ url, method: init?.method ?? 'GET' });
    return handler(url, init);
  }) as typeof globalThis.fetch;
  return { fetch, requests, routes: () => requests.filter((r) => r.method === 'GET') };
}

const geojson = (line: number[][], length: number) => JSON.stringify({
  type: 'FeatureCollection',
  features: [{ type: 'Feature', properties: { 'track-length': String(length), 'total-time': '600', 'filtered ascend': '4' },
    geometry: { type: 'LineString', coordinates: line } }],
});
const straight = geojson([[13.40, 52.52, 34], [13.42, 52.51, 35]], 1800);
const uploaded = (id: string) => new Response(JSON.stringify({ profileid: id }), { headers: { 'Content-Type': 'application/json' } });
const points: Waypoint[] = [
  { latitude: 52.52, longitude: 13.40, kind: 'stop' },
  { latitude: 52.51, longitude: 13.42, kind: 'stop' },
];
const profileText = async (profile: string) => `# ${profile}.brf`;

describe('the brouter.de client', () => {
  test('a profile is uploaded once and routed with by its id', async () => {
    let uploads = 0;
    const brouter = server((url, init) => {
      if (url.pathname.endsWith('/profile')) {
        expect(init?.body).toBe('# gravel.brf');
        return uploaded(`custom_${++uploads}`);
      }
      return new Response(straight);
    });
    const client = new BRouterClient({ profileText, fetch: brouter.fetch });
    const [first, second] = await Promise.all([client.route(points, 'gravel'), client.route(points, 'gravel')]);
    expect(first.length).toBe(1800);
    expect(second.ascent).toBe(4);
    expect(uploads).toBe(1);
    expect(brouter.routes().map((r) => r.url.searchParams.get('profile'))).toEqual(['custom_1', 'custom_1']);
    expect(brouter.routes()[0].url.searchParams.get('profile:pass2coefficient')).toBe('1');
  });

  test('a forgotten profile is uploaded again and the route asked once more', async () => {
    let uploads = 0;
    const brouter = server((url) => {
      if (url.pathname.endsWith('/profile')) return uploaded(`custom_${++uploads}`);
      // brouter.de answers a profile it no longer has with an empty 500.
      return url.searchParams.get('profile') === 'custom_1' && uploads === 2
        ? new Response('', { status: 500 })
        : new Response(straight);
    });
    const client = new BRouterClient({ profileText, fetch: brouter.fetch });
    await client.route(points, 'cycling');
    uploads = 2; // the server forgets custom_1
    const track = await client.route(points, 'cycling');
    expect(track.length).toBe(1800);
    expect(brouter.routes().map((r) => r.url.searchParams.get('profile'))).toEqual(['custom_1', 'custom_1', 'custom_3']);
  });

  test("a refusal with a reason is the route's problem, not the profile's: no upload, the reason shown", async () => {
    let uploads = 0;
    const brouter = server((url) => {
      if (url.pathname.endsWith('/profile')) return uploaded(`custom_${++uploads}`);
      return new Response('from-position not mapped in existing datafile\n', { status: 400 });
    });
    const client = new BRouterClient({ profileText, fetch: brouter.fetch });
    await expect(client.route(points, 'road')).rejects.toThrow(new RoutingError('from-position not mapped in existing datafile'));
    expect(uploads).toBe(1);
  });

  test("when the upload fails, brouter.de's own profile of that name routes, and the next route tries the upload again", async () => {
    let uploadsTried = 0;
    const brouter = server((url) => {
      if (url.pathname.endsWith('/profile')) {
        uploadsTried++;
        return new Response('busy', { status: 503 });
      }
      return new Response(straight);
    });
    const client = new BRouterClient({ profileText, fetch: brouter.fetch });
    await client.route(points, 'hiking');
    await client.route(points, 'hiking');
    expect(brouter.routes().map((r) => r.url.searchParams.get('profile'))).toEqual(['hiking-mountain', 'hiking-mountain']);
    expect(uploadsTried).toBe(2);
  });

  test('a shaping point on the far side of the road is asked again from the near side, and the shorter kept', async () => {
    const fixture = JSON.parse(fixtureText) as { farVia: number[]; farLine: number[][]; nearLine: number[][] };
    const far = fixture.farLine, near = fixture.nearLine;
    const via: Waypoint[] = [
      { latitude: far[0][1], longitude: far[0][0], kind: 'stop' },
      { latitude: fixture.farVia[1], longitude: fixture.farVia[0], kind: 'shaping' },
      { latitude: far.at(-1)![1], longitude: far.at(-1)![0], kind: 'stop' },
    ];
    const brouter = server((url) => {
      if (url.pathname.endsWith('/profile')) return uploaded('custom_1');
      // The first request has the point where it was dropped; the second, moved, gets the near line.
      const middle = url.searchParams.get('lonlats')!.split('|')[1];
      const asDropped = middle === `${fixture.farVia[0].toFixed(6)},${fixture.farVia[1].toFixed(6)}`;
      return new Response(asDropped ? geojson(far, 900) : geojson(near, 400));
    });
    const client = new BRouterClient({ profileText, fetch: brouter.fetch });
    const track = await client.route(via, 'cycling');
    expect(brouter.routes()).toHaveLength(2);
    expect(track.length).toBe(400);
  });

  test('an aborted route rejects, and the upload it was waiting for still serves the next one', async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let uploads = 0;
    const brouter = server(async (url) => {
      if (url.pathname.endsWith('/profile')) {
        uploads++;
        await held;
        return uploaded('custom_1');
      }
      return new Response(straight);
    });
    const client = new BRouterClient({ profileText, fetch: brouter.fetch });
    const controller = new AbortController();
    const first = client.route(points, 'mountainBike', { signal: controller.signal });
    controller.abort();
    await expect(first).rejects.toBeDefined();
    const second = client.route(points, 'mountainBike');
    release();
    expect((await second).length).toBe(1800);
    expect(uploads).toBe(1);
  });

  test('ferries left out are taken after all when BRouter finds no route without them, and only then', async () => {
    const answers: Record<string, () => Response> = {
      noRoute: () => new Response('no track found at pass=0\n', { status: 400 }),
      refused: () => new Response('Please, retry later!', { status: 403 }),
      offMap: () => new Response('from-position not mapped in existing datafile\n', { status: 400 }),
      bare: () => new Response('', { status: 503 }),
    };
    for (const [kind, refusal] of Object.entries(answers)) {
      const brouter = server((url) => {
        if (url.pathname.endsWith('/profile')) return uploaded('custom_1');
        return url.searchParams.get('profile:allow_ferries') === '0' ? refusal() : new Response(straight);
      });
      const client = new BRouterClient({ profileText, fetch: brouter.fetch });
      const route = client.route(points, 'road', { without: ['ferries'] });
      if (kind === 'noRoute') expect((await route).length).toBe(1800);
      else await expect(route).rejects.toBeDefined();
      expect(brouter.routes(), kind).toHaveLength(kind === 'refused' || kind === 'offMap' ? 1 : 2);
    }
  });

  test('a lost connection is not asked again without the ferries', async () => {
    let routes = 0;
    const fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.method === 'POST') return uploaded('custom_1');
      routes++;
      throw new TypeError('Failed to fetch');
    }) as typeof globalThis.fetch;
    const client = new BRouterClient({ profileText, fetch });
    await expect(client.route(points, 'road', { without: ['ferries'] })).rejects.toThrow(TypeError);
    expect(routes).toBe(1);
  });
});

describe('the on-device engine in front of brouter.de', () => {
  /** An engine that answers through `answer` and records what it was asked. */
  function engine(answer: (request: EngineRequest) => string) {
    const requests: EngineRequest[] = [];
    const stand = { broken: false, route: async (request: EngineRequest) => { requests.push(request); return answer(request); } };
    return { engine: stand as unknown as LocalBRouter, requests };
  }
  const nowhere = server(() => { throw new Error('brouter.de was asked'); });

  test("it gets brouter.de's request, without the profile: prefix, and brouter.de is never asked", async () => {
    const local = engine(() => straight);
    const client = new BRouterClient({ profileText, fetch: nowhere.fetch, engine: local.engine });
    const via: Waypoint[] = [points[0], { latitude: 52.515, longitude: 13.41, kind: 'stop' }, points[1]];
    const track = await client.route(via, 'gravel', { alternative: 2, avoid: [{ latitude: 52.5, longitude: 13.4, radius: 50.4 }], without: ['ferries'] });
    expect(track.length).toBe(1800);
    expect(local.requests).toEqual([{
      profile: 'gravel',
      alternative: 2,
      lonlats: '13.400000,52.520000|13.410000,52.515000,m|13.420000,52.510000',
      parameters: { pass2coefficient: '1', allow_ferries: '0' },
      nogos: '13.400000,52.500000,50',
    }]);
    expect(nowhere.requests).toHaveLength(0);
  });

  test("BRouter's reason for no route is shown without the exception's name, and brouter.de isn't asked", async () => {
    const local = engine(() => 'error: java.lang.IllegalArgumentException: from-position not mapped in existing datafile');
    const client = new BRouterClient({ profileText, fetch: nowhere.fetch, engine: local.engine });
    await expect(client.route(points, 'road')).rejects.toThrow(new RoutingError('from-position not mapped in existing datafile'));
  });

  test('when the engine can\'t answer, brouter.de routes', async () => {
    const local = engine(() => { throw new EngineUnavailable('No tiles there.'); });
    const brouter = server((url) => (url.pathname.endsWith('/profile') ? uploaded('custom_1') : new Response(straight)));
    const client = new BRouterClient({ profileText, fetch: brouter.fetch, engine: local.engine });
    expect((await client.route(points, 'cycling')).length).toBe(1800);
    expect(local.requests).toHaveLength(1);
    expect(brouter.routes()).toHaveLength(1);
  });
});
