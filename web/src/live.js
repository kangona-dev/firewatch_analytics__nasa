// Live layer: last 7 days of NASA FIRMS near-real-time detections via our /api/recent proxy.
import * as d3 from 'd3';
import { inPoly, MONTHS } from './data.js';
import { showTip, hideTip, fmtN } from './charts.js';

export const AGE_BINS = [
  { max: 24, label: 'last 24 h', color: '#a50f15' },
  { max: 72, label: '1–3 days', color: '#f16913' },
  { max: 168, label: '3–7 days', color: '#fdae6b' },
];
const SENSOR_COLORS = { 'NOAA-20': '#1c7ed6', 'NOAA-21': '#0ca678', MODIS: '#868e96' };
const K_N20_TO_SNPP = 1.02; // from our calibration (validation.json k_noaa20_to_snpp_national)

const cache = new Map();

/** Fetch live detections for an area (bbox rounded outward to 0.5° so the CDN cache is shared). */
export async function fetchLive(area) {
  const r = (v, f) => f(v * 2) / 2;
  const { s, n, w, e } = area.bbox;
  const bbox = [r(w, Math.floor), r(s, Math.floor), r(e, Math.ceil), r(n, Math.ceil)].join(',');
  if (!cache.has(bbox)) {
    cache.set(bbox, fetch(`/api/recent?bbox=${bbox}`).then(async (res) => {
      const j = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      if (!res.ok || j.error) throw new Error(j.error || `HTTP ${res.status}`);
      return j;
    }));
    cache.get(bbox).catch(() => cache.delete(bbox));
  }
  const data = await cache.get(bbox);
  const now = Date.now();
  const pts = [];
  for (const [lat, lon, date, time, sensor, conf, frp, dn, sat] of data.rows) {
    if (lat < s || lat > n || lon < w || lon > e) continue;
    if (area.poly && !inPoly(lat, lon, area.poly)) continue;
    const t = Date.parse(`${date}T${time.slice(0, 2)}:${time.slice(2)}:00Z`);
    const ageH = (now - t) / 3.6e6;
    // MODIS confidence is 0-100; VIIRS is l/n/h. "good" matches our pipeline filter.
    const good = sensor === 'MODIS' ? +conf >= 30 : conf === 'n' || conf === 'h';
    pts.push({ lat, lon, date, time, sensor, conf, frp, dn, sat, t, ageH, good });
  }
  pts.sort((a, b) => b.t - a.t);
  return { pts, from: data.from, to: data.to, generated: data.generated };
}

export const ageBin = (h) => AGE_BINS.find((b) => h < b.max) ?? AGE_BINS[2];

export function popupHtml(p) {
  const conf = p.sensor === 'MODIS' ? `${p.conf}%` : { l: 'low', n: 'nominal', h: 'high' }[p.conf] ?? p.conf;
  const ago = p.ageH < 1 ? 'under an hour' : p.ageH < 48 ? `${Math.round(p.ageH)} hours` : `${Math.round(p.ageH / 24)} days`;
  return `<b>Fire detection, ${ago} ago</b><br>${p.date} ${p.time.slice(0, 2)}:${p.time.slice(2)} UTC (${p.dn === 'D' ? 'day' : 'night'} pass)<br>` +
    `Satellite: ${p.sensor} · confidence ${conf}<br>Fire radiative power: ${p.frp} MW<br>` +
    `<span class="muted">${p.lat.toFixed(4)}, ${p.lon.toFixed(4)}</span>`;
}

/**
 * Render the "last 7 days" card.
 * typicalMonth = median harmonised detections for the current calendar month (S-NPP-equivalent units).
 */
export function renderLiveCard(el, live, { typicalMonth, monthIdx, onToggleMap, mapOn }) {
  const good = live.pts.filter((p) => p.good);
  const bySensor = d3.rollup(good, (v) => v.length, (p) => p.sensor);
  const n20 = bySensor.get('NOAA-20') ?? 0;
  const days = d3.utcDays(new Date(`${live.from}T00:00:00Z`), new Date(Date.parse(`${live.to}T00:00:00Z`) + 86400000))
    .map((d) => d.toISOString().slice(0, 10));
  // Compare NOAA-20 (one satellite, calibrated to S-NPP units) with a typical week for this month.
  const lastDataDay = good.length ? good[0].date : live.to;
  const nDays = days.filter((d) => d <= lastDataDay).length || 1;
  const dim = new Date(Date.UTC(2001, monthIdx + 1, 0)).getUTCDate();
  const typicalPeriod = (typicalMonth * nDays) / dim;
  const n20eq = n20 * K_N20_TO_SNPP;
  const ratio = (n20eq + 1) / (typicalPeriod + 1);
  const word = ratio >= 1.5 ? 'above' : ratio <= 0.67 ? 'below' : 'close to';
  const maxFrp = d3.greatest(good, (p) => p.frp);
  const latest = good[0];

  el.innerHTML = `
    <div class="live-top">
      <div class="live-num"><span class="live-dot"></span><b>${fmtN(good.length)}</b> fire detections in this area, ${live.from} → ${live.to}</div>
      <label class="live-toggle"><input type="checkbox" id="live-map-toggle" ${mapOn ? 'checked' : ''}> Show on map</label>
    </div>
    <div class="live-grid">
      <div class="live-chart" id="live-chart"></div>
      <div class="live-facts">
        <div class="ol-row"><span>Compared with a typical ${MONTHS[monthIdx]}</span><b>${good.length ? `${ratio >= 1 ? ratio.toFixed(1) + '×' : Math.round(ratio * 100) + '%'} (${word} normal)` : '—'}</b></div>
        <div class="ol-row"><span>By satellite</span><b>${['NOAA-20', 'NOAA-21', 'MODIS'].map((s) => `${s} ${fmtN(bySensor.get(s) ?? 0)}`).join(' · ')}</b></div>
        <div class="ol-row"><span>Latest detection</span><b>${latest ? `${latest.date} ${latest.time.slice(0, 2)}:${latest.time.slice(2)} UTC` : '—'}</b></div>
        <div class="ol-row"><span>Most intense</span><b>${maxFrp ? `${fmtN(maxFrp.frp)} MW (${maxFrp.date})` : '—'}</b></div>
        <p class="hint live-note">Near-real-time NASA FIRMS data, updated every few hours, nominal/high confidence only. Raw detections, not harmonised:
        several satellites can see the same fire, so the comparison uses NOAA-20 alone (calibrated to S-NPP, k = ${K_N20_TO_SNPP}) against a typical
        ${nDays}-day share of ${MONTHS[monthIdx]}. Near-real-time data has no vegetation filter, so a few industrial heat sources may be included.</p>
      </div>
    </div>`;
  document.getElementById('live-map-toggle').onchange = (e) => onToggleMap(e.target.checked);

  // stacked daily bars by satellite
  const box = document.getElementById('live-chart');
  const W = box.clientWidth || 360, H = 170, mg = { t: 22, r: 6, b: 22, l: 40 };
  const sensors = ['NOAA-20', 'NOAA-21', 'MODIS'];
  const rows = days.map((d) => {
    const r = { d };
    for (const s of sensors) r[s] = good.filter((p) => p.date === d && p.sensor === s).length;
    return r;
  });
  const stack = d3.stack().keys(sensors)(rows);
  const svg = d3.select(box).append('svg').attr('width', W).attr('height', H);
  const x = d3.scaleBand().domain(days).range([mg.l, W - mg.r]).padding(0.2);
  const y = d3.scaleLinear().domain([0, d3.max(rows, (r) => sensors.reduce((a, s) => a + r[s], 0)) || 1]).nice().range([H - mg.b, mg.t]);
  svg.append('g').attr('transform', `translate(0,${H - mg.b})`).attr('class', 'axis')
    .call(d3.axisBottom(x).tickFormat((d) => `${+d.slice(8)} ${MONTHS[+d.slice(5, 7) - 1]}`).tickSizeOuter(0));
  svg.append('g').attr('transform', `translate(${mg.l},0)`).attr('class', 'axis').call(d3.axisLeft(y).ticks(4, '~s'));
  svg.append('g').selectAll('g').data(stack).join('g').attr('fill', (s) => SENSOR_COLORS[s.key])
    .selectAll('rect').data((s) => s.map((v) => ({ v, key: s.key }))).join('rect')
    .attr('x', (d) => x(d.v.data.d)).attr('width', x.bandwidth())
    .attr('y', (d) => y(d.v[1])).attr('height', (d) => y(d.v[0]) - y(d.v[1]))
    .on('mousemove', (evt, d) => showTip(evt, `<b>${d.v.data.d}</b><br>${sensors.map((s) => `${s}: ${d.v.data[s]}`).join('<br>')}`))
    .on('mouseleave', hideTip);
  const lg = svg.append('g').attr('transform', `translate(${mg.l},10)`).attr('class', 'axis-l');
  sensors.forEach((s, i) => {
    lg.append('rect').attr('x', i * 78).attr('y', -7).attr('width', 10).attr('height', 10).attr('fill', SENSOR_COLORS[s]);
    lg.append('text').attr('x', i * 78 + 14).attr('y', 2).text(s);
  });
}

export function liveCSV(live, label) {
  const rows = [
    `# Firewatch Analytics — live NASA FIRMS near-real-time detections — ${label.replace(/[\r\n,]/g, ' ')}`,
    `# ${live.from} to ${live.to} (UTC). Sources: VIIRS NOAA-20 NRT, VIIRS NOAA-21 NRT, MODIS NRT. Raw detections, not harmonised.`,
    'latitude,longitude,acq_date,acq_time_utc,sensor,satellite,confidence,frp_mw,daynight,age_hours,passes_quality_filter',
    ...live.pts.map((p) => [p.lat, p.lon, p.date, p.time, p.sensor, p.sat, p.conf, p.frp, p.dn, p.ageH.toFixed(1), p.good].join(',')),
  ];
  return rows.join('\n');
}
