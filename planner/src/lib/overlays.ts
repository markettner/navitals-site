// The app's sport overlays (RouteOverlay): signposted cycle and hiking routes, from our own PMTiles
// build, mirrored to Cloudflare R2 because a browser can't read the GitHub release the app uses.
//
// The styles carry the layers, hidden, and a source named `pmtiles://route-overlays`
// (build_styles.py --web-out). Its requests come here. Until a rider first turns an overlay on
// they simply wait, so a visit that never shows one never asks R2 for anything. Then the
// mirror's index (`overlays/current.json`, written last by the quarterly workflow) names the
// current build, and that file answers them.

import * as maplibregl from 'maplibre-gl';
import { FetchSource, PMTiles, Protocol } from 'pmtiles';

export type OverlayKind = 'cycle' | 'hiking';

export const overlayKinds: { id: OverlayKind; title: string }[] = [
  { id: 'cycle', title: 'Cycle routes' },
  { id: 'hiking', title: 'Hiking routes' },
];

/** The R2 bucket's public address (r2.dev for now; see tools/pipelines/README.md in the app). */
export const overlayIndex = 'https://pub-33efb55f11f54c48b6bf4a5cafb8fbf9.r2.dev/overlays/current.json';
/** The source the styles name, by this id and as `pmtiles://` + this. */
export const overlaySource = 'route-overlays';

/** The layers `add_overlay_layers` writes for an overlay, the name layer third. */
export function layerIDs(kind: OverlayKind): string[] {
  return ['short', 'long', 'name', 'ref'].map((part) => `${kind}-routes-${part}`);
}

/** Translations the tiles carry, as `name_<lang>` (`LANGUAGES` in build_route_overlay.py). */
const languages = new Set(['de', 'en', 'fr', 'nl', 'it', 'es', 'da', 'sv', 'no', 'pl']);

/** Route names in the browser's language, then English, then as mapped: OSM's plain `name` is
 *  whatever a relation's mappers chose, and EuroVelo 7's is Danish. */
export function nameExpression(language: string): maplibregl.ExpressionSpecification {
  let code = language.slice(0, 2).toLowerCase();
  if (code === 'nb' || code === 'nn') code = 'no';
  const chain = [...(languages.has(code) && code !== 'en' ? [code] : []), 'en'];
  return ['coalesce', ...chain.map((c): maplibregl.ExpressionSpecification => ['get', `name_${c}`]), ['get', 'name']];
}

const protocol = new Protocol();
let wanted: () => void = () => {};
const firstWanted = new Promise<void>((resolve) => (wanted = resolve));

/** Whether the mirror answered: asked once an overlay is turned on, and again at the next turn on
 *  after it didn't. */
let mirror: Promise<boolean> | null = null;

function askMirror(): Promise<boolean> {
  mirror ??= (async () => {
    try {
      const response = await fetch(overlayIndex);
      const entry = response.ok ? ((await response.json()) as { url?: string }) : null;
      if (!entry?.url) return false;
      const file = new FetchSource(entry.url);
      // Filed under the name the styles use, so they need no rewriting when a new build comes.
      protocol.add(new PMTiles({ getKey: () => overlaySource, getBytes: (...args) => file.getBytes(...args) }));
      return true;
    } catch {
      return false;
    }
  })().then((answered) => {
    if (!answered) mirror = null;
    return answered;
  });
  return mirror;
}

maplibregl.addProtocol('pmtiles', async (params, abort) => {
  await firstWanted;
  if (!(await (mirror ?? false))) throw new Error('The route overlays are unavailable.');
  return protocol.tile(params, abort);
});

/** An overlay was turned on: the mirror is asked, unless it answered already. Resolves to whether
 *  it can be shown. */
export function loadOverlays(): Promise<boolean> {
  const answer = askMirror();
  wanted();
  return answer;
}

const storageKey = 'navitals-planner-overlays';

export function loadShown(): OverlayKind[] {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) ?? '[]') as unknown;
    return Array.isArray(stored) ? overlayKinds.map((k) => k.id).filter((id) => stored.includes(id)) : [];
  } catch {
    return [];
  }
}

export function saveShown(shown: OverlayKind[]): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(shown));
  } catch {
    // Not remembered, which is all a blocked storage costs.
  }
}
