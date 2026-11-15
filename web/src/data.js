// Data loading + area aggregation. All files are static JSON produced by pipeline/04_export.py.
const BASE = `${import.meta.env.BASE_URL}data/`;
const tileCache = new Map();

export const SRC_NAMES = ['MODIS (scaled to VIIRS)', 'VIIRS S-NPP', 'VIIRS NOAA-20 (calibrated)'];
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export const ymYear = (ym) => 2000 + Math.floor(ym / 12);
export const ymMonth = (ym) => ym % 12; // 0-based
export const ymLabel = (ym) => `${MONTHS[ymMonth(ym)]} ${ymYear(ym)}`;

let indexPromise;
export function loadIndex() {
  indexPromise ??= fetch(`${BASE}index.json`).then((r) => r.json());
  return indexPromise;
}
export const loadOverview = () => fetch(`${BASE}overview.json`).then((r) => r.json());
export const loadValidation = () => fetch(`${BASE}validation.json`).then((r) => r.json());
export const loadFactors = () => fetch(`${BASE}factors.json`).then((r) => r.json());
export const loadTrust = () => fetch(`${BASE}trust.json`).then((r) => r.json());
export const loadSeam = () => fetch(`${BASE}seam.json`).then((r) => r.json());
export const TRUST = {
  good: { color: '#0072B2', label: 'Good: under 20% typical error' },
  caution: { color: '#E69F00', label: 'Caution: 20–40% error' },
  low: { color: '#CC79A7', label: 'Low: over 40% error' },
  sparse: { color: '#9a9a9a', label: 'Too few fires to judge' },
};

function loadTile(ty, tx) {
  const key = `${ty}_${tx}`;
  if (!tileCache.has(key)) {
    tileCache.set(key, fetch(`${BASE}tiles/${key}.json`).then((r) => r.json()));
  }
  return tileCache.get(key);
}

// Ray-casting point-in-polygon; poly = [[lat, lon], ...]
function inPoly(lat, lon, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [yi, xi] = poly[i], [yj, xj] = poly[j];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * Aggregate all 0.1° cells whose centre lies inside `area`.
 * area = { bbox: {s, n, w, e}, poly?: [[lat, lon], ...] }
 * Returns { ym0, ym1, harm[], modis[], snpp[], n20[], src[], cells, partialLast, lastDate }
 */
export async function aggregate(area) {
  const idx = await loadIndex();
  const { s, n, w, e } = area.bbox;
  const have = new Set(idx.tiles.map(([ty, tx]) => `${ty}_${tx}`));
  const jobs = [];
  for (let ty = Math.floor(s); ty <= Math.floor(n - 1e-9); ty++) {
    for (let tx = Math.floor(w); tx <= Math.floor(e - 1e-9); tx++) {
      if (have.has(`${ty}_${tx}`)) jobs.push(loadTile(ty, tx));
    }
  }
  const tiles = await Promise.all(jobs);
  const ym0 = idx.ym_first, ym1 = idx.ym_last, len = ym1 - ym0 + 1;
  const out = {
    ym0, ym1,
    harm: new Float64Array(len), modis: new Float64Array(len),
    snpp: new Float64Array(len), n20: new Float64Array(len),
    src: idx.src_by_ym, cells: 0, partialLast: idx.partial_last_month, lastDate: idx.last_detection_date,
    cellList: [],
  };
  for (const tile of tiles) {
    for (const [cy, cx, yms, h, m, sn, nn] of tile.cells) {
      const lat = (cy + 0.5) / 10, lon = (cx + 0.5) / 10;
      if (lat < s || lat > n || lon < w || lon > e) continue;
      if (area.poly && !inPoly(lat, lon, area.poly)) continue;
      out.cells++;
      out.cellList.push({ cy, cx, yms, h, m, sn, nn });
      for (let i = 0; i < yms.length; i++) {
        const k = yms[i] - ym0;
        if (k < 0 || k >= len) continue;
        out.harm[k] += h[i]; out.modis[k] += m[i]; out.snpp[k] += sn[i]; out.n20[k] += nn[i];
      }
    }
  }
  return out;
}

// Which months is a sensor actually operating? (null = no data, distinct from 0 = no fires)
export function available(series, ym) {
  if (series === 'snpp') return ym >= 12 * 12; // Jan 2012 (partial)
  if (series === 'n20') return ym >= 18 * 12 + 3;
  return true;
}

const csvHeader = (areaLabel, from, to, agg) => [
  `# Firewatch Analytics export — ${areaLabel.replace(/[\r\n,]/g, ' ')}`,
  `# Date range: ${ymLabel(from)} to ${ymLabel(to)}${to === agg.ym1 && agg.partialLast ? ` (last month partial, data to ${agg.lastDate})` : ''}`,
  '# harmonised = VIIRS S-NPP-equivalent fire detections (MODIS and NOAA-20 calibrated to S-NPP)',
  '# Data: NASA FIRMS MODIS C6.1, VIIRS S-NPP 375m, VIIRS NOAA-20 375m; type=0 vegetation fires; MODIS conf>=30, VIIRS nominal/high',
];

/** Monthly series for the area. `medians` = harmonised typical value per calendar month (full record). */
export function toCSV(agg, areaLabel, from, to, medians) {
  const rows = [
    ...csvHeader(areaLabel, from, to, agg),
    'year,month,harmonised,source,typical_harmonised_median,ratio_to_typical,modis_raw,viirs_snpp_raw,viirs_noaa20_raw',
  ];
  for (let ym = from; ym <= to; ym++) {
    const k = ym - agg.ym0;
    const med = medians[ymMonth(ym)].median;
    rows.push([
      ymYear(ym), ymMonth(ym) + 1, agg.harm[k].toFixed(1), SRC_NAMES[agg.src[k]],
      med.toFixed(1), ((agg.harm[k] + 1) / (med + 1)).toFixed(2),
      agg.modis[k], available('snpp', ym) ? agg.snpp[k] : '', available('n20', ym) ? agg.n20[k] : '',
    ].join(','));
  }
  return rows.join('\n');
}

/** One row per 0.1° cell in the area: totals over the date range + that cell's peak month. */
export function cellsCSV(agg, areaLabel, from, to) {
  const rows = [
    ...csvHeader(areaLabel, from, to, agg),
    'cell_lat_min,cell_lon_min,cell_lat_center,cell_lon_center,harmonised_total,modis_raw_total,viirs_snpp_raw_total,viirs_noaa20_raw_total,active_months,peak_month,peak_month_harmonised',
  ];
  const cells = [];
  for (const c of agg.cellList) {
    let h = 0, m = 0, s = 0, n = 0, act = 0, peak = null, pv = -1;
    for (let i = 0; i < c.yms.length; i++) {
      const ym = c.yms[i];
      if (ym < from || ym > to) continue;
      h += c.h[i]; m += c.m[i]; s += c.sn[i]; n += c.nn[i];
      if (c.h[i] > 0) act++;
      if (c.h[i] > pv) { pv = c.h[i]; peak = ym; }
    }
    if (h > 0 || m + s + n > 0) cells.push([c.cy / 10, c.cx / 10, (c.cy + 0.5) / 10, (c.cx + 0.5) / 10, h, m, s, n, act, peak, pv]);
  }
  cells.sort((a, b) => b[4] - a[4]);
  for (const r of cells) {
    rows.push([r[0].toFixed(1), r[1].toFixed(1), r[2].toFixed(2), r[3].toFixed(2), r[4].toFixed(1), r[5], r[6], r[7], r[8],
      r[9] == null ? '' : `${ymYear(r[9])}-${String(ymMonth(r[9]) + 1).padStart(2, '0')}`, r[10].toFixed(1)].join(','));
  }
  return rows.join('\n');
}
