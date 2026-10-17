// The map: the app's styles, the route drawn into them, the stops as markers, and the events the
// card plans from. Plain MapLibre; the card tells it what to show.

import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// MapLibre finds its worker next to its own module, which neither Vite's dev cache nor the bundle
// keeps; so Vite bundles the worker itself and hands MapLibre the address.
import workerURL from 'maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url';
import type { FeatureCollection } from 'geojson';
import type { Coordinate } from '../core/geodesy';
import { darkStyles, styleURL } from '../mapStyles';
import type { Stop } from './planner.svelte';

maplibregl.setWorkerUrl(workerURL);

/** The empty layer every style carries where route lines belong: above the roads and bridges,
 *  below the labels (`add_route_anchor` in the app's build_styles.py). */
const routeAnchor = 'route-anchor';
const routeSource = 'planner-route';
const positionSource = 'planner-position';
/** The app's accent, which is the planned route's colour there. */
const routeColor = '#E03A3E';

export interface MapEvents {
  /** A right-click (or a long press) on the map, at a point on screen. */
  contextMenu: (at: Coordinate, screen: { x: number; y: number }) => void;
  /** A stop's marker was dragged somewhere else. */
  stopMoved: (id: number, to: Coordinate) => void;
  /** The map moved, so a menu over it is no longer where it pointed. */
  moved: () => void;
}

export class MapView {
  readonly map: maplibregl.Map;
  private shownStyle: string;
  private line: Coordinate[] = [];
  private markers = new Map<number, { marker: maplibregl.Marker; signature: string }>();

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
  }

  setStyle(style: string): void {
    if (style === this.shownStyle) return;
    this.shownStyle = style;
    this.map.setStyle(styleURL(style));
  }

  private get isDark(): boolean {
    return darkStyles.some((style) => style.id === this.shownStyle);
  }

  private addRouteLayers(): void {
    const map = this.map;
    const before = map.getLayer(routeAnchor) ? routeAnchor : undefined;
    map.addSource(routeSource, { type: 'geojson', data: this.lineFeature() });
    map.addSource(positionSource, { type: 'geojson', data: emptyCollection });
    map.addLayer({
      id: 'planner-route-casing', type: 'line', source: routeSource,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': this.isDark ? '#0E0F11' : '#FFFFFF', 'line-opacity': 0.9,
        'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 8, 5, 18, 16],
      },
    }, before);
    map.addLayer({
      id: 'planner-route-line', type: 'line', source: routeSource,
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': routeColor,
        'line-width': ['interpolate', ['exponential', 1.5], ['zoom'], 8, 3, 18, 11],
      },
    }, before);
    map.addLayer({
      id: 'planner-position', type: 'circle', source: positionSource,
      paint: { 'circle-radius': 6, 'circle-color': '#FFFFFF', 'circle-stroke-color': routeColor, 'circle-stroke-width': 3 },
    });
  }

  private lineFeature(): FeatureCollection {
    if (this.line.length < 2) return emptyCollection;
    return { type: 'FeatureCollection', features: [{
      type: 'Feature', properties: {},
      geometry: { type: 'LineString', coordinates: this.line.map((p) => [p.longitude, p.latitude]) },
    }] };
  }

  /** The route's line, or none. */
  showRoute(line: Coordinate[]): void {
    this.line = line;
    (this.map.getSource(routeSource) as maplibregl.GeoJSONSource | undefined)?.setData(this.lineFeature());
  }

  /** A dot on the route, where the pointer is on the elevation profile; null takes it away. */
  showPosition(point: Coordinate | null): void {
    (this.map.getSource(positionSource) as maplibregl.GeoJSONSource | undefined)?.setData(point ? {
      type: 'FeatureCollection',
      features: [{ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [point.longitude, point.latitude] } }],
    } : emptyCollection);
  }

  /** One marker per stop that is filled in: the start, numbered stops, the destination. */
  showStops(stops: Stop[]): void {
    const placed = stops.filter((stop) => stop.place && stop.kind === 'stop');
    const keep = new Set<number>();
    placed.forEach((stop, index) => {
      const role = index === 0 ? 'start' : index === placed.length - 1 ? 'end' : 'via';
      const label = role === 'via' ? String(index) : '';
      const signature = `${role}|${label}|${stop.place!.latitude}|${stop.place!.longitude}|${stop.place!.name}`;
      keep.add(stop.id);
      const existing = this.markers.get(stop.id);
      if (existing?.signature === signature) return;
      existing?.marker.remove();
      // MapLibre positions the element with its own transform, so the shape is drawn inside it.
      const element = document.createElement('div');
      element.className = 'stop-marker';
      const shape = document.createElement('span');
      shape.className = `stop-marker-shape stop-marker-${role}`;
      shape.textContent = label;
      element.append(shape);
      element.title = stop.place!.name;
      const marker = new maplibregl.Marker({ element, draggable: true, anchor: role === 'end' ? 'bottom' : 'center' })
        .setLngLat([stop.place!.longitude, stop.place!.latitude])
        .addTo(this.map);
      marker.on('dragend', () => {
        const at = marker.getLngLat();
        this.events.stopMoved(stop.id, { latitude: at.lat, longitude: at.lng });
      });
      this.markers.set(stop.id, { marker, signature });
    });
    for (const [id, { marker }] of this.markers) {
      if (!keep.has(id)) {
        marker.remove();
        this.markers.delete(id);
      }
    }
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

const emptyCollection: FeatureCollection = { type: 'FeatureCollection', features: [] };
