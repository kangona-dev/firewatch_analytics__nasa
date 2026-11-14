"""Step 1: ingest raw FIRMS CSVs (archive + NRT) into one clean Parquet file.

Input : data/raw/fire_{archive,nrt}_*.csv  (extracted from dataset/*.zip)
Output: data/fires.parquet  — one row per detection, harmonised schema:
        sensor (MODIS | VIIRS_SNPP | VIIRS_NOAA20), lat, lon, date, hhmm,
        conf_raw, conf_ok (bool, our quality filter), frp, daynight, type, source
"""
import glob, os, time
import duckdb

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "data", "raw")
OUT = os.path.join(ROOT, "data", "fires.parquet")

SENSORS = {"M-C61": "MODIS", "SV-C2": "VIIRS_SNPP", "J1V-C2": "VIIRS_NOAA20"}


def files(kind, tag):
    hits = glob.glob(os.path.join(RAW, f"fire_{kind}_{tag}_*.csv"))
    return hits[0].replace("\\", "/") if hits else None


def main():
    t0 = time.time()
    con = duckdb.connect()
    con.execute("PRAGMA threads=16")
    parts = []
    for tag, sensor in SENSORS.items():
        arc, nrt = files("archive", tag), files("nrt", tag)
        cols = "latitude, longitude, acq_date, acq_time, CAST(confidence AS VARCHAR) AS confidence, frp, daynight"
        parts.append(f"""
            SELECT '{sensor}' AS sensor, {cols}, CAST(type AS INTEGER) AS type, 'archive' AS source
            FROM read_csv('{arc}', header=true, all_varchar=false, types={{'confidence':'VARCHAR','acq_time':'VARCHAR'}})""")
        if nrt:
            # NRT has no `type` column; only keep dates after the archive ends (no double counting)
            parts.append(f"""
            SELECT '{sensor}' AS sensor, {cols}, NULL::INTEGER AS type, 'nrt' AS source
            FROM read_csv('{nrt}', header=true, types={{'confidence':'VARCHAR','acq_time':'VARCHAR'}})
            WHERE acq_date > (SELECT max(acq_date) FROM read_csv('{arc}', header=true, types={{'confidence':'VARCHAR','acq_time':'VARCHAR'}}))""")

    union = " UNION ALL ".join(parts)
    con.execute(f"""
        COPY (
          SELECT sensor,
                 CAST(latitude AS FLOAT)  AS lat,
                 CAST(longitude AS FLOAT) AS lon,
                 CAST(acq_date AS DATE)   AS date,
                 lpad(acq_time, 4, '0')   AS hhmm,
                 confidence               AS conf_raw,
                 CASE WHEN sensor = 'MODIS' THEN TRY_CAST(confidence AS INTEGER) >= 30
                      ELSE lower(confidence) IN ('n', 'h', 'nominal', 'high') END AS conf_ok,
                 CAST(frp AS FLOAT) AS frp,
                 daynight, type, source
          FROM ({union})
        ) TO '{OUT.replace(chr(92), '/')}' (FORMAT parquet, COMPRESSION zstd)
    """)
    print(f"wrote {OUT} in {time.time()-t0:.0f}s")
    print(con.execute(f"""
        SELECT sensor, source, count(*) n, min(date) d0, max(date) d1,
               round(avg(conf_ok::INT),3) frac_conf_ok,
               round(avg((type=0)::INT),3) frac_veg
        FROM '{OUT.replace(chr(92), '/')}' GROUP BY ALL ORDER BY 1,2""").df().to_string())


if __name__ == "__main__":
    main()
