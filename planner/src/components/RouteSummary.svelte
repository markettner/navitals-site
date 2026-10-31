<script lang="ts">
  // What the route comes to: distance, climbing and time, or why there is none.
  import type { EngineDownload } from '../core/localBRouter';
  import type { RouteState } from '../lib/planner.svelte';

  /** `locating`: the plan waits for the rider's location before it can be routed. */
  let { route, locating = false, download = null }: { route: RouteState; locating?: boolean; download?: EngineDownload | null } = $props();

  const numbers = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1, minimumFractionDigits: 1 });
  const whole = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

  function kilometres(metres: number): string {
    return `${numbers.format(metres / 1000)} km`;
  }

  function duration(seconds: number): string {
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} min`;
    return `${Math.floor(minutes / 60)} hr ${minutes % 60} min`;
  }

  const planning = $derived(download?.what === 'engine' ? 'Downloading the routing engine…'
    : download?.what === 'map' ? 'Downloading map data…' : 'Planning…');
  // Beside the words, not in them: a screen reader would read out every step.
  const percent = $derived(download?.what === 'map' && download.total ? `${Math.floor(download.done / download.total * 100)}%` : '');

  const track = $derived(route.status === 'ready' ? route.track : route.status === 'planning' ? route.previous : null);
</script>

{#snippet status()}
  <p class="summary-status">{planning}{#if percent}{' '}<span aria-hidden="true">{percent}</span>{/if}</p>
{/snippet}

<div class="summary" aria-live="polite">
  {#if route.status === 'failed'}
    <p class="summary-message">{route.message}</p>
  {:else if track}
    <div class="summary-numbers" class:stale={route.status === 'planning'}>
      <span class="summary-distance">{kilometres(track.length)}</span>
      <span class="summary-detail">
        <!-- A line from a file has no time of its own: BRouter's is for routes it planned. -->
        {track.duration ? `${duration(track.duration)} · ` : ''}↗ {whole.format(track.ascent)} m
      </span>
    </div>
    {#if route.status === 'planning'}{@render status()}{/if}
  {:else if route.status === 'planning'}
    {@render status()}
  {:else if locating}
    <p class="summary-status">Finding your location…</p>
  {/if}
</div>
