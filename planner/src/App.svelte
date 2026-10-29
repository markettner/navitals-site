<script lang="ts">
  // The planner: a full-window map with the card at the leading edge (a sheet at the bottom on a
  // phone), as the app lays out iPad and Mac.
  import { flushSync, onMount, tick } from 'svelte';
  import type { Coordinate } from './core/geodesy';
  import { fileName, writeRoute } from './core/gpx';
  import { GPXError, parseGPX } from './core/gpxReader';
  import { sports } from './core/route';
  import { planIn, withPlan } from './core/urlState';
  import { LocationService } from './lib/location.svelte';
  import { MapView } from './lib/mapView';
  import { loadOverlays, loadShown, saveShown, type OverlayKind } from './lib/overlays';
  import { Planner } from './lib/planner.svelte';
  import { loadChoice, saveChoice, wantsDark, type MapChoice } from './mapStyles';
  import ContextMenu from './components/ContextMenu.svelte';
  import Credits from './components/Credits.svelte';
  import ElevationProfile from './components/ElevationProfile.svelte';
  import Icon from './components/Icon.svelte';
  import LineRoute from './components/LineRoute.svelte';
  import MapControls from './components/MapControls.svelte';
  import PenBar from './components/PenBar.svelte';
  import Pills from './components/Pills.svelte';
  import RouteSummary from './components/RouteSummary.svelte';
  import StopList from './components/StopList.svelte';

  let { logo }: { logo: string } = $props();

  const geolocation = new LocationService();
  const planner = new Planner({
    locate: () => {
      if (geolocation.status === 'unavailable') return 'unavailable';
      if (geolocation.status === 'denied') return 'blocked';
      geolocation.start();
      return 'locating';
    },
  });
  let view: MapView | undefined;
  let mapElement: HTMLElement;
  let creditsElement: HTMLElement;
  /** The rider's touches on the map, which fold the credits away on a phone. */
  let touches = $state(0);
  let card: HTMLElement;
  let fileInput: HTMLInputElement;

  let choice = $state<MapChoice>(loadChoice());
  /** The sport overlays shown, remembered; the mirror is asked only once one is. */
  let overlays = $state<OverlayKind[]>(loadShown());
  let overlayMessage = $state('');

  function changeOverlays(shown: OverlayKind[]) {
    overlays = shown;
    saveShown(shown);
  }
  const systemDark = window.matchMedia('(prefers-color-scheme: dark)');
  let prefersDark = $state(systemDark.matches);
  const style = $derived(wantsDark(choice.appearance, prefersDark) ? choice.dark : choice.light);

  type MenuItem = { label: string; destructive?: boolean; action: () => void };
  let menu = $state<{ x: number; y: number; items: MenuItem[] } | null>(null);
  let droppingFile = $state(false);

  // On a phone the card is a sheet, and a sheet can be put away, as the app's drawer: down to one
  // bar, the route's numbers (or Search) and an X that throws the plan away, so the map has the
  // screen. A tap on the handle toggles it, a swipe sets it.
  let collapsed = $state(false);
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  /** Puts the sheet away or brings it up, its height easing from one to the other as the app's
   *  drawer does, and its contents fading in. Done once the sheet has its new height. */
  function setCollapsed(next: boolean): Promise<void> {
    if (next === collapsed) return Promise.resolve();
    const from = card.offsetHeight;
    flushSync(() => (collapsed = next));
    const to = card.offsetHeight;
    if (reduceMotion.matches || from === to) return Promise.resolve();
    const timing = { duration: 320, easing: 'cubic-bezier(0.32, 0.72, 0, 1)' };
    for (const child of card.children) child.animate([{ opacity: 0 }, { opacity: 1 }], { ...timing, duration: 220 });
    return card.animate([{ height: `${from}px`, overflow: 'hidden' }, { height: `${to}px`, overflow: 'hidden' }], timing)
      .finished.then(() => undefined, () => undefined);
  }
  /** The put-away sheet's bar, tapped: the sheet comes up, and with no plan yet its field takes
   *  the keyboard, inside the tap, as iOS wants. */
  function expandSheet() {
    setCollapsed(false);
    if (planner.isEmpty) card.querySelector<HTMLInputElement>('.stop-field input')?.focus();
  }
  let swipeFrom: number | null = null;
  function handleDown(event: PointerEvent) {
    swipeFrom = event.clientY;
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  }
  function handleUp(event: PointerEvent) {
    if (swipeFrom === null) return;
    const moved = event.clientY - swipeFrom;
    swipeFrom = null;
    setCollapsed(moved > 24 ? true : moved < -24 ? false : !collapsed);
  }

  /** The pen is out: strokes on the map edit the route (`Planner.draw`). */
  let drawing = $state(false);
  const touchScreen = window.matchMedia('(pointer: coarse)').matches;
  // iPadOS asks for the desktop site as a Mac.
  const onApple = /iPhone|iPad|iPod|Macintosh/.test(navigator.userAgent);
  const canDraw = $derived(planner.route.status === 'ready');

  async function toggleDrawing() {
    if (drawing) {
      drawing = false;
      planner.endDrawing();
      return;
    }
    if (!canDraw) return;
    drawing = true;
    menu = null;
    // The map is what is being drawn on: on a phone the sheet goes down, and the whole route shows.
    const down = window.innerWidth <= 640 ? setCollapsed(true) : Promise.resolve();
    // Once the sheet is down and the pen bar up, so the route is framed in the map that is left. The
    // bar sits on the sheet's measured height, which the ResizeObserver sets a frame later.
    await down;
    await tick();
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const route = planner.route;
    if (route.status === 'ready') view?.fit(route.track.coordinates, padding());
  }

  /** A Locate press waiting for the first fix, which then brings the map to the rider. */
  let locating = $state(false);
  /** The map is centred on the rider, until it is moved. */
  let centered = $state(false);

  function locate() {
    if (geolocation.status === 'denied' || geolocation.status === 'unavailable') return;
    if (geolocation.fix) view?.showAround(geolocation.fix, padding());
    else locating = true;
    geolocation.start();
  }

  onMount(() => {
    view = new MapView(mapElement, style, {
      contextMenu: (at, screen) => {
        const items = mapMenu(at);
        menu = items.length ? { ...screen, items } : null;
      },
      pointMenu: (id, screen) => {
        const items = pointMenu(id);
        menu = items.length ? { ...screen, items } : null;
      },
      stopMoved: (id, to) => planner.moveTo(id, to),
      insertShaping: (at, before) => planner.insertShaping(at, before),
      chooseRoute: (index) => planner.chooseRoute(index),
      penStroke: (stroke, metresPerPoint) => planner.draw(stroke, metresPerPoint),
      penClick: (at) => planner.penClicked(at),
      centered: (value) => (centered = value),
      moved: () => (menu = null),
      touched: () => touches++,
    }, creditsElement);
    // A link with a plan opens it, also one pasted into this tab, which changes only the hash.
    // Our own writes to the address use replaceState, which fires no hashchange.
    const openLinked = () => {
      const linked = planIn(location.hash);
      if (linked && withPlan('', linked) !== withPlan('', planner.planState)) planner.open(linked);
    };
    openLinked();
    window.addEventListener('hashchange', openLinked);
    const stopFixes = geolocation.onFix((fix) => {
      view?.showLocation(fix);
      planner.positionArrived(fix);
      if (locating) view?.showAround(fix, padding());
      locating = false;
    });
    if (geolocation.fix) view.showLocation(geolocation.fix);
    // For poking at the map from the console while developing.
    if (import.meta.env.DEV) Object.assign(window, { plannerMap: view, plannerLocation: geolocation, planner });

    const follow = (event: MediaQueryListEvent) => (prefersDark = event.matches);
    systemDark.addEventListener('change', follow);
    // On a phone the card is a sheet at the bottom, and the scale and attribution sit above it. The
    // map runs on under Safari's bar, below the sheet's bottom, so the map's controls clear the
    // distance from the map's foot to the sheet's top, measured.
    const measure = () => {
      const style = document.documentElement.style;
      style.setProperty('--sheet-height', `${card.offsetHeight}px`);
      style.setProperty('--sheet-clearance', `${mapElement.getBoundingClientRect().bottom - card.getBoundingClientRect().top}px`);
    };
    const resize = new ResizeObserver(measure);
    resize.observe(card);
    resize.observe(mapElement);
    // The map is taller than the window, so iOS has a page to scroll a field above its keyboard,
    // leaves it scrolled once the keyboard goes, and Safari brings the scroll back on a reload.
    // Without a field in use, the page goes back to its top: only from below it, as Safari's
    // "Open in the Navitals app" banner sits above the top, and scrolling to 0 hid it.
    // TEMPORARY: ?b=r turns the reset off.
    const settle = () => document.documentElement.dataset.b?.includes('r') || requestAnimationFrame(() => {
      if (!document.activeElement?.matches('input, textarea') && window.scrollY > 0) window.scrollTo(0, 0);
    });
    settle();
    window.addEventListener('scroll', settle);
    window.addEventListener('focusout', settle);
    window.visualViewport?.addEventListener('resize', settle);
    return () => {
      window.removeEventListener('hashchange', openLinked);
      stopFixes();
      systemDark.removeEventListener('change', follow);
      resize.disconnect();
      window.removeEventListener('scroll', settle);
      window.removeEventListener('focusout', settle);
      window.visualViewport?.removeEventListener('resize', settle);
      view?.map.remove();
    };
  });

  $effect(() => view?.setStyle(style));
  // Declared after onMount, so the map exists when it first runs: `view` isn't state, so an
  // effect that ran before it would never run again.
  $effect(() => {
    view?.setOverlays(overlays);
    if (!overlays.length) return;
    loadOverlays().then((available) => {
      // A message up means the mirror failed before: what the map asked of it then failed too.
      if (available && overlayMessage) view?.reloadOverlays();
      overlayMessage = available ? '' : "The route overlays can't be loaded right now.";
    });
  });
  $effect(() => view?.showStops(planner.stops));
  $effect(() => view?.setEditable(!planner.line));
  $effect(() => view?.setDrawing(drawing));
  $effect(() => view?.showZones(planner.zones, planner.selectedZone));
  // The stroke stays on the map while its edit is planned, and goes with the answer.
  $effect(() => {
    if (planner.penStatus?.kind !== 'planning') view?.clearStroke();
  });
  // No route, no pen: a route cleared or failing puts it away.
  $effect(() => {
    if (drawing && planner.route.status !== 'ready' && planner.route.status !== 'planning') {
      drawing = false;
      planner.endDrawing();
    }
  });
  // Refused or impossible: nothing waits for a fix any more.
  $effect(() => {
    if (geolocation.status !== 'denied' && geolocation.status !== 'unavailable') return;
    locating = false;
    planner.locationFailed();
  });
  const offersMyLocation = $derived(geolocation.status === 'unavailable' ? null : geolocation.status === 'denied' ? 'blocked' : 'offer');

  /** The ends of the plan last shown whole. A new start or destination is shown whole again;
   *  a new stop, bend, sport or order leaves the view where the rider put it. */
  let fittedEnds = '';
  $effect(() => {
    const route = planner.route;
    if (route.status === 'ready') {
      view?.showRoutes(route.tracks.map((track, index) => ({ line: track.coordinates, label: routeTitle(track.length, index) })), route.selected);
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

  /** A route among those offered, by its length; the one a link chose says so, as in the app. */
  function routeTitle(metres: number, index: number): string {
    return planner.linkedRoute === index ? `From link · ${kilometres(metres)}` : kilometres(metres);
  }

  /** Room for the card: beside it on a wide window, above it on a phone. And above the pen's bar,
   *  while it is out. */
  function padding() {
    const box = card.getBoundingClientRect();
    const bar = document.querySelector('.pen-bar')?.getBoundingClientRect();
    // The map's foot, which on a phone is under Safari's bar, below the window's.
    const foot = mapElement.getBoundingClientRect().bottom;
    const clear = (bottom: number) => (bar ? Math.max(bottom, foot - bar.top + 24) : bottom);
    return window.innerWidth > 640
      ? { top: 72, bottom: clear(48 + Math.max(0, foot - window.innerHeight)), left: box.right + 32, right: 72 }
      : { top: 72, bottom: clear(foot - box.top + 24), left: 32, right: 72 };
  }

  function mapMenu(at: Coordinate): MenuItem[] {
    if (planner.line || drawing) return [];
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
      ...(stop.place && !stop.current ? [{ label: 'Rename…', action: () => planner.startRename(id) }] : []),
      ...(!isEnd ? [{ label: stop.kind === 'shaping' ? 'Remove shaping point' : 'Remove stop', destructive: true, action: () => planner.remove(id) }] : []),
    ];
  }

  function changeMap(next: MapChoice) {
    choice = next;
    saveChoice(next);
  }

  /** The plan's link: the planner with the plan and nothing else in the hash, as the app shares it
   *  (docs/ROUTE_LINK.md). The map frames the route when it opens, so its view needn't travel. */
  const planLink = $derived(planner.planState && `${location.origin}${location.pathname}#${withPlan('', planner.planState)}`);
  /** The same plan under the app's scheme, offered on Apple devices, where the app can be. */
  const appLink = $derived(onApple && planner.planState ? `navitals://open#${withPlan('', planner.planState)}` : null);
  let linkMessage = $state('');

  async function shareLink() {
    if (!planLink) return;
    // A phone shares with its own sheet; a computer copies, to paste where it's wanted.
    if (touchScreen && navigator.share) {
      try {
        await navigator.share({ title: planner.title, url: planLink });
      } catch {
        // Dismissed: nothing to say.
      }
      return;
    }
    try {
      await navigator.clipboard.writeText(planLink);
      linkMessage = 'Link copied.';
    } catch {
      // Where the clipboard API is refused (an embedded view, an older browser), the old way.
      const field = document.createElement('textarea');
      field.value = planLink;
      field.style.position = 'fixed';
      field.style.opacity = '0';
      document.body.append(field);
      field.select();
      const copied = document.execCommand('copy');
      field.remove();
      linkMessage = copied ? 'Link copied.' : "The link couldn't be copied; the address bar holds it too.";
    }
    setTimeout(() => (linkMessage = ''), 2500);
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
    // Typing in a field undoes the typing, not the plan.
    if (event.target instanceof Element && event.target.closest('input, textarea, [contenteditable]')) return;
    if (event.key === 'Escape' && drawing && !menu) {
      toggleDrawing();
      return;
    }
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
<!-- Moved into the map's bottom-right corner, beside the scale, when the map is made. -->
<div class="maplibregl-ctrl credits-ctrl" bind:this={creditsElement}><Credits {touches} /></div>

<aside class="card glass" class:collapsed aria-label="Route planner" bind:this={card}>
  <button type="button" class="sheet-handle" aria-label={collapsed ? 'Show the planner' : 'Put the planner away'}
          aria-expanded={!collapsed} onpointerdown={handleDown} onpointerup={handleUp}
          onkeydown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setCollapsed(!collapsed); } }}></button>
  <div class="sheet-bar">
    <button type="button" class="sheet-search" onclick={expandSheet}>
      {#if planner.isEmpty}
        <Icon name="search" size={18} /> <span class="sheet-placeholder">Search</span>
      {:else}
        <RouteSummary route={planner.route} locating={planner.waitingForLocation} />
      {/if}
    </button>
    {#if !planner.isEmpty}
      <button type="button" class="sheet-close glass" aria-label="Discard the route" title="Discard the route (Undo brings it back)"
              onclick={() => planner.clear()}>
        <Icon name="close" size={18} />
      </button>
    {/if}
  </div>
  <header class="card-head">
    <a class="brand" href="../">
      <img src={logo} alt="Navitals" width="148" height="36">
    </a>
    <span class="kicker">Route Planner</span>
  </header>

  <div class="card-section">
    <Pills label="Sport" options={sports} value={planner.sport} onchoose={(sport) => planner.chooseSport(sport)} />
  </div>

  <!-- Only the stops scroll: the header, the sport and the route's numbers stay put however long the plan. -->
  <div class="card-section card-scroll">
    {#if planner.line}
      <LineRoute {planner} />
    {:else}
      <StopList {planner} myLocation={offersMyLocation} bias={() => view?.center ?? { latitude: 52.52, longitude: 13.405 }} />
    {/if}
  </div>

  <div class="card-section route-section">
    <RouteSummary route={planner.route} locating={planner.waitingForLocation} />
    {#if planner.route.status === 'ready' && planner.route.tracks.length > 1}
      <Pills label="Routes" value={String(planner.route.selected)} onchoose={(id) => planner.chooseRoute(Number(id))}
             options={planner.route.tracks.map((track, index) => ({ id: String(index), title: routeTitle(track.length, index) }))} />
    {/if}
    {#if planner.route.status === 'ready'}
      <ElevationProfile track={planner.route.track} onpoint={(point) => view?.showPosition(point)} />
    {/if}
    {#if planner.route.status === 'ready'}
      <div class="route-actions">
        <button type="button" class="primary-button" onclick={exportGPX}>Export GPX</button>
        {#if planLink}
          <button type="button" class="secondary-button" onclick={shareLink}>{touchScreen && 'share' in navigator ? 'Share Link' : 'Copy Link'}</button>
        {/if}
        {#if appLink}
          <a class="secondary-button" href={appLink}>Open in Navitals</a>
        {/if}
      </div>
      {#if linkMessage}<p class="summary-message" role="status">{linkMessage}</p>{/if}
    {/if}
    {#if planner.importMessage}<p class="summary-message" role="alert">{planner.importMessage}</p>{/if}
  </div>

</aside>

<!-- Beside the card, as komoot's: bringing a route in, going back and forth, drawing on it. -->
<div class="toolbar" role="toolbar" aria-label="Route">
  <button type="button" class="tool-round glass" aria-label="Import GPX" title="Import a GPX file, or drop one on the map" onclick={() => fileInput.click()}>
    <Icon name="import" />
  </button>
  <input bind:this={fileInput} type="file" accept=".gpx,application/gpx+xml" hidden
         onchange={(event) => { importFile(event.currentTarget.files?.[0]); event.currentTarget.value = ''; }} />
  <div class="tool-pill glass">
    <button type="button" class="tool-icon" aria-label="Undo" title="Undo (⌘Z)" disabled={!planner.canUndo} onclick={() => planner.undo()}><Icon name="undo" /></button>
    <button type="button" class="tool-icon" aria-label="Redo" title="Redo (⇧⌘Z)" disabled={!planner.canRedo} onclick={() => planner.redo()}><Icon name="redo" /></button>
  </div>
  <button type="button" class="tool-round glass" aria-label="Draw on the route" aria-pressed={drawing}
          title={drawing ? 'Put the pen away (Esc)' : canDraw ? 'Draw on the route' : 'Plan a route to draw on it'}
          disabled={!canDraw && !drawing} onclick={toggleDrawing}>
    <Icon name="pen" />
  </button>
</div>

{#if drawing}
  <PenBar status={planner.penStatus} zoneSelected={planner.selectedZone !== null} canUndo={planner.canUndo} touch={touchScreen}
          onundo={() => planner.undo()} onremove={() => planner.removeSelectedZone()} ondone={toggleDrawing} />
{/if}

<MapControls {choice} onchange={changeMap} location={geolocation.status} {locating} {centered} onlocate={locate}
             {overlays} {overlayMessage} onoverlays={changeOverlays} />

{#if droppingFile}
  <div class="drop-hint" aria-hidden="true"><span class="glass">Drop a GPX file to open it</span></div>
{/if}

{#if menu}
  <ContextMenu x={menu.x} y={menu.y} items={menu.items} onclose={() => (menu = null)} />
{/if}
