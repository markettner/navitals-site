// The app's map styles (MapStyleProvider.swift), as the web planner offers them.
//
// A style belongs to the light list or the dark list. A rider picks the light map and the dark map
// they want, and Automatic switches between those two with the system's appearance. The JSON in
// public/styles/ is written by the app repo's tools/styles/build_styles.py --web-out, and is the
// app's styles without the route overlays.

export interface MapStyle {
  /** The file's stem, and what is stored. */
  id: string;
  title: string;
  note: string;
}

export const lightStyles: MapStyle[] = [
  { id: 'navitals-vivid', title: 'Vivid', note: 'Warmer and more saturated. A sunny day on a bike.' },
  { id: 'liberty', title: 'Liberty', note: "OpenFreeMap's Liberty on our layer stack, hillshade included." },
  { id: 'bright', title: 'Bright', note: "OpenMapTiles' Bright, unchanged. No hillshade of its own." },
];

export const darkStyles: MapStyle[] = [
  { id: 'navitals-dark', title: 'Night', note: 'Near-black land, tuned for OLED and for battery.' },
  { id: 'navitals-dusk', title: 'Dusk', note: 'Slate-blue land, green countryside, deep blue water. Streets fill in as you zoom.' },
  { id: 'navitals-nocturnal', title: 'Nocturnal', note: 'Dusk in cooler tones: petrol land, cyan-blue water.' },
];

export type Appearance = 'system' | 'light' | 'dark';

export const appearances: { id: Appearance; title: string }[] = [
  { id: 'system', title: 'Automatic' },
  { id: 'light', title: 'Light' },
  { id: 'dark', title: 'Dark' },
];

export interface MapChoice {
  appearance: Appearance;
  light: string;
  dark: string;
}

const storageKey = 'navitals-planner-map';
const defaults: MapChoice = { appearance: 'system', light: lightStyles[0].id, dark: darkStyles[0].id };

/** The rider's last choice. Storage can be missing or blocked (a private window), and then it is
 *  simply the defaults again. */
export function loadChoice(): MapChoice {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey) ?? '{}') as Partial<MapChoice>;
    return {
      appearance: appearances.some((a) => a.id === stored.appearance) ? stored.appearance! : defaults.appearance,
      light: lightStyles.some((s) => s.id === stored.light) ? stored.light! : defaults.light,
      dark: darkStyles.some((s) => s.id === stored.dark) ? stored.dark! : defaults.dark,
    };
  } catch {
    return { ...defaults };
  }
}

export function saveChoice(choice: MapChoice): void {
  try {
    localStorage.setItem(storageKey, JSON.stringify(choice));
  } catch {
    // Not remembered, which is all a blocked storage costs.
  }
}

export function wantsDark(appearance: Appearance, systemDark: boolean): boolean {
  return appearance === 'system' ? systemDark : appearance === 'dark';
}

export function styleURL(id: string): string {
  return `${import.meta.env.BASE_URL}styles/${id}.json`;
}
