<script lang="ts">
  // The planner: a full-window map with the card at the leading edge (a sheet at the bottom on a
  // phone), as the app lays out iPad and Mac.
  import { onMount } from 'svelte';
  import type { Coordinate } from './core/geodesy';
  import { fileName, writeRoute } from './core/gpx';
  import { sports } from './core/route';
  import { MapView } from './lib/mapView';
  import { Planner } from './lib/planner.svelte';
  import { loadChoice, saveChoice, wantsDark, type MapChoice } from './mapStyles';
  import ContextMenu from './components/ContextMenu.svelte';
  import ElevationProfile from './components/ElevationProfile.svelte';
  import MapSettings from './components/MapSettings.svelte';
  import Pills from './components/Pills.svelte';
  import RouteSummary from './components/RouteSummary.svelte';
  import StopList from './components/StopList.svelte';

  let { icon }: { icon: string } = $props();

  const planner = new Planner();
  let view: MapView | undefined;
  let mapElement: HTMLElement;
  let card: HTMLElement;

  let choice = $state<MapChoice>(loadChoice());
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
  let prefersDark = $state(systemDark.matches);
  const style = $derived(wantsDark(choice.appearance, prefersDark) ? choice.dark : choice.light);

  let menu = $state<{ at: Coordinate; x: number; y: number } | null>(null);

  onMount(() => {
    view = new MapView(mapElement, style, {
      contextMenu: (at, screen) => (menu = { at, ...screen }),
      stopMoved: (id, to) => planner.moveTo(id, to),
      moved: () => (menu = null),
    });
    const follow = (event: MediaQueryListEvent) => (prefersDark = event.matches);
    systemDark.addEventListener('change', follow);
    // On a phone the card is a sheet at the bottom, and the scale and attribution sit above it.
    const resize = new ResizeObserver(() => {
      document.documentElement.style.setProperty('--sheet-height', `${card.offsetHeight}px`);
    });
    resize.observe(card);
    return () => {
      systemDark.removeEventListener('change', follow);
      resize.disconnect();
      view?.map.remove();
    };
  });

  $effect(() => view?.setStyle(style));
  $effect(() => view?.showStops(planner.stops));
  /** The ends of the plan last shown whole. A new start or destination is shown whole again;
   *  a new stop, sport or order leaves the view where the rider put it. */
  let fittedEnds = '';
  $effect(() => {
    const route = planner.route;
    if (route.status === 'ready') {
      view?.showRoute(route.track.coordinates);
      const ends = [route.waypoints[0], route.waypoints.at(-1)!].map((p) => `${p.latitude},${p.longitude}`).join('|');
      if (ends !== fittedEnds) view?.fit(route.track.coordinates, padding());
      fittedEnds = ends;
    } else if (route.status !== 'planning') {
      view?.showRoute([]);
      fittedEnds = '';
    }
  });

  /** Room for the card: beside it on a wide window, above it on a phone. */
  function padding() {
    const box = card.getBoundingClientRect();
    return window.innerWidth > 640
      ? { top: 48, bottom: 48, left: box.right + 32, right: 64 }
      : { top: 48, bottom: window.innerHeight - box.top + 24, left: 32, right: 32 };
  }

  function changeMap(next: MapChoice) {
    choice = next;
    saveChoice(next);
  }

  function chooseFromMenu(role: 'start' | 'stop' | 'end') {
    if (menu) planner.placeAt(menu.at, role);
    menu = null;
  }

  function exportGPX() {
    if (planner.route.status !== 'ready') return;
    const { track, waypoints } = planner.route;
    const gpx = writeRoute(planner.title, planner.sport, track.coordinates, waypoints);
    const url = URL.createObjectURL(new Blob([gpx], { type: 'application/gpx+xml' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName(planner.title, new Date());
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  const canAddStop = $derived(Boolean(planner.stops[0].place && planner.stops.at(-1)!.place));
</script>

<div id="map" bind:this={mapElement} aria-label="Map"></div>

<aside class="card glass" aria-label="Route planner" bind:this={card}>
  <header class="card-head">
    <a class="brand" href="../">
      <img src={icon} alt="" width="36" height="36">
      <span>Navitals</span>
    </a>
    <span class="kicker">Route Planner</span>
  </header>

  <div class="card-section">
    <Pills label="Sport" options={sports} value={planner.sport} onchoose={(sport) => planner.chooseSport(sport)} />
    <StopList {planner} bias={() => view?.center ?? { latitude: 52.52, longitude: 13.405 }} />
  </div>

  <div class="card-section route-section">
    <RouteSummary route={planner.route} />
    {#if planner.route.status === 'ready'}
      <ElevationProfile track={planner.route.track} onpoint={(point) => view?.showPosition(point)} />
      <button type="button" class="primary-button" onclick={exportGPX}>Export GPX</button>
    {/if}
  </div>

  <MapSettings {choice} onchange={changeMap} />
</aside>

{#if menu}
  <ContextMenu x={menu.x} y={menu.y} {canAddStop} onchoose={chooseFromMenu} onclose={() => (menu = null)} />
{/if}
