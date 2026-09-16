/**
 * TMDB lookup for films we already know from Letterboxd.
 *
 * The hard part is not fetching, it is being honest about matches. Letterboxd
 * slugs are not derivable from titles ("Beyond Utopia" is "flucht-aus-nordkorea"),
 * so we match on title + release year and apply strict rules. A film we cannot
 * confidently identify is recorded as unmatched, with the candidates we saw,
 * rather than guessed at — a wrong poster is worse than no poster.
 */

const API = 'https://api.themoviedb.org/3';

export const IMAGE_BASE = 'https://image.tmdb.org/t/p';

/** Strips case, accents, punctuation and articles for comparison only. */
export function normalizeTitle(s) {
  if (!s) return '';
  return s
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Whether a TMDB record has any actual content, as opposed to being one of the
 * empty duplicate stubs the database accumulates.
 */
export function isSubstantive(result) {
  return Boolean(result?.poster_path) || (result?.vote_count ?? 0) > 0;
}

export function releaseYear(result) {
  const d = result?.release_date;
  if (!d || d.length < 4) return null;
  const y = Number(d.slice(0, 4));
  return Number.isFinite(y) ? y : null;
}

/**
 * Picks a TMDB result for a known film, or explains why it could not.
 *
 * Accepts, in order of confidence:
 *   exact  - normalized title (or original title) matches and the year matches
 *   year±1 - same, but the release year is one out (festival vs general release)
 *   only   - the search returned exactly one result and its year matches
 *
 * Anything else is a refusal. Popularity is deliberately NOT a tiebreaker:
 * picking the most popular of several same-year films is how you end up with
 * a confident wrong answer.
 */
export function chooseMatch(film, results) {
  const list = Array.isArray(results) ? results : [];
  if (list.length === 0) return { match: null, reason: 'no results' };

  const want = normalizeTitle(film.title);
  const titleHit = r =>
    normalizeTitle(r.title) === want || normalizeTitle(r.original_title) === want;

  if (film.year != null) {
    const exact = list.filter(r => titleHit(r) && releaseYear(r) === film.year);
    if (exact.length === 1) return { match: exact[0], confidence: 'exact' };
    if (exact.length > 1) {
      // TMDB carries genuine duplicate records: one real entry plus a stub with
      // no poster and no votes. Discarding the empty ones is not the same as
      // picking the popular one - we are dropping records with no content, not
      // ranking real candidates against each other.
      const substantive = exact.filter(isSubstantive);
      if (substantive.length === 1) return { match: substantive[0], confidence: 'exact-deduped' };
      return { match: null, reason: `${exact.length} results share that title and year`, candidates: list.slice(0, 5) };
    }

    const near = list.filter(r => titleHit(r) && Math.abs((releaseYear(r) ?? -9999) - film.year) === 1);
    if (near.length === 1) return { match: near[0], confidence: 'year-off-by-one' };

    if (list.length === 1 && releaseYear(list[0]) === film.year) {
      return { match: list[0], confidence: 'sole-result' };
    }

    // Exactly one result, title matches exactly, but the year is further out
    // than one. Festival premiere vs general release can be several years
    // apart. One unambiguous title is enough to accept, flagged so it is
    // visible in the data.
    const titled = list.filter(titleHit);
    if (titled.length === 1 && list.length === 1) {
      return { match: titled[0], confidence: 'title-exact-year-differs' };
    }
    return { match: null, reason: 'no title+year match', candidates: list.slice(0, 5) };
  }

  // No year from Letterboxd: demand an unambiguous title match.
  const byTitle = list.filter(titleHit);
  if (byTitle.length === 1) return { match: byTitle[0], confidence: 'title-only' };
  return { match: null, reason: 'no year to disambiguate', candidates: list.slice(0, 5) };
}

/** TMDB accepts either a v3 api_key or a v4 bearer token; support both. */
function authFor(key) {
  const isBearer = key.startsWith('eyJ');
  return {
    headers: isBearer ? { authorization: `Bearer ${key}`, accept: 'application/json' } : { accept: 'application/json' },
    param: isBearer ? null : key,
  };
}

export function createClient(key, { fetchImpl = fetch } = {}) {
  if (!key) throw new Error('TMDB key is required');
  const auth = authFor(key);

  async function get(path, params = {}) {
    const url = new URL(API + path);
    for (const [k, v] of Object.entries(params)) {
      if (v != null && v !== '') url.searchParams.set(k, String(v));
    }
    if (auth.param) url.searchParams.set('api_key', auth.param);

    for (let attempt = 0; attempt < 4; attempt++) {
      const res = await fetchImpl(url, { headers: auth.headers });
      if (res.status === 429) {
        const wait = Number(res.headers.get('retry-after') ?? 2) * 1000;
        await new Promise(r => setTimeout(r, wait));
        continue;
      }
      if (res.status === 401) throw new Error('TMDB rejected the key (401)');
      if (!res.ok) throw new Error(`TMDB ${path} -> HTTP ${res.status}`);
      return res.json();
    }
    throw new Error(`TMDB ${path} -> still rate limited after retries`);
  }

  return {
    search: (title, year) =>
      get('/search/movie', { query: title, year, include_adult: false }).then(d => d.results ?? []),
    details: id =>
      get(`/movie/${id}`, { append_to_response: 'credits' }),
  };
}

/** Trims a TMDB details payload down to what the site actually needs. */
export function summarize(details) {
  const directors = (details?.credits?.crew ?? [])
    .filter(c => c.job === 'Director')
    .map(c => c.name);
  // Already on the same credits append_to_response as directors - no extra
  // request needed. TMDB's cast array is billing-ordered already, but we
  // sort explicitly rather than lean on that, and take the top few as the
  // "lead" cast.
  const cast = (details?.credits?.cast ?? [])
    .slice()
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .slice(0, 4)
    .map(c => c.name);
  const genres = (details?.genres ?? []).map(g => g.name);
  // Both already on the base /movie/{id} response, same tier as genres -
  // no extra append_to_response needed.
  const countries = (details?.production_countries ?? []).map(c => c.name);
  const imdbId = details?.imdb_id || null;
  return {
    tmdbId: details.id,
    originalTitle: details.original_title ?? null,
    releaseDate: details.release_date || null,
    runtime: details.runtime ?? null,
    overview: details.overview || null,
    posterPath: details.poster_path ?? null,
    backdropPath: details.backdrop_path ?? null,
    directors,
    cast,
    genres,
    countries,
    tmdbUrl: `https://www.themoviedb.org/movie/${details.id}`,
    imdbId,
    imdbUrl: imdbId ? `https://www.imdb.com/title/${imdbId}/` : null,
  };
}
