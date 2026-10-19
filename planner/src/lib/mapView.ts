// The map: the app's styles, the route drawn into them, the stops and bends as markers, and what a
// pointer does with them. Plain MapLibre; the card tells it what to show.
//
// Reshaping follows the app's planner on iPad and Mac (MapPointerController): a mouse grabs the
// line within 12 px and drags out a bend, or picks up a stop or bend and moves it. While it moves,
// the route is drawn dashed and straight through the pointer, and BRouter is asked once, on drop:
// never for a preview, since every pause in a drag would be a request to a donated server. Touch
// pans the map, as in the app; markers can still be dragged with a finger.
//
// With the pen out (the app's PenCanvas), a left-drag or one finger draws instead, and the stroke
// is handed over in map coordinates when it ends. Space held, the wheel, and two fingers still move
// the map. MapLibre listens on its canvas container, so the pen takes its presses one level up, in
// the capture phase, before MapLibre sees them.

import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre finds its worker next to its own module, which neither Vite's dev cache nor the bundle
// keeps; so Vite bundles the worker itself and hands MapLibre the address.
import workerURL from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import type { FeatureCollection } from 'geojson';
import { distance, insertionIndex, prefix, project, stopPositions, suffix, type Coordinate } from '../core/geodesy';
import { labelAnchors } from '../core/labels';
import { darkStyles, styleURL } from '../mapStyles';
import type { Stop, Zone } from './planner.svelte';

maplibregl.setWorkerUrl(workerURL);

/** The empty layer every style carries where route lines belong: above the roads and bridges,
 *  below the labels (`add_route_anchor` in the app's build_styles.py). */
const routeAnchor = 'route-anchor';
const routeSource = 'planner-route';
const alternativesSource = 'planner-alternatives';
const previewSource = 'planner-preview';
const ghostSource = 'planner-ghost';
const positionSource = 'planner-position';
const locationSource = 'planner-location';
const zonesSource = 'planner-zones';
/** The app's accent, which is the planned route's colour there. */
const routeColor = '#E03A3E';
/** The rider's dot: the system's blue, as MapLibre's own control and the app draw it. */
const locationColor = '#1A84FF';
/** The pen's ink: the app's orange, apart from the route's red. */
const penColor = '#FF9500';
/** A stroke keeps a point only this many pixels from the last (`PenCanvas`'s 4 pt). */
const penSpacing = 4;
/** How near the line, in pixels, a press has to start to take it; and how near a marker to take
 *  that instead (`MapPointerController.lineReach`, `pointReach`). */
const lineReach = 12;
const pointReach = 14;
/** A finger held this long, moving less than `holdSlop` px, is a long press: the touch screen's
 *  right-click. iOS Safari sends no `contextmenu` for it. */
const holdDuration = 550;
const holdSlop = 10;

export interface MapEvents {
  /** A right-click on the map, at a point on screen. */
  contextMenu: (at: Coordinate, screen: { x: number; y: number }) => void;
  /** A right-click on a stop's or bend's marker. */
  pointMenu: (id: number, screen: { x: number; y: number }) => void;
  /** A stop's or bend's marker was dragged somewhere else. */
  stopMoved: (id: number, to: Coordinate) => void;
  /** An alternative's line or label was clicked. */
  chooseRoute: (index: number) => void;
  /** The line was dragged out into a bend, which goes before the waypoint at `before`. */
  insertShaping: (at: Coordinate, before: number) => void;
  /** A stroke drawn with the pen, and how many metres a pixel was while it was drawn. */
  penStroke: (stroke: Coordinate[], metresPerPoint: number) => void;
  /** A click with the pen out, without drawing. */
  penClick: (at: Coordinate) => void;
  /** The map moved, so a menu over it is no longer where it pointed. */
  moved: () => void;
}

interface Placed {
  id: number;
  kind: Stop['kind'];
  point: Coordinate;
}

export class MapView {
  readonly map: maplibregl.Map;
  private shownStyle: string;
  private line: Coordinate[] = [];
  /** Every route found, and which is the chosen one (`line`). */
  private routes: Coordinate[][] = [];
  private selected = 0;
  private labels: maplibregl.Marker[] = [];
  private placed: Placed[] = [];
  private editable = true;
  private markers = new Map<number, { marker: maplibregl.Marker; signature: string }>();
  /** The line being pulled into a new bend: where it goes in the plan, the line and stop positions
   *  it was grabbed on, where it was grabbed and where the pointer is now. */
  private pulling: { before: number; positions: number[]; base: Coordinate[]; from: maplibregl.Point; at: Coordinate } | null = null;
  /** The ghost dot's place on the line, while the pointer is near enough to grab it. */
  private grabbable: { at: Coordinate; position: number } | null = null;
  /** The chosen line was pressed: the click that follows is about it, not an alternative under it. */
  private pressedLine = false;
  /** When a menu last opened, so a long press doesn't open a second one where the browser (Android)
   *  sent its own `contextmenu` for the same press. */
  private menuOpenedAt = 0;
  private location: (Coordinate & { accuracy: number }) | null = null;
  private zones: Zone[] = [];
  private selectedZone: number | null = null;
  /** The pen is out. */
  private drawing = false;
  /** Space is held with the pen out: a drag moves the map instead. */
  private spaceHeld = false;
  /** The stroke on screen: its points while it is drawn, its coordinates once it is handed over. */
  private stroke: { pixels: { x: number; y: number }[]; coordinates: Coordinate[] | null } | null = null;
  private readonly strokeLayer: SVGPolylineElement;

  constructor(container: HTMLElement, style: string, private readonly events: MapEvents) {
    this.shownStyle = style;
    this.map = new maplibregl.Map({
      container,
      style: styleURL(style),
      // Berlin until the hash says otherwise; the hash keeps the view across reloads and in links.
      center: [13.405, 52.52],
      zoom: 11,
      hash: 'map',
      attributionControl: false,
    });
    this.map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
    this.map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');
    // OpenFreeMap's TileJSON brings OpenMapTiles and OpenStreetMap, the hillshade source names
    // Mapzen and AWS, BRouter routes. The Natural Earth relief at low zooms names nobody.
    this.map.addControl(new maplibregl.AttributionControl({
      compact: true,
      customAttribution: [
        '<a href="https://www.naturalearthdata.com" target="_blank" rel="noopener">Natural Earth</a>',
        'Routes <a href="https://brouter.de" target="_blank" rel="noopener">BRouter</a>',
      ],
    }), 'bottom-right');

    // A new style starts without our layers, so they go back in each time one loads.
    this.map.on('style.load', () => this.addRouteLayers());
    this.map.on('contextmenu', (event) => {
      event.preventDefault();
      this.menuOpenedAt = Date.now();
      this.events.contextMenu({ latitude: event.lngLat.lat, longitude: event.lngLat.lng }, event.point);
    });
    this.watchLongPress();
    this.map.on('movestart', () => this.events.moved());
    this.map.on('mousemove', (event) => this.pointerMoved(event));
    this.map.on('mousedown', (event) => this.pointerDown(event));
    this.map.on('mouseup', (event) => this.pointerUp(event));
    this.map.on('click', (event) => this.clicked(event));
    this.map.getCanvasContainer().addEventListener('mouseleave', () => { if (!this.pulling) this.setGhost(null); });

    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.classList.add('pen-stroke');
    this.strokeLayer = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
    this.strokeLayer.setAttribute('stroke', penColor);
    svg.append(this.strokeLayer);
    container.append(svg);
    this.watchPen();
    // A stroke handed over stays on the map while its edit is planned, wherever the map goes.
    this.map.on('move', () => {
      if (!this.stroke?.coordinates) return;
      this.stroke.pixels = this.stroke.coordinates.map((c) => this.map.project([c.longitude, c.latitude]));
      this.drawStroke();
    });
  }

  setStyle(style: string): void {
    if (style === this.shownStyle) return;
    this.shownStyle = style;
    this.map.setStyle(styleURL(style));
  }

  /** The pen out or away. While it is out the line can't be pulled and markers stay put. */
  setDrawing(drawing: boolean): void {
    if (drawing === this.drawing) return;
    this.drawing = drawing;
    this.spaceHeld = false;
    this.setGhost(null);
    this.clearStroke();
    this.map.getContainer().classList.toggle('drawing', drawing);
  }

  /** Takes the last stroke off the map, once its edit is done. */
  clearStroke(): void {
    this.stroke = null;
    this.drawStroke();
  }

  /** The areas drawn round, the one offered for removal stronger. */
  showZones(zones: Zone[], selected: number | null): void {
    this.zones = zones;
    this.selectedZone = selected;
    this.setData(zonesSource, this.zonesFeature());
  }

  private zonesFeature(): FeatureCollection {
    return { type: 'FeatureCollection', features: this.zones.map((zone) => ({
      type: 'Feature' as const, properties: { selected: zone.id === this.selectedZone ? 1 : 0 },
      geometry: { type: 'Polygon' as const, coordinates: [[...zone.outline, zone.outline[0]].map((p) => [p.longitude, p.latitude])] },
    })) };
  }

  /** Whether the route can be reshaped: not a line kept as recorded. */
  setEditable(editable: boolean): void {
    if (editable === this.editable) return;
    this.editable = editable;
    if (!editable) this.setGhost(null);
    for (const { marker } of this.markers.values()) marker.setDraggable(editable);
  }

  private get isDark(): boolean {
    return darkStyles.some((style) => style.id === this.shownStyle);
  }

  private addRouteLayers(): void {
    const map = this.map;
    const before = map.getLayer(routeAnchor) ? routeAnchor : undefined;
    const width = (low: number, high: number): maplibregl.ExpressionSpecification =>
      ['interpolate', ['exponential', 1.5], ['zoom'], 8, low, 18, high];
    map.addSource(routeSource, { type: 'geojson', data: lineFeature(this.line) });
    map.addSource(alternativesSource, { type: 'geojson', data: this.alternativesFeature() });
    map.addSource(previewSource, { type: 'geojson', data: empty });
    map.addSource(ghostSource, { type: 'geojson', data: empty });
    map.addSource(positionSource, { type: 'geojson', data: empty });
    map.addSource(zonesSource, { type: 'geojson', data: this.zonesFeature() });
    // No-go zones under every route, as the app draws them: a red wash and a dashed edge.
    map.addLayer({
      id: 'planner-zones-fill', type: 'fill', source: zonesSource,
      paint: { 'fill-color': routeColor, 'fill-opacity': ['case', ['==', ['get', 'selected'], 1], 0.35, 0.18] },
    }, before);
    map.addLayer({
      id: 'planner-zones-line', type: 'line', source: zonesSource,
      paint: { 'line-color': routeColor, 'line-width': 2, 'line-dasharray': [2, 1.5] },
    }, before);
    // The routes not chosen, in grey under the chosen one, as the app draws them.
    map.addLayer({
      id: 'planner-alternatives-casing', type: 'line', source: alternativesSource,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': this.isDark ? '#0E0F11' : '#FFFFFF', 'line-opacity': 0.8, 'line-width': width(5, 16) },
    }, before);
    map.addLayer({
      id: 'planner-alternatives-line', type: 'line', source: alternativesSource,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': this.isDark ? '#7C7C82' : '#9A9AA0', 'line-width': width(3, 11) },
    }, before);
    map.addLayer({
      id: 'planner-route-casing', type: 'line', source: routeSource,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': this.isDark ? '#0E0F11' : '#FFFFFF', 'line-opacity': 0.9, 'line-width': width(5, 16) },
    }, before);
    map.addLayer({
      id: 'planner-route-line', type: 'line', source: routeSource,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: { 'line-color': routeColor, 'line-width': width(3, 11) },
    }, before);
    // Dashed: two straight lines are a placeholder, and drawn solid they would read as the route.
    map.addLayer({
      id: 'planner-preview', type: 'line', source: previewSource,
      layout: { 'line-join': 'round', 'line-cap': 'butt' },
      paint: { 'line-color': routeColor, 'line-width': width(3, 11), 'line-dasharray': [1.2, 1.2] },
    }, before);
    for (const id of ['planner-ghost', 'planner-position']) {
      map.addLayer({
        id, type: 'circle', source: id === 'planner-ghost' ? ghostSource : positionSource,
        paint: { 'circle-radius': 6, 'circle-color': '#FFFFFF', 'circle-stroke-color': routeColor, 'circle-stroke-width': 3 },
      });
    }
    // Where the rider is, and how sure the browser is of it: a circle of that many metres.
    map.addSource(locationSource, { type: 'geojson', data: this.location ? pointFeature(this.location, { accuracy: this.location.accuracy }) : empty });
    map.addLayer({
      id: 'planner-location-accuracy', type: 'circle', source: locationSource,
      paint: {
        'circle-radius': accuracyRadius(this.location?.latitude ?? 0),
        'circle-color': locationColor, 'circle-opacity': 0.12,
        'circle-stroke-color': locationColor, 'circle-stroke-opacity': 0.3, 'circle-stroke-width': 1,
      },
    });
    map.addLayer({
      id: 'planner-location', type: 'circle', source: locationSource,
      paint: { 'circle-radius': 7, 'circle-color': locationColor, 'circle-stroke-color': '#FFFFFF', 'circle-stroke-width': 3 },
    });
  }

  /** The rider's dot and its accuracy, or none. */
  showLocation(fix: (Coordinate & { accuracy: number }) | null): void {
    const latitudeChanged = Boolean(fix && Math.abs((this.location?.latitude ?? 1000) - fix.latitude) > 0.5);
    this.location = fix;
    // The accuracy circle's scale depends on the latitude, which an expression can't read; it is
    // set again when the dot moves far enough north or south to matter.
    if (latitudeChanged && this.map.getLayer('planner-location-accuracy')) {
      this.map.setPaintProperty('planner-location-accuracy', 'circle-radius', accuracyRadius(fix!.latitude));
    }
    this.setData(locationSource, fix ? pointFeature(fix, { accuracy: fix.accuracy }) : empty);
  }

  /** Moves the map to the rider, close enough to see the streets around them. */
  showAround(point: Coordinate, padding: maplibregl.PaddingOptions): void {
    this.map.easeTo({ center: [point.longitude, point.latitude], zoom: Math.max(this.map.getZoom(), 14), padding, duration: 800 });
  }

  private setData(source: string, data: FeatureCollection): void {
    (this.map.getSource(source) as maplibregl.GeoJSONSource | undefined)?.setData(data);
  }

  /** The routes found and the one chosen, or none. A new line also ends the preview of the drag
   *  that asked for it. With more than one route each is labelled with its distance, where it
   *  differs most from the others, and a click on a line or label chooses it. */
  showRoutes(routes: { line: Coordinate[]; label: string }[], selected: number): void {
    this.routes = routes.map((route) => route.line);
    this.selected = selected;
    this.line = this.routes[selected] ?? [];
    this.setData(routeSource, lineFeature(this.line));
    this.setData(alternativesSource, this.alternativesFeature());
    this.setData(previewSource, empty);
    for (const label of this.labels) label.remove();
    this.labels = [];
    if (routes.length < 2) return;
    labelAnchors(this.routes).forEach((anchor, index) => {
      if (!anchor) return;
      const element = document.createElement('button');
      element.type = 'button';
      element.className = `route-label${index === selected ? ' selected' : ''}`;
      element.textContent = routes[index].label;
      element.setAttribute('aria-label', `Route ${index + 1}, ${routes[index].label}`);
      element.addEventListener('click', (event) => { event.stopPropagation(); this.events.chooseRoute(index); });
      this.labels.push(new maplibregl.Marker({ element, anchor: 'bottom', offset: [0, -6] })
        .setLngLat([anchor.longitude, anchor.latitude]).addTo(this.map));
    });
  }

  private alternativesFeature(): FeatureCollection {
    return { type: 'FeatureCollection', features: this.routes.flatMap((line, index) => index === this.selected || line.length < 2 ? [] : [{
      type: 'Feature' as const, properties: { index },
      geometry: { type: 'LineString' as const, coordinates: line.map((p) => [p.longitude, p.latitude]) },
    }]) };
  }

  /** A click near an alternative's line chooses it. */
  private clicked(event: maplibregl.MapMouseEvent): void {
    if (this.pressedLine) {
      this.pressedLine = false;
      return;
    }
    if (this.routes.length < 2 || !this.map.getLayer('planner-alternatives-line')) return;
    const { x, y } = event.point;
    const hit = this.map.queryRenderedFeatures([[x - lineReach, y - lineReach], [x + lineReach, y + lineReach]],
      { layers: ['planner-alternatives-line'] })[0];
    if (hit) this.events.chooseRoute(Number(hit.properties?.index));
  }

  /** Takes a drag's preview down when its plan came to nothing. */
  clearPreview(): void {
    this.setData(previewSource, empty);
  }

  /** A dot on the route, where the pointer is on the elevation profile; null takes it away. */
  showPosition(point: Coordinate | null): void {
    this.setData(positionSource, point ? pointFeature(point) : empty);
  }

  private setGhost(grab: { at: Coordinate; position: number } | null): void {
    this.grabbable = grab;
    this.setData(ghostSource, grab ? pointFeature(grab.at) : empty);
    this.map.getCanvas().style.cursor = this.pulling ? 'grabbing' : grab ? 'grab' : '';
  }

  // ---------- Pulling the line into a bend ----------

  private pointerMoved(event: maplibregl.MapMouseEvent): void {
    if (this.drawing) return;
    const at = { latitude: event.lngLat.lat, longitude: event.lngLat.lng };
    if (this.pulling) {
      this.pulling.at = at;
      const { before, positions, base } = this.pulling;
      this.setData(previewSource, lineFeature([...prefix(base, positions[before - 1]), at, ...suffix(base, positions[before])]));
      this.setData(ghostSource, pointFeature(at));
      return;
    }
    // Over a marker, the marker is what is picked up.
    const overCanvas = event.originalEvent.target === this.map.getCanvas();
    if (!this.editable || this.line.length < 2 || !overCanvas || this.nearMarker(event.point)) {
      if (this.grabbable) this.setGhost(null);
      return;
    }
    const { x, y } = event.point;
    const hit = Boolean(this.map.getLayer('planner-route-line')) && this.map.queryRenderedFeatures(
      [[x - lineReach, y - lineReach], [x + lineReach, y + lineReach]], { layers: ['planner-route-line', 'planner-route-casing'] }).length > 0;
    const projection = hit ? project(this.line, at) : null;
    this.setGhost(projection ? { at: projection.at, position: projection.segment + projection.t } : null);
  }

  private nearMarker(point: maplibregl.Point): boolean {
    return this.placed.some((placed) => {
      const screen = this.map.project([placed.point.longitude, placed.point.latitude]);
      return Math.hypot(screen.x - point.x, screen.y - point.y) <= pointReach;
    });
  }

  private pointerDown(event: maplibregl.MapMouseEvent): void {
    if (event.originalEvent.button !== 0 || !this.grabbable || !this.editable || this.drawing) return;
    // Taking the line, not panning the map.
    event.preventDefault();
    const positions = stopPositions(this.placed.map((p) => p.point), this.line);
    this.pulling = {
      before: insertionIndex(this.grabbable.position, positions), positions, base: this.line,
      from: event.point, at: this.grabbable.at,
    };
    this.setGhost(this.grabbable);
  }

  private pointerUp(event: maplibregl.MapMouseEvent): void {
    const pulling = this.pulling;
    if (!pulling) return;
    this.pulling = null;
    this.pressedLine = true;
    this.setGhost(null);
    // A click on the line without a pull leaves the route as it was.
    if (Math.hypot(event.point.x - pulling.from.x, event.point.y - pulling.from.y) < 3) {
      this.setData(previewSource, empty);
      return;
    }
    this.events.insertShaping({ latitude: event.lngLat.lat, longitude: event.lngLat.lng }, pulling.before);
  }

  // ---------- The pen ----------

  private watchPen(): void {
    const container = this.map.getContainer();
    const point = (clientX: number, clientY: number) => {
      const box = container.getBoundingClientRect();
      return { x: clientX - box.left, y: clientY - box.top };
    };
    // MapLibre's own buttons (zoom, compass, attribution) are pressed, not drawn on.
    const onControl = (target: EventTarget | null) => (target as HTMLElement | null)?.closest('.maplibregl-control-container') != null;
    let pressed = false;

    container.addEventListener('mousedown', (event) => {
      if (!this.drawing || this.spaceHeld || event.button !== 0 || onControl(event.target)) return;
      event.stopPropagation();
      event.preventDefault();
      pressed = true;
      this.beginStroke(point(event.clientX, event.clientY));
    }, { capture: true });
    window.addEventListener('mousemove', (event) => {
      if (pressed) this.extendStroke(point(event.clientX, event.clientY));
    });
    window.addEventListener('mouseup', () => {
      if (!pressed) return;
      pressed = false;
      this.endStroke();
    });

    // One finger draws; a second one turns it into a gesture on the map, which MapLibre takes.
    container.addEventListener('touchstart', (event) => {
      if (!this.drawing || onControl(event.target)) return;
      if (event.touches.length === 1) {
        event.stopPropagation();
        pressed = true;
        const touch = event.touches[0];
        this.beginStroke(point(touch.clientX, touch.clientY));
      } else if (pressed) {
        pressed = false;
        this.clearStroke();
      }
    }, { capture: true, passive: true });
    container.addEventListener('touchmove', (event) => {
      if (!pressed) return;
      event.stopPropagation();
      event.preventDefault();
      const touch = event.touches[0];
      this.extendStroke(point(touch.clientX, touch.clientY));
    }, { capture: true, passive: false });
    const touchEnded = (event: TouchEvent) => {
      if (!pressed || event.touches.length > 0) return;
      event.stopPropagation();
      pressed = false;
      this.endStroke();
    };
    container.addEventListener('touchend', touchEnded, { capture: true });
    container.addEventListener('touchcancel', () => { pressed = false; this.clearStroke(); }, { capture: true });

    // Space moves the map, as in drawing apps; typing a space in a field is only typing.
    window.addEventListener('keydown', (event) => {
      if (!this.drawing || event.key !== ' ') return;
      if (event.target instanceof Element && event.target.closest('input, textarea, button, [contenteditable]')) return;
      event.preventDefault();
      if (!this.spaceHeld) container.classList.add('panning');
      this.spaceHeld = true;
    });
    window.addEventListener('keyup', (event) => {
      if (event.key !== ' ' || !this.spaceHeld) return;
      this.spaceHeld = false;
      container.classList.remove('panning');
    });
  }

  private beginStroke(at: { x: number; y: number }): void {
    this.stroke = { pixels: [at], coordinates: null };
    this.drawStroke();
  }

  private extendStroke(at: { x: number; y: number }): void {
    const pixels = this.stroke?.pixels;
    if (!pixels || this.stroke!.coordinates) return;
    const last = pixels.at(-1)!;
    if (Math.hypot(at.x - last.x, at.y - last.y) < penSpacing) return;
    pixels.push(at);
    this.drawStroke();
  }

  private endStroke(): void {
    const stroke = this.stroke;
    if (!stroke || stroke.coordinates) return;
    const coordinates = stroke.pixels.map(({ x, y }) => {
      const at = this.map.unproject([x, y]);
      return { latitude: at.lat, longitude: at.lng };
    });
    // A click, not a stroke: about what is under it.
    if (stroke.pixels.length < 2) {
      this.clearStroke();
      this.events.penClick(coordinates[0]);
      return;
    }
    stroke.coordinates = coordinates;
    this.events.penStroke(coordinates, this.metresPerPoint());
  }

  private drawStroke(): void {
    this.strokeLayer.setAttribute('points', (this.stroke?.pixels ?? []).map(({ x, y }) => `${x},${y}`).join(' '));
  }

  /** Metres per pixel across the middle of the map, as the app measures a point. */
  private metresPerPoint(): number {
    const bounds = this.map.getBounds();
    const latitude = this.map.getCenter().lat;
    const width = this.map.getContainer().clientWidth;
    const across = distance({ latitude, longitude: bounds.getWest() }, { latitude, longitude: bounds.getEast() });
    return width > 0 && across > 0 ? across / width : 10;
  }

  // ---------- Markers ----------

  /** One marker per point that is filled in: the start, numbered stops, small bends, the
   *  destination. */
  showStops(stops: Stop[]): void {
    const placed = stops.filter((stop) => stop.place);
    this.placed = placed.map((stop) => ({ id: stop.id, kind: stop.kind, point: stop.place! }));
    const keep = new Set<number>();
    let stopNumber = 0;
    placed.forEach((stop, index) => {
      const role = index === 0 ? 'start' : index === placed.length - 1 ? 'end' : stop.kind === 'shaping' ? 'shaping' : 'via';
      if (role === 'via') stopNumber += 1;
      const label = role === 'via' ? String(stopNumber) : '';
      const signature = `${role}|${label}|${stop.place!.latitude}|${stop.place!.longitude}|${stop.place!.name}`;
      keep.add(stop.id);
      const existing = this.markers.get(stop.id);
      if (existing?.signature === signature) return;
      existing?.marker.remove();
      this.markers.set(stop.id, { marker: this.marker(stop, role, label), signature });
    });
    for (const [id, { marker }] of this.markers) {
      if (!keep.has(id)) {
        marker.remove();
        this.markers.delete(id);
      }
    }
  }

  private marker(stop: Stop, role: string, label: string): maplibregl.Marker {
    // MapLibre positions the element with its own transform, so the shape is drawn inside it.
    const element = document.createElement('div');
    element.className = 'stop-marker';
    element.title = role === 'shaping' ? `${stop.place!.name} (shaping point)` : stop.place!.name;
    const shape = document.createElement('span');
    shape.className = `stop-marker-shape stop-marker-${role}`;
    shape.textContent = label;
    element.append(shape);
    element.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.menuOpenedAt = Date.now();
      if (this.editable) this.events.pointMenu(stop.id, { x: event.clientX, y: event.clientY });
    });
    element.dataset.stopId = String(stop.id);
    const marker = new maplibregl.Marker({ element, draggable: this.editable, anchor: role === 'end' ? 'bottom' : 'center' })
      .setLngLat([stop.place!.longitude, stop.place!.latitude])
      .addTo(this.map);

    // While it moves, the legs either side of it run straight to it, dashed.
    let drag: { index: number; positions: number[]; base: Coordinate[] } | null = null;
    marker.on('dragstart', () => {
      const index = this.placed.findIndex((p) => p.id === stop.id);
      drag = this.line.length > 1 ? { index, positions: stopPositions(this.placed.map((p) => p.point), this.line), base: this.line } : null;
    });
    marker.on('drag', () => {
      if (!drag) return;
      const at = marker.getLngLat();
      const point = { latitude: at.lat, longitude: at.lng };
      const { index, positions, base } = drag;
      const head = index > 0 ? prefix(base, positions[index - 1]) : [];
      const tail = index < positions.length - 1 ? suffix(base, positions[index + 1]) : [];
      this.setData(previewSource, lineFeature([...head, point, ...tail]));
    });
    marker.on('dragend', () => {
      drag = null;
      const at = marker.getLngLat();
      this.events.stopMoved(stop.id, { latitude: at.lat, longitude: at.lng });
    });
    return marker;
  }

  /** A long press on the map opens its menu, and on a marker the marker's, as a right-click does. */
  private watchLongPress(): void {
    const container = this.map.getContainer();
    let hold: { timer: ReturnType<typeof setTimeout>; x: number; y: number } | null = null;
    const cancel = () => {
      if (hold) clearTimeout(hold.timer);
      hold = null;
    };
    container.addEventListener('touchstart', (event) => {
      cancel();
      if (event.touches.length !== 1) return;
      const touch = event.touches[0];
      const marker = (event.target as HTMLElement).closest<HTMLElement>('.stop-marker');
      const startedAt = Date.now();
      hold = {
        x: touch.clientX, y: touch.clientY,
        timer: setTimeout(() => {
          hold = null;
          if (this.menuOpenedAt >= startedAt) return; // the browser's own long-press menu came first
          this.menuOpenedAt = Date.now();
          const screen = { x: touch.clientX, y: touch.clientY };
          if (marker?.dataset.stopId) {
            if (this.editable) this.events.pointMenu(Number(marker.dataset.stopId), screen);
            return;
          }
          const box = container.getBoundingClientRect();
          const at = this.map.unproject([screen.x - box.left, screen.y - box.top]);
          this.events.contextMenu({ latitude: at.lat, longitude: at.lng }, screen);
        }, holdDuration),
      };
    }, { passive: true });
    container.addEventListener('touchmove', (event) => {
      const touch = event.touches[0];
      if (hold && touch && Math.hypot(touch.clientX - hold.x, touch.clientY - hold.y) > holdSlop) cancel();
    }, { passive: true });
    container.addEventListener('touchend', cancel);
    container.addEventListener('touchcancel', cancel);
  }

  /** Shows the whole of a line, clear of the card. */
  fit(points: Coordinate[], padding: maplibregl.PaddingOptions): void {
    if (points.length === 0) return;
    const bounds = new maplibregl.LngLatBounds();
    for (const point of points) bounds.extend([point.longitude, point.latitude]);
    this.map.fitBounds(bounds, { padding, maxZoom: 15, duration: 600 });
  }

  /** Where the map's centre is: the bias for search. */
  get center(): Coordinate {
    const center = this.map.getCenter();
    return { latitude: center.lat, longitude: center.lng };
  }
}

/** A circle's radius in pixels for a feature's `accuracy` in metres, at `latitude`: Web Mercator's
 *  metres per pixel at zoom 0 there, halved with every zoom level. */
function accuracyRadius(latitude: number): maplibregl.ExpressionSpecification {
  const atZero = 156543.03 * Math.cos((latitude * Math.PI) / 180);
  return ['interpolate', ['exponential', 2], ['zoom'], 0, ['/', ['get', 'accuracy'], atZero], 22, ['/', ['get', 'accuracy'], atZero / 2 ** 22]];
}

const empty: FeatureCollection = { type: 'FeatureCollection', features: [] };

function lineFeature(line: Coordinate[]): FeatureCollection {
  if (line.length < 2) return empty;
  return { type: 'FeatureCollection', features: [{
    type: 'Feature', properties: {},
    geometry: { type: 'LineString', coordinates: line.map((p) => [p.longitude, p.latitude]) },
  }] };
}

function pointFeature(point: Coordinate, properties: Record<string, number> = {}): FeatureCollection {
  return { type: 'FeatureCollection', features: [{
    type: 'Feature', properties, geometry: { type: 'Point', coordinates: [point.longitude, point.latitude] },
  }] };
}
