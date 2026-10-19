<script lang="ts">
  // The app's map choice: Automatic, Light or Dark, and which light and which dark map.
  import { overlayKinds, type OverlayKind } from '../lib/overlays';
  import { appearances, darkStyles, lightStyles, type MapChoice } from '../mapStyles';
  import Pills from './Pills.svelte';

  interface Props {
    choice: MapChoice;
    onchange: (choice: MapChoice) => void;
    overlays: OverlayKind[];
    /** Why the overlays can't be shown, once that is known. */
    overlayMessage: string;
    onoverlays: (shown: OverlayKind[]) => void;
  }
  let { choice, onchange, overlays, overlayMessage, onoverlays }: Props = $props();

  function toggle(kind: OverlayKind, on: boolean) {
    onoverlays(on ? [...overlays.filter((k) => k !== kind), kind] : overlays.filter((k) => k !== kind));
  }

  function choose(key: keyof MapChoice, id: string) {
    const next = { ...choice, [key]: id };
    // With the appearance fixed, picking a map of the other kind switches to it, so the pick shows.
    // Automatic stays automatic.
    if (key !== 'appearance' && next.appearance !== 'system') next.appearance = key;
    onchange(next);
  }
</script>

<div class="map-settings">
  <div class="field">
    <span class="field-label">Appearance</span>
    <Pills label="Appearance" options={appearances} value={choice.appearance} onchoose={(id) => choose('appearance', id)} />
  </div>
  <div class="field">
    <span class="field-label">Light map</span>
    <Pills label="Light map" options={lightStyles} value={choice.light} onchoose={(id) => choose('light', id)} />
    <p class="note">{lightStyles.find((s) => s.id === choice.light)?.note}</p>
  </div>
  <div class="field">
    <span class="field-label">Dark map</span>
    <Pills label="Dark map" options={darkStyles} value={choice.dark} onchoose={(id) => choose('dark', id)} />
    <p class="note">{darkStyles.find((s) => s.id === choice.dark)?.note}</p>
  </div>
  <div class="field">
    <span class="field-label">Overlays</span>
    {#each overlayKinds as kind (kind.id)}
      <label class="switch-row">
        <span>{kind.title}</span>
        <input type="checkbox" role="switch" checked={overlays.includes(kind.id)}
               onchange={(event) => toggle(kind.id, event.currentTarget.checked)} />
      </label>
    {/each}
    {#if overlayMessage}<p class="note" role="status">{overlayMessage}</p>{/if}
    <p class="note">
      Signposted routes, from OpenStreetMap. Long-distance routes show first as you zoom in, local
      ones last. Cycle routes are purple for international and national routes and green for
      regional and local ones, the same split komoot draws. Hiking routes are dashed brown,
      darker for the long-distance ones.
    </p>
  </div>
</div>
