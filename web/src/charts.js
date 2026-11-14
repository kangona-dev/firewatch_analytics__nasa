import * as d3 from 'd3';
import { MONTHS, SRC_NAMES, ymYear, ymMonth, ymLabel, available } from './data.js';

const tip = () => document.getElementById('tooltip');
export function showTip(evt, html) {
  const t = tip();
  t.innerHTML = html;
  t.hidden = false;
  const pad = 14, r = t.getBoundingClientRect();
  let x = evt.clientX + pad, y = evt.clientY + pad;
  if (x + r.width > innerWidth - 8) x = evt.clientX - r.width - pad;
  if (y + r.height > innerHeight - 8) y = evt.clientY - r.height - pad;
  t.style.left = `${x}px`;
  t.style.top = `${y}px`;
}
export const hideTip = () => { tip().hidden = true; };

const fmt = d3.format(',.0f');
export const fmtN = (v) => (v == null ? '—' : v < 10 && v > 0 ? v.toFixed(1) : fmt(v));
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// inferno without the near-black end, so low values stay visible on dark backgrounds
const fireRamp = (t) => d3.interpolateInferno(0.12 + 0.83 * t);
// colour-blind-safe diverging ramp (purple = below typical, orange = above)
const anomRamp = (t) => d3.interpolatePuOr(1 - t);

/** value of `series` at month index k, or null if that sensor did not exist yet */
export function valueAt(agg, series, k) {
  const ym = agg.ym0 + k;
  return available(series, ym) ? agg[series][k] : null;
}

/** median of the same calendar month across all available years (excluding the partial last month) */
export function monthlyMedians(agg, series) {
  const buckets = Array.from({ length: 12 }, () => []);
  const last = agg.partialLast ? agg.ym1 - 1 : agg.ym1;
  for (let ym = agg.ym0; ym <= last; ym++) {
    const v = valueAt(agg, series, ym - agg.ym0);
    if (v != null) buckets[ymMonth(ym)].push(v);
  }
  return buckets.map((b) => ({ median: d3.median(b) ?? 0, mean: d3.mean(b) ?? 0, min: d3.min(b) ?? 0, max: d3.max(b) ?? 0, n: b.length }));
}

const anomScore = (v, med) => Math.log2((v + 1) / (med + 1));

export function drawCalendar(el, legendEl, agg, { series, mode, selected, onSelect, from = agg.ym0, to = agg.ym1 }) {
  el.innerHTML = '';
  const y0 = ymYear(from), y1 = ymYear(to);
  const years = d3.range(y0, y1 + 1);
  const W = el.clientWidth || 800;
  const left = 44, top = 22, right = 70;
  const cw = Math.max(18, Math.min(56, (W - left - right) / 12));
  const ch = Math.max(14, Math.min(22, cw * 0.55));
  const width = left + cw * 12 + right, height = top + ch * years.length + 4;
  const meds = monthlyMedians(agg, series);

  let max = 1;
  const pos = [];
  for (let k = from - agg.ym0; k <= to - agg.ym0; k++) {
    const v = valueAt(agg, series, k) ?? 0;
    max = Math.max(max, v);
    if (v >= 0.5) pos.push(v);
  }
  // start the ramp at the 5th percentile of non-zero months so typical months use the full colour range
  const lo = Math.max(1, Math.min(max / 2, d3.quantile(pos.sort(d3.ascending), 0.05) ?? 1));
  const countScale = d3.scaleSequentialLog(fireRamp).domain([lo, Math.max(lo * 2, max)]).clamp(true);
  const anomScale = d3.scaleSequential(anomRamp).domain([-3, 3]).clamp(true);
  const zeroCol = css('--cell-zero'), naCol = css('--cell-na');

  const svg = d3.select(el).append('svg').attr('viewBox', `0 0 ${width} ${height}`).attr('width', width).attr('height', height)
    .attr('role', 'img').attr('aria-label', 'Calendar heatmap of monthly fire detections, years by months');

  svg.append('g').selectAll('text').data(MONTHS).join('text')
    .attr('x', (_, i) => left + i * cw + cw / 2).attr('y', top - 7).attr('text-anchor', 'middle').attr('class', 'axis-l').text((m) => (cw < 30 ? m[0] : m));
  svg.append('g').selectAll('text').data(years).join('text')
    .attr('x', left - 6).attr('y', (_, i) => top + i * ch + ch / 2 + 4).attr('text-anchor', 'end').attr('class', 'axis-l').text((y) => y);
  svg.append('text').attr('x', left + 12 * cw + 8).attr('y', top - 7).attr('class', 'axis-l').text('Year total');

  const cells = [];
  for (const y of years) for (let m = 0; m < 12; m++) {
    const ym = (y - 2000) * 12 + m, k = ym - agg.ym0;
    const inData = ym >= agg.ym0 && ym <= agg.ym1;
    const inRange = inData && ym >= from && ym <= to;
    const v = inRange ? valueAt(agg, series, k) : null;
    cells.push({ y, m, ym, k, v, inRange, inData });
  }

  const color = (d) => {
    if (d.v == null) return naCol;
    if (mode === 'anom') return anomScale(anomScore(d.v, meds[d.m].median));
    return d.v < 0.5 ? zeroCol : countScale(d.v);
  };

  svg.append('g').selectAll('rect').data(cells).join('rect')
    .attr('x', (d) => left + d.m * cw + 1).attr('y', (d) => top + (d.y - y0) * ch + 1)
    .attr('width', cw - 2).attr('height', ch - 2).attr('rx', 2)
    .attr('fill', color)
    .attr('class', (d) => `cal-cell${d.ym === selected ? ' sel' : ''}${d.inRange && agg.partialLast && d.ym === agg.ym1 ? ' partial' : ''}`)
    .style('cursor', (d) => (d.v != null ? 'pointer' : 'default'))
    .on('mousemove', (evt, d) => {
      if (!d.inData) return showTip(evt, `<b>${ymLabel(d.ym)}</b><br>${d.ym < agg.ym0 ? 'No satellite record (FIRMS MODIS starts Nov 2000)' : 'Not happened yet'}`);
      if (!d.inRange) return showTip(evt, `<b>${ymLabel(d.ym)}</b><br>Outside the selected date range`);
      if (d.v == null) return showTip(evt, `<b>${ymLabel(d.ym)}</b><br>This sensor was not operating yet`);
      const med = meds[d.m].median;
      const ratio = (d.v + 1) / (med + 1);
      const rows = [
        `<b>${ymLabel(d.ym)}</b>${agg.partialLast && d.ym === agg.ym1 ? ` <i>(to ${agg.lastDate})</i>` : ''}`,
        `<span class="tt-big">${fmtN(d.v)}</span> detections`,
        `Typical ${MONTHS[d.m]}: ${fmtN(med)} &nbsp;·&nbsp; <b>${ratio >= 1 ? ratio.toFixed(1) + '×' : Math.round(ratio * 100) + '%'}</b> of typical`,
      ];
      if (series === 'harm') {
        rows.push(`<span class="muted">Source: ${SRC_NAMES[agg.src[d.k]]}</span>`);
        rows.push(`<span class="muted">Raw — MODIS ${fmtN(agg.modis[d.k])}${available('snpp', d.ym) ? ` · S-NPP ${fmtN(agg.snpp[d.k])}` : ''}${available('n20', d.ym) ? ` · NOAA-20 ${fmtN(agg.n20[d.k])}` : ''}</span>`);
      }
      showTip(evt, rows.join('<br>'));
    })
    .on('mouseleave', hideTip)
    .on('click', (_, d) => d.v != null && onSelect(d.ym));

  // year totals
  const totals = years.map((y) => {
    let t = 0, any = false;
    for (let m = 0; m < 12; m++) {
      const ym = (y - 2000) * 12 + m;
      if (ym < from || ym > to) continue;
      const v = valueAt(agg, series, ym - agg.ym0);
      if (v != null) { t += v; any = true; }
    }
    return any ? t : null;
  });
  const tmax = d3.max(totals) || 1;
  const g = svg.append('g');
  g.selectAll('rect').data(totals).join('rect')
    .attr('x', left + 12 * cw + 6).attr('y', (_, i) => top + i * ch + 3)
    .attr('width', (t) => (t ? Math.max(1, (right - 10) * (t / tmax)) : 0)).attr('height', ch - 6)
    .attr('fill', css('--accent')).attr('opacity', 0.75)
    .on('mousemove', (evt, t) => t != null && showTip(evt, `<b>${years[totals.indexOf(t)]}</b><br>${fmtN(t)} detections in range`))
    .on('mouseleave', hideTip);

  drawLegend(legendEl, mode, lo, max);
}

function drawLegend(el, mode, lo, max) {
  el.innerHTML = '';
  const w = 260, h = 10;
  const svg = d3.select(el).append('svg').attr('width', w + 80).attr('height', 34);
  const id = `lg-${mode}`;
  const grad = svg.append('defs').append('linearGradient').attr('id', id);
  d3.range(0, 1.01, 0.1).forEach((t) => grad.append('stop').attr('offset', `${t * 100}%`)
    .attr('stop-color', mode === 'anom' ? anomRamp(t) : fireRamp(t)));
  svg.append('rect').attr('x', 10).attr('y', 4).attr('width', w).attr('height', h).attr('rx', 2).attr('fill', `url(#${id})`);
  const labels = mode === 'anom'
    ? [[0, '⅛× typical'], [0.5, 'typical'], [1, '8× typical']]
    : [[0, `≤ ${fmtN(lo)}`], [0.5, fmtN(Math.sqrt(lo * Math.max(lo * 2, max)))], [1, fmtN(max)]];
  svg.selectAll('text').data(labels).join('text').attr('x', (d) => 10 + d[0] * w).attr('y', 28)
    .attr('text-anchor', (d) => (d[0] === 0 ? 'start' : d[0] === 1 ? 'end' : 'middle')).attr('class', 'axis-l').text((d) => d[1]);
  const extra = d3.select(el).append('span').attr('class', 'legend-keys');
  extra.html(`<i class="sw" style="background:var(--cell-zero)"></i> no detections <i class="sw" style="background:var(--cell-na)"></i> no data${mode === 'count' ? ' &nbsp;· log scale' : ''}`);
}

/** Bar chart: the selected calendar month in every year, with the median line. */
export function drawAnomaly(el, titleEl, agg, { series, selected }) {
  el.innerHTML = '';
  const m = ymMonth(selected), ySel = ymYear(selected);
  const meds = monthlyMedians(agg, series);
  const data = [];
  for (let ym = m; ym <= agg.ym1; ym += 12) {
    if (ym < agg.ym0) continue;
    const v = valueAt(agg, series, ym - agg.ym0);
    if (v != null) data.push({ y: ymYear(ym), v, ym });
  }
  const v = valueAt(agg, series, selected - agg.ym0) ?? 0;
  const med = meds[m].median;
  const ratio = (v + 1) / (med + 1);
  const word = ratio >= 1.5 ? 'above' : ratio <= 0.67 ? 'below' : 'near';
  titleEl.innerHTML = `${ymLabel(selected)} vs every ${MONTHS[m]} on record`;

  const W = el.clientWidth || 400, H = 220, mg = { t: 34, r: 10, b: 24, l: 46 };
  const svg = d3.select(el).append('svg').attr('width', W).attr('height', H);
  const x = d3.scaleBand().domain(data.map((d) => d.y)).range([mg.l, W - mg.r]).padding(0.15);
  const y = d3.scaleLinear().domain([0, d3.max(data, (d) => d.v) || 1]).nice().range([H - mg.b, mg.t]);
  svg.append('g').attr('transform', `translate(0,${H - mg.b})`).attr('class', 'axis')
    .call(d3.axisBottom(x).tickValues(x.domain().filter((yy) => yy % 5 === 0)).tickSizeOuter(0));
  svg.append('g').attr('transform', `translate(${mg.l},0)`).attr('class', 'axis').call(d3.axisLeft(y).ticks(4, '~s'));
  svg.append('g').selectAll('rect').data(data).join('rect')
    .attr('x', (d) => x(d.y)).attr('width', x.bandwidth()).attr('y', (d) => y(d.v)).attr('height', (d) => y(0) - y(d.v))
    .attr('fill', (d) => (d.y === ySel ? css('--accent') : css('--bar-muted'))).attr('rx', 1)
    .on('mousemove', (evt, d) => showTip(evt, `<b>${MONTHS[m]} ${d.y}</b><br>${fmtN(d.v)} detections`)).on('mouseleave', hideTip);
  svg.append('line').attr('x1', mg.l).attr('x2', W - mg.r).attr('y1', y(med)).attr('y2', y(med))
    .attr('stroke', css('--fg')).attr('stroke-dasharray', '4 3').attr('opacity', 0.7);
  svg.append('text').attr('x', W - mg.r).attr('y', y(med) - 4).attr('text-anchor', 'end').attr('class', 'axis-l').text(`median ${fmtN(med)}`);
  svg.append('text').attr('x', mg.l).attr('y', 16).attr('class', 'callout')
    .text(`${fmtN(v)} detections — ${ratio >= 1 ? ratio.toFixed(1) + '×' : Math.round(ratio * 100) + '% of'} typical${W < 500 ? '' : ` (${word} normal)`}`);
}

/** Seasonal profile: min–max band, median, and the selected year. */
export function drawSeason(el, agg, { series, selected }) {
  el.innerHTML = '';
  const meds = monthlyMedians(agg, series);
  const ySel = ymYear(selected);
  const cur = d3.range(12).map((m) => {
    const ym = (ySel - 2000) * 12 + m;
    if (ym < agg.ym0 || ym > agg.ym1) return null;
    return valueAt(agg, series, ym - agg.ym0);
  });
  const W = el.clientWidth || 400, H = 220, mg = { t: 16, r: 10, b: 24, l: 46 };
  const svg = d3.select(el).append('svg').attr('width', W).attr('height', H);
  const x = d3.scalePoint().domain(d3.range(12)).range([mg.l, W - mg.r]).padding(0.3);
  const ymax = d3.max([...meds.map((d) => d.max), ...cur.filter((c) => c != null)]) || 1;
  const y = d3.scaleLinear().domain([0, ymax]).nice().range([H - mg.b, mg.t]);
  svg.append('g').attr('transform', `translate(0,${H - mg.b})`).attr('class', 'axis').call(d3.axisBottom(x).tickFormat((i) => MONTHS[i][0]));
  svg.append('g').attr('transform', `translate(${mg.l},0)`).attr('class', 'axis').call(d3.axisLeft(y).ticks(4, '~s'));
  svg.append('path').datum(meds).attr('fill', css('--bar-muted')).attr('opacity', 0.45)
    .attr('d', d3.area().x((_, i) => x(i)).y0((d) => y(d.min)).y1((d) => y(d.max)).curve(d3.curveMonotoneX));
  svg.append('path').datum(meds).attr('fill', 'none').attr('stroke', css('--fg')).attr('stroke-width', 1.5).attr('stroke-dasharray', '4 3')
    .attr('d', d3.line().x((_, i) => x(i)).y((d) => y(d.median)).curve(d3.curveMonotoneX));
  const curPts = cur.map((v, i) => ({ v, i })).filter((d) => d.v != null);
  svg.append('path').datum(curPts).attr('fill', 'none').attr('stroke', css('--accent')).attr('stroke-width', 2.5)
    .attr('d', d3.line().x((d) => x(d.i)).y((d) => y(d.v)).curve(d3.curveMonotoneX));
  svg.append('g').selectAll('circle').data(curPts).join('circle').attr('cx', (d) => x(d.i)).attr('cy', (d) => y(d.v)).attr('r', 3.5)
    .attr('fill', css('--accent'))
    .on('mousemove', (evt, d) => showTip(evt, `<b>${MONTHS[d.i]} ${ySel}</b>: ${fmtN(d.v)}<br>median ${fmtN(meds[d.i].median)} · range ${fmtN(meds[d.i].min)}–${fmtN(meds[d.i].max)}`))
    .on('mouseleave', hideTip);
  const lg = svg.append('g').attr('transform', `translate(${mg.l + 8},${mg.t + 4})`).attr('class', 'axis-l');
  lg.append('line').attr('x2', 16).attr('stroke', css('--accent')).attr('stroke-width', 2.5);
  lg.append('text').attr('x', 20).attr('y', 4).text(ySel);
  lg.append('line').attr('x1', 60).attr('x2', 76).attr('stroke', css('--fg')).attr('stroke-dasharray', '4 3');
  lg.append('text').attr('x', 80).attr('y', 4).text('median');
  lg.append('rect').attr('x', 130).attr('y', -5).attr('width', 14).attr('height', 10).attr('fill', css('--bar-muted')).attr('opacity', 0.6);
  lg.append('text').attr('x', 148).attr('y', 4).text('min–max');
}

/** Annual totals bars (within [from, to]), optional Theil–Sen trend line. */
export function drawAnnual(el, agg, { series, selected, onSelect, from = agg.ym0, to = agg.ym1, trend = null }) {
  el.innerHTML = '';
  const years = d3.range(ymYear(from), ymYear(to) + 1);
  const data = years.map((yy) => {
    let t = 0, n = 0;
    for (let m = 0; m < 12; m++) {
      const ym = (yy - 2000) * 12 + m;
      if (ym < from || ym > to) continue;
      const v = valueAt(agg, series, ym - agg.ym0);
      if (v != null) { t += v; n++; }
    }
    return { y: yy, t: n ? t : null, partial: n > 0 && n < 12 || (agg.partialLast && yy === ymYear(agg.ym1)) };
  });
  const W = el.clientWidth || 800, H = 200, mg = { t: 12, r: 10, b: 24, l: 50 };
  const svg = d3.select(el).append('svg').attr('width', W).attr('height', H);
  const x = d3.scaleBand().domain(years).range([mg.l, W - mg.r]).padding(0.15);
  const y = d3.scaleLinear().domain([0, d3.max(data, (d) => d.t) || 1]).nice().range([H - mg.b, mg.t]);
  svg.append('g').attr('transform', `translate(0,${H - mg.b})`).attr('class', 'axis')
    .call(d3.axisBottom(x).tickValues(years.filter((yy) => yy % (W < 600 ? 5 : years.length > 12 ? 2 : 1) === 0)).tickSizeOuter(0));
  svg.append('g').attr('transform', `translate(${mg.l},0)`).attr('class', 'axis').call(d3.axisLeft(y).ticks(4, '~s'));
  const ySel = ymYear(selected);
  svg.append('g').selectAll('rect').data(data.filter((d) => d.t != null)).join('rect')
    .attr('x', (d) => x(d.y)).attr('width', x.bandwidth()).attr('y', (d) => y(d.t)).attr('height', (d) => y(0) - y(d.t)).attr('rx', 1)
    .attr('fill', (d) => (d.y === ySel ? css('--accent') : css('--bar-muted')))
    .attr('opacity', (d) => (d.partial ? 0.5 : 1)).style('cursor', 'pointer')
    .on('mousemove', (evt, d) => showTip(evt, `<b>${d.y}</b>${d.partial ? ' (partial year)' : ''}<br>${fmtN(d.t)} detections`))
    .on('mouseleave', hideTip)
    .on('click', (_, d) => onSelect(Math.min(to, Math.max(from, (d.y - 2000) * 12 + ymMonth(selected)))));
  if (trend) {
    const ty = (yy) => trend.intercept + trend.slope * yy;
    const xc = (yy) => x(yy) + x.bandwidth() / 2;
    svg.append('line').attr('x1', xc(trend.y0)).attr('x2', xc(trend.y1)).attr('y1', y(Math.max(0, ty(trend.y0)))).attr('y2', y(Math.max(0, ty(trend.y1))))
      .attr('stroke', css('--fg')).attr('stroke-width', 2).attr('stroke-dasharray', '6 4').attr('opacity', 0.8);
  }
}
