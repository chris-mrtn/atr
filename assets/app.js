/**
 * Renders the film archive from the two data files.
 *
 *   data/films.json  the list, from Letterboxd (the source of truth)
 *   data/tmdb.json   posters and credits, keyed by Letterboxd slug
 *
 * TMDB data is optional throughout: a film with no match still gets a tile.
 */

const POSTER_SIZES = [
  ['w185', 185],
  ['w342', 342],
  ['w500', 500],
];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function posterFor(imageBase, path, title) {
  if (!path) {
    const box = el('div', 'poster empty');
    box.append(el('span', null, title));
    return box;
  }
  const box = el('div', 'poster');
  const img = el('img');
  img.src = `${imageBase}/w342${path}`;
  img.srcset = POSTER_SIZES.map(([size, w]) => `${imageBase}/${size}${path} ${w}w`).join(', ');
  img.sizes = '(max-width: 26rem) 40vw, 10rem';
  img.alt = `Poster for ${title}`;
  img.loading = 'lazy';
  img.decoding = 'async';
  img.width = 342;
  img.height = 513;
  // A poster that 404s should leave the tile, not a broken-image icon.
  img.addEventListener('error', () => {
    box.classList.add('empty');
    box.replaceChildren(el('span', null, title));
  }, { once: true });
  box.append(img);
  return box;
}

function filmCard(film, meta, imageBase) {
  const li = el('li', 'film');
  const link = el('a');
  link.href = film.letterboxdUrl ?? '#';
  link.rel = 'noopener';

  link.append(posterFor(imageBase, meta?.posterPath, film.title));
  link.append(el('span', 'film-title', film.title));

  const bits = [];
  if (film.year) bits.push(String(film.year));
  if (meta?.directors?.length) bits.push(meta.directors.slice(0, 2).join(', '));
  if (bits.length) link.append(el('span', 'film-meta', bits.join(' · ')));

  li.append(link);
  return li;
}

function yearSection(year, tmdb) {
  const section = el('section', 'year');

  const head = el('div', 'year-head');
  head.append(el('h2', null, String(year.year)));
  head.append(el('span', 'year-count', `${year.films.length} films`));
  if (year.listUrl) {
    const a = el('a', 'year-link', 'On Letterboxd');
    a.href = year.listUrl;
    a.rel = 'noopener';
    head.append(a);
  }
  section.append(head);

  const list = el('ul', 'films');
  for (const film of year.films) {
    list.append(filmCard(film, tmdb?.films?.[film.slug], tmdb?.imageBase ?? 'https://image.tmdb.org/t/p'));
  }
  section.append(list);
  return section;
}

async function loadJson(path, { required }) {
  try {
    const res = await fetch(path, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } catch (err) {
    if (required) throw new Error(`${path}: ${err.message}`);
    console.warn(`${path} unavailable — continuing without it (${err.message})`);
    return null;
  }
}

async function main() {
  const stats = document.getElementById('stats');
  const container = document.getElementById('years');

  let films;
  try {
    films = await loadJson('data/films.json', { required: true });
  } catch (err) {
    stats.textContent = '';
    container.replaceChildren(
      el('div', 'error', `Could not load the film list. ${err.message}`),
    );
    return;
  }

  // Posters are a nice-to-have: if tmdb.json is missing the page still works.
  const tmdb = await loadJson('data/tmdb.json', { required: false });

  const years = [...(films.years ?? [])].sort((a, b) => b.year - a.year);
  const total = years.reduce((n, y) => n + y.films.length, 0);
  const span = years.length ? `${years.at(-1).year}–${years[0].year}` : '';
  stats.textContent = `${total} films · ${span}`;

  container.replaceChildren(...years.map(y => yearSection(y, tmdb)));

  document.getElementById('tmdb-note').textContent =
    tmdb?.note ?? 'Posters and credits from TMDB.';
}

main();
