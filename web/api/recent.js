// Vercel serverless function: GET /api/recent?bbox=w,s,e,n
// Proxies NASA FIRMS near-real-time active fires for the last 7 days.
// The FIRMS MAP_KEY stays server-side (Vercel env var FIRMS_MAP_KEY) and is never sent to the browser.

const FIRMS = 'https://firms.modaps.eosdis.nasa.gov/api/area/csv';
const SOURCES = ['VIIRS_NOAA20_NRT', 'VIIRS_NOAA21_NRT', 'MODIS_NRT']; // S-NPP NRT ended 2026-11-02
const DAYS = 7;          // FIRMS allows max 5 days per request -> split into 5 + 2
const MAX_SPAN = 60;     // max bbox width/height in degrees (keeps responses small)

const isoDay = (d) => d.toISOString().slice(0, 10);

function send(res, status, body, cache = false) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  // Cache on Vercel's CDN for 15 min; serve stale up to 1 h while refreshing. FIRMS NRT updates every few hours.
  res.setHeader('Cache-Control', cache ? 'public, s-maxage=900, stale-while-revalidate=3600' : 'no-store');
  res.end(JSON.stringify(body));
}

function parseCsv(text, source) {
  const lines = text.trim().split('\n');
  if (!lines[0]?.startsWith('latitude')) throw new Error(`FIRMS ${source}: ${lines[0]?.slice(0, 120) || 'empty response'}`);
  const h = lines[0].split(',');
  const ix = (name) => h.indexOf(name);
  const [iLat, iLon, iDate, iTime, iSat, iConf, iFrp, iDn] =
    ['latitude', 'longitude', 'acq_date', 'acq_time', 'satellite', 'confidence', 'frp', 'daynight'].map(ix);
  const sensor = source.startsWith('MODIS') ? 'MODIS' : source.includes('NOAA21') ? 'NOAA-21' : 'NOAA-20';
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    if (c.length < h.length) continue;
    rows.push([+c[iLat], +c[iLon], c[iDate], c[iTime].padStart(4, '0'), sensor, c[iConf], +c[iFrp], c[iDn], c[iSat]]);
  }
  return rows;
}

export default async function handler(req, res) {
  const key = process.env.FIRMS_MAP_KEY;
  if (!key) return send(res, 500, { error: 'Server is missing FIRMS_MAP_KEY' });

  const q = new URL(req.url, 'http://localhost').searchParams;
  const b = (q.get('bbox') || '').split(',').map(Number);
  if (b.length !== 4 || b.some((v) => !Number.isFinite(v))) return send(res, 400, { error: 'bbox=w,s,e,n required' });
  const [w, s, e, n] = b;
  if (w >= e || s >= n || w < -180 || e > 180 || s < -90 || n > 90 || e - w > MAX_SPAN || n - s > MAX_SPAN) {
    return send(res, 400, { error: `Invalid bbox (max ${MAX_SPAN}° per side)` });
  }
  const area = [w, s, e, n].map((v) => +v.toFixed(2)).join(',');

  const today = new Date();
  const d = (back) => isoDay(new Date(today.getTime() - back * 86400000));
  const windows = [[5, d(4)], [2, d(6)]]; // [dayRange, startDate]: covers today-6 .. today (UTC)

  try {
    const jobs = SOURCES.flatMap((src) => windows.map(([range, start]) =>
      fetch(`${FIRMS}/${key}/${src}/${area}/${range}/${start}`, { signal: AbortSignal.timeout(20000) })
        .then((r) => r.text())
        .then((t) => parseCsv(t, src))));
    const parts = await Promise.all(jobs);
    const rows = parts.flat();
    return send(res, 200, {
      generated: new Date().toISOString(),
      from: d(6), to: d(0), bbox: area, sources: SOURCES,
      note: 'NASA FIRMS near-real-time active fire detections (not harmonised). Data: NASA LANCE FIRMS.',
      cols: ['lat', 'lon', 'date', 'time_utc', 'sensor', 'confidence', 'frp_mw', 'daynight', 'satellite'],
      rows,
    }, true);
  } catch (err) {
    // Never echo the request URL (it contains the key)
    return send(res, 502, { error: String(err.message || err).replace(key, '***') });
  }
}
