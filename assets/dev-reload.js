/**
 * Local development auto-reload. No dependencies, no build step, no server
 * support needed - it just polls the files it cares about and reloads when one
 * changes on disk.
 *
 * Inert anywhere that is not localhost, so it costs the live site nothing but
 * the (cached) request for this file.
 */
(() => {
  const LOCAL = ['localhost', '127.0.0.1', '[::1]', ''];
  if (!LOCAL.includes(location.hostname)) return;

  const WATCH = ['index.html', 'assets/styles.css', 'assets/app.js', 'data/films.json', 'data/tmdb.json'];
  const INTERVAL = 1000;
  const stamps = new Map();
  let failures = 0;

  async function stampOf(path) {
    // Cache-bust so we see the file, not the browser's memory of it.
    const res = await fetch(`${path}?_=${Date.now()}`, { method: 'HEAD', cache: 'no-store' });
    if (!res.ok) return null;
    return res.headers.get('last-modified') ?? res.headers.get('etag') ?? String(res.headers.get('content-length'));
  }

  async function tick() {
    try {
      const results = await Promise.all(WATCH.map(async p => [p, await stampOf(p)]));
      failures = 0;
      let changed = null;
      for (const [path, stamp] of results) {
        if (stamp == null) continue;
        if (!stamps.has(path)) { stamps.set(path, stamp); continue; }
        if (stamps.get(path) !== stamp) { stamps.set(path, stamp); changed = path; }
      }
      if (changed) {
        console.log(`[dev-reload] ${changed} changed - reloading`);
        location.reload();
      }
    } catch {
      // Server stopped, or restarting. Back off rather than spamming the console.
      if (++failures === 1) console.warn('[dev-reload] server unreachable, still watching');
    }
  }

  setInterval(tick, INTERVAL);
  console.log('[dev-reload] watching', WATCH.join(', '));
})();
