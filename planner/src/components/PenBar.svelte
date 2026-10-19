<script lang="ts">
  // Under the drawing, as the app's PenBar: what the pen does, or what the last stroke did, with
  // Undo (Remove for a zone clicked) and Done.
  import type { PenStatus } from '../lib/planner.svelte';

  interface Props {
    status: PenStatus | null;
    /** A zone is offered for removal. */
    zoneSelected: boolean;
    canUndo: boolean;
    /** A finger draws here, not a mouse. */
    touch: boolean;
    onundo: () => void;
    onremove: () => void;
    ondone: () => void;
  }
  let { status, zoneSelected, canUndo, touch, onundo, onremove, ondone }: Props = $props();
</script>

<div class="pen-bar glass" role="status" aria-live="polite">
  <p class="pen-text" class:muted={!status || status.kind === 'failed'}>
    {#if status?.kind === 'planning'}
      <span class="spinner" aria-hidden="true"></span> Planning…
    {:else if status}
      {status.text}
    {:else}
      Draw from one point of the route to another to create a shortcut, along the route to erase it,
      across it where it's blocked, or circle an area to avoid it.
      {touch ? 'Two fingers move the map.' : 'Hold Space to move the map.'}
    {/if}
  </p>
  {#if zoneSelected}
    <button type="button" class="pen-action destructive" onclick={onremove}>Remove</button>
  {:else if canUndo}
    <button type="button" class="pen-action" onclick={onundo}>Undo</button>
  {/if}
  <button type="button" class="pen-action done" onclick={ondone}>Done</button>
</div>
