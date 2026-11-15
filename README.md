# Firewatch Analytics

NASA Space Apps Challenge 2026: *Harmonization of MODIS and VIIRS Hot Spots*.

Harmonises 26 years of NASA FIRMS active-fire detections (MODIS C6.1, VIIRS S-NPP, VIIRS NOAA-20) over Australia
into one consistent monthly series per 0.1° cell, and shows a burning-activity calendar for any area you draw.

**Live app:** https://firewatch-analytics-nasa.vercel.app

## Key results (Australia)
- **Sensor break removed.** Naively joining raw MODIS to raw VIIRS creates a **×4.33 jump at 2012 (p = 0.001)**. After harmonisation
  the step is **×0.93 (p = 0.75)**, with no detectable break. Placebo tests at 2007 and 2018 (no sensor change) also show no break.
- **Out-of-sample accuracy.** Leave-one-year-out (2013–2025), 1° tile × month: regional factors R² 0.953, median absolute error 21.7%,
  vs 78.5% with no harmonisation.
- **Trust map.** Each 1° tile is rated by its out-of-sample error: 49% good (< 20%), 25% caution (20–40%), 6% low (> 40%),
  20% too few fires to judge.

## Layout
- `pipeline/`: Python (DuckDB + pandas) data pipeline, raw FIRMS CSVs → static JSON
- `web/`: static web app (Vite + Leaflet + D3), plus one serverless function (`web/api/recent.js`) for the live 7-day layer
- `web/public/data/`: pipeline output served to the browser (committed, ~20 MB)
- `dataset/`, `data/`: raw FIRMS downloads and intermediate files (gitignored, several GB)

## Rebuild the data
```bash
python -m venv .venv && .venv/Scripts/pip install -r pipeline/requirements.txt
mkdir -p data/raw && for f in dataset/*.zip; do unzip -o -j "$f" "*.csv" -d data/raw; done
.venv/Scripts/python pipeline/01_ingest.py      # → data/fires.parquet       (~30 s)
.venv/Scripts/python pipeline/02_grid.py        # → data/grid_monthly.parquet
.venv/Scripts/python pipeline/03_harmonise.py   # → data/harmonised.parquet + web/public/data/validation.json
.venv/Scripts/python pipeline/04_export.py      # → web/public/data/{index,overview}.json + tiles/
.venv/Scripts/python pipeline/05_trust_seam.py  # → web/public/data/{trust,seam}.json (trust map + 2012 seam test)
```
On Linux/macOS/WSL use `.venv/bin/` instead of `.venv/Scripts/`. Step 05 uses SciPy if installed (`pip install scipy`) for exact p-values.

## Run the web app
```bash
cd web && npm install && npm run dev    # http://localhost:5173
npm run build                           # → web/dist (static)
```

## Deploy (Vercel)
Import the repo in Vercel, set **Root Directory = `web`** (Vite is auto-detected; build `npm run build`, output `dist`).

## Live layer & secrets
`web/api/recent.js` is a Vercel serverless function (`GET /api/recent?bbox=w,s,e,n`) that proxies the
NASA FIRMS area API for the last 7 days of near-real-time detections (VIIRS NOAA-20, NOAA-21, MODIS).
It needs `FIRMS_MAP_KEY`:
- **On Vercel:** Project → Settings → Environment Variables → `FIRMS_MAP_KEY`.
- **Locally:** put it in the repo-root `.env` (gitignored, see `.env.example`). `npm run dev` / `npm run preview`
  serve `/api/recent` through a small Vite plugin (`web/vite.config.js`).

The key is only used server-side. It is never sent to the browser or included in the built JS.
Responses are cached on Vercel's CDN for 15 minutes.

## Data & credits
**NASA data** (via NASA FIRMS, https://firms.modaps.eosdis.nasa.gov/, archive + near-real-time downloads for Australia):
- MODIS Collection 6.1 active fires, Terra + Aqua (MCD14ML), Nov 2000 →
- VIIRS 375 m active fires, Suomi NPP (VNP14IMG), Jan 2012 → 2 Nov 2026
- VIIRS 375 m active fires, NOAA-20 (VJ114IMG), Apr 2018 →

**Methods literature**
- Giglio, L., Schroeder, W. & Justice, C. O. (2016). The collection 6 MODIS active fire detection algorithm and fire products. *Remote Sensing of Environment*, 178, 31–41.
- Schroeder, W., Oliva, P., Giglio, L. & Csiszar, I. A. (2014). The New VIIRS 375 m active fire detection data product: Algorithm description and initial assessment. *Remote Sensing of Environment*, 143, 85–96.
- Fu, Y., Li, R., Wang, X., Bergeron, Y., Valeria, O., Chavardès, R. D., Wang, Y. & Hu, J. (2020). Fire Detection and Fire Radiative Power in Forests and Low-Biomass Lands in Northeast Asia: MODIS versus VIIRS Fire Products. *Remote Sensing*, 12(18), 2870.

**Software:** DuckDB, pandas, NumPy, SciPy, Vite, D3, Leaflet, Leaflet.draw. Base map © OpenStreetMap contributors.

**AI use:** built with assistance from Claude Code and Claude (Anthropic). All results were run and checked by the team.

**Disclaimer:** decision support for planning and research, not a safety-of-life warning system. Hotspots are satellite-detected hot pixels, not individual fires or burned area.

## Team & licence
Divyanshu Mishra and Kangona Sinha. MIT licence (see `LICENSE`).
