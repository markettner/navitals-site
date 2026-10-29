<script lang="ts">
  // Start, stops and destination, as the app's planner lists them, with the shaping points a drag
  // left between them in grey. Drag a stop by its handle to reorder, ⇅ to reverse, ✕ to take a
  // stop or bend out.
  //
  // An empty plan is one field, as the app starts: what is picked there is where to go, and the
  // start is the rider's location. The list, Add Stop and ⇅ come with the destination.
  import { untrack } from 'svelte';
  import type { Coordinate } from '../core/geodesy';
  import { stopRows } from '../core/stopRows';
  import type { Planner } from '../lib/planner.svelte';
  import Icon from './Icon.svelte';
  import StopField from './StopField.svelte';

  interface Props {
    planner: Planner;
    bias: () => Coordinate;
    /** Whether stop fields offer "My Location": the browser can locate, or it is blocked here. */
    myLocation: 'offer' | 'blocked' | null;
  }
  let { planner, bias, myLocation }: Props = $props();

  let dragging = $state<number | null>(null);
  let over = $state<number | null>(null);

  const stopCount = $derived(planner.stops.filter((stop) => stop.kind === 'stop').length);

  /** The runs opened, by their first bend. */
  let opened = $state<Set<number>>(new Set());

  /** Runs of bends fold into one row that opens, by the rule the app shares (core/stopRows):
   *  "Make editable" lays up to 80 along a line, and eighty grey rows would bury the stops. */
  const rows = $derived(stopRows(
    planner.stops.map((stop) => stop.kind === 'shaping'),
    (index) => opened.has(planner.stops[index].id),
  ));

  function toggle(id: number) {
    const next = new Set(opened);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    opened = next;
  }

  /** A stop's number between the ends, counting stops only. */
  function stopNumber(index: number): number {
    return planner.stops.slice(0, index + 1).filter((stop) => stop.kind === 'stop').length - 1;
  }

  function label(index: number): string {
    if (index === 0) return 'Start';
    if (index === planner.stops.length - 1) return 'Destination';
    return `Stop ${stopNumber(index)}`;
  }

  /** The name being typed for the stop in `planner.renaming`. Blank gives it its own name back. */
  let draft = $state('');
  // Filled when renaming starts, and only then: a late lookup naming the stop mustn't wipe what is typed.
  $effect(() => {
    const id = planner.renaming;
    draft = untrack(() => planner.stops.find((s) => s.id === id)?.place?.name ?? '');
  });

  /** Opens with the name selected, so typing replaces it. */
  function selectOnMount(input: HTMLInputElement) {
    // After the frame: the draft fills the field only once it is on the page.
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
  }

  function renameKey(event: KeyboardEvent, id: number) {
    if (event.key === 'Enter') { event.preventDefault(); planner.rename(id, draft); }
    else if (event.key === 'Escape') { event.preventDefault(); planner.renaming = null; }
  }

  function drop(index: number) {
    if (dragging !== null && dragging !== index) planner.reorder(dragging, index);
    dragging = null;
    over = null;
  }
</script>

<!-- A stop's own name, typed in place of its search field: Enter or leaving it keeps the name,
     Escape doesn't. The placeholder is what the place is really called, which a blank name goes back to. -->
{#snippet nameField(id: number, placeholder: string)}
  <div class="stop-field">
    <input
      type="text"
      class="name-field"
      bind:value={draft}
      {placeholder}
      aria-label="Name"
      autocomplete="off"
      use:selectOnMount
      onkeydown={(event) => renameKey(event, id)}
      onblur={() => { if (planner.renaming === id) planner.rename(id, draft); }}
    />
  </div>
{/snippet}

{#if planner.isEmpty}
<div class="stops">
  <div class="stop-row">
    <span class="stop-icon end" aria-hidden="true"></span>
    <StopField
      place={null}
      placeholder="Search for a place"
      search={planner.search}
      {bias}
      onchoose={(place) => planner.chooseDestination(place)}
      onclear={() => {}}
    />
  </div>
</div>
{:else}
<div class="stops">
  <ol class="stop-list">
    {#each rows as row (row.type === 'fold' ? `fold-${planner.stops[row.index].id}` : planner.stops[row.index].id)}
      {@const index = row.index}
      {@const stop = planner.stops[index]}
      {#if row.type === 'fold'}
        <li class="stop-row shaping-row">
          <span class="stop-icon shaping" aria-hidden="true"></span>
          <button type="button" class="fold-button" aria-expanded={row.open} onclick={() => toggle(stop.id)}>
            {row.count} shaping points <span aria-hidden="true">{row.open ? '▴' : '▾'}</span>
          </button>
        </li>
      {:else if stop.kind === 'shaping'}
        <li class="stop-row shaping-row">
          <span class="stop-icon shaping" aria-hidden="true"></span>
          {#if planner.renaming === stop.id}
            {@render nameField(stop.id, stop.place?.originalName ?? 'Name')}
          {:else}
            <span class="shaping-name" title={stop.place?.originalName ?? 'A shaping point: the route bends through it'}>{stop.place?.name ?? 'Shaping point'}</span>
            {#if stop.place}
              <button type="button" class="icon-button" title="Rename" aria-label="Rename shaping point"
                      onclick={() => (planner.renaming = stop.id)}>✎</button>
            {/if}
          {/if}
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
            class:via={index > 0 && index < planner.stops.length - 1}
            class:current={stop.current}
            aria-hidden="true"
          >{#if stop.current}<Icon name="navigation" size={11} />{:else if index > 0 && index < planner.stops.length - 1}{stopNumber(index)}{/if}</span>
          {#if planner.renaming === stop.id}
            {@render nameField(stop.id, stop.place?.originalName ?? label(index))}
          {:else}
          <StopField
            place={stop.place}
            current={stop.current}
            placeholder={label(index)}
            search={planner.search}
            {bias}
            {myLocation}
            onchoose={(place) => planner.setPlace(stop.id, place)}
            onclear={() => planner.setPlace(stop.id, null)}
            onmylocation={() => planner.useMyLocation(stop.id)}
          />
          {/if}
          {#if stop.place && !stop.current && planner.renaming !== stop.id}
            <button type="button" class="icon-button" title="Rename" aria-label={`Rename ${label(index).toLowerCase()}`}
                    onclick={() => (planner.renaming = stop.id)}>✎</button>
          {/if}
          {#if stopCount > 2 || stop.place || stop.current}
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
  {#if planner.locationMessage}<p class="note" role="status">{planner.locationMessage}</p>{/if}
</div>
{/if}
