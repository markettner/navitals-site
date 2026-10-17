<script lang="ts">
  // What the route comes to: distance, climbing and time, or why there is none.
  import type { RouteState } from '../lib/planner.svelte';

  let { route }: { route: RouteState } = $props();

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

  const track = $derived(route.status === 'ready' ? route.track : route.status === 'planning' ? route.previous : null);
</script>

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
    {#if route.status === 'planning'}<p class="summary-status">Planning…</p>{/if}
  {:else if route.status === 'planning'}
    <p class="summary-status">Planning…</p>
  {:else}
    <p class="summary-message">Choose a start and a destination, or right-click the map.</p>
  {/if}
</div>
