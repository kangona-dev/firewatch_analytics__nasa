"""Step 5: trust map, uncertainty multipliers and the 2012 seam test.

Reads  : data/grid_monthly.parquet   (from 02_grid.py; does not modify any other step)
Writes : web/public/data/trust.json  per 1-deg tile: out-of-sample error, 90% band, trust class
         web/public/data/seam.json   national step test at the MODIS -> VIIRS switch, raw vs harmonised

Method (matches 03_harmonise.py):
  * Calibration factor k = S-NPP / MODIS, estimated hierarchically (national -> 5-deg block -> 1-deg tile)
    with empirical-Bayes shrinkage  k_child = (sum V + LAMBDA * k_parent) / (sum M + LAMBDA).
  * Trust: leave-one-year-out 2013-2025. For each held-out year, refit k without it, predict that
    year's S-NPP total per tile from MODIS, and record the log error r = log(observed / predicted).
      err    = median |predicted/observed - 1|     (typical error of a harmonised pre-2012 year)
      lo/hi  = exp(5th / 95th percentile of r)     (multipliers for a 90% band on MODIS-era values)
      class  = good (<20%), caution (20-40%), low (>40%), sparse (too few detections to judge)
  * Seam test: national annual totals, 5 years each side of the switch (2007-11 vs 2013-17, 2012 skipped
    as the transition year). Welch t-test on log totals for the naive join (MODIS then S-NPP) and for
    the harmonised series (MODIS x k then S-NPP). Placebo tests at switches that never happened.
"""
import json, math, os
import numpy as np
import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GRID = os.path.join(ROOT, "data", "grid_monthly.parquet").replace("\\", "/")
WEB = os.path.join(ROOT, "web", "public", "data")

LAMBDA = 100.0
OUTAGE_RATIO = 0.85
SNPP_START = 12 * 12 + 1     # 2012-02
SNPP_END = 26 * 12 + 10      # 2026-11 (S-NPP stops 2 Nov 2026; exclude that month on)
VAL_YEARS = list(range(2013, 2026))
MIN_OBS_PER_YEAR = 50        # tiles averaging fewer S-NPP detections per year are "sparse"


def load():
    import duckdb
    g = duckdb.connect().execute(f"SELECT cy, cx, ym, modis, snpp, n20 FROM '{GRID}'").df()
    return prep(g)


def prep(g):
    g = g.copy()
    g[["modis", "snpp", "n20"]] = g[["modis", "snpp", "n20"]].fillna(0).astype("float64")
    g["ym"] = g["ym"].astype(int)
    g["tile"] = (g.cy // 10).astype(str) + "_" + (g.cx // 10).astype(str)
    g["block"] = (g.cy // 50).astype(str) + "_" + (g.cx // 50).astype(str)
    g["year"] = 2000 + g.ym // 12
    return g


def overlap_months(g):
    """Months where S-NPP is complete: after its start, before its end, and not an outage month."""
    nat = g.groupby("ym")[["snpp", "n20"]].sum()
    outage = nat.index[(nat.n20 > 0) & (nat.snpp < OUTAGE_RATIO * nat.n20)]
    ok = (g.ym >= SNPP_START) & (g.ym < SNPP_END) & ~g.ym.isin(outage)
    return g[ok]


def fit_k(ov):
    """Hierarchical shrunk ratio S-NPP / MODIS. Returns dict tile -> k."""
    k_nat = ov.snpp.sum() / max(ov.modis.sum(), 1.0)
    b = ov.groupby("block")[["snpp", "modis"]].sum()
    k_block = (b.snpp + LAMBDA * k_nat) / (b.modis + LAMBDA)
    t = ov.groupby(["tile", "block"])[["snpp", "modis"]].sum().reset_index()
    kb = t.block.map(k_block).fillna(k_nat)
    t["k"] = (t.snpp + LAMBDA * kb) / (t.modis + LAMBDA)
    return dict(zip(t.tile, t.k)), k_nat


def trust_map(g):
    ov = overlap_months(g)
    rows = []
    for y in VAL_YEARS:
        k_tile, k_nat = fit_k(ov[ov.year != y])
        test = ov[ov.year == y].groupby("tile")[["snpp", "modis"]].sum()
        test = test[test.snpp > 0]
        pred = test.modis * test.index.map(lambda t: k_tile.get(t, k_nat)).to_numpy()
        rows.append(pd.DataFrame({"tile": test.index, "year": y, "obs": test.snpp.to_numpy(),
                                  "pred": pred.to_numpy()}))
    r = pd.concat(rows, ignore_index=True)
    r = r[r.pred > 0]
    r["logr"] = np.log(r.obs / r.pred)
    r["abs_rel"] = (r.pred / r.obs - 1).abs()

    out = []
    for tile, d in r.groupby("tile"):
        cy, cx = (int(v) for v in tile.split("_"))
        mean_obs = d.obs.sum() / len(VAL_YEARS)
        err = float(d.abs_rel.median())
        if mean_obs < MIN_OBS_PER_YEAR or len(d) < 5:
            cls = "sparse"
        elif err < 0.20:
            cls = "good"
        elif err < 0.40:
            cls = "caution"
        else:
            cls = "low"
        out.append({"tile": tile, "lat0": cy, "lon0": cx,
                    "err": round(err, 3),
                    "lo": round(float(np.exp(d.logr.quantile(0.05))), 3),
                    "hi": round(float(np.exp(d.logr.quantile(0.95))), 3),
                    "years": int(len(d)), "mean_obs": round(float(mean_obs), 1), "class": cls})
    summary = pd.Series([o["class"] for o in out]).value_counts().to_dict()
    return {"method": "leave-one-year-out 2013-2025, annual totals per 1-deg tile",
            "classes": {"good": "<20% typical error", "caution": "20-40%", "low": ">40%",
                        "sparse": f"< {MIN_OBS_PER_YEAR} S-NPP detections/yr or < 5 test years"},
            "band_note": "lo/hi multiply harmonised MODIS-era (pre-Feb 2012) values for a 90% band; "
                         "S-NPP months are observed, not modelled",
            "summary": {k: int(v) for k, v in summary.items()},
            "tiles": out}


def welch(a, b):
    """Welch t-test on two samples; returns (t, two-sided p)."""
    a, b = np.asarray(a, float), np.asarray(b, float)
    va, vb = a.var(ddof=1) / len(a), b.var(ddof=1) / len(b)
    t = (b.mean() - a.mean()) / math.sqrt(va + vb)
    df = (va + vb) ** 2 / (va ** 2 / (len(a) - 1) + vb ** 2 / (len(b) - 1))
    try:
        from scipy import stats
        p = 2 * stats.t.sf(abs(t), df)
    except ImportError:
        p = math.erfc(abs(t) / math.sqrt(2))   # normal approximation
    return float(t), float(p)


def step(series, before, after):
    a = np.log(series.loc[before].to_numpy())
    b = np.log(series.loc[after].to_numpy())
    t, p = welch(a, b)
    return {"before": f"{before[0]}-{before[-1]}", "after": f"{after[0]}-{after[-1]}",
            "step_factor": round(float(np.exp(b.mean() - a.mean())), 2),
            "t": round(t, 2), "p": round(p, 4), "significant": bool(p < 0.05)}


def seam_test(g):
    k_tile, k_nat = fit_k(overlap_months(g))
    g = g.assign(k=g.tile.map(k_tile).fillna(k_nat))
    pre = g.ym < SNPP_START
    raw = np.where(pre, g.modis, g.snpp)
    harm = np.where(pre, g.modis * g.k, g.snpp)
    annual = pd.DataFrame({"year": g.year, "raw": raw, "harm": harm}).groupby("year").sum()

    seam_b, seam_a = list(range(2007, 2012)), list(range(2013, 2018))
    res = {"note": "National annual totals, Welch t-test on log values. 2012 skipped (transition year).",
           "seam_2012": {"raw": step(annual.raw, seam_b, seam_a),
                         "harmonised": step(annual.harm, seam_b, seam_a)},
           "placebo": {"2007 (MODIS only)": step(annual.harm, list(range(2002, 2007)), list(range(2007, 2012))),
                       "2018 (VIIRS only)": step(annual.harm, list(range(2013, 2018)), list(range(2018, 2023)))},
           "annual": [{"year": int(y), "raw": round(float(r.raw)), "harmonised": round(float(r.harm))}
                      for y, r in annual.iterrows() if 2001 <= y <= 2025]}
    return res


def main():
    g = load()
    trust = trust_map(g)
    seam = seam_test(g)
    os.makedirs(WEB, exist_ok=True)
    with open(os.path.join(WEB, "trust.json"), "w") as f:
        json.dump(trust, f, separators=(",", ":"))
    with open(os.path.join(WEB, "seam.json"), "w") as f:
        json.dump(seam, f, indent=1)
    print("trust classes:", trust["summary"])
    for name, s in seam["seam_2012"].items():
        print(f"2012 seam, {name:10s}: x{s['step_factor']}  p={s['p']}  significant={s['significant']}")
    for name, s in seam["placebo"].items():
        print(f"placebo {name}: x{s['step_factor']}  p={s['p']}")


if __name__ == "__main__":
    main()
