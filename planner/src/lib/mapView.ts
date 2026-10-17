// The map: the app's styles, the route drawn into them, the stops and bends as markers, and what a
// pointer does with them. Plain MapLibre; the card tells it what to show.
//
// Reshaping follows the app's planner on iPad and Mac (MapPointerController): a mouse grabs the
// line within 12 px and drags out a bend, or picks up a stop or bend and moves it. While it moves,
// the route is drawn dashed and straight through the pointer, and BRouter is asked once, on drop:
// never for a preview, since every pause in a drag would be a request to a donated server. Touch
// pans the map, as in the app; markers can still be dragged with a finger.

import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre finds its worker next to its own module, which neither Vite's dev cache nor the bundle
// keeps; so Vite bundles the worker itself and hands MapLibre the address.
import workerURL from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import type { FeatureCollection } from 'geojson';
import { insertionIndex, prefix, project, stopPositions, suffix, type Coordinate } from '../core/geodesy';
import { darkStyles, styleURL } from '../mapStyles';
import type { Stop } from './planner.svelte';

maplibregl.setWorkerUrl(workerURL);

/** The empty layer every style carries where route lines belong: above the roads and bridges,
 *  below the labels (`add_route_anchor` in the app's build_styles.py). */
const routeAnchor = 'route-anchor';
const routeSource = 'planner-route';
const previewSource = 'planner-preview';
const ghostSource = 'planner-ghost';
const positionSource = 'planner-position';
/** The app's accent, which is the planned route's colour there. */
const routeColor = '#E03A3E';
/** How near the line, in pixels, a press has to start to take it; and how near a marker to take
 *  that instead (`MapPointerController.lineReach`, `pointReach`). */
const lineReach = 12;
const pointReach = 14;

export interface MapEvents {
  /** A right-click on the map, at a point on screen. */
  contextMenu: (at: Coordinate, screen: { x: number; y: number }) => void;
  /** A right-click on a stop's or bend's marker. */
  pointMenu: (id: number, screen: { x: number; y: number }) => void;
  /** A stop's or bend's marker was dragged somewhere else. */
  stopMoved: (id: number, to: Coordinate) => void;
  /** The line was dragged out into a bend, which goes before the waypoint at `before`. */
  insertShaping: (at: Coordinate, before: number) => void;
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
  private placed: Placed[] = [];
  private editable = true;
  private markers = new Map<number, { marker: maplibregl.Marker; signature: string }>();
  /** The line being pulled into a new bend: where it goes in the plan, the line and stop positions
   *  it was grabbed on, where it was grabbed and where the pointer is now. */
  private pulling: { before: number; positions: number[]; base: Coordinate[]; from: maplibregl.Point; at: Coordinate } | null = null;
  /** The ghost dot's place on the line, while the pointer is near enough to grab it. */
  private grabbable: { at: Coordinate; position: number } | null = null;

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
    this.map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: false } }), 'top-right');
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
      this.events.contextMenu({ latitude: event.lngLat.lat, longitude: event.lngLat.lng }, event.point);
    });
    this.map.on('movestart', () => this.events.moved());
    this.map.on('mousemove', (event) => this.pointerMoved(event));
    this.map.on('mousedown', (event) => this.pointerDown(event));
    this.map.on('mouseup', (event) => this.pointerUp(event));
    this.map.getCanvasContainer().addEventListener('mouseleave', () => { if (!this.pulling) this.setGhost(null); });
  }

  setStyle(style: string): void {
    if (style === this.shownStyle) return;
    this.shownStyle = style;
    this.map.setStyle(styleURL(style));
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
    map.addSource(previewSource, { type: 'geojson', data: empty });
    map.addSource(ghostSource, { type: 'geojson', data: empty });
    map.addSource(positionSource, { type: 'geojson', data: empty });
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
  }

  private setData(source: string, data: FeatureCollection): void {
    (this.map.getSource(source) as maplibregl.GeoJSONSource | undefined)?.setData(data);
  }

  /** The route's line, or none. A new line also ends the preview of the drag that asked for it. */
  showRoute(line: Coordinate[]): void {
    this.line = line;
    this.setData(routeSource, lineFeature(line));
    this.setData(previewSource, empty);
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
    if (event.originalEvent.button !== 0 || !this.grabbable || !this.editable) return;
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
    this.setGhost(null);
    // A click on the line without a pull leaves the route as it was.
    if (Math.hypot(event.point.x - pulling.from.x, event.point.y - pulling.from.y) < 3) {
      this.setData(previewSource, empty);
      return;
    }
    this.events.insertShaping({ latitude: event.lngLat.lat, longitude: event.lngLat.lng }, pulling.before);
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
      if (this.editable) this.events.pointMenu(stop.id, { x: event.clientX, y: event.clientY });
    });
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

const empty: FeatureCollection = { type: 'FeatureCollection', features: [] };

function lineFeature(line: Coordinate[]): FeatureCollection {
  if (line.length < 2) return empty;
  return { type: 'FeatureCollection', features: [{
    type: 'Feature', properties: {},
    geometry: { type: 'LineString', coordinates: line.map((p) => [p.longitude, p.latitude]) },
  }] };
}

function pointFeature(point: Coordinate): FeatureCollection {
  return { type: 'FeatureCollection', features: [{
    type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [point.longitude, point.latitude] },
  }] };
}
