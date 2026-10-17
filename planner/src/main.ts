import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre finds its worker next to its own module, which neither Vite's dev cache nor the bundle
// keeps; so Vite bundles the worker itself and hands MapLibre the address.
import workerURL from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import './planner.css';
import iconURL from '../../icon.png';
import {
  appearances, darkStyles, lightStyles, loadChoice, saveChoice, styleURL, wantsDark,
  type MapChoice, type MapStyle,
} from './mapStyles';

maplibregl.setWorkerUrl(workerURL);

// The site's icon, bundled from the site rather than copied (index.html can't reach it in dev).
document.querySelectorAll<HTMLImageElement | HTMLLinkElement>('[data-icon]').forEach((element) => {
  if (element instanceof HTMLLinkElement) element.href = iconURL;
  else element.src = iconURL;
});

const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
let choice = loadChoice();

function currentStyle(): string {
  return wantsDark(choice.appearance, systemDark.matches) ? choice.dark : choice.light;
}

const map = new maplibregl.Map({
  container: 'map',
  style: styleURL(currentStyle()),
  // Berlin until the hash says otherwise; the hash keeps the view across reloads and in links.
  center: [13.405, 52.52],
  zoom: 11,
  hash: 'map',
  attributionControl: false,
});
map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: false } }), 'top-right');
map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');
// OpenFreeMap's TileJSON brings OpenMapTiles and OpenStreetMap, and the hillshade source names
// Mapzen and AWS. The Natural Earth relief at low zooms names nobody, so it is added here.
map.addControl(new maplibregl.AttributionControl({
  compact: true,
  customAttribution: '<a href="https://www.naturalearthdata.com" target="_blank" rel="noopener">Natural Earth</a>',
}), 'bottom-right');

let shownStyle = currentStyle();
function applyStyle(): void {
  const wanted = currentStyle();
  if (wanted === shownStyle) return;
  shownStyle = wanted;
  map.setStyle(styleURL(wanted));
}
systemDark.addEventListener('change', applyStyle);

// The pickers: one row of pills each, as the app's settings show them.
type ChoiceKey = keyof MapChoice;
const options: Record<ChoiceKey, { id: string; title: string }[]> = {
  appearance: appearances,
  light: lightStyles,
  dark: darkStyles,
};

// Built once, so a click keeps the keyboard focus where it was; a choice only updates them.
for (const key of Object.keys(options) as ChoiceKey[]) {
  document.querySelector(`[data-choice="${key}"]`)!.replaceChildren(...options[key].map((option) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.role = 'radio';
    button.dataset.id = option.id;
    button.textContent = option.title;
    button.addEventListener('click', () => choose(key, option.id));
    return button;
  }));
}

function renderPickers(): void {
  for (const key of Object.keys(options) as ChoiceKey[]) {
    document.querySelectorAll<HTMLButtonElement>(`[data-choice="${key}"] button`).forEach((button) => {
      button.setAttribute('aria-checked', String(choice[key] === button.dataset.id));
    });
  }
  const note = (list: MapStyle[], id: string) => list.find((s) => s.id === id)?.note ?? '';
  document.querySelector('[data-note="light"]')!.textContent = note(lightStyles, choice.light);
  document.querySelector('[data-note="dark"]')!.textContent = note(darkStyles, choice.dark);
}

function choose(key: ChoiceKey, id: string): void {
  choice = { ...choice, [key]: id };
  // With the appearance fixed, picking a map of the other kind switches to it, so the pick shows.
  // Automatic stays automatic.
  if (key !== 'appearance' && choice.appearance !== 'system') choice.appearance = key;
  saveChoice(choice);
  renderPickers();
  applyStyle();
}

renderPickers();

// On a phone the card is a sheet at the bottom, and the scale and attribution sit above it.
const card = document.querySelector<HTMLElement>('.card')!;
new ResizeObserver(() => {
  document.documentElement.style.setProperty('--sheet-height', `${card.offsetHeight}px`);
}).observe(card);
