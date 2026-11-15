// Parse an uploaded GeoJSON boundary into our area format: { bbox, polys: [{ outer, holes, bb }], name }.
// Rings are converted from GeoJSON [lon, lat] to [lat, lon]. Very detailed rings are thinned for speed.

const MAX_RING = 1500; // vertices per ring after thinning

function thin(ring) {
  if (ring.length <= MAX_RING) return ring;
  const step = Math.ceil(ring.length / MAX_RING);
  return ring.filter((_, i) => i % step === 0);
}

function ringBBox(ring) {
  let s = Infinity, n = -Infinity, w = Infinity, e = -Infinity;
  for (const [lat, lon] of ring) { s = Math.min(s, lat); n = Math.max(n, lat); w = Math.min(w, lon); e = Math.max(e, lon); }
  return { s, n, w, e };
}

export function parseGeoJSON(obj) {
  const polys = [];
  let name = null;
  const addPolygon = (rings) => {
    const conv = rings.map((r) => thin(r.map((c) => {
      const [x, y] = c;
      if (!Number.isFinite(x) || !Number.isFinite(y) || Math.abs(x) > 180 || Math.abs(y) > 90) {
        throw new Error("Coordinates don't look like longitude/latitude. Please export the file in WGS84 (EPSG:4326).");
      }
      return [y, x];
    })));
    if (!conv[0] || conv[0].length < 3) return;
    polys.push({ outer: conv[0], holes: conv.slice(1).filter((h) => h.length >= 3), bb: ringBBox(conv[0]) });
  };
  const addGeom = (g) => {
    if (!g) return;
    if (g.type === 'Polygon') addPolygon(g.coordinates);
    else if (g.type === 'MultiPolygon') g.coordinates.forEach(addPolygon);
    else if (g.type === 'GeometryCollection') g.geometries.forEach(addGeom);
  };
  const addFeature = (f) => {
    const p = f.properties ?? {};
    name ??= p.name ?? p.NAME ?? p.Name ?? p.title ?? p.LABEL ?? null;
    addGeom(f.geometry);
  };
  if (obj?.type === 'FeatureCollection') obj.features.forEach(addFeature);
  else if (obj?.type === 'Feature') addFeature(obj);
  else addGeom(obj);
  if (!polys.length) throw new Error('No polygon found. The file needs Polygon or MultiPolygon shapes (points and lines are not supported).');

  const bbox = polys.reduce((b, p) => ({
    s: Math.min(b.s, p.bb.s), n: Math.max(b.n, p.bb.n), w: Math.min(b.w, p.bb.w), e: Math.max(b.e, p.bb.e),
  }), { s: Infinity, n: -Infinity, w: Infinity, e: -Infinity });
  if (bbox.n < -45 || bbox.s > -9 || bbox.e < 112 || bbox.w > 155) {
    throw new Error('This boundary is outside Australia. The current data covers Australia only.');
  }
  return { bbox, polys, name: name ? String(name).slice(0, 80) : null };
}
