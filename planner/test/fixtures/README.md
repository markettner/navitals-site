# Fixtures shared with the app

Copies of files in the app repo (`Navitals`), so the planner is tested against the same examples
the app is. `npm run sync` (scripts/sync-from-app.sh) copies them again, along with the map styles
and the BRouter profiles; a difference after a sync is a change to the contract.

| file | from |
|---|---|
| `navitals-route.gpx`, `navitals-route-rte.gpx`, `line-route.gpx`, `garmin-trip.gpx`, `plain-route.gpx` | `NavitalsKit/Tests/NavitalsKitTests/Fixtures/route-gpx/` (the examples of `docs/ROUTE_GPX.md`) |
| `brouter-far-side-via.json` | `NavitalsKit/Tests/NavitalsKitTests/Fixtures/` (An der Wuhlheide, a shaping point on the far carriageway) |
| `brouter-route1-timode3.geojson` | `NavitalsKit/Tests/NavitalsKitTests/Fixtures/` (a BRouter 1.7.10 answer) |
| `brouter-mauerweg-replan.json` | `NavitalsKit/Tests/NavitalsKitTests/Fixtures/` (points 28–36 of the Berliner Mauerweg before and after moving one, and the windows routed again) |
