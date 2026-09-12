/**
 * Renders the film archive from the two data files.
 *
 *   data/films.json  the list, from Letterboxd (the source of truth)
 *   data/tmdb.json   posters and credits, keyed by Letterboxd slug
 *
 * TMDB data is optional throughout: a film with no match still gets a tile.
 */

// Row thumbnails are small; ask for small files and a 2x option.
const POSTER_SIZES = [
  ['w92', 92],
  ['w154', 154],
  ['w185', 185],
];

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function posterFor(imageBase, path, title) {
  // In a list the title sits right beside the thumbnail, so a film with no
  // poster gets a plain tile rather than its title repeated at 8px.
  if (!path) return el('div', 'poster empty');
  const box = el('div', 'poster');
  const img = el('img');
  img.src = `${imageBase}/w154${path}`;
  img.srcset = POSTER_SIZES.map(([size, w]) => `${imageBase}/${size}${path} ${w}w`).join(', ');
  img.sizes = '3rem';
  img.alt = `Poster for ${title}`;
  img.loading = 'lazy';
  img.decoding = 'async';
  img.width = 154;
  img.height = 231;
  // A poster that 404s should leave the tile, not a broken-image icon.
  img.addEventListener('error', () => {
    box.classList.add('empty');
    box.replaceChildren();
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

  const text = el('div', 'film-text');
  text.append(el('span', 'film-title', film.title));

  const bits = [];
  if (film.year) bits.push(String(film.year));
  if (meta?.directors?.length) bits.push(meta.directors.slice(0, 2).join(', '));
  if (bits.length) text.append(el('span', 'film-meta', bits.join(' · ')));
  link.append(text);

  if (meta?.runtime) link.append(el('span', 'film-runtime', `${meta.runtime} min`));

  li.append(link);
  return li;
}

/* -------------------------------------------------------------------------
 * Dominant colour of the hero poster
 *
 * TMDB serves its images with CORS headers, so we can read the pixels rather
 * than shipping a colour from a build step. Averaging the whole poster gives
 * mud, so we bucket colours and take the most common one that is actually a
 * colour - skipping near-black, near-white and grey, which otherwise win on
 * every poster with a dark background or a white border.
 * ---------------------------------------------------------------------- */

function dominantColor(img, { size = 32 } = {}) {
  const c = document.createElement('canvas');
  const h = Math.round(size * 1.5);
  c.width = size;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, size, h);

  const { data } = ctx.getImageData(0, 0, size, h);
  const buckets = new Map();
  let fallback = [0, 0, 0, 0];

  for (let i = 0; i < data.length; i += 4) {
    const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
    if (a < 200) continue;

    fallback[0] += r; fallback[1] += g; fallback[2] += b; fallback[3]++;

    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    const lightness = (max + min) / 510;              // 0..1
    const sat = max === 0 ? 0 : (max - min) / max;    // 0..1
    if (lightness < 0.12 || lightness > 0.88 || sat < 0.18) continue;

    // 4 bits per channel: enough to group shades, coarse enough to cluster.
    const key = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
    const bucket = buckets.get(key) ?? [0, 0, 0, 0];
    bucket[0] += r; bucket[1] += g; bucket[2] += b; bucket[3]++;
    buckets.set(key, bucket);
  }

  let best = null;
  for (const bucket of buckets.values()) {
    if (!best || bucket[3] > best[3]) best = bucket;
  }
  const pick = best ?? (fallback[3] ? fallback : null);
  if (!pick) return null;

  return [0, 1, 2].map(i => Math.round(pick[i] / pick[3]));
}

/** Paints the top-of-page wash once we know the poster's colour. */
function applyBackdrop(rgb) {
  if (!rgb) return;
  document.documentElement.style.setProperty('--hero-rgb', rgb.join(' '));
  document.getElementById('backdrop')?.classList.add('is-lit');
}

/**
 * The newest film in the newest year is what the club watches next, so it gets
 * the top of the page rather than a row in the archive. It moves down into its
 * year section once a newer film takes its place.
 */
function renderHero(film, meta, imageBase) {
  const hero = document.getElementById('hero');
  hero.hidden = false;
  hero.replaceChildren();

  const link = el('a', 'hero-inner');
  link.href = film.letterboxdUrl ?? '#';
  link.rel = 'noopener';

  const art = el('div', 'hero-poster');
  if (meta?.posterPath) {
    const img = el('img');
    img.src = `${imageBase}/w500${meta.posterPath}`;
    img.srcset = [342, 500, 780].map(w => `${imageBase}/w${w}${meta.posterPath} ${w}w`).join(', ');
    img.sizes = '(max-width: 34rem) 60vw, 20rem';
    img.alt = `Poster for ${film.title}`;
    img.width = 500;
    img.height = 750;
    img.addEventListener('error', () => art.classList.add('empty'), { once: true });

    // Sampling the pixels needs an anonymous-CORS fetch. If that is ever
    // refused the poster still renders; we just get no backdrop.
    const sampler = new Image();
    sampler.crossOrigin = 'anonymous';
    sampler.addEventListener('load', () => {
      try { applyBackdrop(dominantColor(sampler)); }
      catch (err) { console.warn('backdrop: could not sample poster', err); }
    }, { once: true });
    sampler.addEventListener('error', () => console.warn('backdrop: poster not readable'), { once: true });
    sampler.src = `${imageBase}/w154${meta.posterPath}`;

    art.append(img);
  } else {
    art.classList.add('empty');
  }
  link.append(art);

  const body = el('div', 'hero-body');
  body.append(el('p', 'hero-label', 'Next'));
  body.append(el('h2', 'hero-title', film.title));

  const bits = [];
  if (film.year) bits.push(String(film.year));
  if (meta?.directors?.length) bits.push(meta.directors.slice(0, 2).join(', '));
  if (meta?.runtime) bits.push(`${meta.runtime} min`);
  if (bits.length) body.append(el('p', 'hero-meta', bits.join(' · ')));

  if (meta?.overview) body.append(el('p', 'hero-overview', meta.overview));

  link.append(body);
  hero.append(link);
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

  // Years run newest-first, and so do the films inside them, so scrolling
  // down is always travelling backwards in time. Letterboxd gives us the list
  // in the order films were added, i.e. oldest first, so reverse it.
  const list = el('ul', 'films');
  for (const film of [...year.films].reverse()) {
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

  const imageBase = tmdb?.imageBase ?? 'https://image.tmdb.org/t/p';
  const years = [...(films.years ?? [])].sort((a, b) => b.year - a.year)
    .map(y => ({ ...y, films: [...y.films] }));

  // Lift the newest film out of the newest year: it is what's coming up, not
  // part of the archive. It drops back in on its own once something newer is
  // added to the list.
  let next = null;
  const newest = years[0];
  if (newest?.films.length) {
    next = newest.films.pop();
    renderHero(next, tmdb?.films?.[next.slug], imageBase);
  }

  // A year emptied by that lift has nothing left to show.
  const archive = years.filter(y => y.films.length > 0);

  const total = archive.reduce((n, y) => n + y.films.length, 0);
  const span = archive.length ? `${archive.at(-1).year}–${archive[0].year}` : '';
  stats.textContent = `${total} watched · ${span}`;

  container.replaceChildren(...archive.map(y => yearSection(y, tmdb)));

  document.getElementById('tmdb-note').textContent =
    tmdb?.note ?? 'Posters and credits from TMDB.';
}

main();
