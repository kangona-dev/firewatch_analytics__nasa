import * as d3 from 'd3';
import { ymYear, ymMonth } from './data.js';
import { valueAt, monthlyMedians } from './charts.js';

/** Annual totals for complete years inside [from, to] (all 12 months available for this series). */
export function completeYears(agg, series, from, to) {
  const out = [];
  const last = agg.partialLast ? agg.ym1 - 1 : agg.ym1;
  for (let y = ymYear(from); y <= ymYear(to); y++) {
    const a = (y - 2000) * 12, b = a + 11;
    if (a < from || b > to || a < agg.ym0 || b > last) continue;
    let t = 0, ok = true;
    for (let ym = a; ym <= b; ym++) {
      const v = valueAt(agg, series, ym - agg.ym0);
      if (v == null) { ok = false; break; }
      t += v;
    }
    if (ok) out.push({ y, t });
  }
  return out;
}

// Standard normal CDF (Abramowitz–Stegun 7.1.26 erf approximation, |err| < 1.5e-7)
function phi(z) {
  const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(z * z) / 2);
  return z >= 0 ? 0.5 * (1 + erf) : 0.5 * (1 - erf);
}

/**
 * Theil–Sen slope + Mann–Kendall trend test on annual totals.
 * Returns { n, slope (detections/yr), pctPerYear (vs median annual total), p, intercept, years } or null.
 */
export function trend(points) {
  const n = points.length;
  if (n < 8) return null;
  const slopes = [];
  let S = 0;
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    slopes.push((points[j].t - points[i].t) / (points[j].y - points[i].y));
    S += Math.sign(points[j].t - points[i].t);
  }
  const slope = d3.median(slopes);
  const medT = d3.median(points, (p) => p.t);
  const medY = d3.median(points, (p) => p.y);
  // tie-corrected variance
  const ties = d3.rollup(points, (v) => v.length, (p) => p.t);
  let tieSum = 0;
  for (const c of ties.values()) if (c > 1) tieSum += c * (c - 1) * (2 * c + 5);
  const varS = (n * (n - 1) * (2 * n + 5) - tieSum) / 18;
  const Z = S === 0 ? 0 : (S - Math.sign(S)) / Math.sqrt(varS);
  const p = 2 * (1 - phi(Math.abs(Z)));
  return {
    n, slope, p, pctPerYear: medT > 0 ? (slope / medT) * 100 : 0,
    intercept: medT - slope * medY, y0: points[0].y, y1: points[n - 1].y,
  };
}

/**
 * Season outlook from climatology: for the in-progress month and the next 3 months,
 * how active is that calendar month historically, and how often is it a high-activity month?
 * "High activity" = above the area's 90th percentile of all complete months on record.
 */
export function outlook(agg, series) {
  const meds = monthlyMedians(agg, series);
  const last = agg.partialLast ? agg.ym1 - 1 : agg.ym1;
  const all = [];
  for (let ym = agg.ym0; ym <= last; ym++) {
    const v = valueAt(agg, series, ym - agg.ym0);
    if (v != null) all.push(v);
  }
  all.sort(d3.ascending);
  const high = Math.max(1, d3.quantile(all, 0.9) ?? 1);

  const byMonth = (m) => {
    const vals = [];
    for (let ym = m; ym <= last; ym += 12) {
      if (ym < agg.ym0) continue;
      const v = valueAt(agg, series, ym - agg.ym0);
      if (v != null) vals.push({ y: ymYear(ym), v });
    }
    const sorted = vals.map((d) => d.v).sort(d3.ascending);
    const top = d3.greatest(vals, (d) => d.v);
    const nHigh = vals.filter((d) => d.v >= high).length;
    return {
      m, n: vals.length,
      median: meds[m].median,
      p25: d3.quantile(sorted, 0.25) ?? 0, p75: d3.quantile(sorted, 0.75) ?? 0,
      top, pHigh: vals.length ? nHigh / vals.length : 0, nHigh,
    };
  };

  const months = [];
  const startYm = agg.partialLast ? agg.ym1 : agg.ym1 + 1;
  for (let ym = startYm; ym < startYm + 4; ym++) months.push({ ym, ...byMonth(ymMonth(ym)) });

  // the in-progress month: value so far and pace
  let current = null;
  if (agg.partialLast) {
    const d = new Date(`${agg.lastDate}T00:00:00Z`);
    const day = d.getUTCDate();
    const dim = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
    const soFar = valueAt(agg, series, agg.ym1 - agg.ym0) ?? 0;
    current = { day, dim, soFar, pace: soFar * (dim / day) };
  }

  // recent conditions: last 3 complete months vs their typical values
  let rSum = 0, mSum = 0;
  const recent = [];
  for (let ym = last - 2; ym <= last; ym++) {
    const v = valueAt(agg, series, ym - agg.ym0) ?? 0;
    rSum += v; mSum += meds[ymMonth(ym)].median;
    recent.push(ym);
  }
  return { months, current, high, recent: { from: recent[0], to: recent[2], ratio: (rSum + 1) / (mSum + 1), v: rSum, typical: mSum } };
}

export const level = (p) => (p >= 0.4 ? 'high' : p >= 0.15 ? 'moderate' : 'low');

/**
 * Critical period: the shortest run of consecutive calendar months (wrapping Dec→Jan) that holds
 * at least `share` of a typical year's fire, using the mean detections per calendar month over the
 * full record. Returns { start, len, months[], pct } or { diffuse: true } when fire is spread across
 * 8+ months (no distinct season), or null when the area has almost no fire.
 */
export function criticalPeriod(agg, series = 'harm', share = 0.7) {
  const means = monthlyMedians(agg, series).map((d) => d.mean);
  const total = d3.sum(means);
  if (total < 12) return null; // under ~1 detection a month on average
  let best = null;
  for (let len = 1; len <= 12 && !best; len++) {
    for (let start = 0; start < 12; start++) {
      let s = 0;
      for (let i = 0; i < len; i++) s += means[(start + i) % 12];
      if (s / total >= share && (!best || s > best.sum)) best = { start, len, sum: s };
    }
  }
  if (best.len >= 8) return { diffuse: true, len: best.len };
  const months = d3.range(best.len).map((i) => (best.start + i) % 12);
  return { start: best.start, len: best.len, months, pct: Math.round((best.sum / total) * 100) };
}
