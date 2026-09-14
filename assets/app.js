/**
 * Renders the film archive from the data files.
 *
 *   data/films.json    the list, from Letterboxd (the source of truth)
 *   data/tmdb.json     posters, credits and genres, keyed by Letterboxd slug
 *   data/pickers.json  who picked each film, keyed by "<year>:<slug>" -
 *                       hand-maintained, since Letterboxd has no notion of it
 *   data/schedule.json the current pick cycle - who picked (or picked last),
 *                       which film (once decided) and when it screens
 *   data/members.json  the club's pick rotation, oldest to newest turn
 *
 * TMDB data and picker data are both optional: a film with no match, or no
 * recorded picker, still gets a tile. schedule.json and members.json are
 * also optional - their absence just means the hero falls back to a bare
 * "waiting for selection" with no name attached.
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

/** Wraps a node in a link out to IMDb, opened in a new tab. */
function imdbLink(href, child, title, className = 'poster-link') {
  const a = el('a', className);
  a.href = href;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  a.setAttribute('aria-label', `${title} on IMDb`);
  a.append(child);
  return a;
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

  const poster = posterFor(imageBase, meta?.posterPath, film.title);
  row.append(meta?.imdbUrl ? imdbLink(meta.imdbUrl, poster, film.title) : poster);

  const text = el('div', 'film-text');

  if (picker) text.append(el('span', 'film-picker', picker));

  const titleLine = el('span', 'film-title');
  if (meta?.imdbUrl) {
    titleLine.append(imdbLink(meta.imdbUrl, document.createTextNode(film.title), film.title, 'film-title-link'));
  } else {
    titleLine.append(document.createTextNode(film.title));
  }
  if (film.year) titleLine.append(el('span', 'film-year', String(film.year)));
  text.append(titleLine);

  const bits = [];
  if (meta?.directors?.length) bits.push(meta.directors.slice(0, 2).join(', '));
  if (meta?.cast?.length) bits.push(meta.cast.slice(0, 2).join(', '));
  if (meta?.runtime) bits.push(`${meta.runtime} min`);
  // Most films have 3 or fewer genres; a handful run to 4-5, so cap the
  // display rather than let a rare outlier stretch the row.
  if (meta?.genres?.length) bits.push(meta.genres.slice(0, 2).join(', '));
  if (bits.length) text.append(el('span', 'film-meta', bits.join(' · ')));

  if (meta?.overview) text.append(el('span', 'film-description', meta.overview));

  row.append(text);

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
 * Screening time, once per member time zone - a visitor only sees their own
 * zone's version, picked from their browser's IANA zone, not all three.
 * The instant itself is real (data/schedule.json's scheduledFor); only the
 * zone-name label is hand-supplied rather than trusted from the browser,
 * since Intl's own abbreviations for these zones are inconsistent.
 */
const HERO_SCHEDULE_ZONES = [
  {
    tzNames: ['Australia/Melbourne', 'Australia/Sydney', 'Australia/Brisbane', 'Australia/Canberra', 'Australia/ACT'],
    ianaTz: 'Australia/Melbourne',
    label: 'AEST',
  },
  {
    tzNames: ['Australia/Adelaide', 'Australia/Broken_Hill'],
    ianaTz: 'Australia/Adelaide',
    label: 'ACST',
  },
  {
    tzNames: ['America/Los_Angeles', 'America/Vancouver', 'America/Tijuana'],
    ianaTz: 'America/Los_Angeles',
    label: 'PT',
  },
];

/** Falls back to the AEST anchor for a visitor outside the three tracked zones. */
function heroScheduleZone() {
  let viewerTz;
  try {
    viewerTz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    viewerTz = null;
  }
  return HERO_SCHEDULE_ZONES.find(z => z.tzNames.includes(viewerTz)) ?? HERO_SCHEDULE_ZONES[0];
}

/** Renders a real ISO instant as a {date, time} pair in the viewer's own zone. */
function formatSchedule(scheduledFor) {
  const zone = heroScheduleZone();
  const when = new Date(scheduledFor);
  const date = new Intl.DateTimeFormat('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', timeZone: zone.ianaTz,
  }).format(when);
  const time = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', minute: '2-digit', timeZone: zone.ianaTz,
  }).format(when);
  return { date, time: `${time} (${zone.label})` };
}

/**
 * Whoever picked last (data/schedule.json's picker) tells us whose turn is
 * next in data/members.json's rotation - falling back to the start of the
 * rotation if we can't place them (no prior pick recorded, or the roster
 * changed since).
 */
function nextPickerName(schedule, members) {
  const order = members?.order ?? [];
  if (!order.length) return null;
  const idx = order.indexOf(schedule?.picker);
  return idx === -1 ? order[0] : order[(idx + 1) % order.length];
}

/**
 * The upcoming pick, per data/schedule.json - shown until its scheduledFor
 * instant passes, at which point main() stops calling this and the film
 * just renders in its year section like any other archive entry.
 */
function renderHeroUpcoming(film, meta, imageBase, picker, scheduledFor) {
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
  if (meta?.genres?.length) bits.push(meta.genres.slice(0, 2).join(', '));
  if (meta?.runtime) bits.push(`${meta.runtime} min`);
  if (bits.length) info.append(el('p', 'hero-meta', bits.join(' · ')));
  if (picker) info.append(el('p', 'hero-picker', `Chosen by ${picker}`));
  body.append(info);

  const scheduleRow = el('div', 'hero-schedule-row');
  const schedule = formatSchedule(scheduledFor);
  const scheduleText = el('div', 'hero-schedule-text');
  scheduleText.append(el('p', 'hero-date', schedule.date));
  scheduleText.append(el('p', 'hero-time', schedule.time));
  scheduleRow.append(scheduleText);

  // Placeholder - not wired up to anything yet.
  const calendarBtn = el('button', 'hero-calendar-btn', '+ Add to Calendar');
  calendarBtn.type = 'button';
  scheduleRow.append(calendarBtn);
  body.append(scheduleRow);

  wrap.append(body);
  hero.append(wrap);

  updateBackdropExtent();
}

/**
 * Nobody has picked the next film yet - shown in place of the upcoming pick
 * once data/schedule.json has no film locked in, or its scheduledFor instant
 * has already passed. No poster to sample, so the backdrop just stays off.
 */
/**
 * A handful of ways to say "your turn" - picked deterministically per name
 * (a stable hash, not Math.random) so the same person gets the same one
 * every time they're up, rather than it changing on every reload.
 */
const HERO_WAITING_PHRASES = [
  name => `${name}, you're up!`,
  name => `Over to you, ${name}.`,
  name => `No pressure, ${name}.`,
];

// No poster to sample a colour from yet, so these are fixed seed palettes
// fed through the same vivify() pipeline a real poster's colours go
// through - one is picked per person (deterministically, like the phrase
// above) so it's not the same wash every time someone's up.
const HERO_WAITING_PALETTES = [
  [[200, 130, 80], [70, 100, 150], [120, 80, 140]],
  [[180, 60, 70], [60, 140, 120], [200, 170, 60]],
  [[90, 150, 110], [150, 90, 130], [70, 90, 160]],
  [[210, 90, 60], [80, 130, 170], [160, 140, 70]],
];

/** A stable hash of a name - same input, same index, every time. */
function hashName(name) {
  let hash = 0;
  for (const ch of name) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return hash;
}

function heroWaitingTitle(name) {
  if (!name) return 'Waiting on a pick';
  return HERO_WAITING_PHRASES[hashName(name) % HERO_WAITING_PHRASES.length](name);
}

function heroWaitingPalette(name) {
  return HERO_WAITING_PALETTES[name ? hashName(name) % HERO_WAITING_PALETTES.length : 0];
}

function renderHeroWaiting(pickerName) {
  const hero = document.getElementById('hero');
  hero.hidden = false;
  hero.replaceChildren();

  const wrap = el('div', 'hero-inner');

  wrap.append(el('div', 'hero-poster empty'));

  // Same source as the backdrop mesh below (--hero-rgb-1/2), so the blurred
  // poster placeholder and the wash behind it are always the same colours,
  // not two independent guesses.
  applyBackdrop(heroWaitingPalette(pickerName));

  const body = el('div', 'hero-body');
  const info = el('div', 'hero-info');
  info.append(el('p', 'hero-label', 'Waiting for Selection'));
  info.append(el('h2', 'hero-title', heroWaitingTitle(pickerName)));
  body.append(info);
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

function filmGridItem(film, meta, imageBase) {
  const li = el('li', 'film-grid-item');
  const poster = posterFor(imageBase, meta?.posterPath, film.title);
  li.append(meta?.imdbUrl ? imdbLink(meta.imdbUrl, poster, film.title) : poster);
  return li;
}

function yearSection(year, tmdb, pickers, { showHead = true } = {}) {
  const section = el('section', 'year');

  // Skipped when a single year is already picked via the filter above - its
  // chip already says which year this is, so the heading would just repeat it.
  if (showHead) {
    const head = el('div', 'year-head');
    const label = year.year === new Date().getFullYear() ? 'This Year' : String(year.year);
    head.append(el('h2', null, label));
    head.append(el('span', 'year-count', `${year.films.length} films`));
    section.append(head);
  }

  // Years run newest-first, and so do the films inside them, so scrolling
  // down is always travelling backwards in time. Letterboxd gives us the list
  // in the order films were added, i.e. oldest first, so reverse it.
  const imageBase = tmdb?.imageBase ?? 'https://image.tmdb.org/t/p';
  const list = el('ul', 'films');
  for (const film of [...year.films].reverse()) {
    const picker = pickers?.picks?.[`${year.year}:${film.slug}`];
    list.append(filmCard(film, tmdb?.films?.[film.slug], imageBase, picker));
  }
  section.append(list);
  return section;
}

/**
 * Year filter for the archive - a custom dropdown pill (not a native
 * <select>, so the open menu can be styled to match the rest of the page).
 * Reads "Year" until one's picked, then shows that year in white with a
 * round clear (x) button appearing to its left; clearing goes back to the
 * full archive rather than being another item in the menu.
 */
/**
 * One custom dropdown pill - the shared building block behind every archive
 * filter (year, genre, and whatever's added after). Reads `placeholder`
 * until a value is picked, then shows that value in white with a round
 * clear (x) button to its left. `onSelect(value)` fires with '' for
 * "nothing picked". Not a native <select> so the open menu can be styled to
 * match the rest of the page instead of the OS's own list chrome.
 */
/**
 * A dropdown pill that allows more than one value picked at once (e.g. two
 * genres) - clicking an option toggles it on or off and the menu stays open
 * so several picks can be made in one go. `onChange` fires with the full
 * current Set of selected values after every toggle.
 */
function createFilterPill(placeholder, onChange) {
  const group = el('div', 'filter-group');

  const toggle = el('button', 'pill-select-btn', placeholder);
  toggle.type = 'button';
  toggle.setAttribute('aria-haspopup', 'listbox');
  toggle.setAttribute('aria-expanded', 'false');

  const menu = el('div', 'pill-menu');
  menu.setAttribute('role', 'listbox');
  menu.hidden = true;

  // The scrolling happens on this inner wrapper, not on `menu` itself, so
  // the bottom-fade cue (an ::after on `menu`) stays pinned to the visible
  // edge instead of scrolling away with the options - an absolutely
  // positioned pseudo-element scrolls right along with its content when
  // it's a descendant of the element that actually has the overflow, so
  // it has to live on a non-scrolling ancestor instead.
  const menuList = el('div', 'pill-menu-list');
  menu.append(menuList);

  const selected = new Set();

  function closeMenu() {
    menu.hidden = true;
    toggle.setAttribute('aria-expanded', 'false');
  }

  function refreshOptions() {
    for (const opt of menuList.children) opt.classList.toggle('is-selected', selected.has(opt.dataset.value));
  }

  // The bottom fade should only show while there's more list below the fold
  // - not once you've scrolled to the true end, and not at all if everything
  // already fits without scrolling.
  function updateFade() {
    const canScrollDown = menuList.scrollHeight - menuList.scrollTop - menuList.clientHeight > 1;
    menu.classList.toggle('pill-menu--fade-bottom', canScrollDown);
  }
  menuList.addEventListener('scroll', updateFade);

  function toggleValue(value) {
    if (selected.has(value)) selected.delete(value);
    else selected.add(value);
    refreshOptions();
    onChange(new Set(selected));
  }

  function option(value, label) {
    const opt = el('button', 'pill-menu-option', label);
    opt.type = 'button';
    opt.dataset.value = value;
    opt.addEventListener('click', () => toggleValue(value));
    return opt;
  }

  toggle.addEventListener('click', () => {
    const isHidden = menu.hidden;
    menu.hidden = !isHidden;
    toggle.setAttribute('aria-expanded', String(isHidden));
    if (isHidden) updateFade(); // just opened - menuList had no layout while hidden
  });

  document.addEventListener('click', e => {
    if (!group.contains(e.target)) closeMenu();
  });

  group.append(toggle, menu);

  return {
    element: group,
    setOptions(values) {
      menuList.replaceChildren(...values.map(v => option(v, v)));
      refreshOptions();
      updateFade();
    },
    remove(value) {
      selected.delete(value);
      refreshOptions();
      onChange(new Set(selected));
    },
  };
}

/**
 * Wires up the archive's filter bar - a year pill and a genre pill so far,
 * each allowing multiple picks. Every picked value shows up as its own chip
 * underneath, with its own remove (x), so a query can be built up freely
 * (e.g. "2022" + "2023" + "Action"). Values within one filter combine with
 * OR (either year matches), different filters combine with AND (must match
 * the year picks AND the genre picks), and a year left with nothing after
 * the genre filter just drops out, same as any other empty year.
 */
function setupArchiveFilters(archive, container, tmdb, pickers) {
  const bar = document.getElementById('year-filters');
  const chipsRow = document.getElementById('filter-chips');
  if (!bar) return;
  bar.replaceChildren();
  if (chipsRow) { chipsRow.replaceChildren(); chipsRow.hidden = true; }
  if (!archive.length) return;

  const state = { member: new Set(), genre: new Set(), country: new Set() };
  const pills = {};
  const chipLabels = { member: 'Member', genre: 'Genre', country: 'Country' };
  let view = 'list';

  function render() {
    // Genre is a tag on the film itself, so multiple genres combine with
    // AND - a film only shows once it matches every genre picked, not just
    // one of them. Member is a single-valued-per-film attribute (a film
    // only ever has one picker), so multiple members combine with OR -
    // either one's pick shows. Country is a tag like genre, but a
    // co-production listing two countries is still "made in either", so
    // multiple picks combine with OR rather than AND.
    const shown = archive
      .map(year => ({
        ...year,
        films: year.films.filter(f => {
          const filmGenres = tmdb?.films?.[f.slug]?.genres ?? [];
          const genreMatch = state.genre.size === 0 || [...state.genre].every(g => filmGenres.includes(g));
          const picker = pickers?.picks?.[`${year.year}:${f.slug}`];
          const memberMatch = state.member.size === 0 || (picker != null && state.member.has(picker));
          const filmCountries = tmdb?.films?.[f.slug]?.countries ?? [];
          const countryMatch = state.country.size === 0 || filmCountries.some(c => state.country.has(c));
          return genreMatch && memberMatch && countryMatch;
        }),
      }))
      .filter(year => year.films.length > 0);

    if (!shown.length) {
      container.replaceChildren(el('p', 'no-results', 'No results match those filters.'));
      return;
    }

    if (view === 'grid') {
      // No year sections here - every matching poster flows into one
      // continuous grid, newest year first and oldest-to-newest within
      // each year (same overall order the list view uses, just without
      // the headers breaking it up).
      const imageBase = tmdb?.imageBase ?? 'https://image.tmdb.org/t/p';
      const grid = el('ul', 'films-grid');
      for (const year of shown) {
        for (const film of [...year.films].reverse()) {
          grid.append(filmGridItem(film, tmdb?.films?.[film.slug], imageBase));
        }
      }
      container.replaceChildren(grid);
      return;
    }

    container.replaceChildren(...shown.map(year => yearSection(year, tmdb, pickers)));
  }

  function renderChips() {
    if (!chipsRow) return;
    const chips = Object.entries(state).flatMap(([key, values]) => [...values].map(value => [key, value]));
    chipsRow.replaceChildren(...chips.map(([key, value]) => {
      const chip = el('span', 'filter-chip');
      chip.append(document.createTextNode(value));
      const remove = el('button', 'filter-chip-remove', '×');
      remove.type = 'button';
      remove.setAttribute('aria-label', `Remove ${chipLabels[key]} filter (${value})`);
      remove.addEventListener('click', () => pills[key].remove(value));
      chip.append(remove);
      return chip;
    }));
    chipsRow.hidden = chips.length === 0;
  }

  function onFilterChange(key) {
    return values => {
      state[key] = values;
      render();
      renderChips();
    };
  }

  const members = [...new Set(
    archive.flatMap(year => year.films.map(f => pickers?.picks?.[`${year.year}:${f.slug}`]).filter(Boolean)),
  )].sort();
  if (members.length) {
    const memberPill = createFilterPill('Member', onFilterChange('member'));
    memberPill.setOptions(members);
    pills.member = memberPill;
    bar.append(memberPill.element);
  }

  const genres = [...new Set(
    archive.flatMap(year => year.films.flatMap(f => tmdb?.films?.[f.slug]?.genres ?? [])),
  )].sort();
  if (genres.length) {
    const genrePill = createFilterPill('Genre', onFilterChange('genre'));
    genrePill.setOptions(genres);
    pills.genre = genrePill;
    bar.append(genrePill.element);
  }

  const countries = [...new Set(
    archive.flatMap(year => year.films.flatMap(f => tmdb?.films?.[f.slug]?.countries ?? [])),
  )].sort();
  if (countries.length) {
    const countryPill = createFilterPill('Country', onFilterChange('country'));
    countryPill.setOptions(countries);
    pills.country = countryPill;
    bar.append(countryPill.element);
  }

  const viewToggle = document.getElementById('view-toggle');
  if (viewToggle) {
    const buttons = [...viewToggle.querySelectorAll('.view-toggle-btn')];
    for (const button of buttons) {
      button.addEventListener('click', () => {
        if (button.dataset.view === view) return;
        view = button.dataset.view;
        for (const b of buttons) b.classList.toggle('is-active', b === button);
        render();
      });
    }
  }

  render();
  renderChips();
}

/* ------------------------------------------------------------------------
 * Stats page content - a grab-bag of facts pulled from the same archive,
 * tmdb and pickers data the rest of the page already uses, so nothing here
 * needs re-fetching or hand-updating as the list grows.
 * ---------------------------------------------------------------------- */
function computeStats(archive, tmdb, pickers, members) {
  const tf = tmdb?.films ?? {};
  const allFilms = archive.flatMap(y => y.films.map(f => ({ ...f, watchYear: y.year, meta: tf[f.slug] })));
  const total = allFilms.length;

  const watchYears = archive.map(y => y.year);
  const firstYear = Math.min(...watchYears);
  const lastYear = Math.max(...watchYears);

  const withRuntime = allFilms.filter(f => f.meta?.runtime);
  const totalMinutes = withRuntime.reduce((n, f) => n + f.meta.runtime, 0);
  const avgRuntime = withRuntime.length ? Math.round(totalMinutes / withRuntime.length) : null;
  const longest = withRuntime.length ? withRuntime.reduce((a, b) => (b.meta.runtime > a.meta.runtime ? b : a)) : null;
  const shortest = withRuntime.length ? withRuntime.reduce((a, b) => (b.meta.runtime < a.meta.runtime ? b : a)) : null;

  function tally(getValues) {
    const counts = new Map();
    for (const f of allFilms) for (const v of getValues(f) ?? []) counts.set(v, (counts.get(v) ?? 0) + 1);
    return counts;
  }
  function top(counts, { exclude } = {}) {
    const entries = [...counts.entries()].filter(([k]) => k !== exclude);
    if (!entries.length) return null;
    const max = Math.max(...entries.map(([, n]) => n));
    return { names: entries.filter(([, n]) => n === max).map(([k]) => k).sort(), count: max };
  }

  const genreCounts = tally(f => f.meta?.genres);
  const topGenre = top(genreCounts);

  const directorCounts = tally(f => f.meta?.directors);
  const topDirector = top(directorCounts);

  const countryCounts = tally(f => f.meta?.countries);
  const withCountries = allFilms.filter(f => f.meta?.countries?.length);
  const usFilms = withCountries.filter(f => f.meta.countries.includes('United States of America')).length;
  const pctNonUs = withCountries.length ? Math.round(((withCountries.length - usFilms) / withCountries.length) * 100) : null;
  const topForeignCountry = top(countryCounts, { exclude: 'United States of America' });

  const yearCounts = new Map(archive.map(y => [y.year, y.films.length]));
  const busiestYearCount = Math.max(...yearCounts.values());
  const busiestYears = [...yearCounts.entries()].filter(([, n]) => n === busiestYearCount).map(([y]) => y).sort();

  const withRelease = allFilms.filter(f => f.meta?.releaseDate);
  function extremeByRelease(better) {
    if (!withRelease.length) return null;
    const pick = withRelease.reduce((a, b) => (better(b.meta.releaseDate, a.meta.releaseDate) ? b : a));
    const year = pick.meta.releaseDate.slice(0, 4);
    const ties = withRelease.filter(f => f.meta.releaseDate.slice(0, 4) === year);
    return { year, films: ties };
  }
  const oldest = extremeByRelease((b, a) => b < a);
  const newest = extremeByRelease((b, a) => b > a);

  const pickCounts = new Map((members?.order ?? []).map(name => [name, 0]));
  let attributed = 0;
  for (const f of allFilms) {
    const picker = pickers?.picks?.[`${f.watchYear}:${f.slug}`];
    if (picker) {
      attributed++;
      pickCounts.set(picker, (pickCounts.get(picker) ?? 0) + 1);
    }
  }
  const pickerBoard = [...pickCounts.entries()].sort((a, b) => b[1] - a[1]);

  return {
    total, firstYear, lastYear, totalMinutes, avgRuntime, longest, shortest,
    topGenre, topDirector, numCountries: countryCounts.size, pctNonUs, topForeignCountry,
    busiestYears, busiestYearCount, oldest, newest, attributed, pickerBoard,
  };
}

function renderStatsPage(archive, tmdb, pickers, members) {
  const page = document.getElementById('stats-page');
  if (!page) return;
  if (!archive.length) { page.replaceChildren(); return; }

  const s = computeStats(archive, tmdb, pickers, members);

  // Reserved for later: the full fact set below is still computed by
  // computeStats() above, just not rendered yet. Re-introduce these one at a
  // time as their own elements alongside the hero number, rather than going
  // back to a single dumped list.
  //
  //   `${s.total} films watched over ${s.lastYear - s.firstYear + 1} seasons, ${s.firstYear}-${s.lastYear}.`
  //   `${days} straight days of movies` (s.totalMinutes / 60 / 24)
  //   `${s.avgRuntime} minutes is the average runtime.`
  //   longest / shortest film (s.longest, s.shortest)
  //   top genre (s.topGenre)
  //   top director(s) (s.topDirector)
  //   country count / % non-US / top foreign country (s.numCountries, s.pctNonUs, s.topForeignCountry)
  //   busiest season (s.busiestYears, s.busiestYearCount)
  //   oldest / newest film (s.oldest, s.newest)
  //   picker leaderboard / unattributed count (s.pickerBoard, s.attributed)

  const minutes = s.totalMinutes || null;

  // Values arrive pre-formatted (not raw numbers) so a year like 1985 never
  // picks up a thousands comma the way toLocaleString() would give it.
  // `text: true` is for a headline that's a title/name rather than a short
  // number - smaller, looser letter-spacing, allowed to wrap.
  // `heading` is an optional label ABOVE the number (same treatment as
  // "Waiting for Selection" above the hero) - for a stat like longest/
  // shortest where the number alone doesn't say what it's the number of.
  // `sub` is a third, quieter tier below the label - for a detail (a film
  // title) that belongs to the stat but shouldn't shout like the label does.
  function statItem(display, label, { text = false, sub = null, heading = null } = {}) {
    const item = el('div', 'stats-hero-item');
    if (heading) item.append(el('span', 'hero-label', heading));
    item.append(
      el('span', text ? 'stats-hero-number stats-hero-number--text' : 'stats-hero-number', display != null ? display : '\u2014'),
      el('span', 'hero-label', label),
    );
    if (sub) item.append(el('span', 'stats-hero-sub', sub));
    return item;
  }

  const hero = el('div', 'stats-hero');
  hero.append(
    statItem(s.total.toLocaleString(), 'movies'),
    statItem(minutes != null ? minutes.toLocaleString() : null, 'minutes'),
    statItem(s.oldest ? String(s.oldest.year) : null, 'oldest movie'),
    statItem(s.longest ? String(s.longest.meta.runtime) : null, 'minutes', { heading: 'longest movie', sub: s.longest?.title }),
    statItem(s.shortest ? String(s.shortest.meta.runtime) : null, 'minutes', { heading: 'shortest movie', sub: s.shortest?.title }),
    statItem(s.topGenre ? s.topGenre.names.join(' / ') : null, s.topGenre ? `${s.topGenre.count} films` : 'top genre', { text: true }),
  );
  page.replaceChildren(hero);
}

/* ------------------------------------------------------------------------
 * Stats page toggle - a full-bleed overlay that swaps in for the normal
 * page content. main fades out (not away - it stays in the DOM, just faded
 * and unclickable) rather than being removed, so the backdrop effect
 * behind it keeps running untouched; the stats page fades in over the top
 * of it.
 * ---------------------------------------------------------------------- */
function setupStatsPage() {
  const toggle = document.getElementById('stats-toggle');
  const page = document.getElementById('stats-page');
  if (!toggle || !page) return;

  // The bar-chart icon is the closed ("Stats") state - saved here so close()
  // can restore it, since open() overwrites it with the × glyph.
  const iconMarkup = toggle.innerHTML;

  let hideTimer;

  // The button jumps from top-right to top-left (and back) on click without
  // the mouse moving, so the browser has nothing to prompt it to re-check
  // whether the cursor is still over the button - it just leaves :hover
  // switched on at the old position's coordinates. Toggling pointer-events
  // off and back forces a re-check on the next frame, against wherever the
  // mouse actually is now.
  function dropStaleHover() {
    toggle.style.pointerEvents = 'none';
    requestAnimationFrame(() => { toggle.style.pointerEvents = ''; });
  }

  function open() {
    clearTimeout(hideTimer);
    page.hidden = false;
    // Force layout so the browser commits "no longer hidden" before the
    // class flip below - otherwise it can coalesce both into one frame and
    // the opacity change has nothing to transition from.
    void page.offsetHeight;
    document.body.classList.add('stats-open');
    page.setAttribute('aria-hidden', 'false');
    toggle.setAttribute('aria-pressed', 'true');
    toggle.setAttribute('aria-label', 'Close stats');
    toggle.textContent = '×';
    dropStaleHover();
  }

  function close() {
    document.body.classList.remove('stats-open');
    page.setAttribute('aria-hidden', 'true');
    toggle.setAttribute('aria-pressed', 'false');
    toggle.setAttribute('aria-label', 'View stats');
    toggle.innerHTML = iconMarkup;
    dropStaleHover();
    // Matches the .4s opacity transition in CSS - only actually hide (so it
    // drops out of layout/tab order) once the fade-out has finished.
    hideTimer = setTimeout(() => { page.hidden = true; }, 400);
  }

  toggle.addEventListener('click', () => {
    if (document.body.classList.contains('stats-open')) close();
    else open();
  });
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
 * TEMP: one floating settings panel (bottom-right) bundling the hero-state
 * override, the random-poster preview, and the backdrop effect sliders,
 * so there's a single toggle instead of three separate widgets scattered
 * around the page. Delete this whole block (and its call in main()) once
 * everything above is settled.
 * ---------------------------------------------------------------------- */
function setupDebugPanel({ allFilms, tmdb, imageBase, upcoming, waitingName }) {
  const rootStyle = document.documentElement.style;

  const panel = document.createElement('div');
  panel.style.cssText = [
    'position: fixed', 'bottom: 60px', 'right: 12px', 'z-index: 999',
    'width: min(20rem, calc(100vw - 24px))', 'max-height: 70vh', 'overflow: auto',
    'padding: .9rem 1rem', 'border-radius: 12px',
    'border: 1px solid rgba(127,127,127,.4)', 'background: rgba(20,20,20,.85)',
    'color: #eee', 'backdrop-filter: blur(10px)', 'font-family: inherit',
    'font-size: .75rem', 'display: none', 'flex-direction: column', 'gap: .9rem',
  ].join(';');

  const toggle = document.createElement('button');
  toggle.textContent = '⚙️ settings';
  toggle.style.cssText = [
    'position: fixed', 'bottom: 12px', 'right: 12px', 'z-index: 999',
    'padding: .5rem .9rem', 'font-size: .75rem', 'border-radius: 999px',
    'border: 1px solid rgba(127,127,127,.4)', 'background: rgba(127,127,127,.2)',
    'color: inherit', 'backdrop-filter: blur(6px)', 'cursor: pointer',
    'font-family: inherit',
  ].join(';');
  toggle.addEventListener('click', () => {
    panel.style.display = panel.style.display === 'none' ? 'flex' : 'none';
  });

  function sectionLabel(text) {
    const h = document.createElement('div');
    h.textContent = text;
    h.style.cssText = [
      'font-weight: 600', 'letter-spacing: .08em', 'text-transform: uppercase',
      'font-size: .65rem', 'opacity: .6',
    ].join(';');
    return h;
  }

  function actionButton(label, onClick) {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = [
      'padding: .4rem .8rem', 'font-size: .7rem', 'border-radius: 999px',
      'border: 1px solid rgba(127,127,127,.4)', 'background: rgba(127,127,127,.2)',
      'color: inherit', 'cursor: pointer', 'font-family: inherit',
    ].join(';');
    b.addEventListener('click', onClick);
    return b;
  }

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

  // --- hero state override ---
  const stateRow = document.createElement('div');
  stateRow.style.cssText = 'display:flex; gap:.4rem; flex-wrap:wrap;';
  if (upcoming) {
    stateRow.append(actionButton('▶ Upcoming', () => {
      renderHeroUpcoming(upcoming.film, upcoming.meta, upcoming.imageBase, upcoming.picker, upcoming.scheduledFor);
    }));
  }
  stateRow.append(actionButton('⏳ Waiting', () => {
    renderHeroWaiting(waitingName);
  }));
  panel.append(sectionLabel('Hero state'), stateRow);

  // --- random poster preview ---
  const candidates = allFilms.filter(f => tmdb?.films?.[f.slug]?.posterPath);
  if (candidates.length) {
    const posterRow = document.createElement('div');
    posterRow.append(actionButton('🎲 Random poster', () => {
      const film = candidates[Math.floor(Math.random() * candidates.length)];
      // Preview only - a made-up near-future instant, not real schedule data.
      const fakeScheduledFor = new Date(Date.now() + 86400000).toISOString();
      renderHeroUpcoming(film, tmdb.films[film.slug], imageBase, null, fakeScheduledFor);
    }));
    panel.append(sectionLabel('Preview'), posterRow);
  }

  // --- backdrop effect sliders ---
  panel.append(
    sectionLabel('Effect controls'),
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

  setupStatsPage();

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
  // The current pick cycle - who picked (or picked last), which film (once
  // decided) and when it screens. Missing just means "waiting, no name yet".
  const schedule = await loadJson('data/schedule.json', { required: false });
  // The pick rotation, oldest to newest turn - for working out whose turn is
  // next once a screening passes with nothing queued up after it.
  const members = await loadJson('data/members.json', { required: false });

  const imageBase = tmdb?.imageBase ?? 'https://image.tmdb.org/t/p';
  const years = [...(films.years ?? [])].sort((a, b) => b.year - a.year)
    .map(y => ({ ...y, films: [...y.films] }));

  // Find the film data/schedule.json points at, if any - independent of
  // whether its scheduledFor instant has actually passed, so the debug
  // override below can still preview it even once it has.
  let scheduledYear = null;
  let scheduledFilm = null;
  if (schedule?.pick) {
    scheduledYear = years.find(y => y.year === schedule.pick.year) ?? null;
    scheduledFilm = scheduledYear?.films.find(f => f.slug === schedule.pick.slug) ?? null;
  }

  // "Upcoming" only while that instant is still ahead of us. Once it
  // passes, we simply stop lifting the film out of its year here - it
  // renders in the archive like anything else, no separate step needed.
  const scheduledDate = schedule?.scheduledFor ? new Date(schedule.scheduledFor) : null;
  const isUpcoming = Boolean(scheduledFilm && scheduledDate && scheduledDate.getTime() > Date.now());

  if (isUpcoming) {
    scheduledYear.films.splice(scheduledYear.films.indexOf(scheduledFilm), 1);
    renderHeroUpcoming(scheduledFilm, tmdb?.films?.[scheduledFilm.slug], imageBase, schedule.picker, schedule.scheduledFor);
  } else {
    renderHeroWaiting(nextPickerName(schedule, members));
  }

  // A year emptied by lifting the upcoming pick out has nothing left to show.
  const archive = years.filter(y => y.films.length > 0);

  const total = archive.reduce((n, y) => n + y.films.length, 0);
  const since = archive.length ? archive.at(-1).year : '';
  stats.textContent = `${total} movies since ${since}`;

  setupArchiveFilters(archive, container, tmdb, pickers);
  renderStatsPage(archive, tmdb, pickers, members);

  document.getElementById('tmdb-note').textContent =
    tmdb?.note ?? 'Posters and credits from TMDB.';

  // TEMP — see the block above.
  setupDebugPanel({
    allFilms: (films.years ?? []).flatMap(y => y.films),
    tmdb,
    imageBase,
    upcoming: scheduledFilm
      ? { film: scheduledFilm, meta: tmdb?.films?.[scheduledFilm.slug], imageBase, picker: schedule.picker, scheduledFor: schedule.scheduledFor }
      : null,
    waitingName: nextPickerName(schedule, members),
  });
}

main();
