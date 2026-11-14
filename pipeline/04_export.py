"""Step 4: export harmonised data as small static files for the web app.

web/public/data/
  index.json            metadata + list of 1-deg tiles that contain data
  overview.json         0.25-deg total harmonised detections (map backdrop layer)
  tiles/{ty}_{tx}.json  per 1-deg tile: cells [cy, cx, ym[], harm[], modis[], snpp[], n20[]]
                        (cy, cx = floor(lat*10), floor(lon*10); ym = months since 2000-01)
The browser fetches only tiles overlapping the user's area and sums cells inside it.
"""
import json, os, shutil, datetime
import duckdb

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "data", "harmonised.parquet").replace("\\", "/")
WEB = os.path.join(ROOT, "web", "public", "data")
TILES = os.path.join(WEB, "tiles")


def main():
    con = duckdb.connect()
    df = con.execute(f"SELECT * FROM '{SRC}' ORDER BY cy, cx, ym").df()
    df["ty"], df["tx"] = df.cy // 10, df.cx // 10

    shutil.rmtree(TILES, ignore_errors=True)
    os.makedirs(TILES)
    tiles, total_bytes = [], 0
    for (ty, tx), t in df.groupby(["ty", "tx"], sort=False):
        cells = []
        for (cy, cx), c in t.groupby(["cy", "cx"], sort=False):
            cells.append([int(cy), int(cx), c.ym.astype(int).tolist(),
                          [round(float(v), 1) for v in c.harm],
                          c.modis.astype(int).tolist(), c.snpp.astype(int).tolist(), c.n20.astype(int).tolist()])
        path = os.path.join(TILES, f"{ty}_{tx}.json")
        with open(path, "w") as f:
            json.dump({"cells": cells}, f, separators=(",", ":"))
        total_bytes += os.path.getsize(path)
        tiles.append([int(ty), int(tx), round(float(t.harm.sum()))])

    ov = con.execute(f"""
        SELECT floor(cy / 2.5) AS qy, floor(cx / 2.5) AS qx, round(sum(harm)) AS h
        FROM '{SRC}' GROUP BY ALL HAVING sum(harm) >= 1 ORDER BY 1, 2""").fetchall()
    with open(os.path.join(WEB, "overview.json"), "w") as f:
        json.dump({"res": 0.25, "cells": [[int(a), int(b), int(h)] for a, b, h in ov]}, f, separators=(",", ":"))

    ym_max = int(df.ym.max())
    # source sensor per month (0 = MODIS scaled, 1 = S-NPP, 2 = NOAA-20 calibrated) — global per month
    src_by_ym = df.groupby("ym").src.max().reindex(range(10, ym_max + 1)).ffill().astype(int).tolist()
    last_day = con.execute("SELECT max(date) FROM 'data/fires.parquet'").fetchone()[0]
    index = {
        "generated": datetime.date.today().isoformat(),
        "region": "Australia",
        "cell_deg": 0.1, "tile_deg": 1,
        "ym_first": 10, "ym_last": ym_max,  # 2000-11 .. latest
        "last_detection_date": str(last_day),
        "partial_last_month": True,
        "unit": "VIIRS S-NPP-equivalent fire detections",
        "src_by_ym": src_by_ym,
        "tiles": tiles,
    }
    with open(os.path.join(WEB, "index.json"), "w") as f:
        json.dump(index, f, separators=(",", ":"))
    print(f"{len(tiles)} tiles, {total_bytes/1e6:.1f} MB total, overview {len(ov)} cells, last date {last_day}")


if __name__ == "__main__":
    os.chdir(ROOT)
    main()
