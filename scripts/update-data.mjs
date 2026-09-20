/**
 * Runs the full local update in one go: enrich data/films.json with TMDB,
 * backfill IMDb ratings from OMDb. The same two steps the "Update film
 * data" GitHub Action runs, for whenever it is easier to just run this
 * here than to trigger that workflow.
 *
 *   TMDB_API_KEY=... OMDB_API_KEY=... node scripts/update-data.mjs
 *
 * data/films.json itself is no longer generated - films go in by hand (or
 * via chat) as they're picked, not pulled from Letterboxd. This just fills
 * in the TMDB/OMDb metadata for whatever's already in there.
 *
 * Nothing here runs on a schedule (locally or in CI) - the archive only
 * changes when a new film gets added, so this is meant to be run by hand,
 * only when there is actually something new to pull in.
 */

import { spawn } from 'node:child_process';

const STEPS = [
  { label: 'Enriching with TMDB', script: 'enrich.mjs' },
  { label: 'Backfilling IMDb ratings', script: 'imdb-ratings.mjs' },
];

function run(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [new URL(script, import.meta.url)], { stdio: 'inherit' });
    child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`${script} exited with code ${code}`))));
    child.on('error', reject);
  });
}

for (const { label, script } of STEPS) {
  console.log(`\n=== ${label} (${script}) ===`);
  await run(script);
}

console.log('\nDone.');
