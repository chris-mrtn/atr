# atr

Website for the movie club: https://chris-mrtn.github.io/atr/

Static site on GitHub Pages. Pushing to `main` redeploys it.

## The film database

`data/films.json` is built from the yearly *Avoid the Rut* lists on Letterboxd,
one list per year from 2020. It is generated — don't edit it by hand.

```
scripts/letterboxd.mjs       fetches and parses a list page
scripts/sync.mjs             walks the years, writes data/films.json
scripts/tmdb.mjs             TMDB client and match rules
scripts/enrich.mjs           adds TMDB metadata, writes data/tmdb.json
scripts/summary.mjs          renders the Actions run summary
scripts/*.test.mjs           tests, no network required
```

`data/films.json` and `data/tmdb.json` are kept separate on purpose. The first
is rewritten wholesale on every sync; the second is a cache keyed by Letterboxd
slug. A re-sync therefore cannot wipe the TMDB data, and enrichment cannot
corrupt the list.

### Running it

```sh
node --test scripts/*.test.mjs           # tests, no network
node scripts/sync.mjs                    # rebuild data/films.json
node scripts/sync.mjs --check            # fail if the committed data is stale
TMDB_API_KEY=... node scripts/enrich.mjs # add TMDB metadata
```

### When TMDB gets a film wrong

Matching is deliberately strict: a film is only accepted when the title and
year line up, and ties are never broken by popularity, because a confident
wrong poster is worse than none. Anything ambiguous lands in the `unmatched`
section of `data/tmdb.json` with the candidates that were considered, and is
listed in the Actions run summary.

To settle one by hand, put its TMDB id in `data/tmdb-overrides.json`:

```json
{ "some-letterboxd-slug": 12345 }
```

Then re-run the workflow. Overrides always win.

This product uses the TMDB API but is not endorsed or certified by TMDB.

### Automation

`.github/workflows/sync-letterboxd.yml` runs the sync daily and commits
`data/films.json` when it changes. You can also trigger it by hand from the
Actions tab.

### Why scraping

The Letterboxd API is request-only and excludes personal projects, and their
pages send no CORS headers, so the browser cannot read them directly. Fetching
at build time is the remaining option. `scripts/letterboxd.mjs` is the only
file that knows this — if API access ever appears, replacing it is the whole
migration.

The sync refuses to write when a year that previously had films returns none,
so a markup change or a rate limit fails the build instead of quietly emptying
the archive.

## The site

```
index.html          markup and element hooks
assets/styles.css   all styling; light and dark
assets/app.js       merges films.json with tmdb.json and renders
```

The page reads both data files at load. `films.json` is required; `tmdb.json`
is optional, so a film with no TMDB match still gets a tile with its title in
it, and the page works even if enrichment has never run.

## Running the site locally

```sh
python3 -m http.server 8000
```

Then open http://localhost:8000
