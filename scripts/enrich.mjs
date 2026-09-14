/**
 * Enriches the Letterboxd film database with TMDB metadata and poster paths.
 *
 *   TMDB_API_KEY=... node scripts/enrich.mjs
 *   TMDB_API_KEY=... node scripts/enrich.mjs --retry-unmatched
 *
 * data/films.json is the Letterboxd truth and is rewritten wholesale by
 * sync.mjs. This writes a separate data/tmdb.json keyed by Letterboxd slug, so
 * the two never fight: a re-sync cannot wipe TMDB data, and this script cannot
 * corrupt the list.
 *
 * Lookups are cached. A film already resolved is never queried again, so the
 * daily run costs a handful of requests for whatever is new rather than 122.
 *
 * Films that cannot be matched confidently are recorded in `unmatched` with the
 * candidates that were considered, and retried on later runs. To settle one by
 * hand, put its TMDB id in data/tmdb-overrides.json:
 *
 *   { "some-letterboxd-slug": 12345 }
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createClient, chooseMatch, summarize } from './tmdb.mjs';

const FILMS = new URL('../data/films.json', import.meta.url);
const OUT = new URL('../data/tmdb.json', import.meta.url);
const OVERRIDES = new URL('../data/tmdb-overrides.json', import.meta.url);

const RETRY_UNMATCHED = process.argv.includes('--retry-unmatched');
const CONCURRENCY = 4;

async function readJson(url, fallback) {
  try {
    return JSON.parse(await readFile(url, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw new Error(`${url.pathname.split('/').pop()} will not parse: ${err.message}`);
  }
}

/** Runs tasks with a fixed number in flight, preserving input order. */
async function pooled(items, limit, worker) {
  const out = new Array(items.length);
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}

async function main() {
  const key = process.env.TMDB_API_KEY;
  if (!key) {
    // Locally, skipping is a convenience. In CI it is a misconfiguration: the
    // step exists to fetch this data, so passing silently would let a green
    // run hide the fact that nothing happened.
    if (process.env.CI) {
      console.error('TMDB_API_KEY is empty or unset in CI. Add it at Settings > Secrets and variables > Actions.');
      process.exit(1);
    }
    console.warn('TMDB_API_KEY is not set - skipping enrichment, leaving data/tmdb.json untouched.');
    return;
  }

  const db = await readJson(FILMS, null);
  if (!db?.years?.length) {
    console.error('data/films.json is missing or empty. Run scripts/sync.mjs first.');
    process.exit(1);
  }

  const cache = await readJson(OUT, { films: {}, unmatched: {} });
  const overrides = await readJson(OVERRIDES, {});
  const client = createClient(key);

  // One entry per film, even when it appears in more than one year's list.
  const bySlug = new Map();
  for (const y of db.years) {
    for (const f of y.films) if (f.slug && !bySlug.has(f.slug)) bySlug.set(f.slug, f);
  }
  const films = [...bySlug.values()];

  const needsLookup = films.filter(f => {
    if (overrides[f.slug] && cache.films?.[f.slug]?.tmdbId !== overrides[f.slug]) return true;
    if (cache.films?.[f.slug]) {
      // One-time backfill: entries resolved before genres/countries/cast/
      // imdbUrl were tracked are missing the field entirely (as opposed to
      // holding an empty array or null, which means TMDB genuinely had
      // nothing there), so re-fetch just those.
      return !('genres' in cache.films[f.slug])
        || !('countries' in cache.films[f.slug])
        || !('cast' in cache.films[f.slug])
        || !('imdbUrl' in cache.films[f.slug]);
    }
    if (cache.unmatched?.[f.slug] && !RETRY_UNMATCHED) return false;
    return true;
  });

  console.log(`${films.length} films known, ${needsLookup.length} to look up`);
  if (cache.unmatched && Object.keys(cache.unmatched).length && !RETRY_UNMATCHED) {
    console.log(`${Object.keys(cache.unmatched).length} previously unmatched (use --retry-unmatched to try again)`);
  }

  const resolved = { ...(cache.films ?? {}) };
  const unmatched = { ...(cache.unmatched ?? {}) };
  let failures = 0;

  await pooled(needsLookup, CONCURRENCY, async film => {
    try {
      let details;
      let confidence;

      if (overrides[film.slug]) {
        details = await client.details(overrides[film.slug]);
        confidence = 'manual-override';
      } else {
        const results = await client.search(film.title, film.year);
        const { match, reason, candidates } = chooseMatch(film, results);
        if (!match) {
          delete resolved[film.slug];
          unmatched[film.slug] = {
            title: film.title,
            year: film.year,
            reason,
            candidates: (candidates ?? []).map(c => ({
              tmdbId: c.id, title: c.title, releaseDate: c.release_date || null,
            })),
          };
          console.warn(`  unmatched: ${film.title} (${film.year ?? '?'}) — ${reason}`);
          return;
        }
        details = await client.details(match.id);
        confidence = match.confidence ?? confidence;
      }

      delete unmatched[film.slug];
      resolved[film.slug] = {
        ...summarize(details),
        letterboxdTitle: film.title,
        letterboxdYear: film.year,
        confidence: confidence ?? 'exact',
      };
      console.log(`  ${film.title} (${film.year ?? '?'}) -> tmdb ${details.id}`);
    } catch (err) {
      failures++;
      console.error(`  error: ${film.title} — ${err.message}`);
    }
  });

  // films.json is complete-or-failed by construction, so anything not in it is
  // genuinely gone from the lists.
  const live = new Set(films.map(f => f.slug));
  for (const slug of Object.keys(resolved)) if (!live.has(slug)) delete resolved[slug];
  for (const slug of Object.keys(unmatched)) if (!live.has(slug)) delete unmatched[slug];

  if (failures) {
    console.error(`\n${failures} lookup(s) errored. Not writing; rerun once TMDB is reachable.`);
    process.exit(1);
  }

  const out = {
    generatedAt: new Date().toISOString(),
    note: 'This product uses the TMDB API but is not endorsed or certified by TMDB.',
    imageBase: 'https://image.tmdb.org/t/p',
    matched: Object.keys(resolved).length,
    unmatchedCount: Object.keys(unmatched).length,
    films: Object.fromEntries(Object.entries(resolved).sort(([a], [b]) => a.localeCompare(b))),
    unmatched: Object.fromEntries(Object.entries(unmatched).sort(([a], [b]) => a.localeCompare(b))),
  };

  const stable = o => JSON.stringify({ ...o, generatedAt: null }, null, 2);
  if (stable(out) === stable(cache)) {
    console.log('\nNo change.');
    return;
  }

  await mkdir(new URL('../data/', import.meta.url), { recursive: true });
  await writeFile(OUT, JSON.stringify(out, null, 2) + '\n');
  console.log(`\nWrote data/tmdb.json — ${out.matched} matched, ${out.unmatchedCount} unmatched`);
}

main().catch(err => { console.error(err); process.exit(1); });
