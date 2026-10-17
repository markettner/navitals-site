<script lang="ts">
  // The route's elevation over its distance. Pointing at it puts a dot on the map where that is.
  import type { Track } from '../core/brouter';
  import { distance, type Coordinate } from '../core/geodesy';

  interface Props {
    track: Track;
    onpoint: (point: Coordinate | null) => void;
  }
  let { track, onpoint }: Props = $props();

  const width = 320;
  const height = 72;
  const whole = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

  /** Metres along the line at each point. */
  const along = $derived.by(() => {
    const result = [0];
    for (let i = 1; i < track.coordinates.length; i++) {
      result.push(result[i - 1] + distance(track.coordinates[i - 1], track.coordinates[i]));
    }
    return result;
  });

  const range = $derived.by(() => {
    let low = Infinity, high = -Infinity;
    for (const e of track.elevations) {
      if (e < low) low = e;
      if (e > high) high = e;
    }
    // A flat route still gets a little height, so its line doesn't sit on the floor.
    const span = Math.max(high - low, 20);
    return { low, high, floor: low - span * 0.1, span: span * 1.2 };
  });

  const path = $derived.by(() => {
    const total = along.at(-1) || 1;
    const x = (m: number) => (m / total) * width;
    const y = (e: number) => height - ((e - range.floor) / range.span) * height;
    let line = '';
    track.elevations.forEach((e, i) => { line += `${i ? 'L' : 'M'}${x(along[i]).toFixed(1)},${y(e).toFixed(1)}`; });
    return { line, area: `${line}L${width},${height}L0,${height}Z` };
  });

  let cursor = $state<number | null>(null);

  function move(event: PointerEvent) {
    const box = (event.currentTarget as SVGElement).getBoundingClientRect();
    const share = Math.min(Math.max((event.clientX - box.left) / box.width, 0), 1);
    const target = share * (along.at(-1) ?? 0);
    // The first point at or past the distance pointed at.
    let low = 0, high = along.length - 1;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (along[mid] < target) low = mid + 1;
      else high = mid;
    }
    cursor = low;
    onpoint(track.coordinates[low]);
  }

  function leave() {
    cursor = null;
    onpoint(null);
  }
</script>

{#if track.elevations.length > 1}
  <figure class="elevation">
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" role="img"
         aria-label={`Elevation from ${whole.format(range.low)} to ${whole.format(range.high)} m`}
         onpointermove={move} onpointerleave={leave}>
      <path class="elevation-area" d={path.area} />
      <path class="elevation-line" d={path.line} vector-effect="non-scaling-stroke" />
      {#if cursor !== null}
        <line class="elevation-cursor" x1={(along[cursor] / (along.at(-1) || 1)) * width} x2={(along[cursor] / (along.at(-1) || 1)) * width}
              y1="0" y2={height} vector-effect="non-scaling-stroke" />
      {/if}
    </svg>
    <figcaption class="elevation-caption">
      {#if cursor !== null}
        <span>{(along[cursor] / 1000).toLocaleString(undefined, { maximumFractionDigits: 1 })} km · {whole.format(track.elevations[cursor])} m</span>
      {:else}
        <span>{whole.format(range.low)}–{whole.format(range.high)} m</span>
      {/if}
    </figcaption>
  </figure>
{/if}
