<script lang="ts">
  // The map's credits, in our glass: one small line at the map's corner, as komoot has it on the
  // web. On a phone the line folds into an (i) once the map is first touched, or after five
  // seconds, which the OSMF's attribution guidelines allow; the (i) opens every credit and the
  // privacy policy, as Apple Maps keeps its Legal behind one control.
  import Icon from './Icon.svelte';

  interface Props {
    /** Counts the rider's touches on the map: the first one folds the line away. */
    touches: number;
  }
  let { touches }: Props = $props();

  const phone = window.matchMedia('(max-width: 640px)');
  let folded = $state(false);
  let open = $state(false);
  let credits: HTMLElement;

  function fold() {
    if (phone.matches) folded = true;
  }

  $effect(() => {
    if (touches) fold();
  });
  $effect(() => {
    const timer = setTimeout(fold, 5000);
    return () => clearTimeout(timer);
  });

  $effect(() => {
    if (!open) return;
    const away = (event: PointerEvent) => { if (!credits.contains(event.target as Node)) open = false; };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') open = false; };
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('keydown', key);
    };
  });
</script>

<div class="credits" bind:this={credits}>
  {#if open}
    <section class="credits-panel glass" aria-label="Credits">
      <h2>Credits</h2>
      <ul>
        <li>Map data <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap</a> contributors, under the Open Database License</li>
        <li>Map tiles <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">© OpenMapTiles</a>, served by <a href="https://openfreemap.org" target="_blank" rel="noopener">OpenFreeMap</a></li>
        <li>Terrain <a href="https://github.com/tilezen/joerd/blob/master/docs/attribution.md" target="_blank" rel="noopener">Mapzen/AWS Open Data</a></li>
        <li>Relief <a href="https://www.naturalearthdata.com" target="_blank" rel="noopener">Natural Earth</a></li>
        <li>Routes <a href="https://brouter.de" target="_blank" rel="noopener">BRouter</a></li>
      </ul>
      <a class="credits-privacy" href="../privacy_policy.html#web-planner">Privacy Policy</a>
    </section>
  {/if}
  {#if folded}
    <button type="button" class="credits-button glass" aria-label="Credits and privacy" title="Credits and privacy"
            aria-expanded={open} onclick={() => (open = !open)}><Icon name="info" size={18} /></button>
  {:else}
    <p class="credits-line glass">
      <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">© OpenStreetMap</a>
      <span aria-hidden="true">·</span>
      <a href="https://www.openmaptiles.org/" target="_blank" rel="noopener">© OpenMapTiles</a>
      <button type="button" class="credits-more" aria-label="All credits and privacy" title="All credits and privacy"
              aria-expanded={open} onclick={() => (open = !open)}><Icon name="info" size={14} /></button>
    </p>
  {/if}
</div>
