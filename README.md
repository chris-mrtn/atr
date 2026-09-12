# atr

Website for the movie club: https://chris-mrtn.github.io/atr/

Static site on GitHub Pages. Pushing to `main` redeploys it.

## The film database

`data/films.json` is built from the yearly *Avoid the Rut* lists on Letterboxd,
one list per year from 2020. It is generated — don't edit it by hand.

```
scripts/letterboxd.mjs       fetches and parses a list page
scripts/letterboxd.test.mjs  parser tests, run against a captured fixture
scripts/sync.mjs             walks the years, writes data/films.json
```

### Running it

```sh
node --test scripts/*.test.mjs   # parser tests, no network
node scripts/sync.mjs            # rebuild data/films.json
node scripts/sync.mjs --check    # fail if the committed data is stale
```

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

## Running the site locally

```sh
python3 -m http.server 8000
```

Then open http://localhost:8000
