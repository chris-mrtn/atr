/**
 * OMDb lookup for a film's IMDb rating.
 *
 * TMDB (scripts/tmdb.mjs) doesn't expose this - its own vote_average is a
 * separate, TMDB-only score. OMDb wraps IMDb's own data and is looked up by
 * IMDb id, which every already-matched film in data/tmdb.json already
 * carries (imdbId, or an imdbUrl to parse it back out of for older cache
 * entries).
 *
 * Get a free key at https://www.omdbapi.com/apikey.aspx (1,000 requests/day,
 * plenty for a once-a-day backfill of a couple hundred films) and run:
 *
 *   OMDB_API_KEY=... node scripts/imdb-ratings.mjs
 */

const API = 'https://www.omdbapi.com/';

/** OMDb sends the rating as a string, "N/A" when IMDb doesn't have one yet
 *  (a very new release, or something too obscure to have enough votes). */
export function parseRating(raw) {
  if (!raw || raw === 'N/A') return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

export function createClient(key, { fetchImpl = fetch } = {}) {
  if (!key) throw new Error('OMDb key is required');

  async function rating(imdbId) {
    const url = new URL(API);
    url.searchParams.set('i', imdbId);
    url.searchParams.set('apikey', key);

    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetchImpl(url);
      if (res.status === 429) {
        const wait = Number(res.headers?.get?.('retry-after') ?? 2) * 1000;
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      if (res.status === 401) throw new Error('OMDb rejected the key (401)');
      if (!res.ok) throw new Error(`OMDb ${imdbId} -> HTTP ${res.status}`);
      const data = await res.json();
      // OMDb answers 200 OK even for "not found" - the actual signal is
      // this field, not the HTTP status.
      if (data.Response === 'False') throw new Error(`OMDb ${imdbId} -> ${data.Error || 'not found'}`);
      return parseRating(data.imdbRating);
    }
    throw new Error(`OMDb ${imdbId} -> still rate limited after retries`);
  }

  return { rating };
}
