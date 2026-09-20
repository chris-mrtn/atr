# atr

Website for the movie club: https://chris-mrtn.github.io/atr/

Static site on GitHub Pages. Pushing to `main` redeploys it.

## The film database

`data/films.json` is maintained by hand, one entry per film, added as each
one gets picked - not pulled from anywhere. (It used to be generated from
the yearly *Avoid the Rut* lists on Letterboxd; that's no longer how films
get added, so there's no sync step any more.)

```
scripts/tmdb.mjs             TMDB client and match rules
scripts/enrich.mjs           adds TMDB metadata, writes data/tmdb.json
scripts/imdb-ratings.mjs     backfills IMDb ratings via OMDb, writes into data/tmdb.json
scripts/summary.mjs          renders the Actions run summary
scripts/*.test.mjs           tests, no network required
```

`data/films.json` and `data/tmdb.json` are kept separate on purpose. The
first is edited directly; the second is a cache keyed by each film's slug.
Editing the film list therefore cannot wipe the TMDB data, and enrichment
cannot corrupt the list.

### Running it

```sh
node --test scripts/*.test.mjs           # tests, no network
TMDB_API_KEY=... node scripts/enrich.mjs # add TMDB metadata for whatever's new
```

### When TMDB gets a film wrong

Matching is deliberately strict: a film is only accepted when the title and
year line up, and ties are never broken by popularity, because a confident
wrong poster is worse than none. Anything ambiguous lands in the `unmatched`
section of `data/tmdb.json` with the candidates that were considered, and is
listed in the Actions run summary.

To settle one by hand, put its TMDB id in `data/tmdb-overrides.json`:

```json
{ "some-film-slug": 12345 }
```

Then re-run the workflow. Overrides always win.

This product uses the TMDB API but is not endorsed or certified by TMDB.

### Automation

`.github/workflows/update-film-data.yml` adds TMDB metadata and backfills
IMDb ratings for whatever's new in `data/films.json`, then commits the
result. It only runs when triggered by hand from the Actions tab (or by a
push that touches the scripts themselves) - nothing here runs on a
schedule, since the archive only changes when a film gets added.

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
