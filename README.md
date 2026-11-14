# Firewatch Analytics

NASA Space Apps Challenge 2026: *Harmonization of MODIS and VIIRS Hot Spots*.

Harmonises 26 years of NASA FIRMS active-fire detections (MODIS C6.1, VIIRS S-NPP, VIIRS NOAA-20) over Australia
into one consistent monthly series per 0.1° cell, and shows a burning-activity calendar for any area you draw.

## Layout
- `pipeline/`: Python (DuckDB + pandas) data pipeline, raw FIRMS CSVs → static JSON
- `web/`: static web app (Vite + Leaflet + D3), with no backend
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
```

## Run the web app
```bash
cd web && npm install && npm run dev    # http://localhost:5173
npm run build                           # → web/dist (static)
```

## Deploy (Vercel)
Import the repo in Vercel, set **Root Directory = `web`** (Vite is auto-detected; build `npm run build`, output `dist`).

## Secrets
`FIRMS_MAP_KEY` lives in `.env` (gitignored). See `.env.example`. The static site does not use it.

## Data & credits
NASA FIRMS, https://firms.modaps.eosdis.nasa.gov/. Base map © OpenStreetMap contributors.
Built with assistance from Claude Code (Anthropic).

## Team & licence
Divyanshu Mishra and Kangona Sinha. MIT licence (see `LICENSE`).
