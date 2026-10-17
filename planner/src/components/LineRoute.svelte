<script lang="ts">
  // An imported recording kept as it is: its ends, the places it passes, and the way to change it.
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
  <p class="note">
    This route follows the line in the file, exactly. To change it, make it editable: shaping points
    are laid along it and BRouter plans it through them, so it then keeps to BRouter's roads and paths.
  </p>
  <button type="button" class="text-button" onclick={() => planner.makeEditable()}>Make editable</button>
</div>
