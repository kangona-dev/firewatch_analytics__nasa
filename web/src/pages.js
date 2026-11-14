import * as d3 from 'd3';
import L from 'leaflet';
import { loadValidation, loadFactors } from './data.js';
import { showTip, hideTip, fmtN } from './charts.js';

const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
let methodDone = false, aboutDone = false;

export async function renderMethod(el) {
  if (methodDone) return;
  methodDone = true;
  const v = await loadValidation();
  const val = v.validation;
  const row = (label, m) => `<tr><td>${label}</td><td>${m.r2.toFixed(3)}</td><td>${m.pearson_log.toFixed(3)}</td><td>${m.bias_pct > 0 ? '+' : ''}${m.bias_pct}%</td><td>${m.median_abs_pct_err}%</td><td>${m.n.toLocaleString()}</td></tr>`;
  const table = (scale, title) => `
    <h4>${title}</h4>
    <div class="tbl-wrap"><table>
      <thead><tr><th>Model</th><th>R²</th><th>r (log)</th><th>Bias</th><th>Median abs. error*</th><th>n</th></tr></thead>
      <tbody>
        ${row('No harmonisation (raw MODIS)', val[scale].no_scaling)}
        ${row('Single national factor', val[scale].national_factor)}
        <tr class="best">${row('Regional factors (ours)', val[scale].regional_factor).slice(4, -5)}</tr>
      </tbody>
    </table></div>`;

  el.innerHTML = `
  <h1>Method &amp; validation</h1>
  <p class="lede">Three NASA satellites have watched Australian fires for 26 years, but they don't see the same fires. MODIS (1 km pixels, since 2000)
  misses small fires that VIIRS (375 m pixels, since 2012) detects, so a naive time series shows a fake <b>~${v.k_modis_to_snpp_national.toFixed(1)}× jump</b> in 2012.
  We put all three sensors on one scale, so 2001 can be compared fairly with 2019.</p>

  <div class="card"><h3>Australia-wide annual detections, by sensor</h3><div id="m-chart"></div>
  <p class="hint">Raw MODIS (grey) sits far below VIIRS. After scaling, MODIS (dashed) lines up with VIIRS S-NPP over the 2012–2025 overlap, which gives one continuous series back to 2000.</p></div>

  <div class="card factor-card">
    <h3>Where MODIS misses the most fires: the regional factor <i>k</i></h3>
    <p class="hint">Each square is 1°×1° (about 110 km). Its colour is how many VIIRS detections there are for every MODIS detection, fitted over 2012–2025.
    Higher <i>k</i> means more small fires that MODIS's 1 km pixels miss. Faded squares have little fire data of their own and lean on their regional value. Hover over a square for details.</p>
    <div class="factor-wrap"><div id="factor-map"></div><div id="factor-legend" class="factor-legend"></div></div>
    <p class="hint" id="factor-summary"></p>
  </div>

  <h2>Pipeline</h2>
  <ol>
    <li><b>Data.</b> NASA FIRMS archive + near-real-time hotspots for Australia: MODIS Collection 6.1 (Terra + Aqua, Nov 2000 →), VIIRS S-NPP 375 m (Jan 2012 → 2 Nov 2026), VIIRS NOAA-20 375 m (Apr 2018 →). In total, 34.7 million detections.</li>
    <li><b>Quality filter.</b> Keep only <code>type = 0</code> (presumed vegetation fire, excluding volcanoes, industrial heat and offshore flares); MODIS confidence ≥ 30; VIIRS confidence nominal or high.</li>
    <li><b>Gridding.</b> Count detections per 0.1° cell (~11 km) per month, separately for each sensor.</li>
    <li><b>Reference scale.</b> We use VIIRS S-NPP as the reference, because it is the longest high-resolution record. Every value is in <i>VIIRS S-NPP-equivalent detections</i>.</li>
    <li><b>MODIS → VIIRS.</b> For each region, we compute the ratio of total S-NPP to total MODIS detections over 2012–2025. The ratio varies across Australia (≈3.2× in the arid interior, ≈6× in eastern forests, where small fires are common), so one national number is not enough.
      Ratios are estimated hierarchically (national → 5° block → 1° tile) with shrinkage:
      <code>k = (ΣVIIRS + λ·k<sub>parent</sub>) / (ΣMODIS + λ)</code>, λ = ${v.lambda}. That way, tiles with few fires fall back to their regional value instead of producing noisy estimates.</li>
    <li><b>VIIRS continuity.</b> NOAA-20 is calibrated to S-NPP in the same way (national k = ${v.k_noaa20_to_snpp_national.toFixed(3)}). In months where S-NPP was in safe mode or had stopped (S-NPP/NOAA-20 below ${v.outage_ratio_threshold} nationally:
      ${v.snpp_outage_months.join(', ')}), we fill the gap with calibrated NOAA-20 instead of showing a fake drop.</li>
    <li><b>Harmonised series.</b> Nov 2000 – Jan 2012: MODIS × k. Feb 2012 →: S-NPP, with NOAA-20 × k in outage months and after S-NPP ends.</li>
  </ol>

  <h2>Validation</h2>
  <p>Leave-one-year-out cross-validation, 2013–2025. For each year Y, we fit the factors <i>without</i> Y, predict that year's S-NPP counts from MODIS alone, and compare against what S-NPP actually saw. Every number below is out-of-sample.</p>
  ${table('tile_1deg_month', '1° tile × month (~110 km squares)')}
  ${table('block_5deg_month', '5° region × month')}
  ${table('national_month', 'All of Australia × month')}
  <p class="hint">*Median absolute % error over cells/months with at least 50 observed detections. NOAA-20 → S-NPP gap-fill, 1° tile × month: R² ${val.noaa20_to_snpp_tile_1deg_month.r2}, median error ${val.noaa20_to_snpp_tile_1deg_month.median_abs_pct_err}%.</p>

  <h4>Out-of-sample yearly totals (Australia)</h4>
  <div class="tbl-wrap"><table><thead><tr><th>Year</th><th>S-NPP observed</th><th>Raw MODIS</th><th>Predicted (national k)</th><th>Predicted (regional k)</th><th>Error</th></tr></thead><tbody>
  ${val.yearly_out_of_sample.map((r) => `<tr><td>${r.year}</td><td>${fmtN(r.snpp_observed)}</td><td>${fmtN(r.modis_raw)}</td><td>${fmtN(r.pred_national)}</td><td>${fmtN(r.pred_regional)}</td><td>${(((r.pred_regional - r.snpp_observed) / r.snpp_observed) * 100).toFixed(1)}%</td></tr>`).join('')}
  </tbody></table></div>

  <h2>Limitations</h2>
  <ul>
    <li>Detection counts are a proxy for fire activity, not burned area. One large fire can produce many detections, and cloud or smoke can hide fires from both sensors.</li>
    <li>Overpass times differ (MODIS ~10:30/13:30, VIIRS ~13:30). Fires that burn mostly at night or in the morning are under-sampled differently by each sensor. The regional factors absorb the average effect, not the variation from one month to the next.</li>
    <li>Near-real-time data (Aug 2026 onward) has no <code>type</code> flag, so a few industrial or other static hot sources may be included. It will be replaced by archive data as FIRMS reprocesses it.</li>
    <li>The latest month is partial. FIRMS data in this build runs to the date shown on the Explore page.</li>
  </ul>`;

  drawSensorChart(document.getElementById('m-chart'), v.national_monthly);
  drawFactorMap(await loadFactors());
}

function drawFactorMap(fx) {
  const lo = 2.5, hi = 7;
  const color = d3.scaleSequential(d3.interpolateViridis).domain([lo, hi]).clamp(true);
  const map = L.map('factor-map', { zoomSnap: 0.25, scrollWheelZoom: false, minZoom: 3, maxBounds: [[-50, 100], [0, 170]] })
    .fitBounds([[-44, 112], [-10, 154]]);
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 10, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  const renderer = L.canvas({ padding: 0.2 });
  for (const [ty, tx, k, m, s, w] of fx.tiles) {
    L.rectangle([[ty, tx], [ty + 1, tx + 1]], {
      renderer, stroke: false, fillColor: color(k), fillOpacity: 0.3 + 0.6 * w,
    }).bindTooltip(
      `<b>${Math.abs(ty + 1)}–${Math.abs(ty)}°S,${tx}–${tx + 1}°E</b><br>k = <b>${k.toFixed(2)}</b> VIIRS per MODIS detection<br>` +
      `Overlap data: ${fmtN(m)} MODIS · ${fmtN(s)} VIIRS<br>` +
      `<span class="muted">${Math.round(w * 100)}% own data, ${Math.round((1 - w) * 100)}% regional fallback</span>`,
      { sticky: true, className: 'factor-tt' },
    ).addTo(map);
  }
  // legend
  const el = document.getElementById('factor-legend');
  const w = 220, svg = d3.select(el).append('svg').attr('width', w + 20).attr('height', 46);
  const grad = svg.append('defs').append('linearGradient').attr('id', 'k-grad');
  d3.range(0, 1.01, 0.1).forEach((t) => grad.append('stop').attr('offset', `${t * 100}%`).attr('stop-color', color(lo + t * (hi - lo))));
  svg.append('text').attr('x', 10).attr('y', 11).attr('class', 'axis-l').text('k (VIIRS ÷ MODIS)');
  svg.append('rect').attr('x', 10).attr('y', 16).attr('width', w).attr('height', 10).attr('rx', 2).attr('fill', 'url(#k-grad)');
  const x = d3.scaleLinear().domain([lo, hi]).range([10, 10 + w]);
  svg.append('line').attr('x1', x(fx.k_national)).attr('x2', x(fx.k_national)).attr('y1', 13).attr('y2', 29).attr('stroke', css('--fg')).attr('stroke-width', 2);
  svg.selectAll('text.t').data([lo, fx.k_national, hi]).join('text').attr('class', 'axis-l t')
    .attr('x', (d) => x(d)).attr('y', 42).attr('text-anchor', (d, i) => (i === 0 ? 'start' : i === 2 ? 'end' : 'middle'))
    .text((d, i) => (i === 1 ? `national ${d.toFixed(1)}` : i === 0 ? `≤ ${d}` : `≥ ${d}`));

  const ks = fx.tiles.map((t) => t[2]).sort(d3.ascending);
  const strong = fx.tiles.filter((t) => t[5] > 0.5).length;
  const p10 = d3.quantile(ks, 0.1), p90 = d3.quantile(ks, 0.9);
  const over = Math.round((fx.k_national / p10 - 1) * 100), under = Math.round((1 - fx.k_national / p90) * 100);
  document.getElementById('factor-summary').innerHTML =
    `${fx.tiles.length} tiles. The middle 80% of tiles range from <b>${p10.toFixed(1)}×</b> to <b>${p90.toFixed(1)}×</b>, ` +
    `so a single national factor (${fx.k_national.toFixed(1)}×) would over-count pre-2012 fire in low-<i>k</i> regions by ~${over}% and under-count it in high-<i>k</i> regions by ~${under}%. ` +
    `${strong} tiles are mostly fitted from their own data; the rest borrow strength from their 5° region (shrinkage, λ = ${fx.lambda}).`;
}

function drawSensorChart(el, nm) {
  const years = new Map();
  const add = (k, i, val) => {
    const y = 2000 + Math.floor((nm.ym0 + i) / 12);
    if (!years.has(y)) years.set(y, { y, modis: 0, snpp: 0, n20: 0, modis_scaled: 0, harm: 0, n: 0 });
    years.get(y)[k] += val;
  };
  for (const k of ['modis', 'snpp', 'n20', 'modis_scaled', 'harm']) nm[k].forEach((val, i) => add(k, i, val));
  const data = [...years.values()].filter((d) => d.y >= 2001 && d.y <= 2025);
  const series = [
    { k: 'modis', name: 'MODIS raw', color: css('--bar-muted'), from: 2001 },
    { k: 'modis_scaled', name: 'MODIS × regional k', color: css('--accent'), dash: '5 4', from: 2001 },
    { k: 'snpp', name: 'VIIRS S-NPP', color: '#1c7ed6', from: 2012 },
    { k: 'n20', name: 'VIIRS NOAA-20', color: '#0ca678', from: 2019 },
  ];
  const W = el.clientWidth || 800, H = 300, mg = { t: 30, r: 16, b: 26, l: 56 };
  const svg = d3.select(el).append('svg').attr('width', W).attr('height', H);
  const x = d3.scaleLinear().domain([2001, 2025]).range([mg.l, W - mg.r]);
  const y = d3.scaleLinear().domain([0, d3.max(data, (d) => Math.max(d.snpp, d.modis_scaled))]).nice().range([H - mg.b, mg.t]);
  svg.append('rect').attr('x', x(2012)).attr('width', x(2025) - x(2012)).attr('y', mg.t).attr('height', H - mg.t - mg.b).attr('fill', css('--bar-muted')).attr('opacity', 0.12);
  svg.append('text').attr('x', x(2012) + 6).attr('y', mg.t + 12).attr('class', 'axis-l').text('overlap: calibration & validation period');
  svg.append('g').attr('transform', `translate(0,${H - mg.b})`).attr('class', 'axis').call(d3.axisBottom(x).tickFormat(d3.format('d')).ticks(12));
  svg.append('g').attr('transform', `translate(${mg.l},0)`).attr('class', 'axis').call(d3.axisLeft(y).ticks(5, '~s'));
  for (const s of series) {
    const pts = data.filter((d) => d.y >= s.from);
    svg.append('path').datum(pts).attr('fill', 'none').attr('stroke', s.color).attr('stroke-width', 2.2).attr('stroke-dasharray', s.dash ?? null)
      .attr('d', d3.line().x((d) => x(d.y)).y((d) => y(d[s.k])));
    svg.append('g').selectAll('circle').data(pts).join('circle').attr('cx', (d) => x(d.y)).attr('cy', (d) => y(d[s.k])).attr('r', 3).attr('fill', s.color)
      .on('mousemove', (evt, d) => showTip(evt, `<b>${d.y}</b><br>${series.map((ss) => (d.y >= ss.from ? `${ss.name}: ${fmtN(d[ss.k])}` : '')).filter(Boolean).join('<br>')}`))
      .on('mouseleave', hideTip);
  }
  const lg = svg.append('g').attr('transform', `translate(${mg.l},12)`).attr('class', 'axis-l');
  let off = 0;
  for (const s of series) {
    lg.append('line').attr('x1', off).attr('x2', off + 18).attr('stroke', s.color).attr('stroke-width', 2.2).attr('stroke-dasharray', s.dash ?? null);
    lg.append('text').attr('x', off + 22).attr('y', 4).text(s.name);
    off += 30 + s.name.length * 6.2;
  }
}

export function renderAbout(el) {
  if (aboutDone) return;
  aboutDone = true;
  el.innerHTML = `
  <h1>About</h1>
  <p class="lede">Firewatch Analytics answers a simple question for any patch of Australia: <b>when does it burn, and is this year unusual?</b>
  It joins 26 years of NASA satellite fire detections into one consistent record and shows it as a calendar you can read at a glance.</p>
  <h2>Who it's for</h2>
  <p>Emergency and early-warning teams, land and park managers, firefighters and researchers who need to know whether a place is in its usual fire season or something unusual is happening.</p>
  <h2>How to use it</h2>
  <ol>
    <li><b>Choose an area.</b> Pick a preset, draw a rectangle, polygon or circle on the map, or type a point with a radius or a bounding box.</li>
    <li><b>Choose a date range</b> (or a quick range such as the last 10 years). Totals, records, the trend, the calendar and the downloads all follow it.</li>
    <li><b>Read the calendar.</b> Each row is a year and each column is a month, and brighter means more fire. Switch to <i>Anomaly</i> to see which months were unusual for that time of year, or switch to a single raw sensor to see the problem harmonisation solves.</li>
    <li><b>Check the season outlook.</b> For the current month and the next three, it shows what is typical, how often that month has been severe, and how the current month is tracking. It is based only on the historical record, not on a weather forecast.</li>
    <li><b>Click any month</b> to compare it with the same month in every other year.</li>
    <li><b>Download</b> the monthly series or per-cell totals as CSV, and any chart as a PNG.</li>
    <li><b>Share the URL.</b> It keeps your area and date range.</li>
  </ol>
  <h2>What the numbers mean</h2>
  <ul>
    <li><b>Detections</b> are satellite hotspot pixels (active fire), counted per month in VIIRS S-NPP-equivalent units. They show how much burning there was, not the area burned.</li>
    <li><b>Typical</b> is the median of that calendar month across all years on record.</li>
    <li><b>Trend</b> is the Theil–Sen slope of annual totals (as % of the median year per year), tested with the Mann–Kendall test. It is only shown with 8 or more complete years.</li>
    <li><b>Severe month</b> means above this area's 90th-percentile month.</li>
  </ul>
  <h2>Challenge</h2>
  <p>NASA Space Apps Challenge 2026: <i>Harmonization of MODIS and VIIRS Hot Spots</i>.</p>
  <h2>Data &amp; references</h2>
  <ul>
    <li>NASA FIRMS (Fire Information for Resource Management System), <a href="https://firms.modaps.eosdis.nasa.gov/" target="_blank" rel="noopener">firms.modaps.eosdis.nasa.gov</a>: MODIS Collection 6.1 (MCD14), VIIRS S-NPP 375 m (VNP14IMG), VIIRS NOAA-20 375 m (VJ114IMG) active fire archive and NRT products. We acknowledge the use of data and imagery from LANCE FIRMS operated by NASA's Earth Science Data and Information System (ESDIS).</li>
    <li>Giglio, L., Schroeder, W., Justice, C.O. (2016). The collection 6 MODIS active fire detection algorithm and fire products. <i>Remote Sensing of Environment</i>, 178, 31–41.</li>
    <li>Schroeder, W., Oliva, P., Giglio, L., Csiszar, I. (2014). The New VIIRS 375 m active fire detection data product: Algorithm description and initial assessment. <i>Remote Sensing of Environment</i>, 143, 85–96.</li>
    <li>Sen, P.K. (1968). Estimates of the regression coefficient based on Kendall's tau. <i>Journal of the American Statistical Association</i>, 63(324), 1379–1389. Mann, H.B. (1945). Nonparametric tests against trend. <i>Econometrica</i>, 13(3), 245–259.</li>
    <li>Base map © OpenStreetMap contributors. Libraries: Leaflet, Leaflet.draw, D3.js, Vite; pipeline: Python, pandas, DuckDB.</li>
  </ul>
  <h2>AI disclosure</h2>
  <p>This project was built with assistance from Claude Code (Anthropic), which was used for code generation, data-pipeline design and documentation. The team reviewed, tested and directed all of the work.</p>
  <h2>Licence</h2>
  <p>Code: MIT licence, © 2026 Divyanshu Mishra and Kangona Sinha. FIRMS data is distributed by NASA under its open data policy.</p>`;
}
