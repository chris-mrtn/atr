/**
 * Backfills each film's IMDb rating into data/tmdb.json, alongside the rest
 * of the metadata scripts/enrich.mjs already puts there.
 *
 *   OMDB_API_KEY=... node scripts/imdb-ratings.mjs
 *
 * Runs after scripts/enrich.mjs (that's what resolves each film's imdbId in
 * the first place). Lookups are cached the same way enrich.mjs caches its
 * own: a film that already has a numeric rating is never queried again. A
 * film OMDb has no rating for yet (imdbRating: null - too new, or too
 * obscure to have votes) is retried on later runs rather than treated as
 * settled, since that can genuinely change over time.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { createClient } from './omdb.mjs';

const TMDB = new URL('../data/tmdb.json', import.meta.url);
const CONCURRENCY = 4;

/** Runs tasks with a fixed number in flight. */
async function pooled(items, limit, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      await worker(items[cursor++]);
    }
  });
  await Promise.all(runners);
}

/** Older cache entries were resolved before imdbId was stored explicitly -
 *  it's still recoverable from imdbUrl for those. */
function imdbIdOf(meta) {
  return meta.imdbId ?? meta.imdbUrl?.match(/\/title\/(tt\d+)\/?/)?.[1] ?? null;
}

async function main() {
  const key = process.env.OMDB_API_KEY;
  if (!key) {
    // Unlike TMDB_API_KEY, this one is optional even in CI - ratings are a
    // nice-to-have on top of the core TMDB data, not something the rest of
    // the site depends on, so a missing key here should never fail the
    // workflow. It just quietly does nothing until the secret is added.
    console.warn('OMDB_API_KEY is not set - skipping, leaving data/tmdb.json untouched.');
    return;
  }

  const cache = JSON.parse(await readFile(TMDB, 'utf8'));
  const client = createClient(key);

  const entries = Object.entries(cache.films ?? {});
  const needsLookup = entries.filter(
    ([, meta]) => imdbIdOf(meta) && typeof meta.imdbRating !== 'number',
  );

  console.log(`${entries.length} films known, ${needsLookup.length} missing a rating`);

  let failures = 0;
  await pooled(needsLookup, CONCURRENCY, async ([slug, meta]) => {
    try {
      const rating = await client.rating(imdbIdOf(meta));
      cache.films[slug] = { ...meta, imdbRating: rating };
      console.log(`  ${slug} -> ${rating ?? 'no rating yet'}`);
    } catch (err) {
      failures++;
      console.error(`  error: ${slug} — ${err.message}`);
    }
  });

  if (failures) {
    console.error(`\n${failures} lookup(s) errored. Not writing; rerun once OMDb is reachable.`);
    process.exit(1);
  }
  if (!needsLookup.length) {
    console.log('\nNo change.');
    return;
  }

  await writeFile(TMDB, JSON.stringify(cache, null, 2) + '\n');
  console.log(`\nWrote data/tmdb.json — ${needsLookup.length} rating(s) added`);
}

main().catch(err => { console.error(err); process.exit(1); });
