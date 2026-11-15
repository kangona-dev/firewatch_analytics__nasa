import { defineConfig, loadEnv } from 'vite';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

// Runs /api/* serverless functions inside `vite dev` / `vite preview` so the live layer works locally.
// On Vercel the same files in web/api/ are deployed as serverless functions.
function localApi() {
  const mount = (server) => {
    server.middlewares.use('/api/recent', async (req, res) => {
      try {
        const url = pathToFileURL(path.join(here, 'api', 'recent.js')).href;
        const { default: handler } = await import(/* @vite-ignore */ `${url}?t=${Date.now()}`);
        req.url = req.originalUrl ?? req.url;
        await handler(req, res);
      } catch (err) {
        res.statusCode = 500;
        res.end(JSON.stringify({ error: `local api: ${err.message}` }));
      }
    });
  };
  return { name: 'local-api', configureServer: mount, configurePreviewServer: mount };
}

export default defineConfig(({ mode }) => {
  // Server-side only: read FIRMS_MAP_KEY from the repo-root .env for the local API.
  // It is NOT exposed to browser code (Vite only exposes VITE_* variables).
  const env = loadEnv(mode, path.resolve(here, '..'), '');
  if (env.FIRMS_MAP_KEY && !process.env.FIRMS_MAP_KEY) process.env.FIRMS_MAP_KEY = env.FIRMS_MAP_KEY;
  return {
    build: { target: 'es2022' },
    plugins: [localApi()],
  };
});
