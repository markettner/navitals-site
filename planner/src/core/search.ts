// Place search, by the app's rules (plan Phase 7i; NavitalsKit's PhotonGeocoder, NominatimGeocoder,
// CircuitBreaker and Place.merging).
//
// Photon answers as you type, behind a circuit breaker. Nominatim answers an explicit search (Enter)
// only: its policy forbids autocomplete and asks for at most one request a second, answers cached,
// and a client that identifies itself, which a browser does with its Referer. The app's own search
// index is app-only.

import type { Coordinate } from './geodesy';

export interface Place extends Coordinate {
  /** OSM's object as `N:123` / `W:123` / `R:123`, the same from both sources, or the point itself. */
  id: string;
  name: string;
  /** The most specific locator first, never repeating the name. */
  subtitle: string;
  kind: 'street' | 'address' | 'other';
}

/** The rider's own position as a stop: the app's `RouteStop.currentLocationName`. */
export const myLocationName = 'My Location';

/** What a rider might type for "My Location": the app's name, the usual others, and German, since a
 *  German rider types it that way whatever the page's language. */
const myLocationWords = ['my location', 'current location', 'current position', 'location', 'position', 'standort', 'mein standort', 'aktuelle position', 'aktueller standort'];

/** Whether a stop field's text still asks for "My Location": nothing typed yet, or the start of one
 *  of its names (two letters at least, so "l" doesn't put it over every search). */
export function matchesMyLocation(text: string): boolean {
  const typed = text.trim().toLowerCase().replace(/\s+/g, ' ');
  if (!typed) return true;
  return typed.length >= 2 && myLocationWords.some((word) => word.startsWith(typed));
}

export class SearchUnavailable extends Error {}

export class BadStatus extends Error {
  constructor(readonly status: number) {
    super(`The search server answered ${status}.`);
  }
}

// ---------- Photon ----------

interface PhotonProperties {
  osm_type?: string; osm_id?: number; osm_key?: string; osm_value?: string;
  name?: string; street?: string; housenumber?: string; postcode?: string;
  locality?: string; district?: string; city?: string; state?: string; country?: string;
}
interface PhotonFeature { geometry?: { coordinates?: number[] }; properties?: PhotonProperties }

export const photonHost = 'https://photon.komoot.io';

/** Photon serves only a few languages, and anything else is a 400. */
export function photonLanguage(language: string): string {
  const code = language.slice(0, 2).toLowerCase();
  return ['de', 'en', 'fr', 'it'].includes(code) ? code : 'en';
}

export function photonSearchURL(query: string, bias: Coordinate | null, language: string, limit = 12): string {
  const params = new URLSearchParams({ q: query.trim(), limit: String(limit), lang: photonLanguage(language) });
  if (bias) {
    params.set('lat', String(bias.latitude));
    params.set('lon', String(bias.longitude));
  }
  return `${photonHost}/api?${params}`;
}

export function photonReverseURL(point: Coordinate, language: string): string {
  // Ten, enough to get past the businesses in a building to the building's own address.
  const params = new URLSearchParams({
    lat: String(point.latitude), lon: String(point.longitude), lang: photonLanguage(language), limit: '10',
  });
  return `${photonHost}/reverse?${params}`;
}

function photonFeatures(text: string): PhotonFeature[] {
  const features = JSON.parse(text)?.features;
  if (!Array.isArray(features)) throw new SyntaxError('Not a Photon answer.');
  return features;
}

export function photonPlace(feature: PhotonFeature): Place | null {
  const p = feature.properties ?? {};
  const coordinates = feature.geometry?.coordinates;
  if (!Array.isArray(coordinates) || coordinates.length < 2) return null;
  const [longitude, latitude] = coordinates;
  // An address with no name shows its street line as the title, the way Apple Maps does.
  const street = [p.street, p.housenumber].filter(Boolean).join(' ');
  const name = p.name ?? (street || p.city || p.district || 'Dropped pin');
  // Not every result carries an OSM id; an empty id would collide with every other id-less one.
  const id = p.osm_type && p.osm_id !== undefined ? `${p.osm_type}:${p.osm_id}` : `at:${latitude.toFixed(5)},${longitude.toFixed(5)}`;
  return {
    id, name, latitude, longitude,
    subtitle: subtitle(name, street, [p.district, p.locality, p.city, p.state, p.country]),
    kind: !p.name && p.housenumber ? 'address' : p.osm_key === 'highway' && p.osm_value !== 'bus_stop' ? 'street' : 'other',
  };
}

export function photonPlaces(text: string): Place[] {
  return placesFrom(photonFeatures(text));
}

function placesFrom(features: PhotonFeature[]): Place[] {
  return deduplicated(features.map(photonPlace).filter((place): place is Place => place !== null));
}

/** The first result that is an address, titled as one, at the point asked about; short of that, a
 *  street; short of that, whatever is nearest. Outside a front door the nearest things are the
 *  businesses in the building, and a route that "starts at conecta Immobilien" is wrong in a way
 *  "starts at Garnisonkirchplatz 2" is not. */
export function photonAddress(text: string, at: Coordinate): Place | null {
  return addressFrom(photonFeatures(text), at);
}

function addressFrom(features: PhotonFeature[], at: Coordinate): Place | null {
  const chosen = features.find((f) => f.properties?.street && f.properties?.housenumber)
    ?? features.find((f) => f.properties?.street);
  if (!chosen) {
    const found = features.map(photonPlace).find((place) => place !== null);
    return found ? { ...found, latitude: at.latitude, longitude: at.longitude } : null;
  }
  const p = chosen.properties!;
  const title = [p.street, p.housenumber].filter(Boolean).join(' ');
  return {
    id: `address:${at.latitude.toFixed(5)},${at.longitude.toFixed(5)}`,
    name: title,
    subtitle: subtitle(title, title, [p.district, p.locality, p.city, p.state, p.country]),
    latitude: at.latitude, longitude: at.longitude,
    kind: p.housenumber ? 'address' : 'street',
  };
}

/** Second line: the street when it isn't the title, then up to two of the area names. */
function subtitle(title: string, street: string, areas: (string | undefined)[]): string {
  const parts: string[] = [];
  if (street && street !== title) parts.push(street);
  for (const area of areas) {
    if (!area || area === title || parts.includes(area)) continue;
    parts.push(area);
    if (parts.length >= 2) break;
  }
  return parts.join(', ');
}

/** Photon returns one real place several times: the same object repeated, one place tagged as two
 *  objects at one point, and a cluster modelling one thing (a station as a halt, a station and six
 *  stops). Rows that read the same can't be chosen between, so the first is kept. */
export function deduplicated(places: Place[]): Place[] {
  const kept: Place[] = [];
  const seen = new Set<string>();
  for (const place of places) {
    const identity = [place.id, `${place.name}@${place.latitude.toFixed(5)},${place.longitude.toFixed(5)}`];
    if (identity.some((key) => seen.has(key))) continue;
    if (kept.some((other) => other.name === place.name && other.subtitle === place.subtitle
      && metres(other, place) < clusterRadius)) continue;
    identity.forEach((key) => seen.add(key));
    kept.push(place);
  }
  return kept;
}

/** Wide enough to swallow a station's entrances and platforms, tight enough to keep two same-named
 *  places on opposite sides of a neighbourhood apart. */
const clusterRadius = 150;

/** Equirectangular: well under a metre off at these distances. */
export function metres(a: Coordinate, b: Coordinate): number {
  const meanLatitude = (((a.latitude + b.latitude) / 2) * Math.PI) / 180;
  const dx = (a.longitude - b.longitude) * 111_320 * Math.cos(meanLatitude);
  const dy = (a.latitude - b.latitude) * 110_540;
  return Math.hypot(dx, dy);
}

// ---------- Nominatim ----------

interface NominatimItem {
  osm_type?: string; osm_id?: number; lat: string; lon: string;
  category?: string; type?: string; name?: string; display_name?: string;
  address?: Record<string, string>;
}

export const nominatimHost = 'https://nominatim.openstreetmap.org';
/** The bias as a preferred box rather than a hard filter: about 40 by 45 km around it. */
const viewboxHalfSpan = { latitude: 0.2, longitude: 0.3 };

export function nominatimSearchURL(query: string, bias: Coordinate | null, language: string, limit = 10): string {
  const params = new URLSearchParams({
    q: query.trim(), format: 'jsonv2', addressdetails: '1', limit: String(limit), 'accept-language': language,
  });
  if (bias) {
    params.set('viewbox', [bias.longitude - viewboxHalfSpan.longitude, bias.latitude + viewboxHalfSpan.latitude,
      bias.longitude + viewboxHalfSpan.longitude, bias.latitude - viewboxHalfSpan.latitude].map((v) => v.toFixed(4)).join(','));
  }
  return `${nominatimHost}/search?${params}`;
}

export function nominatimPlaces(text: string): Place[] {
  const items = JSON.parse(text);
  if (!Array.isArray(items)) throw new SyntaxError('Not a Nominatim answer.');
  return deduplicated(items.map(nominatimPlace).filter((place): place is Place => place !== null));
}

export function nominatimPlace(item: NominatimItem): Place | null {
  const latitude = Number(item.lat), longitude = Number(item.lon);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  const address = item.address ?? {};
  const road = address.road ?? address.pedestrian ?? address.footway ?? address.path;
  const street = [road, address.house_number].filter(Boolean).join(' ');
  const settlement = address.city ?? address.town ?? address.village ?? address.municipality;
  const name = item.name || undefined;
  const title = name ?? (street || settlement || item.display_name?.split(',')[0] || 'Dropped pin');
  // Photon's id form, so one OSM object from both sources is one row.
  const id = item.osm_type && item.osm_id !== undefined
    ? `${item.osm_type[0].toUpperCase()}:${item.osm_id}`
    : `at:${latitude.toFixed(5)},${longitude.toFixed(5)}`;
  const district = address.suburb ?? address.city_district ?? address.quarter;
  return {
    id, name: title, latitude, longitude,
    subtitle: subtitle(title, street, [district, settlement, address.state, address.country]),
    // An address with no name of its own is a house, whatever OSM files it under.
    kind: !name && address.house_number ? 'address' : item.category === 'highway' && item.type !== 'bus_stop' ? 'street' : 'other',
  };
}

/** Spaces requests at least `spacing` ms apart, however many callers there are. */
export class RequestGate {
  private next = 0;
  constructor(private readonly spacing: number, private readonly now: () => number = () => Date.now(),
              private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))) {}

  async wait(): Promise<void> {
    const slot = Math.max(this.now(), this.next);
    // Claimed before sleeping, so a second caller queues behind this one rather than beside it.
    this.next = slot + this.spacing;
    const delay = slot - this.now();
    if (delay > 0) await this.sleep(delay);
  }
}

// ---------- Both ----------

/** Stops asking a server that has stopped answering: after `failureLimit` failures in a row nothing
 *  is sent for `cooldown` ms, then a single request goes through as a probe, and its outcome closes
 *  the breaker or opens it for another cooldown. */
export class CircuitBreaker {
  private failures = 0;
  private openUntil: number | null = null;
  private probing = false;

  constructor(readonly failureLimit = 2, readonly cooldown = 300_000, private readonly now: () => number = () => Date.now()) {}

  get isOpen(): boolean {
    return this.openUntil !== null;
  }

  /** Whether a request may go out now. One that is allowed reports back through `succeeded`,
   *  `failed` or `released`. */
  allows(): boolean {
    if (this.openUntil === null) return true;
    if (this.now() < this.openUntil || this.probing) return false;
    this.probing = true;
    return true;
  }

  succeeded(): void {
    this.failures = 0;
    this.openUntil = null;
    this.probing = false;
  }

  failed(): void {
    this.failures += 1;
    if (this.probing || this.failures >= this.failureLimit) this.openUntil = this.now() + this.cooldown;
    this.probing = false;
  }

  /** The request ended without saying anything about the server: cancelled, or no network here. */
  released(): void {
    this.probing = false;
  }
}

/** `shown` keeps its order, and from `arriving` only places not already there are appended, so a
 *  row never moves under the pointer when a slower source answers. One place from two sources has
 *  the same id, or the same name within 50 m; a street, which each source puts somewhere else along
 *  it, within 1.5 km. */
export function merging(shown: Place[], arriving: Place[]): Place[] {
  const merged = [...shown];
  for (const place of arriving) {
    const known = merged.some((other) => other.id === place.id || (other.name === place.name
      && metres(other, place) < (other.kind === 'street' && place.kind === 'street' ? 1500 : 50)));
    if (!known) merged.push(place);
  }
  return merged;
}

export interface SearchOptions {
  language?: string;
  fetch?: typeof fetch;
  photonBreaker?: CircuitBreaker;
  nominatimGate?: RequestGate;
}

/** Photon and Nominatim together, with the breaker, the gate and the cache the app uses. */
export class PlaceSearch {
  private readonly language: string;
  private readonly fetch: typeof fetch;
  private readonly breaker: CircuitBreaker;
  private readonly gate: RequestGate;
  private readonly cache = new Map<string, Place[]>();

  constructor(options: SearchOptions = {}) {
    this.language = options.language ?? (typeof navigator !== 'undefined' ? navigator.language : 'en');
    this.fetch = options.fetch ?? fetch.bind(globalThis);
    this.breaker = options.photonBreaker ?? new CircuitBreaker();
    this.gate = options.nominatimGate ?? new RequestGate(1000);
  }

  /** Photon, as you type. Throws `SearchUnavailable` at once while its breaker is open. */
  async suggest(query: string, bias: Coordinate | null, signal?: AbortSignal): Promise<Place[]> {
    if (!query.trim()) return [];
    return placesFrom(await this.photon(photonSearchURL(query, bias, this.language), signal));
  }

  /** What a point is called, for a stop placed on the map: the address there, or the nearest thing. */
  async name(point: Coordinate, signal?: AbortSignal): Promise<Place | null> {
    return addressFrom(await this.photon(photonReverseURL(point, this.language), signal), point);
  }

  /** Nominatim, for an explicit search. Asked once per question per visit, a second apart. */
  async search(query: string, bias: Coordinate | null, signal?: AbortSignal): Promise<Place[]> {
    if (!query.trim()) return [];
    const url = nominatimSearchURL(query, bias, this.language);
    const cached = this.cache.get(url);
    if (cached) return cached;
    await this.gate.wait();
    signal?.throwIfAborted();
    const response = await this.fetch(url, { signal });
    if (!response.ok) throw new BadStatus(response.status);
    const places = nominatimPlaces(await response.text());
    this.cache.set(url, places);
    if (this.cache.size > 100) this.cache.delete(this.cache.keys().next().value!);
    return places;
  }

  private async photon(url: string, signal?: AbortSignal): Promise<PhotonFeature[]> {
    if (!this.breaker.allows()) throw new SearchUnavailable('Photon is resting after failures.');
    try {
      const response = await this.fetch(url, { signal });
      if (!response.ok) throw new BadStatus(response.status);
      // An answer that doesn't read is the server's failure too.
      const features = photonFeatures(await response.text());
      this.breaker.succeeded();
      return features;
    } catch (error) {
      if (isServerFailure(error)) this.breaker.failed();
      else this.breaker.released();
      throw error;
    }
  }
}

/** Whether an error says the server is in trouble, rather than this request or this browser: a
 *  cancellation, no network or a 400 say nothing about it. */
export function isServerFailure(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') return false;
  if (error instanceof BadStatus) return error.status === 429 || error.status >= 500;
  if (error instanceof SyntaxError) return true;
  // fetch's TypeError: offline here, or the server unreachable. Only the browser knows which.
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}
