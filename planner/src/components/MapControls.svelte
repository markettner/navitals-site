<script lang="ts">
  // The capsule at the top right, as Apple Maps and the app have it: the map's settings and the
  // rider's location, above MapLibre's zoom and compass. The settings open beside it.
  import type { LocationStatus } from '../lib/location.svelte';
  import type { OverlayKind } from '../lib/overlays';
  import type { MapChoice } from '../mapStyles';
  import Icon from './Icon.svelte';
  import MapSettings from './MapSettings.svelte';

  interface Props {
    choice: MapChoice;
    onchange: (choice: MapChoice) => void;
    location: LocationStatus;
    /** Whether the map is following a Locate press that hasn't found the rider yet. */
    locating: boolean;
    /** The map is centred on the rider: the arrow fills. */
    centered: boolean;
    onlocate: () => void;
    overlays: OverlayKind[];
    overlayMessage: string;
    onoverlays: (shown: OverlayKind[]) => void;
  }
  let { choice, onchange, location, locating, centered, onlocate, overlays, overlayMessage, onoverlays }: Props = $props();

  let open = $state(false);
  let controls: HTMLElement;

  const locateTitle = $derived(
    location === 'denied' ? 'Location access is blocked for this site'
    : location === 'unavailable' ? 'This browser has no location'
    : location === 'slow' ? 'Still looking for your location…'
    : 'Show my location',
  );

  $effect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => { if (!controls.contains(event.target as Node)) open = false; };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') open = false; };
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', key);
    };
  });
</script>

<div class="map-controls" bind:this={controls}>
  <div class="control-pill glass" role="group" aria-label="Map">
    <button type="button" class="control-button" aria-label="Map settings" title="Map" aria-expanded={open}
            class:active={open} onclick={() => (open = !open)}>
      <Icon name="layers" />
    </button>
    <button type="button" class="control-button locate" aria-label="Show my location" title={locateTitle}
            disabled={location === 'unavailable'} class:waiting={locating} class:centered aria-pressed={centered}
            class:blocked={location === 'denied'} onclick={onlocate}>
      <Icon name="navigation" size={18} />
    </button>
  </div>
  {#if open}
    <section class="map-popover glass" aria-label="Map settings">
      <h2>Map</h2>
      <MapSettings {choice} {onchange} {overlays} {overlayMessage} {onoverlays} />
    </section>
  {/if}
</div>
