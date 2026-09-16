/**
 * Runs the full local update in one go: sync the film list from Letterboxd,
 * enrich with TMDB, backfill IMDb ratings from OMDb. The same three steps
 * the "Sync Letterboxd" GitHub Action runs, for whenever it is easier to
 * just run this here than to trigger that workflow.
 *
 *   TMDB_API_KEY=... OMDB_API_KEY=... node scripts/update-data.mjs
 *
 * Nothing here runs on a schedule (locally or in CI) - the archive only
 * changes when a new film gets added, so this is meant to be run by hand,
 * only when there is actually something new to pull in.
 */

import { spawn } from 'node:child_process';

const STEPS = [
  { label: 'Syncing film list from Letterboxd', script: 'sync.mjs' },
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
