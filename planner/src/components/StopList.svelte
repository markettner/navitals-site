<script lang="ts">
  // Start, stops and destination, as the app's planner lists them: drag a row by its handle to
  // reorder, the arrows to reverse, ✕ to take a stop out.
  import type { Coordinate } from '../core/geodesy';
  import type { Planner } from '../lib/planner.svelte';
  import StopField from './StopField.svelte';

  interface Props {
    planner: Planner;
    bias: () => Coordinate;
  }
  let { planner, bias }: Props = $props();

  let dragging = $state<number | null>(null);
  let over = $state<number | null>(null);

  const stops = $derived(planner.stops.filter((stop) => stop.kind === 'stop'));

  function label(index: number): string {
    return index === 0 ? 'Start' : index === stops.length - 1 ? 'Destination' : `Stop ${index}`;
  }

  /** Index into `planner.stops`, which also holds the shaping points between these rows. */
  function plannerIndex(index: number): number {
    return planner.stops.indexOf(stops[index]);
  }

  function drop(index: number) {
    if (dragging !== null && dragging !== index) planner.reorder(plannerIndex(dragging), plannerIndex(index));
    dragging = null;
    over = null;
  }
</script>

<div class="stops">
  <ol class="stop-list">
    {#each stops as stop, index (stop.id)}
      <li
        class="stop-row"
        class:drop-target={over === index && dragging !== index}
        ondragover={(event) => { if (dragging !== null) { event.preventDefault(); over = index; } }}
        ondragleave={() => { if (over === index) over = null; }}
        ondrop={(event) => { event.preventDefault(); drop(index); }}
      >
        <span
          class="stop-icon"
          class:start={index === 0}
          class:end={index === stops.length - 1}
          aria-hidden="true"
        >{index > 0 && index < stops.length - 1 ? index : ''}</span>
        <StopField
          place={stop.place}
          placeholder={label(index)}
          search={planner.search}
          {bias}
          onchoose={(place) => planner.setPlace(stop.id, place)}
          onclear={() => planner.setPlace(stop.id, null)}
        />
        {#if stops.length > 2 || stop.place}
          <button type="button" class="icon-button" aria-label={`Remove ${label(index).toLowerCase()}`}
                  onclick={() => planner.remove(stop.id)}>✕</button>
        {/if}
        <span
          class="drag-handle"
          role="button"
          tabindex="-1"
          aria-label={`Move ${label(index).toLowerCase()}`}
          draggable="true"
          ondragstart={(event) => { dragging = index; event.dataTransfer?.setData('text/plain', String(index)); }}
          ondragend={() => { dragging = null; over = null; }}
        >≡</span>
      </li>
    {/each}
  </ol>
  <div class="stop-actions">
    <button type="button" class="text-button" onclick={() => planner.addStop()}>
      <span class="add-icon" aria-hidden="true">+</span> Add Stop
    </button>
    <button type="button" class="icon-button" aria-label="Reverse the route" title="Reverse"
            disabled={planner.waypoints.length < 2} onclick={() => planner.reverse()}>⇅</button>
  </div>
</div>
