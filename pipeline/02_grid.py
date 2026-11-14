"""Step 2: aggregate quality-filtered detections to 0.1-degree cells x month, per sensor.

Filter: conf_ok (MODIS conf >= 30; VIIRS n/h) AND type == 0 (presumed vegetation fire).
        NRT rows have no `type`, so they are kept (they are < 2% of rows).
Output: data/grid_monthly.parquet  columns: cy, cx (int cell index = floor(deg*10)),
        ym (int months since 2000-01), modis, snpp, n20 (detection counts), frp_* sums
"""
import os, time
import duckdb

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "data", "fires.parquet").replace("\\", "/")
OUT = os.path.join(ROOT, "data", "grid_monthly.parquet").replace("\\", "/")

t0 = time.time()
con = duckdb.connect()
con.execute(f"""
COPY (
  SELECT CAST(floor(lat * 10) AS INTEGER) AS cy,
         CAST(floor(lon * 10) AS INTEGER) AS cx,
         CAST((year(date) - 2000) * 12 + month(date) - 1 AS SMALLINT) AS ym,
         count(*) FILTER (WHERE sensor = 'MODIS')        AS modis,
         count(*) FILTER (WHERE sensor = 'VIIRS_SNPP')   AS snpp,
         count(*) FILTER (WHERE sensor = 'VIIRS_NOAA20') AS n20,
         sum(frp) FILTER (WHERE sensor = 'MODIS')        AS frp_modis,
         sum(frp) FILTER (WHERE sensor = 'VIIRS_SNPP')   AS frp_snpp,
         sum(frp) FILTER (WHERE sensor = 'VIIRS_NOAA20') AS frp_n20
  FROM '{SRC}'
  WHERE conf_ok AND (type = 0 OR type IS NULL)
  GROUP BY ALL
) TO '{OUT}' (FORMAT parquet)
""")
print(f"wrote {OUT} in {time.time()-t0:.0f}s")
print(con.execute(f"""SELECT count(*) cell_months, count(DISTINCT cy*10000+cx) cells,
   sum(modis) modis, sum(snpp) snpp, sum(n20) n20,
   min(cy)/10 lat0, max(cy)/10 lat1, min(cx)/10 lon0, max(cx)/10 lon1 FROM '{OUT}'""").df().T)
