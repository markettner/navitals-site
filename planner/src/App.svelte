<script lang="ts">
  // The planner: a full-window map with the card at the leading edge (a sheet at the bottom on a
  // phone), as the app lays out iPad and Mac.
  import { onMount } from 'svelte';
  import type { Coordinate } from './core/geodesy';
  import { fileName, writeRoute } from './core/gpx';
  import { GPXError, parseGPX } from './core/gpxReader';
  import { sports } from './core/route';
  import { planIn, withPlan } from './core/urlState';
  import { MapView } from './lib/mapView';
  import { Planner } from './lib/planner.svelte';
  import { loadChoice, saveChoice, wantsDark, type MapChoice } from './mapStyles';
  import ContextMenu from './components/ContextMenu.svelte';
  import ElevationProfile from './components/ElevationProfile.svelte';
  import LineRoute from './components/LineRoute.svelte';
  import MapSettings from './components/MapSettings.svelte';
  import Pills from './components/Pills.svelte';
  import RouteSummary from './components/RouteSummary.svelte';
  import StopList from './components/StopList.svelte';

  let { icon }: { icon: string } = $props();

  const planner = new Planner();
  let view: MapView | undefined;
  let mapElement: HTMLElement;
  let card: HTMLElement;
  let fileInput: HTMLInputElement;

  let choice = $state<MapChoice>(loadChoice());
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
  let prefersDark = $state(systemDark.matches);
  const style = $derived(wantsDark(choice.appearance, prefersDark) ? choice.dark : choice.light);

  type MenuItem = { label: string; destructive?: boolean; action: () => void };
  let menu = $state<{ x: number; y: number; items: MenuItem[] } | null>(null);
  let droppingFile = $state(false);

  // On a phone the card is a sheet, and a sheet can be put away: down to its header and the
  // route's numbers, so the map has the screen. A tap on the handle toggles it, a swipe sets it.
  let collapsed = $state(false);
  let swipeFrom: number | null = null;
  function handleDown(event: PointerEvent) {
    swipeFrom = event.clientY;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }
  function handleUp(event: PointerEvent) {
    if (swipeFrom === null) return;
    const moved = event.clientY - swipeFrom;
    swipeFrom = null;
    collapsed = moved > 24 ? true : moved < -24 ? false : !collapsed;
  }

  onMount(() => {
    view = new MapView(mapElement, style, {
      contextMenu: (at, screen) => (menu = { ...screen, items: mapMenu(at) }),
      pointMenu: (id, screen) => {
        const items = pointMenu(id);
        menu = items.length ? { ...screen, items } : null;
      },
      stopMoved: (id, to) => planner.moveTo(id, to),
      insertShaping: (at, before) => planner.insertShaping(at, before),
      chooseRoute: (index) => planner.chooseRoute(index),
      moved: () => (menu = null),
    });
    // A link with a plan opens it, also one pasted into this tab, which changes only the hash.
    // Our own writes to the address use replaceState, which fires no hashchange.
    const openLinked = () => {
      const linked = planIn(location.hash);
      if (linked && withPlan('', linked) !== withPlan('', planner.planState)) planner.open(linked);
    };
    openLinked();
    window.addEventListener('hashchange', openLinked);
    // For poking at the map from the console while developing.
    if (import.meta.env.DEV) (window as unknown as { plannerMap: MapView }).plannerMap = view;

    const follow = (event: MediaQueryListEvent) => (prefersDark = event.matches);
    systemDark.addEventListener('change', follow);
    // On a phone the card is a sheet at the bottom, and the scale and attribution sit above it.
    const resize = new ResizeObserver(() => {
      document.documentElement.style.setProperty('--sheet-height', `${card.offsetHeight}px`);
    });
    resize.observe(card);
    return () => {
      window.removeEventListener('hashchange', openLinked);
      systemDark.removeEventListener('change', follow);
      resize.disconnect();
      view?.map.remove();
    };
  });

  $effect(() => view?.setStyle(style));
  $effect(() => view?.showStops(planner.stops));
  $effect(() => view?.setEditable(!planner.line));

  /** The ends of the plan last shown whole. A new start or destination is shown whole again;
   *  a new stop, bend, sport or order leaves the view where the rider put it. */
  let fittedEnds = '';
  $effect(() => {
    const route = planner.route;
    if (route.status === 'ready') {
      view?.showRoutes(route.tracks.map((track) => ({ line: track.coordinates, label: kilometres(track.length) })), route.selected);
      const line = route.track.coordinates;
      const ends = [line[0], line.at(-1)!].map((p) => `${p.latitude.toFixed(3)},${p.longitude.toFixed(3)}`).join('|');
      if (ends !== fittedEnds) view?.fit(line, padding());
      fittedEnds = ends;
    } else if (route.status === 'failed') {
      view?.clearPreview();
    } else if (route.status === 'idle') {
      view?.showRoutes([], 0);
      fittedEnds = '';
    }
  });

  // The plan goes into the address as it changes, beside MapLibre's view, so the page's link is
  // always the route on screen. replaceState: an edit is not a page to go back to.
  $effect(() => {
    const hash = withPlan(location.hash, planner.planState);
    if (`#${hash}` !== location.hash) history.replaceState(null, '', `${location.pathname}${location.search}#${hash}`);
  });

  const tenths = new Intl.NumberFormat(undefined, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  function kilometres(metres: number): string {
    return `${tenths.format(metres / 1000)} km`;
  }

  /** Room for the card: beside it on a wide window, above it on a phone. */
  function padding() {
    const box = card.getBoundingClientRect();
    return window.innerWidth > 640
      ? { top: 48, bottom: 48, left: box.right + 32, right: 64 }
      : { top: 48, bottom: window.innerHeight - box.top + 24, left: 32, right: 32 };
  }

  function mapMenu(at: Coordinate): MenuItem[] {
    if (planner.line) return [];
    const hasEnds = Boolean(planner.stops[0].place && planner.stops.at(-1)!.place);
    return [
      { label: 'Start here', action: () => planner.placeAt(at, 'start') },
      ...(hasEnds ? [{ label: 'Add a stop here', action: () => planner.placeAt(at, 'stop') }] : []),
      { label: 'End here', action: () => planner.placeAt(at, 'end') },
    ];
  }

  function pointMenu(id: number): MenuItem[] {
    const index = planner.stops.findIndex((stop) => stop.id === id);
    const stop = planner.stops[index];
    if (!stop) return [];
    const isEnd = index === 0 || index === planner.stops.length - 1;
    return [
      ...(stop.kind === 'shaping' ? [{ label: 'Make it a stop', action: () => planner.makeStop(id) }] : []),
      ...(!isEnd ? [{ label: stop.kind === 'shaping' ? 'Remove shaping point' : 'Remove stop', destructive: true, action: () => planner.remove(id) }] : []),
    ];
  }

  function changeMap(next: MapChoice) {
    choice = next;
    saveChoice(next);
  }

  function exportGPX() {
    if (planner.route.status !== 'ready') return;
    const gpx = writeRoute(planner.title, planner.sport, planner.route.track.coordinates, planner.exportWaypoints, Boolean(planner.line));
    const url = URL.createObjectURL(new Blob([gpx], { type: 'application/gpx+xml' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName(planner.title, new Date());
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function importFile(file: File | undefined) {
    if (!file) return;
    try {
      planner.import(parseGPX(await file.text()));
      fittedEnds = '';
    } catch (error) {
      planner.importMessage = error instanceof GPXError ? error.message : `${file.name} couldn't be read.`;
    }
  }

  function keydown(event: KeyboardEvent) {
    const target = event.target as HTMLElement | null;
    // Typing in a field undoes the typing, not the plan.
    if (target?.closest('input, textarea, [contenteditable]')) return;
    const command = event.metaKey || event.ctrlKey;
    if (command && event.key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) planner.redo();
      else planner.undo();
    } else if (command && event.key.toLowerCase() === 'y') {
      event.preventDefault();
      planner.redo();
    }
  }

  // A file dropped anywhere on the page is imported.
  function dragover(event: DragEvent) {
    if (!event.dataTransfer?.types.includes('Files')) return;
    event.preventDefault();
    droppingFile = true;
  }

  function drop(event: DragEvent) {
    if (!event.dataTransfer?.files.length) return;
    event.preventDefault();
    droppingFile = false;
    importFile(event.dataTransfer.files[0]);
  }
</script>

<svelte:window onkeydown={keydown} ondragover={dragover} ondragleave={() => (droppingFile = false)} ondrop={drop} />

<div id="map" bind:this={mapElement} aria-label="Map"></div>

<aside class="card glass" class:collapsed aria-label="Route planner" bind:this={card}>
  <button type="button" class="sheet-handle" aria-label={collapsed ? 'Show the planner' : 'Put the planner away'}
          aria-expanded={!collapsed} onpointerdown={handleDown} onpointerup={handleUp}
          onkeydown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); collapsed = !collapsed; } }}></button>
  <header class="card-head">
    <a class="brand" href="../">
      <img src={icon} alt="" width="36" height="36">
      <span>Navitals</span>
    </a>
    <span class="kicker">Route Planner</span>
    <span class="history">
      <button type="button" class="icon-button" aria-label="Undo" title="Undo (⌘Z)" disabled={!planner.canUndo} onclick={() => planner.undo()}>↶</button>
      <button type="button" class="icon-button" aria-label="Redo" title="Redo (⇧⌘Z)" disabled={!planner.canRedo} onclick={() => planner.redo()}>↷</button>
    </span>
  </header>

  <div class="card-section">
    <Pills label="Sport" options={sports} value={planner.sport} onchoose={(sport) => planner.chooseSport(sport)} />
    {#if planner.line}
      <LineRoute {planner} />
    {:else}
      <StopList {planner} bias={() => view?.center ?? { latitude: 52.52, longitude: 13.405 }} />
    {/if}
  </div>

  <div class="card-section route-section">
    <RouteSummary route={planner.route} />
    {#if planner.route.status === 'ready' && planner.route.tracks.length > 1}
      <Pills label="Routes" value={String(planner.route.selected)} onchoose={(id) => planner.chooseRoute(Number(id))}
             options={planner.route.tracks.map((track, index) => ({ id: String(index), title: kilometres(track.length) }))} />
    {/if}
    {#if planner.route.status === 'ready'}
      <ElevationProfile track={planner.route.track} onpoint={(point) => view?.showPosition(point)} />
    {/if}
    <div class="file-actions">
      {#if planner.route.status === 'ready'}
        <button type="button" class="primary-button" onclick={exportGPX}>Export GPX</button>
      {/if}
      <button type="button" class="text-button" onclick={() => fileInput.click()}>Import GPX</button>
      <input bind:this={fileInput} type="file" accept=".gpx,application/gpx+xml" hidden
             onchange={(event) => { importFile(event.currentTarget.files?.[0]); event.currentTarget.value = ''; }} />
    </div>
    {#if planner.importMessage}<p class="summary-message" role="alert">{planner.importMessage}</p>{/if}
  </div>

  <MapSettings {choice} onchange={changeMap} />
</aside>

{#if droppingFile}
  <div class="drop-hint" aria-hidden="true"><span class="glass">Drop a GPX file to open it</span></div>
{/if}

{#if menu}
  <ContextMenu x={menu.x} y={menu.y} items={menu.items} onclose={() => (menu = null)} />
{/if}
