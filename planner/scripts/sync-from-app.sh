#!/bin/sh
# Copies what the planner shares with the app from a checkout of the app repo (default: the
# Navitals checkout next to navitals-site): the map styles (built without the route overlays),
# the BRouter profiles, and the test fixtures of the GPX and link contracts. build_styles.py rewrites the
# app's own styles as it goes, byte for byte as they were.
set -eu
here=$(cd "$(dirname "$0")/.." && pwd)
app=${1:-"$here/../../Navitals"}
python3 "$app/tools/styles/build_styles.py" --web-out "$here/public/styles" >/dev/null
cp "$app"/Navitals/Resources/BRouter/*.brf "$app"/Navitals/Resources/BRouter/lookups.dat "$here/public/profiles/"
fixtures="$app/NavitalsKit/Tests/NavitalsKitTests/Fixtures"
cp "$fixtures"/route-gpx/*.gpx "$fixtures/brouter-far-side-via.json" "$fixtures/brouter-route1-timode3.geojson" \
  "$fixtures/brouter-mauerweg-replan.json" "$fixtures/route-link/route-links.json" "$here/test/fixtures/"
echo "synced from $app"
