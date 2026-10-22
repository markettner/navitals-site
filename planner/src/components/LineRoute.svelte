<script lang="ts">
  // A route kept as its line: an imported line while BRouter is fitted to it, one BRouter can't
  // ride, or one the pen changed. Its ends, the places it passes, and the ways to change it.
  // The app treats such a route the same way ("routes that follow their line"): planning it again
  // through its ends would throw the line away, so only making it editable does.
  import type { Planner } from '../lib/planner.svelte';

  let { planner }: { planner: Planner } = $props();

  const start = $derived(planner.stops[0]?.place);
  const finish = $derived(planner.stops.at(-1)?.place);
</script>

<div class="line-route">
  <ol class="stop-list">
    <li class="stop-row line-row"><span class="stop-icon start" aria-hidden="true"></span><span>{start?.name}</span></li>
    {#each planner.line?.places ?? [] as place (place.id)}
      <li class="stop-row line-row place-row"><span class="stop-icon place" aria-hidden="true"></span><span>{place.name}</span></li>
    {/each}
    <li class="stop-row line-row"><span class="stop-icon end" aria-hidden="true"></span><span>{finish?.name}</span></li>
  </ol>
  {#if planner.fitting === 'fitting'}
    <p class="note" role="status">Fitting BRouter to this line: its places become stops, with shaping points where BRouter would ride another way.</p>
  {:else}
    <p class="note">
      {#if planner.fitting === 'failed'}
        BRouter doesn't ride all of this line, so the route follows it exactly.
      {:else if planner.fitting === 'busy'}
        brouter.de is busy with this planner, so the route follows its line for now. In a minute,
        make it editable to fit BRouter to it.
      {:else}
        This route follows its line exactly: from a file, or as the pen left it.
      {/if}
      Draw on it to change part of it, or make it editable: shaping points are laid along it and
      BRouter plans it through them, so it then keeps to BRouter's roads and paths.
    </p>
    <button type="button" class="text-button" onclick={() => planner.makeEditable()}>Make editable</button>
  {/if}
</div>
