"""Step 3: harmonise MODIS + VIIRS S-NPP + VIIRS NOAA-20 into one monthly series per 0.1-deg cell.

Reference unit: "VIIRS S-NPP-equivalent detections" (375 m, the longest VIIRS record).

  1. S-NPP is used directly in every month where it is complete.
  2. S-NPP outage months (national S-NPP/NOAA-20 ratio < OUTAGE_RATIO, e.g. safe-mode events,
     and after S-NPP ends) are filled with NOAA-20 x k_ns (calibrated NOAA-20 -> S-NPP factor).
  3. Months before S-NPP (Nov 2000 - Jan 2012) use MODIS x k_ms (calibrated MODIS -> S-NPP factor).

Calibration factors are ratios of totals over the overlap period, estimated hierarchically
(national -> 5-deg block -> 1-deg tile) with empirical-Bayes shrinkage:
      k_child = (sum V_child + LAMBDA * k_parent) / (sum M_child + LAMBDA)
so sparse tiles fall back to their region / the national ratio.

Validation: leave-one-year-out (2013-2025) — fit factors without year Y, predict S-NPP counts
from MODIS for year Y, compare with observed S-NPP. Compared against (a) no scaling and
(b) a single national factor.

Outputs: data/harmonised.parquet, web/public/data/validation.json
"""
import json, os
import numpy as np
import pandas as pd
import duckdb

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GRID = os.path.join(ROOT, "data", "grid_monthly.parquet")
OUT = os.path.join(ROOT, "data", "harmonised.parquet")
WEB = os.path.join(ROOT, "web", "public", "data")

LAMBDA = 100.0          # shrinkage strength, in MODIS (or NOAA-20) detections
OUTAGE_RATIO = 0.85     # national S-NPP/NOAA-20 below this => S-NPP month treated as incomplete
SNPP_START = 12 * 12 + 1  # 2012-02 (S-NPP archive starts 20 Jan 2012 -> Jan is partial)
N20_START = 18 * 12 + 3   # 2018-04
VAL_YEARS = range(2013, 2026)


def ym_label(ym):
    return f"{2000 + ym // 12}-{ym % 12 + 1:02d}"


def load():
    g = duckdb.connect().execute(f"SELECT cy, cx, ym, modis, snpp, n20 FROM '{GRID}'").df()
    g[["modis", "snpp", "n20"]] = g[["modis", "snpp", "n20"]].fillna(0).astype("float64")
    g["ym"] = g["ym"].astype(int)
    g["tile"] = (g.cy // 10).astype(str) + "_" + (g.cx // 10).astype(str)       # 1 deg
    g["block"] = (g.cy // 50).astype(str) + "_" + (g.cx // 50).astype(str)      # 5 deg
    g["year"] = 2000 + g.ym // 12
    return g


def snpp_good_months(g):
    nat = g.groupby("ym")[["snpp", "n20"]].sum()
    ratio = nat.snpp / nat.n20.replace(0, np.nan)
    good = pd.Series(False, index=range(g.ym.max() + 1))
    for ym in good.index:
        if ym < SNPP_START or ym not in nat.index or nat.loc[ym, "snpp"] == 0:
            continue
        r = ratio.get(ym, np.nan)
        good[ym] = np.isnan(r) or r >= OUTAGE_RATIO   # pre-NOAA-20: nothing to compare, trust S-NPP
    return good, ratio


def hier_factors(df, num, den):
    """Return (k_nat, k_block dict, k_tile dict) from a frame with tile/block/num/den columns."""
    k_nat = df[num].sum() / df[den].sum()
    b = df.groupby("block")[[num, den]].sum()
    k_block = ((b[num] + LAMBDA * k_nat) / (b[den] + LAMBDA)).to_dict()
    t = df.groupby(["tile", "block"])[[num, den]].sum().reset_index()
    t["k"] = (t[num] + LAMBDA * t.block.map(k_block)) / (t[den] + LAMBDA)
    return k_nat, k_block, dict(zip(t.tile, t.k))


def lookup(tiles, blocks, k_tile, k_block, k_nat):
    k = tiles.map(k_tile)
    k = k.fillna(blocks.map(k_block))
    return k.fillna(k_nat)


def metrics(obs, pred):
    obs, pred = np.asarray(obs, float), np.asarray(pred, float)
    ss_res = ((obs - pred) ** 2).sum()
    ss_tot = ((obs - obs.mean()) ** 2).sum()
    big = obs >= 50
    return {
        "r2": round(float(1 - ss_res / ss_tot), 3),
        "pearson_log": round(float(np.corrcoef(np.log1p(obs), np.log1p(pred))[0, 1]), 3),
        "bias_pct": round(float((pred.sum() - obs.sum()) / obs.sum() * 100), 1),
        "median_abs_pct_err": round(float(np.median(np.abs(pred[big] - obs[big]) / obs[big]) * 100), 1),
        "n": int(len(obs)),
    }


def validate(g, good):
    ov = g[g.ym.map(good) & g.year.isin(VAL_YEARS)]
    preds = {"none": [], "national": [], "regional": []}
    rows = []
    for y in VAL_YEARS:
        train, test = ov[ov.year != y], ov[ov.year == y]
        k_nat, k_block, k_tile = hier_factors(train, "snpp", "modis")
        # aggregate test to tile-month (the scale calibration operates on)
        tm = test.groupby(["tile", "block", "ym"])[["modis", "snpp"]].sum().reset_index()
        k = lookup(tm.tile, tm.block, k_tile, k_block, k_nat)
        tm["p_none"], tm["p_nat"], tm["p_reg"] = tm.modis, tm.modis * k_nat, tm.modis * k
        rows.append(tm)
    tm = pd.concat(rows)

    out = {}
    for scale, keys in {"tile_1deg_month": ["tile", "ym"], "block_5deg_month": ["block", "ym"],
                        "national_month": ["ym"]}.items():
        a = tm.groupby(keys)[["snpp", "p_none", "p_nat", "p_reg"]].sum()
        out[scale] = {
            "no_scaling": metrics(a.snpp, a.p_none),
            "national_factor": metrics(a.snpp, a.p_nat),
            "regional_factor": metrics(a.snpp, a.p_reg),
        }
    # per-year national totals (observed vs predicted, out-of-sample)
    yr = tm.assign(year=2000 + tm.ym // 12).groupby("year")[["snpp", "p_nat", "p_reg", "modis"]].sum()
    out["yearly_out_of_sample"] = [
        {"year": int(y), "snpp_observed": int(r.snpp), "modis_raw": int(r.modis),
         "pred_national": int(r.p_nat), "pred_regional": int(r.p_reg)} for y, r in yr.iterrows()]
    return out


def main():
    g = load()
    good, ns_ratio = snpp_good_months(g)
    outage = [ym_label(m) for m in good.index if m >= SNPP_START and not good[m]]
    print("S-NPP outage / missing months filled from NOAA-20:", outage)

    # --- calibration on all good overlap months ---
    ov_ms = g[g.ym.map(good)]
    kms_nat, kms_block, kms_tile = hier_factors(ov_ms, "snpp", "modis")
    ov_ns = g[g.ym.map(good) & (g.ym >= N20_START)]
    kns_nat, kns_block, kns_tile = hier_factors(ov_ns, "snpp", "n20")
    print(f"national MODIS->S-NPP k = {kms_nat:.3f}, NOAA-20->S-NPP k = {kns_nat:.3f}")

    g["k_ms"] = lookup(g.tile, g.block, kms_tile, kms_block, kms_nat)
    g["k_ns"] = lookup(g.tile, g.block, kns_tile, kns_block, kns_nat)

    is_good = g.ym.map(good)
    src = np.where(is_good, 1, np.where(g.ym >= N20_START, 2, 0))   # 0 MODIS, 1 S-NPP, 2 NOAA-20
    g["src"] = src
    g["harm"] = np.select([src == 1, src == 2], [g.snpp, g.n20 * g.k_ns], g.modis * g.k_ms)

    out_df = g[["cy", "cx", "ym", "modis", "snpp", "n20", "harm", "src", "k_ms", "k_ns"]]
    duckdb.connect().execute(f"COPY (SELECT * FROM out_df) TO '{OUT.replace(chr(92), '/')}' (FORMAT parquet)")
    print(f"wrote {OUT} ({len(g):,} cell-months)")

    # --- validation ---
    val = validate(g, good)
    for scale in ("tile_1deg_month", "block_5deg_month", "national_month"):
        print(scale, json.dumps(val[scale]))

    # --- NOAA-20 -> S-NPP validation (same LOYO idea, 2019-2025) ---
    rows = []
    for y in range(2019, 2026):
        tr, te = ov_ns[ov_ns.year != y], ov_ns[ov_ns.year == y]
        kn, kb, kt = hier_factors(tr, "snpp", "n20")
        tm = te.groupby(["tile", "block", "ym"])[["n20", "snpp"]].sum().reset_index()
        tm["p"] = tm.n20 * lookup(tm.tile, tm.block, kt, kb, kn)
        rows.append(tm)
    tm = pd.concat(rows)
    val["noaa20_to_snpp_tile_1deg_month"] = metrics(tm.snpp, tm.p)
    print("NOAA-20->S-NPP", val["noaa20_to_snpp_tile_1deg_month"])

    # --- national monthly series for the methodology chart ---
    nat = g.groupby("ym")[["modis", "snpp", "n20", "harm"]].sum()
    nat["modis_scaled"] = g.assign(x=g.modis * g.k_ms).groupby("ym").x.sum()
    nat = nat.reindex(range(10 * 1 + 0, g.ym.max() + 1)).fillna(0)
    nat = nat[nat.index >= 10]  # FIRMS MODIS archive starts 2000-11
    os.makedirs(WEB, exist_ok=True)
    validation = {
        "unit": "VIIRS S-NPP-equivalent fire detections",
        "lambda": LAMBDA, "outage_ratio_threshold": OUTAGE_RATIO,
        "k_modis_to_snpp_national": round(kms_nat, 4),
        "k_noaa20_to_snpp_national": round(kns_nat, 4),
        "k_modis_to_snpp_blocks": {k: round(v, 3) for k, v in kms_block.items()},
        "snpp_outage_months": outage,
        "validation": val,
        "national_monthly": {
            "ym0": int(nat.index[0]),
            **{c: [round(float(v), 1) for v in nat[c]] for c in ["modis", "snpp", "n20", "modis_scaled", "harm"]},
        },
    }
    with open(os.path.join(WEB, "validation.json"), "w") as f:
        json.dump(validation, f, separators=(",", ":"))
    print("wrote validation.json")


if __name__ == "__main__":
    main()
