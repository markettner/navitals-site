// The app's PhotonGeocoderTests and SearchSourcesTests, on the same answers.

import { describe, expect, test } from 'vitest';
import {
  BadStatus, CircuitBreaker, PlaceSearch, RequestGate, SearchUnavailable, merging, nominatimPlace,
  nominatimSearchURL, photonAddress, photonPlaces, photonSearchURL, type Place,
} from '../src/core/search';

/** Trimmed from a real photon.komoot.io response. */
const photon = JSON.stringify({ type: 'FeatureCollection', features: [
  { type: 'Feature', properties: { osm_type: 'W', osm_id: 86379623, osm_key: 'railway', osm_value: 'platform', name: 'Hauptbahnhof',
    street: 'Europaplatz', district: 'Moabit', city: 'Berlin', country: 'Germany', postcode: '10557' },
  geometry: { type: 'Point', coordinates: [13.3701211, 52.5253038] } },
  { type: 'Feature', properties: { osm_type: 'W', osm_id: 346206374, osm_key: 'highway', osm_value: 'pedestrian', name: 'Alexanderplatz',
    district: 'Mitte', city: 'Berlin', country: 'Germany' },
  geometry: { type: 'Point', coordinates: [13.4131914, 52.5216438] } },
  { type: 'Feature', properties: { osm_type: 'N', osm_id: 1, osm_key: 'building', osm_value: 'yes', street: 'Chausseestraße',
    housenumber: '94', city: 'Berlin', country: 'Germany' },
  geometry: { type: 'Point', coordinates: [13.38, 52.53] } },
] });

const feature = (id: number, name: string, longitude: number, latitude: number, extra: object = {}) => ({
  type: 'Feature', properties: { osm_type: 'N', osm_id: id, name, district: 'Mitte', city: 'Berlin', ...extra },
  geometry: { type: 'Point', coordinates: [longitude, latitude] },
});
const collection = (...features: object[]) => JSON.stringify({ type: 'FeatureCollection', features });

describe('Photon', () => {
  test('decodes name, coordinate, kind and id', () => {
    const places = photonPlaces(photon);
    expect(places).toHaveLength(3);
    expect(places[0]).toMatchObject({ id: 'W:86379623', name: 'Hauptbahnhof', latitude: 52.5253038, longitude: 13.3701211, kind: 'other' });
    expect(places[1].kind).toBe('street');
  });

  test('the subtitle locates without repeating the title', () => {
    const places = photonPlaces(photon);
    expect(places[0].subtitle).toBe('Europaplatz, Moabit');
    expect(places[1].subtitle).toBe('Mitte, Berlin');
  });

  test('an unnamed address falls back to its street line', () => {
    expect(photonPlaces(photon)[2]).toMatchObject({ name: 'Chausseestraße 94', subtitle: 'Berlin, Germany', kind: 'address' });
  });

  test('the same object twice, or one place as two objects at one point, is one place', () => {
    expect(photonPlaces(collection(feature(1, 'Central Cemetery', 14.51, 53.41), feature(1, 'Central Cemetery', 14.51, 53.41)))).toHaveLength(1);
    expect(photonPlaces(collection(feature(1, 'Volkspark', 13.4, 52.5), { ...feature(2, 'Volkspark', 13.4, 52.5) }))).toHaveLength(1);
  });

  test('a station modelled as many objects collapses, and does not bury the landmark', () => {
    const tor = (id: number, latitude: number, longitude: number) => feature(id, 'Brandenburger Tor', longitude, latitude, { street: 'Unter den Linden' });
    const places = photonPlaces(collection(tor(1, 52.5164, 13.3808), tor(2, 52.51645, 13.3815), tor(3, 52.51638, 13.3812),
      tor(4, 52.51642, 13.3809), feature(5, 'Brandenburg Gate', 13.3777, 52.51627, { street: 'Pariser Platz' })));
    expect(places.map((p) => p.name)).toEqual(['Brandenburger Tor', 'Brandenburg Gate']);
  });

  test('namesakes far apart stay two places, and results without ids get distinct ones', () => {
    expect(photonPlaces(collection(feature(1, 'Rathaus', 13.4, 52.52), feature(2, 'Rathaus', 13.413, 52.52)))).toHaveLength(2);
    const idless = photonPlaces(collection(
      { type: 'Feature', properties: { name: 'A' }, geometry: { coordinates: [13.39, 52.53] } },
      { type: 'Feature', properties: { name: 'B' }, geometry: { coordinates: [13.44, 52.54] } }));
    expect(new Set(idless.map((p) => p.id)).size).toBe(2);
  });

  test('an address beats the estate agent on the ground floor, at the point asked about', () => {
    const point = { latitude: 52.521782, longitude: 13.401925 };
    const place = photonAddress(collection(
      { type: 'Feature', properties: { osm_key: 'office', name: 'conecta Immobilien', street: 'Garnisonkirchplatz', district: 'Mitte', city: 'Berlin' },
        geometry: { coordinates: [13.4019, 52.5218] } },
      { type: 'Feature', properties: { osm_key: 'place', street: 'Garnisonkirchplatz', housenumber: '2', district: 'Mitte', city: 'Berlin' },
        geometry: { coordinates: [13.402, 52.5219] } }), point)!;
    expect(place).toMatchObject({ name: 'Garnisonkirchplatz 2', subtitle: 'Mitte, Berlin', ...point });
  });

  test('with no address, a street; with no street, the nearest thing; with nothing, nothing', () => {
    const point = { latitude: 52.43, longitude: 13.68 };
    expect(photonAddress(collection({ properties: { name: 'Kiosk', street: 'Am See' }, geometry: { coordinates: [13.68, 52.43] } }), point)?.name).toBe('Am See');
    expect(photonAddress(collection({ properties: { name: 'Badestelle Kleiner Müggelsee' }, geometry: { coordinates: [13.677, 52.428] } }), point)?.name)
      .toBe('Badestelle Kleiner Müggelsee');
    expect(photonAddress(collection(), point)).toBeNull();
  });

  test('malformed geometry is skipped, not fatal', () => {
    expect(photonPlaces(collection({ properties: { name: 'X' }, geometry: { coordinates: [] } }))).toEqual([]);
  });

  test('the request carries the bias, the limit and a language Photon serves', () => {
    const url = new URL(photonSearchURL('  Alex ', { latitude: 52.52, longitude: 13.4 }, 'pt-BR'));
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: 'Alex', limit: '12', lang: 'en', lat: '52.52', lon: '13.4' });
    expect(new URL(photonSearchURL('x', null, 'de-DE')).searchParams.get('lang')).toBe('de');
  });
});

describe('Nominatim', () => {
  test('an address without a name is titled by its street line, with Photon id form', () => {
    expect(nominatimPlace({ osm_type: 'node', osm_id: 42, lat: '52.5219', lon: '13.4020', category: 'place', type: 'house',
      address: { road: 'Garnisonkirchplatz', house_number: '2', suburb: 'Mitte', city: 'Berlin', country: 'Deutschland' } }))
      .toMatchObject({ id: 'N:42', name: 'Garnisonkirchplatz 2', subtitle: 'Mitte, Berlin', kind: 'address' });
  });

  test('a named place keeps its name, and the street becomes the subtitle', () => {
    expect(nominatimPlace({ osm_type: 'way', osm_id: 7, lat: '52.52', lon: '13.41', name: 'Fernsehturm',
      address: { road: 'Panoramastraße', house_number: '1A', suburb: 'Mitte', city: 'Berlin' } }))
      .toMatchObject({ id: 'W:7', name: 'Fernsehturm', subtitle: 'Panoramastraße 1A, Mitte' });
  });

  test('the request prefers the box around the bias', () => {
    const url = new URL(nominatimSearchURL('Müggelsee', { latitude: 52.44, longitude: 13.64 }, 'de'));
    expect(url.searchParams.get('viewbox')).toBe('13.3400,52.6400,13.9400,52.2400');
    expect(url.searchParams.get('format')).toBe('jsonv2');
    expect(url.searchParams.get('accept-language')).toBe('de');
  });

  test('the same question twice reaches the server once, and questions are spaced a second apart', async () => {
    let calls = 0;
    const slept: number[] = [];
    let clock = 0;
    const gate = new RequestGate(1000, () => clock, async (ms) => { slept.push(ms); clock += ms; });
    const search = new PlaceSearch({ language: 'en', nominatimGate: gate, fetch: (async () => {
      calls++;
      return new Response('[{"osm_type":"node","osm_id":1,"lat":"52.5","lon":"13.4","name":"Somewhere"}]');
    }) as typeof fetch });
    await search.search('Somewhere', null);
    await search.search('Somewhere', null);
    expect(calls).toBe(1);
    await search.search('Elsewhere', null);
    expect(calls).toBe(2);
    expect(slept).toEqual([1000]);
  });
});

describe('the circuit breaker', () => {
  test('two failures in a row open it, and a success in between resets the count', () => {
    const breaker = new CircuitBreaker(2, 300_000, () => 0);
    breaker.failed();
    breaker.succeeded();
    breaker.failed();
    expect(breaker.isOpen).toBe(false);
    breaker.failed();
    expect(breaker.isOpen).toBe(true);
    expect(breaker.allows()).toBe(false);
  });

  test('after the cooldown exactly one probe goes out; its answer closes or reopens it', () => {
    let now = 0;
    const breaker = new CircuitBreaker(2, 1000, () => now);
    breaker.failed();
    breaker.failed();
    now = 1000;
    expect(breaker.allows()).toBe(true);
    expect(breaker.allows()).toBe(false);
    breaker.failed();
    expect(breaker.allows()).toBe(false);
    now = 2000;
    expect(breaker.allows()).toBe(true);
    breaker.succeeded();
    expect(breaker.isOpen).toBe(false);
  });

  test('once open, Photon is not asked at all; a 400 or an abort says nothing about the server', async () => {
    let calls = 0;
    let status = 400;
    const search = new PlaceSearch({ language: 'en', fetch: (async (_: unknown, init?: RequestInit) => {
      calls++;
      init?.signal?.throwIfAborted();
      return new Response('', { status });
    }) as typeof fetch });
    await expect(search.suggest('a', null)).rejects.toBeInstanceOf(BadStatus);
    await expect(search.suggest('b', null)).rejects.toBeInstanceOf(BadStatus);
    const aborted = new AbortController();
    aborted.abort();
    await expect(search.suggest('c', null, aborted.signal)).rejects.toBeDefined();
    status = 503;
    await expect(search.suggest('d', null)).rejects.toBeInstanceOf(BadStatus);
    await expect(search.suggest('e', null)).rejects.toBeInstanceOf(BadStatus);
    await expect(search.suggest('f', null)).rejects.toBeInstanceOf(SearchUnavailable);
    await expect(search.name({ latitude: 52.5, longitude: 13.4 })).rejects.toBeInstanceOf(SearchUnavailable);
    expect(calls).toBe(5);
  });
});

describe('merging', () => {
  const place = (id: string, name: string, latitude: number, kind: Place['kind'] = 'other'): Place =>
    ({ id, name, subtitle: '', latitude, longitude: 13.4, kind });

  test('rows on screen keep their order, and only new places are appended', () => {
    const shown = [place('N:1', 'A', 52.5), place('N:2', 'B', 52.51)];
    expect(merging(shown, [place('N:2', 'B', 52.51), place('N:3', 'C', 52.52)]).map((p) => p.id)).toEqual(['N:1', 'N:2', 'N:3']);
  });

  test('one street from two sources is one row; the same name far apart is two places', () => {
    expect(merging([place('W:1', 'Torstraße', 52.5, 'street')], [place('W:2', 'Torstraße', 52.508, 'street')])).toHaveLength(1);
    expect(merging([place('N:1', 'Rathaus', 52.5)], [place('N:2', 'Rathaus', 52.508)])).toHaveLength(2);
  });
});
