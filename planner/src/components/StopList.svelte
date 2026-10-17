<script lang="ts">
  // Start, stops and destination, as the app's planner lists them, with the shaping points a drag
  // left between them in grey. Drag a stop by its handle to reorder, ⇅ to reverse, ✕ to take a
  // stop or bend out.
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

  const stopCount = $derived(planner.stops.filter((stop) => stop.kind === 'stop').length);

  /** A stop's number between the ends, counting stops only. */
  function stopNumber(index: number): number {
    return planner.stops.slice(0, index + 1).filter((stop) => stop.kind === 'stop').length - 1;
  }

  function label(index: number): string {
    if (index === 0) return 'Start';
    if (index === planner.stops.length - 1) return 'Destination';
    return `Stop ${stopNumber(index)}`;
  }

  function drop(index: number) {
    if (dragging !== null && dragging !== index) planner.reorder(dragging, index);
    dragging = null;
    over = null;
  }
</script>

<div class="stops">
  <ol class="stop-list">
    {#each planner.stops as stop, index (stop.id)}
      {#if stop.kind === 'shaping'}
        <li class="stop-row shaping-row">
          <span class="stop-icon shaping" aria-hidden="true"></span>
          <span class="shaping-name" title="A shaping point: the route bends through it">{stop.place?.name ?? 'Shaping point'}</span>
          <button type="button" class="icon-button" title="Make it a stop" aria-label="Make this shaping point a stop"
                  onclick={() => planner.makeStop(stop.id)}>◎</button>
          <button type="button" class="icon-button" aria-label="Remove shaping point" onclick={() => planner.remove(stop.id)}>✕</button>
        </li>
      {:else}
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
            class:end={index === planner.stops.length - 1}
            aria-hidden="true"
          >{index > 0 && index < planner.stops.length - 1 ? stopNumber(index) : ''}</span>
          <StopField
            place={stop.place}
            placeholder={label(index)}
            search={planner.search}
            {bias}
            onchoose={(place) => planner.setPlace(stop.id, place)}
            onclear={() => planner.setPlace(stop.id, null)}
          />
          {#if stopCount > 2 || stop.place}
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
      {/if}
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
