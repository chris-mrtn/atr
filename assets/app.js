/**
 * Renders the film archive from the data files.
 *
 *   data/films.json    the list, from Letterboxd (the source of truth)
 *   data/tmdb.json     posters, credits and genres, keyed by Letterboxd slug
 *   data/pickers.json  who picked each film, keyed by "<year>:<slug>" -
 *                       hand-maintained, since Letterboxd has no notion of it
 *
 * TMDB data and picker data are both optional: a film with no match, or no
 * recorded picker, still gets a tile.
 */

// Row thumbnails - ask for a size that still looks sharp at 2x.
const POSTER_SIZES = [
  ['w92', 92],
  ['w154', 154],
  ['w185', 185],
  ['w342', 342],
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
  img.sizes = '6rem';
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

function filmCard(film, meta, imageBase, picker) {
  const li = el('li', 'film');
  const row = el('div', 'film-row');

  row.append(posterFor(imageBase, meta?.posterPath, film.title));

  const text = el('div', 'film-text');
  text.append(el('span', 'film-title', film.title));

  const bits = [];
  if (film.year) bits.push(String(film.year));
  if (meta?.directors?.length) bits.push(meta.directors.slice(0, 2).join(', '));
  if (meta?.genres?.length) bits.push(meta.genres.slice(0, 2).join(', '));
  if (picker) bits.push(`picked by ${picker}`);
  if (bits.length) text.append(el('span', 'film-meta', bits.join(' · ')));

  if (meta?.overview) text.append(el('span', 'film-description', meta.overview));

  row.append(text);

  if (meta?.runtime) row.append(el('span', 'film-runtime', `${meta.runtime} min`));

  li.append(row);
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

/**
 * Loads a poster in a way that is guaranteed to be canvas-readable.
 *
 * Using `new Image()` with crossOrigin is fragile: if the same URL was already
 * fetched by a plain <img> (a list thumbnail, say) the browser can hand back
 * the cached response, which carries no CORS headers, and the canvas is then
 * tainted. Going through fetch -> blob sidesteps that completely, because a
 * blob: image is same-origin by definition.
 */
async function loadSampleImage(url) {
  const res = await fetch(url, { mode: 'cors', cache: 'reload' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const blob = await res.blob();
  if (typeof createImageBitmap === 'function') return createImageBitmap(blob);

  const objectUrl = URL.createObjectURL(blob);
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('blob image failed to decode'));
      img.src = objectUrl;
    });
    return img;
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

/** Plain Euclidean distance in RGB space - good enough to tell two swatches apart. */
function colorDistance(a, b) {
  return Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2);
}

/**
 * Picks up to `count` distinct colours out of the poster, most-common first,
 * for the mesh backdrop. Skipping near-duplicate buckets means a poster with
 * one dominant hue still yields varied swatches instead of three copies of
 * the same colour.
 */
function dominantColors(img, { size = 32, count = 3 } = {}) {
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

  const ranked = [...buckets.values()].sort((a, b) => b[3] - a[3]);
  const colors = [];
  for (const bucket of ranked) {
    const rgb = [0, 1, 2].map(i => Math.round(bucket[i] / bucket[3]));
    if (colors.some(picked => colorDistance(picked, rgb) < 40)) continue;
    colors.push(rgb);
    if (colors.length === count) break;
  }

  if (!colors.length && fallback[3]) {
    colors.push([0, 1, 2].map(i => Math.round(fallback[i] / fallback[3])));
  }

  return colors;
}

function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  if (!d) return [0, 0, l];
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? ((g - b) / d + (g < b ? 6 : 0))
          : max === g ? (b - r) / d + 2
          : (r - g) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb([h, s, l]) {
  if (!s) { const v = Math.round(l * 255); return [v, v, v]; }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = t => {
    t = (t + 1) % 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)].map(v => Math.round(v * 255));
}

/**
 * Keeps the poster's hue but forces enough saturation and mid-lightness to
 * actually read as a colour. Plenty of posters are near-monochrome - Stalker's
 * sepia resolves to a grey-green that looks like nothing on screen - and the
 * point of the wash is to be seen.
 */
function vivify(rgb, { minSat = 0.45, minLight = 0.32, maxLight = 0.6 } = {}) {
  const [h, s, l] = rgbToHsl(rgb);
  return hslToRgb([h, Math.max(s, minSat), Math.min(Math.max(l, minLight), maxLight)]);
}

/** Paints the top-of-page mesh once we know the poster's colours. */
function applyBackdrop(colors) {
  if (!colors || !colors.length) return;
  const vivid = colors.map(rgb => vivify(rgb));
  while (vivid.length < 3) vivid.push(vivid[vivid.length - 1]);

  const root = document.documentElement.style;
  root.setProperty('--hero-rgb-1', vivid[0].join(' '));
  root.setProperty('--hero-rgb-2', vivid[1].join(' '));
  root.setProperty('--hero-rgb-3', vivid[2].join(' '));
  document.getElementById('backdrop')?.classList.add('is-lit');
}

/**
 * The newest film in the newest year is what the club watches next, so it gets
 * the top of the page rather than a row in the archive. It moves down into its
 * year section once a newer film takes its place.
 */
function renderHero(film, meta, imageBase, picker) {
  const hero = document.getElementById('hero');
  hero.hidden = false;
  hero.replaceChildren();

  const wrap = el('div', 'hero-inner');

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

    // Sample the poster for the backdrop colour. Failure here is cosmetic:
    // the poster still renders, we just get no wash.
    loadSampleImage(`${imageBase}/w185${meta.posterPath}`)
      .then(bitmap => applyBackdrop(dominantColors(bitmap)))
      .catch(err => console.warn('backdrop: could not sample poster —', err.message));

    art.append(img);
  } else {
    art.classList.add('empty');
  }
  wrap.append(art);

  const body = el('div', 'hero-body');

  const info = el('div', 'hero-info');
  info.append(el('p', 'hero-label', 'Now Showing'));
  info.append(el('h2', 'hero-title', film.title));

  const bits = [];
  if (film.year) bits.push(String(film.year));
  if (meta?.directors?.length) bits.push(meta.directors.slice(0, 2).join(', '));
  if (meta?.runtime) bits.push(`${meta.runtime} min`);
  if (picker) bits.push(`Chosen by ${picker}`);
  if (bits.length) info.append(el('p', 'hero-meta', bits.join(' · ')));
  body.append(info);

  const scheduleRow = el('div', 'hero-schedule-row');
  // Placeholders - the club always meets Sunday 10am AEST, so this is
  // static for now. Once we have real scheduling this becomes computed
  // (and the button below gets wired up to build an actual calendar file).
  scheduleRow.append(el('p', 'hero-schedule', 'Sunday · 10:00 AM AEST'));

  const calendarBtn = el('button', 'hero-calendar-btn', '+ Add to Calendar');
  calendarBtn.type = 'button';
  scheduleRow.append(calendarBtn);
  body.append(scheduleRow);

  wrap.append(body);
  hero.append(wrap);

  updateBackdropExtent();
}

/**
 * The backdrop should always reach exactly to the bottom of the hero poster,
 * no matter the viewport size or how tall the poster ends up being - so
 * measure it after each render (and again on resize, since the poster's
 * width, and therefore its height, is viewport-relative) rather than
 * hard-coding a height.
 */
let debugExtentFraction = 1.5;

function updateBackdropExtent() {
  const poster = document.querySelector('.hero-poster');
  if (!poster) return;
  const bodyTop = document.body.getBoundingClientRect().top;
  const rect = poster.getBoundingClientRect();
  const extent = (rect.top - bodyTop) + rect.height * debugExtentFraction;
  document.documentElement.style.setProperty('--backdrop-height', `${Math.round(extent)}px`);
}

let backdropResizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(backdropResizeTimer);
  backdropResizeTimer = setTimeout(updateBackdropExtent, 100);
});

function yearSection(year, tmdb, pickers) {
  const section = el('section', 'year');

  const head = el('div', 'year-head');
  const label = year.year === new Date().getFullYear() ? 'This Year' : String(year.year);
  head.append(el('h2', null, label));
  head.append(el('span', 'year-count', `${year.films.length} films`));
  if (year.listUrl) {
    const a = el('a', 'year-link', 'Letterboxd');
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
    const picker = pickers?.picks?.[`${year.year}:${film.slug}`];
    list.append(filmCard(film, tmdb?.films?.[film.slug], tmdb?.imageBase ?? 'https://image.tmdb.org/t/p', picker));
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

/* ------------------------------------------------------------------------
 * TEMP DEBUG: a floating button to load a random film's poster into the
 * hero, just to eyeball the mesh backdrop against different artwork.
 * Delete this whole block (and its call in main()) once that's settled.
 * ---------------------------------------------------------------------- */
function setupDebugRandomPoster(allFilms, tmdb, imageBase) {
  const candidates = allFilms.filter(f => tmdb?.films?.[f.slug]?.posterPath);
  if (!candidates.length) return;

  const btn = document.createElement('button');
  btn.textContent = '\ud83c\udfb2 random poster (debug)';
  btn.style.cssText = [
    'position: fixed', 'bottom: 12px', 'right: 12px', 'z-index: 999',
    'max-width: calc(100vw - 24px)',
    'padding: .5rem .9rem', 'font-size: .75rem', 'border-radius: 999px',
    'border: 1px solid rgba(127,127,127,.4)', 'background: rgba(127,127,127,.2)',
    'color: inherit', 'backdrop-filter: blur(6px)', 'cursor: pointer',
    'font-family: inherit',
  ].join(';');
  btn.addEventListener('click', () => {
    const film = candidates[Math.floor(Math.random() * candidates.length)];
    renderHero(film, tmdb.films[film.slug], imageBase);
  });
  document.body.append(btn);
}

/* ------------------------------------------------------------------------
 * TEMP DEBUG: a floating panel of sliders for the backdrop's tunable knobs
 * - poster extent, where the fade starts, per-blob opacity, grain amount and
 * size - so they can be dialled in live instead of round-tripping edits.
 * Delete this whole block (and its call in main()) once values are settled.
 * ---------------------------------------------------------------------- */
function setupDebugControls() {
  const rootStyle = document.documentElement.style;

  const panel = document.createElement('div');
  panel.style.cssText = [
    'position: fixed', 'bottom: 60px', 'left: 12px', 'z-index: 999',
    'width: min(20rem, calc(100vw - 24px))', 'max-height: 70vh', 'overflow: auto',
    'padding: .9rem 1rem', 'border-radius: 12px',
    'border: 1px solid rgba(127,127,127,.4)', 'background: rgba(20,20,20,.85)',
    'color: #eee', 'backdrop-filter: blur(10px)', 'font-family: inherit',
    'font-size: .75rem', 'display: none', 'flex-direction: column', 'gap: .7rem',
  ].join(';');

  const toggle = document.createElement('button');
  toggle.textContent = '🎛️ effect controls (debug)';
  toggle.style.cssText = [
    'position: fixed', 'bottom: 12px', 'left: 12px', 'z-index: 999',
    'padding: .5rem .9rem', 'font-size: .75rem', 'border-radius: 999px',
    'border: 1px solid rgba(127,127,127,.4)', 'background: rgba(127,127,127,.2)',
    'color: inherit', 'backdrop-filter: blur(6px)', 'cursor: pointer',
    'font-family: inherit',
  ].join(';');
  toggle.addEventListener('click', () => {
    panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
  });

  function slider({ label, min, max, step, value, format, onInput }) {
    const row = document.createElement('label');
    row.style.cssText = 'display:flex; flex-direction:column; gap:.25rem;';

    const top = document.createElement('div');
    top.style.cssText = 'display:flex; justify-content:space-between; gap:.5rem;';
    const name = document.createElement('span');
    name.textContent = label;
    const out = document.createElement('span');
    out.style.cssText = 'font-variant-numeric: tabular-nums; opacity:.7;';
    const show = v => format ? format(v) : v;
    out.textContent = show(value);
    top.append(name, out);

    const input = document.createElement('input');
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    input.value = String(value);
    input.style.width = '100%';
    input.addEventListener('input', () => {
      const v = Number(input.value);
      out.textContent = show(v);
      onInput(v);
    });

    row.append(top, input);
    return row;
  }

  panel.append(
    slider({
      label: 'effect opacity', min: 0, max: 1, step: .05, value: .85,
      onInput: v => rootStyle.setProperty('--backdrop-opacity', v),
    }),
    slider({
      label: 'poster extent', min: 0, max: 200, step: 5, value: 150,
      format: v => `${v}%`,
      onInput: v => { debugExtentFraction = v / 100; updateBackdropExtent(); },
    }),
    slider({
      label: 'fade start', min: 0, max: 100, step: 1, value: 30,
      format: v => `${v}%`,
      onInput: v => rootStyle.setProperty('--mask-fade-start', `${v}%`),
    }),
    slider({
      label: 'blob 1 opacity', min: 0, max: 1, step: .05, value: .70,
      onInput: v => rootStyle.setProperty('--blob-1-alpha', v),
    }),
    slider({
      label: 'blob 2 opacity', min: 0, max: 1, step: .05, value: .60,
      onInput: v => rootStyle.setProperty('--blob-2-alpha', v),
    }),
    slider({
      label: 'blob 3 opacity', min: 0, max: 1, step: .05, value: .55,
      onInput: v => rootStyle.setProperty('--blob-3-alpha', v),
    }),
    slider({
      label: 'grain opacity', min: 0, max: .3, step: .01, value: .21,
      onInput: v => rootStyle.setProperty('--grain-opacity', v),
    }),
    slider({
      label: 'grain size', min: 40, max: 400, step: 10, value: 160,
      format: v => `${v}px`,
      onInput: v => rootStyle.setProperty('--grain-size', `${v}px`),
    }),
    slider({
      label: 'drift speed', min: .1, max: 8, step: .1, value: 1,
      format: v => `${v}x`,
      onInput: v => rootStyle.setProperty('--drift-speed', v),
    }),
    slider({
      label: 'blob blur', min: 0, max: 60, step: 1, value: 0,
      format: v => `${v}px`,
      onInput: v => rootStyle.setProperty('--blob-blur', `${v}px`),
    }),
    slider({
      label: 'blob edge (lower = sharper)', min: 20, max: 100, step: 5, value: 50,
      format: v => `${v}%`,
      onInput: v => rootStyle.setProperty('--blob-edge', `${v}%`),
    }),
    slider({
      label: 'vertical wander', min: 0, max: 15, step: 1, value: 15,
      format: v => `${v}%`,
      onInput: v => rootStyle.setProperty('--drift-y-amount', `${v}%`),
    }),
    slider({
      label: 'breathing amount', min: 0, max: 20, step: 1, value: 20,
      format: v => `${v}%`,
      onInput: v => rootStyle.setProperty('--breathe-amount', v),
    }),
    slider({
      label: 'saturation drift', min: 100, max: 300, step: 10, value: 180,
      format: v => `${v}%`,
      onInput: v => rootStyle.setProperty('--saturation-drift-amount', `${v}%`),
    }),
  );

  document.body.append(toggle, panel);
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
  // Picker attribution is hand-sourced and often absent - also optional.
  const pickers = await loadJson('data/pickers.json', { required: false });

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
    // Keyed the same way as the archive - "<year>:<slug>" - so the same
    // data/pickers.json entry covers a film whether it's the featured
    // pick or has already dropped back into the archive.
    const picker = pickers?.picks?.[`${newest.year}:${next.slug}`];
    renderHero(next, tmdb?.films?.[next.slug], imageBase, picker);
  }

  // A year emptied by that lift has nothing left to show.
  const archive = years.filter(y => y.films.length > 0);

  const total = archive.reduce((n, y) => n + y.films.length, 0);
  const since = archive.length ? archive.at(-1).year : '';
  stats.textContent = `${total} movies since ${since}`;

  container.replaceChildren(...archive.map(y => yearSection(y, tmdb, pickers)));

  document.getElementById('tmdb-note').textContent =
    tmdb?.note ?? 'Posters and credits from TMDB.';

  // TEMP DEBUG — see the blocks above.
  setupDebugRandomPoster((films.years ?? []).flatMap(y => y.films), tmdb, imageBase);
  setupDebugControls();
}

main();
