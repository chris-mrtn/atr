/**
 * Builds data/films.json from the yearly "Avoid the Rut" Letterboxd lists.
 *
 *   node scripts/sync.mjs            # sync every year from 2020 to now
 *   node scripts/sync.mjs --check    # sync but do not write; exit 1 if stale
 *
 * The guiding rule: never let a bad scrape destroy good data. Letterboxd could
 * change their markup, rate-limit us, or serve an error page — in any of those
 * cases the parse yields zero films, and silently committing that would wipe
 * the archive. So a year that previously had films and now has none is a hard
 * failure, not an update.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fetchList, listUrlFor } from './letterboxd.mjs';

const MEMBER = 'chrismrtn';
const FIRST_YEAR = 2020;
const OUT = new URL('../data/films.json', import.meta.url);

const args = new Set(process.argv.slice(2));
const CHECK_ONLY = args.has('--check');

async function readExisting() {
  try {
    return JSON.parse(await readFile(OUT, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw new Error(`data/films.json exists but will not parse: ${err.message}`);
  }
}

function countsByYear(db) {
  const out = new Map();
  for (const y of db?.years ?? []) out.set(y.year, y.films.length);
  return out;
}

async function main() {
  const thisYear = new Date().getUTCFullYear();
  const previous = await readExisting();
  const before = countsByYear(previous);

  const years = [];
  const problems = [];

  for (let year = FIRST_YEAR; year <= thisYear; year++) {
    const url = listUrlFor(MEMBER, year);
    let list;
    try {
      list = await fetchList(url);
    } catch (err) {
      problems.push(`${year}: fetch failed — ${err.message}`);
      continue;
    }

    if (list === null) {
      // No list for this year yet. Fine for a future year; suspicious if we
      // used to have one.
      if (before.get(year)) problems.push(`${year}: list 404s but we previously had ${before.get(year)} films`);
      else console.log(`${year}: no list, skipping`);
      continue;
    }

    if (list.films.length === 0) {
      problems.push(`${year}: parsed 0 films from a 200 response — markup may have changed`);
      continue;
    }

    const had = before.get(year);
    if (had && list.films.length < had) {
      console.warn(`${year}: film count dropped ${had} -> ${list.films.length}`);
    }

    console.log(`${year}: ${list.films.length} films`);
    years.push({
      year,
      listTitle: list.title,
      listUrl: list.url,
      films: list.films,
    });
  }

  if (problems.length) {
    console.error('\nRefusing to write. Problems:');
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }

  if (years.length === 0) {
    console.error('Refusing to write: no years produced any films.');
    process.exit(1);
  }

  const db = {
    // generatedAt deliberately excluded from the change comparison below, so a
    // scheduled run that finds nothing new produces no commit.
    generatedAt: new Date().toISOString(),
    source: { kind: 'letterboxd-list', member: MEMBER },
    totalFilms: years.reduce((n, y) => n + y.films.length, 0),
    years,
  };

  const stable = JSON.stringify({ ...db, generatedAt: null }, null, 2);
  const stablePrev = previous ? JSON.stringify({ ...previous, generatedAt: null }, null, 2) : null;
  const changed = stable !== stablePrev;

  console.log(`\n${db.totalFilms} films across ${years.length} years — ${changed ? 'changed' : 'no change'}`);

  if (CHECK_ONLY) {
    if (changed) { console.error('Data is stale. Run: node scripts/sync.mjs'); process.exit(1); }
    return;
  }

  if (!changed) return;
  await mkdir(new URL('../data/', import.meta.url), { recursive: true });
  await writeFile(OUT, JSON.stringify(db, null, 2) + '\n');
  console.log('Wrote data/films.json');
}

main().catch(err => { console.error(err); process.exit(1); });
