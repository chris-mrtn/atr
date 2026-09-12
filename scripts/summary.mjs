/** Writes the Actions run summary. Never fails the job. */
import { readFile } from 'node:fs/promises';

const read = async name => {
  try { return JSON.parse(await readFile(new URL(`../data/${name}`, import.meta.url), 'utf8')); }
  catch { return null; }
};

const films = await read('films.json');
const tmdb = await read('tmdb.json');
const lines = [];

if (!films) {
  lines.push('No `data/films.json` was produced.');
} else {
  lines.push(`**${films.totalFilms} films** across ${films.years.length} years`, '');
  lines.push('| Year | Films |', '|---|---:|');
  for (const y of films.years) lines.push(`| ${y.year} | ${y.films.length} |`);
}

if (tmdb) {
  lines.push('', `**TMDB:** ${tmdb.matched} matched, ${tmdb.unmatchedCount} unmatched`);
  const un = Object.entries(tmdb.unmatched ?? {});
  if (un.length) {
    lines.push('', '<details><summary>Unmatched films</summary>', '');
    lines.push('| Film | Year | Why |', '|---|---|---|');
    for (const [slug, u] of un) lines.push(`| ${u.title} | ${u.year ?? '?'} | ${u.reason} |`);
    lines.push('', 'Pin one by adding its TMDB id to `data/tmdb-overrides.json`.', '</details>');
  }
} else {
  lines.push('', '**TMDB:** no `data/tmdb.json` — is the `TMDB_API_KEY` secret set?');
}

console.log(lines.join('\n'));
