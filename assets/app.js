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

// The club's Discord channel, for the calendar invite's location field.
const DISCORD_CHAT_URL = 'https://discord.com/channels/216826370662072320/216826370662072321';

// Plus/minus icons for each accordion row in the mobile filter overlay
// (see overlaySection() below) - plus while collapsed, minus once
// expanded, swapped outright rather than one glyph rotated 180deg.
const FILTER_EXPAND_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="M12 5v14"/></svg>';
const FILTER_COLLAPSE_SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/></svg>';

/* ------------------------------------------------------------------------
 * Easter egg: click the "o" in "movies" in the header ("122 movies" - it
 * turns into a popcorn kernel on hover) to drop a screen full of popcorn.
 * Kernels fall from the top and pile up at the bottom, then after a short
 * pause pop into popcorn and fill the whole screen.
 * ---------------------------------------------------------------------- */
// 9 variants each (from the two 3x3 sprite sheets Chris generated) rather
// than one fixed shape, so a screen full of pieces doesn't look like a
// stamped repeating pattern.
const POPCORN_KERNEL_SRCS = Array.from({ length: 9 }, (_, i) => `assets/effects/kernel-${i + 1}.png`);
const POPCORN_POPPED_SRCS = Array.from({ length: 9 }, (_, i) => `assets/effects/popcorn-${i + 1}.png`);
const randomOf = arr => arr[Math.floor(Math.random() * arr.length)];
// One kernel per movie in the archive, up to a ceiling - set once main()
// knows the real count; this fallback only matters if somehow triggered
// before that. The ceiling exists because this used to be an uncapped
// 1:1 with the archive size (122 and growing) - Chris had it crash on iOS
// Safari ("a problem repeatedly occurred", i.e. the page's content
// process got killed and kept restarting), which fits: that many
// concurrently-animated <img> pieces each becomes its own composited
// layer, and mobile Safari's per-tab GPU/memory budget is a lot tighter
// than desktop's. Capping the count is a blunter fix than rewriting this
// to a single <canvas> (which would dodge the per-element layer cost
// entirely), but it directly cuts the thing actually driving the crash
// and keeps the effect exactly as simple as it already was.
const POPCORN_MAX_KERNELS = 70;
let POPCORN_KERNEL_COUNT = 10;

/**
 * Runs several popped-popcorn bodies through gravity + floor/wall bounces
 * AND pairwise collisions with each other, all in one shared loop, so a
 * growing piece actually pushes its neighbours out of the way instead of
 * just overlapping them - which is what makes the result read as a pile
 * that stacks up rather than a flat mosaic of circles.
 */
// Speed below which a body is considered "at rest" for sleep purposes,
// and how many consecutive slow frames it takes to actually fall asleep -
// a couple of frames of coincidental slowness shouldn't freeze something
// that's still actively settling.
const POPCORN_SLEEP_SPEED = 20;
const POPCORN_SLEEP_FRAMES = 12;
// How hard an awake neighbour has to be moving to jolt a sleeping piece
// back awake - gentle nudges from something still settling shouldn't
// wake it, but a freshly-popped kernel slamming into it should.
const POPCORN_WAKE_SPEED = 180;
// How many frames a just-popped piece gets to punch its way clear of the
// pile before normal collision damping applies to it. Without this, a
// kernel that pops while surrounded on several sides (deep in a crowded
// pile) gets hit with that damping once per overlapping neighbour in the
// very same frame it pops - several multiplications compounding at once -
// and never actually leaves the spot it popped in. A short grace window
// lets it shove through first and only then start behaving like every
// other settling piece.
const POPCORN_LAUNCH_FRAMES = 9;

function runPopcornPile(bodies, overlay, { duration = 4200, onAllSettled = null } = {}) {
  const start = performance.now();
  let lastT = null;
  let settled = false;

  function step(t) {
    const dt = Math.min((t - (lastT ?? t)) / 1000, 0.032); // clamp big gaps
    lastT = t;
    // The overlay's own box, not window.innerWidth/innerHeight - on mobile
    // Safari the window size reflects the small/visible viewport (above the
    // address bar), while the overlay is sized in CSS to the large viewport
    // (see .popcorn-overlay), so reading the overlay directly is what makes
    // the pile actually fall all the way to the true bottom of the page.
    const vw = overlay.clientWidth;
    const vh = overlay.clientHeight;

    for (const b of bodies) {
      // Asleep bodies are frozen outright - no gravity, no drift, nothing
      // to slowly decay - which is what actually stops the endless
      // micro-jitter a purely position-corrected pile never settles out
      // of on its own (gravity keeps adding a little energy back in every
      // single frame otherwise, forever).
      if (b.asleep) continue;

      if (b.launchFrames > 0) b.launchFrames--;

      b.vy += b.gravity * dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.angle += b.angularVel * dt;
      // Spin bleeds off continuously (like air resistance / friction
      // against whatever it's resting on), not just on a floor bounce -
      // otherwise a piece resting on TOP of the pile, never touching the
      // actual floor again, would spin forever with nothing to slow it.
      b.angularVel *= Math.exp(-3 * dt);

      const floorY = vh - b.size;
      if (b.y > floorY) {
        b.y = floorY;
        b.vy = -b.vy * b.restitution;
        b.vx *= 0.7;
        b.angularVel *= 0.6;
      }
      if (b.x < 0) {
        b.x = 0;
        b.vx = -b.vx * b.restitution;
      } else if (b.x > vw - b.size) {
        b.x = vw - b.size;
        b.vx = -b.vx * b.restitution;
      }
    }

    // Pairwise collisions - push overlapping pieces apart along the line
    // between their centres. O(n^2), but n tops out at POPCORN_MAX_KERNELS
    // and this only runs for a few seconds.
    //
    // A single correction pass per frame isn't enough once three or more
    // pieces are wedged against each other (or against a wall/floor) at
    // once: resolving A-vs-B can shove A right back into overlapping C,
    // and resolving A-vs-C can shove it back into B, so a piece squeezed
    // into a tight spot never actually reaches zero overlap - it just gets
    // pushed a little one way, then the other, forever. That's the
    // aggressive vibration on pieces stuck between others. Running the
    // position correction several times per frame (a standard fix for
    // exactly this - more "relaxation" passes before moving on) lets a
    // wedged piece actually converge on a stable, non-overlapping spot
    // within the same frame instead of oscillating between two competing
    // half-fixes frame after frame. Velocity damping and the sleep/wake
    // handoff only need to happen once per frame though - repeating those
    // every pass would just damp speeds to nothing - so only the first
    // pass touches vx/vy; the rest are position-only.
    const COLLISION_ITERATIONS = 4;
    for (let iter = 0; iter < COLLISION_ITERATIONS; iter++) {
      const applyImpulse = iter === 0;
      for (let i = 0; i < bodies.length; i++) {
        const a = bodies[i];
        const acx = a.x + a.size / 2;
        const acy = a.y + a.size / 2;
        for (let j = i + 1; j < bodies.length; j++) {
          const c = bodies[j];
          if (a.asleep && c.asleep) continue; // neither can move - nothing to resolve
          const ccx = c.x + c.size / 2;
          const ccy = c.y + c.size / 2;
          let dx = ccx - acx;
          let dy = ccy - acy;
          const dist = Math.hypot(dx, dy) || 0.01;
          // A little overlap is allowed - real popcorn nests into itself
          // rather than sitting as perfectly separated circles - but not
          // much: 0.5 is where two circles that size would just touch, so
          // this stays close to that rather than letting them sink deep
          // into each other, which was making the pile look overly dense
          // and, with that much overlap to correct every frame, jigglier.
          const minDist = (a.size + c.size) * 0.48;
          if (dist >= minDist) continue;

          dx /= dist;
          dy /= dist;
          const overlap = minDist - dist;

          if (a.asleep || c.asleep) {
            // Treat the sleeping one as immovable - the awake one absorbs
            // the whole correction - unless the awake one is hitting it
            // hard enough (a fresh pop, not just a slow settle) to justify
            // waking it back up and handing it a share of that momentum.
            const sleeper = a.asleep ? a : c;
            const mover = a.asleep ? c : a;
            const sign = a.asleep ? 1 : -1;
            mover.x += sign * dx * overlap;
            mover.y += sign * dy * overlap;
            if (applyImpulse) {
              const moverSpeed = Math.hypot(mover.vx, mover.vy);
              if (moverSpeed > POPCORN_WAKE_SPEED) {
                sleeper.asleep = false;
                sleeper.restFrames = 0;
                sleeper.vx = sign * dx * moverSpeed * 0.4;
                sleeper.vy = sign * dy * moverSpeed * 0.4;
                if (!(mover.launchFrames > 0)) {
                  mover.vx *= 0.6;
                  mover.vy *= 0.6;
                }
              } else if (!(mover.launchFrames > 0)) {
                mover.vx *= 0.9;
                mover.vy *= 0.9;
              }
            }
          } else {
            const push = overlap / 2;
            a.x -= dx * push;
            a.y -= dy * push;
            c.x += dx * push;
            c.y += dy * push;
            if (applyImpulse) {
              if (!(a.launchFrames > 0)) { a.vx *= 0.9; a.vy *= 0.9; }
              if (!(c.launchFrames > 0)) { c.vx *= 0.9; c.vy *= 0.9; }
            }
          }
        }
      }
    }

    // A body that's stayed slow for long enough goes to sleep (see above).
    for (const b of bodies) {
      if (b.asleep) continue;
      const speed = Math.hypot(b.vx, b.vy);
      if (speed < POPCORN_SLEEP_SPEED) {
        b.restFrames = (b.restFrames ?? 0) + 1;
        if (b.restFrames > POPCORN_SLEEP_FRAMES) {
          b.asleep = true;
          b.vx = 0;
          b.vy = 0;
          b.angularVel = 0;
        }
      } else {
        b.restFrames = 0;
      }
    }

    for (const b of bodies) {
      b.piece.style.transform = `translate(${b.x}px, ${b.y}px) rotate(${b.angle}deg)`;
    }

    // Once nothing's moving, let whoever asked know - once. This is one
    // continuous loop for the kernels' whole life (fall, pile up, pop,
    // resettle), so unlike a one-shot animation this doesn't stop here;
    // popping later just mutates these same bodies in place, and they
    // keep colliding with everything else in the array throughout.
    if (onAllSettled && !settled && bodies.length > 0 && t - start > 200) {
      const allSlow = bodies.every(b => Math.abs(b.vx) < 15 && Math.abs(b.vy) < 15);
      if (allSlow) {
        settled = true;
        onAllSettled();
      }
    }

    if (t - start < duration) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

/** The effect itself - kernels fall and pile, then pop and fill the screen. */
function triggerPopcornEffect() {
  if (document.querySelector('.popcorn-overlay')) return; // already running

  const overlay = el('div', 'popcorn-overlay');
  document.body.append(overlay);

  function makePiece(src, size) {
    const piece = document.createElement('img');
    piece.src = src;
    piece.alt = '';
    piece.className = 'popcorn-piece';
    piece.style.width = `${size}px`;
    piece.style.height = `${size}px`;
    return piece;
  }

  // Every kernel is one physics body for its entire life - falling,
  // piling up, popping, and resettling all happen to the same object in
  // the same array, run through one continuous simulation below. That's
  // what makes a popping kernel actually shove its still-unpopped
  // neighbours out of the way: they're all in the same collision system
  // the whole time, nothing "joins late" or falls through anything else.
  const KERNEL_COUNT = POPCORN_KERNEL_COUNT;
  const kernels = [];

  for (let i = 0; i < KERNEL_COUNT; i++) {
    const size = 18 + Math.random() * 14;
    const piece = makePiece(randomOf(POPCORN_KERNEL_SRCS), size);
    overlay.append(piece);

    kernels.push({
      piece,
      x: Math.random() * (overlay.clientWidth - size),
      y: -size - Math.random() * 200, // staggers the entrance a little
      size,
      vx: 0,
      vy: 0,
      gravity: 2000 + Math.random() * 700,
      restitution: 0.3 + Math.random() * 0.3,
      angle: 0,
      angularVel: (Math.random() - 0.5) * 420,
      asleep: false,
      restFrames: 0,
      launchFrames: 0,
    });
  }

  // Pop timing (below) needs the whole 10s + 5s window plus room to
  // settle at the end - the one physics loop runs for all of it.
  const SLOW_WINDOW_MS = 10000;
  const FAST_WINDOW_MS = 5000;
  const TOTAL_POP_WINDOW_MS = SLOW_WINDOW_MS + FAST_WINDOW_MS;

  runPopcornPile(kernels, overlay, {
    duration: 6000 + TOTAL_POP_WINDOW_MS + 4500,
    onAllSettled: () => setTimeout(startPopping, 500),
  });

  // Safety net in case the fall never fully settles (a background tab,
  // say) - the show goes on regardless.
  setTimeout(() => { if (!started) startPopping(); }, 5200);

  let started = false;
  function startPopping() {
    if (started) return;
    started = true;

    // Every popped piece is the same size (popping is what makes that
    // true in real life too - it's the kernel size that varies, not the
    // popped result), scaled to the viewport rather than a fixed pixel
    // count so it looks about the same on a phone and a monitor.
    const POPPED_SIZE = Math.min(90, Math.max(50, overlay.clientWidth * 0.06));

    function popOne(k) {
      k.piece.src = randomOf(POPCORN_POPPED_SRCS);
      // Growth centred on wherever the kernel actually settled (rather
      // than growing down-and-right from its top-left corner) so it
      // erupts outward from that spot instead of sliding off toward a
      // corner. k is still the exact same body the shared simulation has
      // been tracking the whole time - mutating it in place here is what
      // lets the very next physics frame immediately start pushing
      // whichever neighbours it now overlaps.
      const growBy = POPPED_SIZE - k.size;
      k.x -= growBy / 2;
      k.y -= growBy / 2;
      k.size = POPPED_SIZE;
      k.piece.style.width = `${POPPED_SIZE}px`;
      k.piece.style.height = `${POPPED_SIZE}px`;
      k.piece.style.zIndex = String(Math.round(POPPED_SIZE));
      // A vigorous hop in a random horizontal direction too, not just
      // straight up and down - a popping kernel kicks sideways as often
      // as not, and hard enough to actually be noticeable, shoving
      // whatever's nearby (popped or not) out of the way. A random
      // "power" scalar on top of that means pops vary in intensity too -
      // some just hop, some really fly - rather than every single one
      // landing in the same narrow range.
      const power = 0.65 + Math.random() * 0.95;
      k.vx = (Math.random() - 0.5) * 2 * (600 + Math.random() * 500) * power;
      k.vy = -(800 + Math.random() * 700) * power;
      k.gravity = 2600;
      k.restitution = 0.35 + Math.random() * 0.2;
      k.angularVel = (Math.random() - 0.5) * 260;
      // A kernel that had already gone to sleep mid-pile needs waking up
      // explicitly - otherwise the physics loop would just skip it and it
      // would sit there popped but frozen in its old kernel spot.
      k.asleep = false;
      k.restFrames = 0;
      // A brief grace window to actually punch clear of the pile before
      // normal collision damping kicks back in (see POPCORN_LAUNCH_FRAMES).
      k.launchFrames = POPCORN_LAUNCH_FRAMES;
    }

    // Real popcorn ramps up rather than going off all at once - a slow
    // trickle of the first few kernels, then everything else kicks off in
    // a rush. Which kernels land in which group is random too, not just
    // their timing within each window.
    const shuffled = [...kernels];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const slowCount = Math.round(shuffled.length * 0.2);

    shuffled.slice(0, slowCount).forEach(k => {
      setTimeout(() => popOne(k), Math.random() * SLOW_WINDOW_MS);
    });
    shuffled.slice(slowCount).forEach(k => {
      setTimeout(() => popOne(k), SLOW_WINDOW_MS + Math.random() * FAST_WINDOW_MS);
    });

    // Let it sit fully "filled" for a moment after the last pop, then
    // fade the whole thing away on its own - or a click anywhere ends it
    // early.
    const dismiss = () => {
      overlay.style.transition = 'opacity .6s ease';
      overlay.style.opacity = '0';
      setTimeout(() => overlay.remove(), 650);
    };
    overlay.style.pointerEvents = 'auto';
    overlay.addEventListener('click', dismiss, { once: true });
    setTimeout(dismiss, TOTAL_POP_WINDOW_MS + 4500);
  }
}

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

/**
 * Sampling a poster is a network fetch + decode, so it's too slow to do on
 * every hero nav click and still have the backdrop colour ready the instant
 * the new poster reveals (see transitionHero() and applyBackdrop()) -
 * without this, the label/backdrop visibly caught up to the right colour
 * after the poster had already landed. Caching by sample URL means a film
 * only ever gets sampled once per page load; main() also prefetches
 * whichever film a nav click would go to next, so by the time someone
 * actually clicks, this is usually already resolved.
 */
const backdropColorCache = new Map();
// Same keys as backdropColorCache, but the plain resolved value rather than
// a promise - lets a render function check synchronously whether a film's
// colour is already known (it usually is, thanks to prefetchPoster() in
// main()) instead of only ever finding out a tick later via .then(), which
// was the root of the "Previously" label recolouring well after it had
// already appeared - see the comment on .hero-label's colour handling in
// renderHeroPrevious() etc.
const resolvedBackdropColors = new Map();

function fetchBackdropColors(sampleUrl) {
  if (!sampleUrl) return Promise.resolve(null);
  if (!backdropColorCache.has(sampleUrl)) {
    const promise = loadSampleImage(sampleUrl)
      .then(bitmap => dominantColors(bitmap))
      .catch(err => {
        console.warn('backdrop: could not sample poster —', err.message);
        backdropColorCache.delete(sampleUrl); // don't poison the cache - let a later attempt retry
        return null;
      })
      .then(colors => {
        resolvedBackdropColors.set(sampleUrl, colors);
        return colors;
      });
    backdropColorCache.set(sampleUrl, promise);
  }
  return backdropColorCache.get(sampleUrl);
}

/**
 * Loads data/poster-colors.json's pre-sampled colours (see
 * scripts/poster-colors.py) straight into the caches above, so every poster
 * listed there is already known the moment a hero renders - no download,
 * no sampling, nothing arriving late. Posters not in the file yet (added
 * since it was last generated) still go through fetchBackdropColors()'s
 * live sampling as before.
 */
function seedBackdropColors(imageBase, data) {
  for (const [posterPath, colors] of Object.entries(data?.colors ?? {})) {
    if (!Array.isArray(colors) || !colors.length) continue;
    const url = `${imageBase}/w185${posterPath}`;
    resolvedBackdropColors.set(url, colors);
    backdropColorCache.set(url, Promise.resolve(colors));
  }
}

/** Whatever fetchBackdropColors() already knows for this URL, if anything. */
function getKnownBackdropColors(sampleUrl) {
  return sampleUrl ? (resolvedBackdropColors.get(sampleUrl) ?? null) : null;
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

/** vivify() each sampled colour, padding out to three if the poster only
 * yielded one or two - shared by applyBackdrop() and blendLabelColor() so
 * they're always working from the same three colours. */
function vivifyAll(colors) {
  const vivid = colors.map(rgb => vivify(rgb));
  while (vivid.length < 3) vivid.push(vivid[vivid.length - 1]);
  return vivid;
}

/**
 * Mirrors .hero-label's own color-mix() formula in styles.css exactly (blend
 * 1+2, then blend that with 3), so a render function can give the label this
 * colour directly - see the comment on that in renderHeroPrevious() etc.
 */
function blendLabelColor(vivid) {
  const mix = (a, b) => a.map((v, i) => Math.round((v + b[i]) / 2));
  return `rgb(${mix(mix(vivid[0], vivid[1]), vivid[2]).join(' ')})`;
}

/**
 * The three vivid colours currently painted into --hero-rgb-1/2/3, so a
 * later applyBackdrop() call can crossfade from here instead of snapping -
 * null until the first call, which always applies instantly (nothing to
 * fade from yet, and it's covered by the backdrop's own opacity transition
 * as it lights up for the first time).
 */
let currentBackdropColors = null;
let backdropColorFrame = null;

function setBackdropColorVars(vivid) {
  const root = document.documentElement.style;
  root.setProperty('--hero-rgb-1', vivid[0].map(Math.round).join(' '));
  root.setProperty('--hero-rgb-2', vivid[1].map(Math.round).join(' '));
  root.setProperty('--hero-rgb-3', vivid[2].map(Math.round).join(' '));
}

/**
 * Paints the top-of-page mesh once we know the poster's colours. CSS can't
 * transition a gradient's own colours directly (they're baked into .blob's
 * background from these custom properties), so when animate is on this
 * hand-rolls the fade with requestAnimationFrame instead - lerping each
 * channel of each blob's colour from whatever's currently applied to the
 * new value every frame - rather than the old approach of fading the whole
 * backdrop element through transparent, which read as a dip to black. This
 * runs on its own timeline now - nothing waits on it (see the comment on
 * .hero-label's colour handling for why the label doesn't either).
 */
function applyBackdrop(colors, { animate = false, duration = 90 * HERO_ANIM_SCALE } = {}) {
  if (!colors || !colors.length) return Promise.resolve();
  const vivid = vivifyAll(colors);

  document.getElementById('backdrop')?.classList.add('is-lit');

  if (backdropColorFrame) {
    cancelAnimationFrame(backdropColorFrame);
    backdropColorFrame = null;
  }

  if (!animate || !currentBackdropColors) {
    setBackdropColorVars(vivid);
    currentBackdropColors = vivid;
    return Promise.resolve();
  }

  const from = currentBackdropColors;
  const to = vivid;
  const start = performance.now();
  // Resolves once the crossfade actually finishes, not just once it's
  // kicked off - transitionHero() awaits this before revealing the new
  // poster/text, so anything whose colour is derived from these variables
  // (the "Previously" label, say) never visibly recolours after it's
  // already faded in.
  return new Promise(resolve => {
    const step = now => {
      const t = Math.min(1, (now - start) / duration);
      const mixed = to.map((rgb, i) => rgb.map((c, ch) => from[i][ch] + (c - from[i][ch]) * t));
      setBackdropColorVars(mixed);
      if (t < 1) {
        backdropColorFrame = requestAnimationFrame(step);
      } else {
        currentBackdropColors = to;
        backdropColorFrame = null;
        resolve();
      }
    };
    backdropColorFrame = requestAnimationFrame(step);
  });
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
 * Add to Calendar - a downloaded .ics file rather than a single calendar
 * provider's link, so it works the same in Apple Calendar, Outlook, Google
 * Calendar, anything that can import one. Times go out in UTC (a plain "Z"
 * instant, no TZID), so each member's calendar app converts it to whatever
 * zone that app is already in - the same reason the hero itself resolves a
 * viewer-local zone in heroScheduleZone() above, rather than assuming ours.
 */
function icsEscapeText(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

function toIcsUtcStamp(date) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/**
 * Builds the .ics text for one "Movie Chat" event. This is just the
 * post-watch discussion, not a watch-together session, so the block is a
 * flat 30 minutes regardless of the film's own runtime.
 */
const MOVIE_CHAT_DURATION_MINUTES = 30;

function buildMovieChatIcs({ film, meta, scheduledFor, discordUrl }) {
  const start = new Date(scheduledFor);
  const end = new Date(start.getTime() + MOVIE_CHAT_DURATION_MINUTES * 60000);

  const titleLine = film.year ? `${film.title} (${film.year})` : film.title;
  const descriptionParts = [titleLine];
  if (meta?.imdbUrl) descriptionParts.push(`IMDb: ${meta.imdbUrl}`);
  if (discordUrl) descriptionParts.push(`Discord: ${discordUrl}`);

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Avoid The Rut//Movie Chat//EN',
    'CALSCALE:GREGORIAN',
    'BEGIN:VEVENT',
    `UID:${film.slug}-${film.year}@avoidtherut.com`,
    `DTSTAMP:${toIcsUtcStamp(new Date())}`,
    `DTSTART:${toIcsUtcStamp(start)}`,
    `DTEND:${toIcsUtcStamp(end)}`,
    'SUMMARY:Movie Chat',
    `DESCRIPTION:${icsEscapeText(descriptionParts.join('\n'))}`,
  ];
  if (meta?.imdbUrl) lines.push(`URL:${meta.imdbUrl}`);
  if (discordUrl) lines.push(`LOCATION:${icsEscapeText(discordUrl)}`);
  lines.push(
    'BEGIN:VALARM',
    'ACTION:DISPLAY',
    'DESCRIPTION:Movie Chat starting soon',
    'TRIGGER:-PT15M',
    'END:VALARM',
    'END:VEVENT',
    'END:VCALENDAR',
  );
  return lines.join('\r\n');
}

/** Triggers the .ics download for one hero's "Add to Calendar" button. */
function downloadMovieChatIcs(film, meta, scheduledFor) {
  const ics = buildMovieChatIcs({ film, meta, scheduledFor, discordUrl: DISCORD_CHAT_URL });
  const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `movie-chat-${film.slug}.ics`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
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
 * Carousel-style prev/next arrows for stepping back through the archive
 * from the hero, one film at a time in either direction - prev steps back
 * (to the most recently watched film, then further back through the
 * archive from there), next steps forward again, back to whatever the
 * hero would normally be showing (upcoming pick, or waiting) once you're
 * back at the start. Anchored to the screen edges rather than the poster
 * itself (see .hero-nav in styles.css - they're children of body, not of
 * the poster), so they need repositioning whenever the poster's own
 * on-screen position changes; updateHeroNavPosition() below handles that,
 * same idea as updateBackdropExtent() already does for the backdrop.
 */
const HERO_NAV_ICON_LEFT = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>';
const HERO_NAV_ICON_RIGHT = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';

function heroNavButton(direction, label, onClick) {
  const btn = el('button', `hero-nav hero-nav-${direction}`);
  btn.type = 'button';
  btn.setAttribute('aria-label', label);
  btn.innerHTML = direction === 'prev' ? HERO_NAV_ICON_LEFT : HERO_NAV_ICON_RIGHT;
  btn.addEventListener('click', onClick);
  return btn;
}

/**
 * (Re)creates the prev/next arrows as children of body - not the poster,
 * see the comment above - clearing out whichever ones a previous hero
 * render left behind first, since body itself is never cleared the way
 * #hero is on each render. Called once at the end of every hero render
 * function with whichever callbacks actually apply (a null skips that
 * button entirely, same "not created at all" rule as before).
 */
// Left/right arrow keys step through the hero the same as its prev/next
// arrows - they just click whichever arrow is currently showing. Ignored
// while typing somewhere, with a modifier held (so browser shortcuts like
// Cmd+Left still work), or while the stats page or filters are open.
document.addEventListener('keydown', e => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
  if (e.target.closest?.('input, textarea, select, [contenteditable]')) return;
  if (document.getElementById('stats-page')?.hidden === false) return;
  if (document.getElementById('filter-overlay')?.hidden === false) return;
  const arrow = document.querySelector(e.key === 'ArrowLeft' ? '.hero-nav-prev' : '.hero-nav-next');
  if (!arrow) return;
  e.preventDefault();
  arrow.click();
});

function setHeroNav({ onPrev, onNext }) {
  document.querySelectorAll('.hero-nav').forEach(n => n.remove());
  if (onPrev) document.body.append(heroNavButton('prev', 'Show previous film', onPrev));
  if (onNext) document.body.append(heroNavButton('next', 'Back to current pick', onNext));
  updateHeroNavPosition();
}

/**
 * Keeps the nav arrows vertically centred on the poster's actual on-screen
 * position - same measurement approach as updateBackdropExtent() below,
 * called from the same places (each hero render, and on resize).
 */
function updateHeroNavPosition() {
  const poster = document.querySelector('.hero-poster');
  const navs = document.querySelectorAll('.hero-nav');
  if (!poster || !navs.length) return;
  const bodyTop = document.body.getBoundingClientRect().top;
  const rect = poster.getBoundingClientRect();
  const centerY = (rect.top - bodyTop) + rect.height / 2;
  for (const nav of navs) nav.style.top = `${Math.round(centerY)}px`;
}

/**
 * Steps between hero states around a nav click, rather than the abrupt
 * swap a plain re-render gives you - slides and fades the poster itself
 * out and the new one in (in whichever direction the click moved through
 * the archive), while the title/metadata/picker/schedule row next to it
 * fades along with it (opacity only, no slide of its own) so the two read
 * as one movement without the text shifting position and jostling the
 * archive list below it. The render function is a normal hero render
 * function, unaware it's being animated - it just rebuilds .hero-inner
 * from scratch like it always has. Reveal doesn't wait on the backdrop
 * colour at all (an earlier version did, gating it on a promise - that
 * turned out fragile and still let the label recolour late); instead
 * renderHeroPrevious() etc. give .hero-label its correct colour directly,
 * synchronously wherever possible, so there's nothing to wait for. The
 * backdrop mesh itself still crossfades its own colours smoothly on its
 * own timeline (see applyBackdrop()'s animate option), independent of
 * this.
 *
 * A previously-watched film has no calendar box, so its slot animates
 * closed (and back open on the way forward again) - see the calendar box
 * handling near the end, and buildScheduleSlot().
 *
 * Only ever called from a nav click - the very first hero render on page
 * load stays instant, going through the render functions directly.
 */
// Slow-motion knob for tuning the hero nav animation - multiplies every
// hero transition: the JS timings here plus, via --hero-anim-scale, the
// CSS transition durations on .hero-poster, .hero-body and
// .hero-schedule-slot. 1 is normal speed; bump it (e.g. to 10) to watch
// the animation closely, then set it back.
const HERO_ANIM_SCALE = 1;
document.documentElement.style.setProperty('--hero-anim-scale', String(HERO_ANIM_SCALE));

const HERO_FADE_MS = 120 * HERO_ANIM_SCALE;
// Must match .hero-schedule-slot's grid-template-rows duration in styles.css.
const HERO_SLOT_MS = 200 * HERO_ANIM_SCALE;
const HERO_SLIDE_PX = 10;

function transitionHero(renderFn, direction = 'prev') {
  const hero = document.getElementById('hero');
  const currentPoster = hero.querySelector('.hero-poster');
  const currentBody = hero.querySelector('.hero-body');

  // Nothing on screen yet to fade from (shouldn't happen once a nav arrow
  // exists at all, but cheap to guard) - just render straight away.
  if (!currentPoster) { renderFn(); return; }

  // 'prev' (older, left arrow) slides the outgoing poster right and brings
  // the incoming one in from the left; 'next' (newer, right arrow) is the
  // mirror image. The body only ever fades, never slides.
  const exitX = direction === 'prev' ? HERO_SLIDE_PX : -HERO_SLIDE_PX;
  const enterX = direction === 'prev' ? -HERO_SLIDE_PX : HERO_SLIDE_PX;

  // Only the current film has a calendar box, so leaving it means the box
  // is going away: collapse it right here, on the outgoing content, while
  // everything else fades out - rather than carrying it over into the
  // incoming film (which has none) and collapsing it there, which showed a
  // box fading in on a film that shouldn't have one. The swap then waits
  // for the collapse to finish, so the new (already collapsed) slot takes
  // over at exactly the same height.
  const oldSlot = hero.querySelector('.hero-schedule-slot');
  const wasOpen = oldSlot ? !oldSlot.classList.contains('is-collapsed') : null;
  if (wasOpen) oldSlot.classList.add('is-collapsed');

  currentPoster.style.opacity = '0';
  currentPoster.style.transform = `translateX(${exitX}px)`;
  if (currentBody) currentBody.style.opacity = '0';

  setTimeout(() => {
    renderFn();

    const newPoster = hero.querySelector('.hero-poster');
    const newBody = hero.querySelector('.hero-body');

    // Same transition-suppression trick dropStaleHover() uses - start
    // faded/offset with transitions off, force the browser to register
    // that frame, then hand control back so the fade-in (and, for the
    // poster, the slide) actually animates instead of the swap and the
    // transition landing in the same paint.
    if (newPoster) {
      newPoster.style.transition = 'none';
      newPoster.style.opacity = '0';
      newPoster.style.transform = `translateX(${enterX}px)`;
    }
    if (newBody) {
      newBody.style.transition = 'none';
      newBody.style.opacity = '0';
    }
    void hero.offsetHeight;
    if (newPoster) newPoster.style.transition = '';
    if (newBody) newBody.style.transition = '';
    requestAnimationFrame(() => {
      if (newPoster) {
        newPoster.style.opacity = '1';
        newPoster.style.transform = 'translateX(0)';
      }
      if (newBody) newBody.style.opacity = '1';
    });
    // Calendar box appearing (coming back to the current film): its slot
    // starts collapsed, then opens, growing the box and pushing the archive
    // list down with it. The disappearing case was already handled before
    // the swap, above.
    const newSlot = hero.querySelector('.hero-schedule-slot');
    if (newSlot && wasOpen === false && !newSlot.classList.contains('is-collapsed')) {
      newSlot.style.transition = 'none';
      newSlot.classList.add('is-collapsed');
      void newSlot.offsetHeight;
      newSlot.style.transition = '';
      requestAnimationFrame(() => requestAnimationFrame(() => {
        newSlot.classList.remove('is-collapsed');
      }));
    }
  }, wasOpen ? Math.max(HERO_FADE_MS, HERO_SLOT_MS) : HERO_FADE_MS);
}

/**
 * "Where to Watch" - a link out to the film on JustWatch, in the visitor's
 * country: Australia for an Australian time zone (the Melbourne/Adelaide
 * members), the US otherwise (the LA member, and a reasonable default for
 * anyone else). It's JustWatch's search for the title rather than the
 * film's own page, since those page addresses use JustWatch's own slugs,
 * which can't be worked out reliably from ours - the film is normally the
 * first result.
 */
function buildWhereToWatchLink(film) {
  let country = 'us';
  try {
    if (Intl.DateTimeFormat().resolvedOptions().timeZone?.startsWith('Australia/')) country = 'au';
  } catch { /* no time zone info - stick with the default */ }
  const link = el('a', 'hero-calendar-btn hero-watch-btn');
  link.href = `https://www.justwatch.com/${country}/search?q=${encodeURIComponent(film.title)}`;
  link.target = '_blank';
  link.rel = 'noopener';
  // Lucide "tv-minimal-play", path data from lucide.dev.
  link.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M15.033 9.44a.647.647 0 0 1 0 1.12l-4.065 2.352a.645.645 0 0 1-.968-.56V7.648a.645.645 0 0 1 .967-.56z"/><path d="M7 21h10"/><rect width="20" height="14" x="2" y="3" rx="2"/></svg><span class="hero-btn-text">Where to Watch</span>';
  link.title = 'Where to Watch';
  return link;
}

/**
 * Every hero state has one of these where the calendar/schedule box goes -
 * holding the real box for an upcoming pick, or empty and collapsed to
 * zero height for a previously-watched film / the waiting state. It's a
 * one-row grid whose row animates between 1fr and 0fr (see
 * .hero-schedule-slot in styles.css), so toggling is-collapsed smoothly
 * grows or shrinks the box, pushing the archive list below down or up
 * with it. transitionHero() does the toggling on a nav click.
 */
function buildScheduleSlot(content) {
  const slot = el('div', 'hero-schedule-slot');
  const clip = el('div', 'hero-schedule-clip');
  if (content) {
    const pad = el('div', 'hero-schedule-pad');
    pad.append(content);
    clip.append(pad);
  } else {
    slot.classList.add('is-collapsed');
  }
  slot.append(clip);
  return slot;
}

/**
 * The most recently watched film, shown in place of the upcoming pick (or
 * the waiting state) when the hero's back arrow is used - same poster/
 * title/meta treatment as renderHeroUpcoming(), just without a schedule
 * row at all (there's no real date/time to show) and with the forward
 * arrow instead of the back one. Hero ends up shorter here than it does
 * for an upcoming pick - transitionHero() animates that height change, so
 * the archive list below visibly slides up rather than jumping.
 */
function renderHeroPrevious(film, meta, imageBase, picker, { onOlder, onNewer } = {}) {
  const hero = document.getElementById('hero');
  hero.hidden = false;
  hero.replaceChildren();

  const wrap = el('div', 'hero-inner');

  const art = el('div', 'hero-poster');
  const label = el('p', 'hero-label', 'Previously');
  if (meta?.posterPath) {
    const img = el('img');
    img.src = `${imageBase}/w500${meta.posterPath}`;
    img.srcset = [342, 500, 780].map(w => `${imageBase}/w${w}${meta.posterPath} ${w}w`).join(', ');
    img.sizes = '(max-width: 34rem) 60vw, 20rem';
    img.alt = `Poster for ${film.title}`;
    img.width = 500;
    img.height = 750;
    img.addEventListener('error', () => art.classList.add('empty'), { once: true });

    const sampleUrl = `${imageBase}/w185${meta.posterPath}`;
    // The label's colour is set directly here rather than left to read
    // .hero-label's own color-mix() off the (separately, smoothly
    // crossfading) backdrop CSS variables - reading a value that's still
    // mid-animation is exactly how the label used to visibly recolour a
    // beat after it had already appeared. blendLabelColor() mirrors the
    // same formula, so it's set once, synchronously, to its final colour
    // if this film was already prefetched (the common case - see
    // prefetchPoster() in main()), or the moment the sample resolves if
    // not - either way a single correct value, never an in-between one.
    const known = getKnownBackdropColors(sampleUrl);
    if (known) label.style.color = blendLabelColor(vivifyAll(known));
    fetchBackdropColors(sampleUrl).then(colors => {
      applyBackdrop(colors, { animate: true });
      if (colors) label.style.color = blendLabelColor(vivifyAll(colors));
    });

    art.append(img);
  } else {
    art.classList.add('empty');
  }
  wrap.append(art);

  const body = el('div', 'hero-body');

  const info = el('div', 'hero-info');
  info.append(label);
  info.append(el('h2', 'hero-title', film.title));

  const metaText = heroMetaText(film, meta);
  if (metaText) info.append(el('p', 'hero-meta', metaText));
  if (picker) info.append(el('p', 'hero-picker', `Picked by ${picker}`));
  body.append(info);
  body.append(buildScheduleSlot(null));

  wrap.append(body);
  hero.append(wrap);

  updateBackdropExtent();
  updateHeroReserve();
  setHeroNav({ onPrev: onOlder, onNext: onNewer });
}

/**
 * The upcoming pick, per data/schedule.json - shown until its scheduledFor
 * instant passes, at which point main() stops calling this and the film
 * just renders in its year section like any other archive entry.
 */
function renderHeroUpcoming(film, meta, imageBase, picker, scheduledFor, { onShowPrevious } = {}) {
  const hero = document.getElementById('hero');
  hero.hidden = false;
  hero.replaceChildren();

  const wrap = el('div', 'hero-inner');

  const art = el('div', 'hero-poster');
  const label = el('p', 'hero-label', 'Now Showing');
  if (meta?.posterPath) {
    const img = el('img');
    img.src = `${imageBase}/w500${meta.posterPath}`;
    img.srcset = [342, 500, 780].map(w => `${imageBase}/w${w}${meta.posterPath} ${w}w`).join(', ');
    img.sizes = '(max-width: 34rem) 60vw, 20rem';
    img.alt = `Poster for ${film.title}`;
    img.width = 500;
    img.height = 750;
    img.addEventListener('error', () => art.classList.add('empty'), { once: true });

    // Sample the poster for the backdrop colour (cached - see
    // fetchBackdropColors()). Failure here is cosmetic: the poster still
    // renders, we just get no wash. See the matching comment in
    // renderHeroPrevious() for why the label's colour is set directly here
    // rather than left to read the live (separately crossfading) CSS vars.
    const sampleUrl = `${imageBase}/w185${meta.posterPath}`;
    const known = getKnownBackdropColors(sampleUrl);
    if (known) label.style.color = blendLabelColor(vivifyAll(known));
    fetchBackdropColors(sampleUrl).then(colors => {
      applyBackdrop(colors, { animate: true });
      if (colors) label.style.color = blendLabelColor(vivifyAll(colors));
    });

    art.append(img);
  } else {
    art.classList.add('empty');
  }
  wrap.append(art);

  const body = el('div', 'hero-body');

  const info = el('div', 'hero-info');
  info.append(label);
  info.append(el('h2', 'hero-title', film.title));

  const metaText = heroMetaText(film, meta);
  if (metaText) info.append(el('p', 'hero-meta', metaText));
  if (picker) info.append(el('p', 'hero-picker', `Picked by ${picker}`));
  body.append(info);

  const scheduleRow = el('div', 'hero-schedule-row');
  const schedule = formatSchedule(scheduledFor);
  const scheduleText = el('div', 'hero-schedule-text');
  scheduleText.append(el('p', 'hero-date', schedule.date));
  scheduleText.append(el('p', 'hero-time', schedule.time));
  scheduleRow.append(scheduleText);

  const calendarBtn = el('button', 'hero-calendar-btn');
  calendarBtn.type = 'button';
  // Same inline-SVG icon convention as the toolbar buttons (filters,
  // stats) - Lucide's current "calendar-plus" glyph (the redesigned one
  // with the plus cut into the corner, not the older "calendar-plus-2"
  // centred-plus style) so it reads as specifically an add-to-calendar
  // action at a glance. Path data pulled straight from lucide.dev's own
  // "Edit in studio" link for this icon, so it matches exactly.
  calendarBtn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M16 18h6"/><path d="M16 2v3"/><path d="M19 15v6"/><path d="M21 11.5V5a2 2 0 00-2-2H5a2 2 0 00-2 2v14a2 2 0 002 2h8.3"/><path d="M3 9h18"/><path d="M8 2v3"/></svg><span class="hero-btn-text">Add to Calendar</span>';
  // Tooltip for when narrow screens show the icon on its own (see
  // .hero-btn-text in styles.css) - the text stays for screen readers.
  calendarBtn.title = 'Add to Calendar';
  calendarBtn.addEventListener('click', () => downloadMovieChatIcs(film, meta, scheduledFor));

  const actions = el('div', 'hero-schedule-actions');
  actions.append(buildWhereToWatchLink(film), calendarBtn);
  scheduleRow.append(actions);
  body.append(buildScheduleSlot(scheduleRow));

  wrap.append(body);
  hero.append(wrap);

  updateBackdropExtent();
  updateHeroReserve();
  setHeroNav({ onPrev: onShowPrevious, onNext: null });
}

/**
 * Nobody has picked the next film yet - shown in place of the upcoming pick
 * once data/schedule.json has no film locked in, or its scheduledFor instant
 * has already passed. No poster to sample, so the backdrop just stays off.
 */
/**
 * A handful of ways to say "your turn" - picked at random each time this
 * renders, so reloading the page while someone's still up shows a
 * different one rather than the same phrase sitting there indefinitely.
 */
const HERO_WAITING_PHRASES = [
  name => `${name}, you're up!`,
  name => `Over to you, ${name}.`,
  name => `No pressure, ${name}.`,
  name => `What'll it be, ${name}?`,
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
  const phrase = HERO_WAITING_PHRASES[Math.floor(Math.random() * HERO_WAITING_PHRASES.length)];
  return phrase(name);
}

function heroWaitingPalette(name) {
  return HERO_WAITING_PALETTES[name ? hashName(name) % HERO_WAITING_PALETTES.length : 0];
}

function renderHeroWaiting(pickerName, { onShowPrevious } = {}) {
  const hero = document.getElementById('hero');
  hero.hidden = false;
  hero.replaceChildren();

  const wrap = el('div', 'hero-inner');

  const art = el('div', 'hero-poster empty');
  wrap.append(art);

  // Same source as the backdrop mesh below (--hero-rgb-1/2), so the blurred
  // poster placeholder and the wash behind it are always the same colours,
  // not two independent guesses. This palette is a fixed lookup, not a
  // sample, so - unlike renderHeroPrevious()/renderHeroUpcoming() - the
  // label's colour is always known synchronously; still set directly
  // rather than off the live CSS vars, for the same reason as those.
  const palette = heroWaitingPalette(pickerName);
  applyBackdrop(palette, { animate: true });

  const body = el('div', 'hero-body');
  const info = el('div', 'hero-info');
  const label = el('p', 'hero-label', 'Waiting for Selection');
  label.style.color = blendLabelColor(vivifyAll(palette));
  info.append(label);
  info.append(el('h2', 'hero-title', heroWaitingTitle(pickerName)));
  body.append(info);
  body.append(buildScheduleSlot(null));
  wrap.append(body);
  hero.append(wrap);

  updateBackdropExtent();
  updateHeroReserve();
  setHeroNav({ onPrev: onShowPrevious, onNext: null });
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

/** The hero's "year · director · genres · runtime" line. */
function heroMetaText(film, meta) {
  const bits = [];
  if (film.year) bits.push(String(film.year));
  if (meta?.directors?.length) bits.push(meta.directors.slice(0, 2).join(', '));
  if (meta?.genres?.length) bits.push(meta.genres.slice(0, 2).join(', '));
  if (meta?.runtime) bits.push(`${meta.runtime} min`);
  return bits.join(' · ');
}

/**
 * The hero's text block (label, title, metadata, picker) is a different
 * height from film to film - titles and, on a phone, the metadata line run
 * to one or two lines - which moved the archive list up and down as you
 * stepped between films. So every film the hero can show is measured once
 * at the current width (again only if the width changes), and whatever's
 * on screen gets the difference between its own height and the tallest
 * one as extra space below the hero (--hero-reserve on #hero in
 * styles.css). The hero's own layout doesn't change; the archive just
 * always sits where the tallest film would put it. Set by main().
 */
let heroReserveEntries = [];
let tallestHeroInfo = { width: 0, height: 0 };

function measureTallestHeroInfo(body) {
  const width = body.clientWidth;
  if (tallestHeroInfo.width === width) return tallestHeroInfo.height;
  // A hidden copy of .hero-body at the same width, inside the hero so it
  // picks up exactly the same styles, filled with each film's text in turn.
  const probe = el('div', 'hero-body');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText = `position:absolute;left:0;top:0;width:${width}px;visibility:hidden;pointer-events:none;`;
  body.parentNode.append(probe);
  let height = 0;
  for (const entry of heroReserveEntries) {
    const info = el('div', 'hero-info');
    info.append(el('p', 'hero-label', 'Previously'), el('h2', 'hero-title', entry.title));
    if (entry.meta) info.append(el('p', 'hero-meta', entry.meta));
    if (entry.picker) info.append(el('p', 'hero-picker', `Picked by ${entry.picker}`));
    probe.replaceChildren(info);
    height = Math.max(height, info.getBoundingClientRect().height);
  }
  probe.remove();
  tallestHeroInfo = { width, height };
  return height;
}

function updateHeroReserve() {
  const hero = document.getElementById('hero');
  const body = hero?.querySelector('.hero-body');
  const info = body?.querySelector('.hero-info');
  if (!info || !heroReserveEntries.length) return;
  const reserve = Math.max(0, measureTallestHeroInfo(body) - info.getBoundingClientRect().height);
  hero.style.setProperty('--hero-reserve', `${reserve}px`);
}

let backdropResizeTimer;
window.addEventListener('resize', () => {
  clearTimeout(backdropResizeTimer);
  backdropResizeTimer = setTimeout(() => {
    updateBackdropExtent();
    updateHeroNavPosition();
    updateHeroReserve();
  }, 100);
});
// Line counts can change once the web font finishes loading (it's wider
// than the fallback), after the first render has already measured.
document.fonts?.ready.then(() => {
  tallestHeroInfo = { width: 0, height: 0 };
  updateHeroReserve();
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
    // Lets another surface for the same filter (the mobile filter overlay,
    // below) toggle a value through the exact same code path a dropdown
    // click uses, so there is only ever one place a filter's selection
    // actually lives - this Set - no matter which UI changed it.
    toggle: toggleValue,
    getSelected: () => new Set(selected),
    clear() {
      if (!selected.size) return;
      selected.clear();
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

  // The mobile filter overlay (built further down) shows the exact same
  // Member/Genre/Country choices as the desktop dropdown pills, just laid
  // out as plain toggle lists instead of menus. Rather than a second copy
  // of the selection state, each overlay option calls straight into the
  // matching pill's own toggle() - so there's still only one Set per
  // filter - and every overlay section registers a refresh() here so it
  // stays in sync no matter which surface (dropdown, chip removal, or the
  // overlay itself) actually changed something.
  const overlayRefreshers = [];
  function refreshOverlay() {
    for (const refresh of overlayRefreshers) refresh();
  }

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
    const list = el('div', 'filter-chips-list');
    list.append(...chips.map(([key, value]) => {
      const chip = el('span', 'filter-chip');
      chip.append(document.createTextNode(value));
      const remove = el('button', 'filter-chip-remove', '×');
      remove.type = 'button';
      remove.setAttribute('aria-label', `Remove ${chipLabels[key]} filter (${value})`);
      remove.addEventListener('click', () => pills[key].remove(value));
      chip.append(remove);
      return chip;
    }));
    const clearBtn = el('button', 'filter-clear-btn', 'Clear Filters');
    clearBtn.type = 'button';
    clearBtn.addEventListener('click', () => {
      for (const pill of Object.values(pills)) pill.clear();
    });
    chipsRow.replaceChildren(list, clearBtn);
    chipsRow.hidden = chips.length === 0;
  }

  function onFilterChange(key) {
    return values => {
      state[key] = values;
      render();
      renderChips();
      refreshOverlay();
    };
  }

  /** One "Member" / "Genre" / "Country" section for the mobile overlay -
   *  an accordion row (closed by default) that expands into a two-column
   *  list of every value that pill offers. */
  function overlaySection(label, key, values) {
    const section = el('div', 'filter-overlay-section');

    const sectionToggle = el('button', 'filter-overlay-section-toggle');
    sectionToggle.type = 'button';
    sectionToggle.setAttribute('aria-expanded', 'false');
    sectionToggle.append(el('span', 'filter-overlay-section-label', label));
    const toggleIcon = el('span', 'filter-overlay-toggle-icon');
    toggleIcon.innerHTML = FILTER_EXPAND_SVG;
    sectionToggle.append(toggleIcon);

    const body = el('div', 'filter-overlay-section-body');
    body.hidden = true; // closed by default

    const options = el('div', 'filter-overlay-options');
    const optionEls = values.map(value => {
      const opt = el('button', 'filter-overlay-option', value);
      opt.type = 'button';
      opt.addEventListener('click', () => pills[key].toggle(value));
      options.append(opt);
      return { value, opt };
    });
    body.append(options);

    sectionToggle.addEventListener('click', () => {
      const isOpen = sectionToggle.getAttribute('aria-expanded') === 'true';
      sectionToggle.setAttribute('aria-expanded', String(!isOpen));
      body.hidden = isOpen;
      toggleIcon.innerHTML = isOpen ? FILTER_EXPAND_SVG : FILTER_COLLAPSE_SVG;
    });

    section.append(sectionToggle, body);

    overlayRefreshers.push(() => {
      const selected = pills[key].getSelected();
      for (const { value, opt } of optionEls) opt.classList.toggle('is-selected', selected.has(value));
    });
    return section;
  }

  const overlaySections = [];

  const members = [...new Set(
    archive.flatMap(year => year.films.map(f => pickers?.picks?.[`${year.year}:${f.slug}`]).filter(Boolean)),
  )].sort();
  if (members.length) {
    const memberPill = createFilterPill('Member', onFilterChange('member'));
    memberPill.setOptions(members);
    pills.member = memberPill;
    bar.append(memberPill.element);
    overlaySections.push(overlaySection('Member', 'member', members));
  }

  const genres = [...new Set(
    archive.flatMap(year => year.films.flatMap(f => tmdb?.films?.[f.slug]?.genres ?? [])),
  )].sort();
  if (genres.length) {
    const genrePill = createFilterPill('Genre', onFilterChange('genre'));
    genrePill.setOptions(genres);
    pills.genre = genrePill;
    bar.append(genrePill.element);
    overlaySections.push(overlaySection('Genre', 'genre', genres));
  }

  const countries = [...new Set(
    archive.flatMap(year => year.films.flatMap(f => tmdb?.films?.[f.slug]?.countries ?? [])),
  )].sort();
  if (countries.length) {
    const countryPill = createFilterPill('Country', onFilterChange('country'));
    countryPill.setOptions(countries);
    pills.country = countryPill;
    bar.append(countryPill.element);
    overlaySections.push(overlaySection('Country', 'country', countries));
  }

  setupFilterOverlay(overlaySections);

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

/**
 * Builds the mobile "Filters" overlay (see #filter-overlay in index.html)
 * from the section elements setupArchiveFilters() built above, and wires
 * up #filters-toggle to open it - a full-screen, dimmed stand-in for the
 * dropdown pills, which stop being usable once the toolbar collapses them
 * down to a single button at narrow widths (see the @media rule for
 * .filters-toggle / .year-filters in styles.css). Same open/close/fade
 * mechanics as the stats page's own overlay - see setupStatsPage() - just
 * triggered by a different button and with no bar-chart/× icon swap, since
 * the close affordance here is its own dedicated button instead.
 */
function setupFilterOverlay(sections) {
  const toggle = document.getElementById('filters-toggle');
  const overlay = document.getElementById('filter-overlay');
  // A sibling of #filter-overlay, not appended inside it - see the comment
  // on this button in index.html for why: an opacity-faded ancestor
  // isolates any mix-blend-mode inside it from the real page backdrop, so
  // a vibrancy-blended close button living inside that fade never actually
  // lights up the way #stats-toggle does. (.filter-overlay itself no
  // longer uses opacity at all now - see the comment on it in styles.css -
  // but the close button stays out here regardless, same as the sections/
  // icons/pills that couldn't be moved out and needed the ancestor fixed
  // instead.)
  const closeBtn = document.getElementById('filter-overlay-close');
  if (!toggle || !overlay || !closeBtn) return;

  overlay.replaceChildren();
  // No sections (no member/genre/country data at all) means there is
  // nothing to filter by - leave the button out of the toolbar entirely
  // rather than open an overlay with nothing in it but a close button.
  if (!sections.length) {
    toggle.hidden = true;
    return;
  }

  const sectionsWrap = el('div', 'filter-overlay-sections');
  sectionsWrap.append(...sections);
  overlay.append(el('p', 'filter-overlay-title', 'Filters'), sectionsWrap);

  let hideTimer;

  function open() {
    clearTimeout(hideTimer);
    overlay.hidden = false;
    closeBtn.hidden = false;
    // Same reasoning as setupStatsPage()'s open(): force layout so
    // "no longer hidden" commits before the class flip, or the transform
    // transition has nothing to animate from.
    void overlay.offsetHeight;
    document.body.classList.add('filters-open');
    overlay.setAttribute('aria-hidden', 'false');
    toggle.setAttribute('aria-expanded', 'true');
  }

  function close() {
    document.body.classList.remove('filters-open');
    overlay.setAttribute('aria-hidden', 'true');
    toggle.setAttribute('aria-expanded', 'false');
    // closeBtn has no fade of its own (see index.html) - it just stays
    // up for as long as the overlay it belongs to is still visibly
    // fading out, then disappears at the same moment as the overlay
    // itself rather than vanishing out ahead of it.
    hideTimer = setTimeout(() => { overlay.hidden = true; closeBtn.hidden = true; }, 400);
  }

  toggle.addEventListener('click', () => {
    if (document.body.classList.contains('filters-open')) close();
    else open();
  });
  closeBtn.addEventListener('click', close);
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
  // TMDB's genre list is a small fixed set, so a lookup table reads more
  // naturally than a generic pluralizer would for the handful of genres
  // that are normally treated as mass nouns (Action, Crime, Horror...) -
  // anything not listed here falls back to a plain "+s"/"y -> ies" guess.
  const GENRE_PLURALS = {
    'Action': 'Action', 'Adventure': 'Adventures', 'Animation': 'Animation',
    'Comedy': 'Comedies', 'Crime': 'Crime', 'Documentary': 'Documentaries',
    'Drama': 'Dramas', 'Family': 'Family', 'Fantasy': 'Fantasies',
    'History': 'History', 'Horror': 'Horror', 'Music': 'Music',
    'Mystery': 'Mysteries', 'Romance': 'Romances', 'Science Fiction': 'Science Fiction',
    'TV Movie': 'TV Movies', 'Thriller': 'Thrillers', 'War': 'War', 'Western': 'Westerns',
  };
  const pluralizeGenre = name => GENRE_PLURALS[name]
    ?? (/[^aeiou]y$/i.test(name) ? `${name.slice(0, -1)}ies` : `${name}s`);
  // Folded in here (rather than left for renderStatsPage() to build) since
  // pluralizeGenre/GENRE_PLURALS are only in scope inside computeStats().
  if (topGenre) topGenre.pluralLabel = topGenre.names.map(pluralizeGenre).join(' / ');

  // Release decade, not watch year - "top decade" means the era the films
  // themselves are from, same as "oldest"/"newest" already do. Buckets via
  // the same tally()/top() helpers as genre and director above, so ties
  // (e.g. two decades sharing the lead) are handled the same way too.
  const decadeCounts = tally(f => f.meta?.releaseDate
    ? [`${Math.floor(Number(f.meta.releaseDate.slice(0, 4)) / 10) * 10}`]
    : []);
  const topDecade = top(decadeCounts);
  if (topDecade) topDecade.label = topDecade.names.map(d => `${d}s`).join(' / ');

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

  // Dave's well-known soft spot for anime - "anime" here means the
  // Animation genre AND Japan as a producing country, which is the same
  // shorthand test a person would use and comes for free from fields TMDB
  // already gives every film, no extra tagging required.
  const davePicks = allFilms.filter(f => pickers?.picks?.[`${f.watchYear}:${f.slug}`] === 'Dave');
  const daveAnimeCount = davePicks.filter(
    f => f.meta?.genres?.includes('Animation') && f.meta?.countries?.includes('Japan'),
  ).length;
  const davePctAnime = davePicks.length ? Math.round((daveAnimeCount / davePicks.length) * 100) : null;

  // OMDb's IMDb-rating backfill (scripts/imdb-ratings.mjs) is optional and
  // may not have run yet, so most films can genuinely have no imdbRating -
  // that's just excluded from the average rather than counted as a 0.
  const withImdbRating = allFilms.filter(f => typeof f.meta?.imdbRating === 'number');
  const avgImdbRating = withImdbRating.length
    ? Math.round((withImdbRating.reduce((n, f) => n + f.meta.imdbRating, 0) / withImdbRating.length) * 10) / 10
    : null;

  return {
    total, firstYear, lastYear, totalMinutes, avgRuntime, longest, shortest,
    topGenre, topDecade, topDirector, numCountries: countryCounts.size, pctNonUs, topForeignCountry,
    busiestYears, busiestYearCount, oldest, newest, attributed, pickerBoard,
    davePctAnime, daveAnimeCount, davePickCount: davePicks.length,
    avgImdbRating, ratedFilmCount: withImdbRating.length,
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

  // Rounds to 1 decimal place, but drops it entirely when that rounds to
  // a whole number ("6" rather than "6.0") - a trailing ".0" reads as
  // false precision on a number that landed on the nose.
  function formatDays(totalMins) {
    const days = Math.round((totalMins / 60 / 24) * 10) / 10;
    return Number.isInteger(days) ? String(days) : days.toFixed(1);
  }

  const minutes = s.totalMinutes || null;
  const totalDays = minutes != null ? formatDays(minutes) : null;
  // Same flat-30-minutes-per-film assumption as the calendar invite itself
  // (MOVIE_CHAT_DURATION_MINUTES, above) - reused here rather than a second
  // hardcoded 30, so the two stay in sync if that ever changes.
  const chatDays = formatDays(s.total * MOVIE_CHAT_DURATION_MINUTES);

  // Values arrive pre-formatted (not raw numbers) so a year like 1985 never
  // picks up a thousands comma the way toLocaleString() would give it.
  // `text: true` is for a headline that's a title/name rather than a short
  // number - smaller, looser letter-spacing, allowed to wrap.
  // `heading` is an optional label ABOVE the number (same treatment as
  // "Waiting for Selection" above the hero) - for a stat like longest/
  // shortest where the number alone doesn't say what it's the number of.
  // `sub` is a third, quieter tier below the label - for a detail (a film
  // title) that belongs to the stat but shouldn't shout like the label does.
  // `film` is the archive film object (the same shape computeStats() builds
  // - .title plus .meta from tmdb.json) behind a stat that's really about
  // one specific movie (longest, highest rated, ...) - when given, its
  // Each stat is centred and stands alone now, so a poster (when there is
  // one behind the stat) renders centred above the number instead of in a
  // fixed-width left-hand slot - reusing the exact same posterFor()/
  // imdbLink() treatment as the archive list so it looks like it belongs
  // to the same site rather than a bespoke crop. Only rendered when a
  // film is actually behind the stat; there's no column of numbers left
  // to keep aligned, so a stat with no film just has no poster.
  function statItem(display, label, { text = false, sub = null, heading = null, film = null, unit = null } = {}) {
    const item = el('div', 'stats-hero-item');

    if (film) {
      const posterSlot = el('div', 'stats-hero-poster');
      // posterFor() already renders its own empty/untitled fallback when
      // there's no poster art for this film - reuse that rather than
      // leaving the slot blank, so a film stat with missing art still
      // reads as "this stat has a poster, just no image for it" rather
      // than looking identical to a stat with no film behind it at all.
      const poster = posterFor(tmdb?.imageBase, film.meta?.posterPath, film.title);
      posterSlot.append(film.meta?.imdbUrl ? imdbLink(film.meta.imdbUrl, poster, film.title) : poster);
      item.append(posterSlot);
    }

    const textCol = el('div', 'stats-hero-text');
    if (heading) textCol.append(el('span', 'hero-label', heading));
    // `unit` renders as a smaller suffix on the same line as the number
    // itself (e.g. "171" + "minutes") rather than a separate line below -
    // sized in em so it's always exactly half the number's own font-size,
    // whatever that resolves to at the current viewport width.
    const numberEl = el('span', text ? 'stats-hero-number stats-hero-number--text' : 'stats-hero-number');
    numberEl.append(display != null ? display : '\u2014');
    if (unit && display != null) numberEl.append(el('span', 'stats-hero-unit', unit));
    textCol.append(numberEl, el('span', 'hero-label', label));
    if (sub) textCol.append(el('span', 'stats-hero-sub', sub));
    item.append(textCol);

    return item;
  }

  // Two films side by side in one stat (highest/lowest rated, longest/
  // shortest) rather than two separate full-width rows - each gets its own
  // poster with its own number/label stacked underneath, sharing the same
  // poster/number building blocks as statItem() above so it reads as the
  // same visual language, just two columns instead of one. `a` and `b` are
  // { film, display, label, unit? } - same shape statItem() takes for a
  // film-backed stat, just without the "no film" case since a pair only
  // ever makes sense when both sides have one.
  function statPairCol(one) {
    const col = el('div', 'stats-hero-pair-col');
    // Same graceful-degradation rule as statItem() above: no film (e.g. no
    // ratings backfilled yet) just means no poster, not a broken stat.
    if (one.film) {
      const posterSlot = el('div', 'stats-hero-poster');
      const poster = posterFor(tmdb?.imageBase, one.film.meta?.posterPath, one.film.title);
      posterSlot.append(one.film.meta?.imdbUrl ? imdbLink(one.film.meta.imdbUrl, poster, one.film.title) : poster);
      col.append(posterSlot);
    }

    const textCol = el('div', 'stats-hero-text');
    const numberEl = el('span', 'stats-hero-number');
    numberEl.append(one.display != null ? one.display : '\u2014');
    if (one.unit && one.display != null) numberEl.append(el('span', 'stats-hero-unit', one.unit));
    textCol.append(numberEl, el('span', 'hero-label', one.label));

    col.append(textCol);
    return col;
  }
  function statPair(a, b) {
    const item = el('div', 'stats-hero-item stats-hero-pair');
    item.append(statPairCol(a), statPairCol(b));
    return item;
  }

  const hero = el('div', 'stats-hero');
  hero.append(
    statItem(s.total.toLocaleString(), 'movies watched'),
    statItem(totalDays, 'time spent watching movies', { unit: 'days' }),
    statItem(chatDays, 'time spent chatting', { unit: 'days' }),
    statItem(s.oldest ? String(s.oldest.year) : null, 'oldest movie'),
    statPair(
      { film: s.shortest, display: s.shortest ? String(s.shortest.meta.runtime) : null, label: 'shortest movie', unit: 'mins' },
      { film: s.longest, display: s.longest ? String(s.longest.meta.runtime) : null, label: 'longest movie', unit: 'mins' },
    ),
    statItem(s.topGenre ? String(s.topGenre.count) : null, 'most watched genre', { unit: s.topGenre?.pluralLabel }),
    statItem(s.topDecade?.label ?? null, 'most picked decade'),
    statItem(s.davePctAnime != null ? `${s.davePctAnime}%` : null, 'dave picks are anime'),
    statItem(s.avgImdbRating != null ? s.avgImdbRating.toFixed(1) : null, 'avg IMDb rating'),
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

  // The button jumps from top-right to top-left (and back) on click
  // without the mouse moving, so the browser never gets a real mousemove
  // crossing the button's edge to fire a genuine mouseleave - it was
  // truly hovered right up until the click, at the OLD position, and
  // nothing ever tells it that position is no longer under the cursor.
  // Relying on :hover directly leaves that stuck indefinitely (the
  // pointer-events toggle this used to do is a common trick for forcing
  // a re-check, but it depends on the browser re-running hit-testing on
  // its own timing, which isn't reliable enough here). Tracking hover
  // manually instead (.is-hovered, via mouseenter/mouseleave below) means
  // this can just clear it outright, deterministically, the moment the
  // button teleports - no waiting on the browser to notice anything.
  // Transition is suppressed for one frame so the ring disappears
  // instantly rather than visibly easing back down.
  function dropStaleHover() {
    toggle.style.transition = 'none';
    toggle.classList.remove('is-hovered');
    void toggle.offsetHeight;
    requestAnimationFrame(() => { toggle.style.transition = ''; });
  }
  toggle.addEventListener('mouseenter', () => toggle.classList.add('is-hovered'));
  toggle.addEventListener('mouseleave', () => toggle.classList.remove('is-hovered'));

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

  // Invisible on purpose - this is a dev-only panel, not something a
  // visitor should be able to find. The click target is still a real
  // 2.2rem circle bottom-right, there's just nothing to see there.
  const toggle = document.createElement('button');
  toggle.textContent = '⚙️ settings';
  toggle.setAttribute('aria-hidden', 'true');
  toggle.tabIndex = -1;
  toggle.style.cssText = [
    'position: fixed', 'bottom: 12px', 'right: 12px', 'z-index: 999',
    'width: 2.2rem', 'height: 2.2rem', 'padding: 0', 'border: none',
    'border-radius: 999px', 'background: transparent', 'color: transparent',
    'cursor: default', 'font-family: inherit', 'opacity: 0',
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
  // Pre-sampled poster colours - optional, like the other enrichment files.
  seedBackdropColors(imageBase, await loadJson('data/poster-colors.json', { required: false }));
  // Hand-picked colours for particular films, keyed by slug - seeded after
  // the sampled ones so they win. Hand-edited, unlike poster-colors.json,
  // which the update workflow regenerates.
  const colorOverrides = await loadJson('data/poster-color-overrides.json', { required: false });
  seedBackdropColors(imageBase, {
    colors: Object.fromEntries(Object.entries(colorOverrides?.colors ?? {})
      .map(([slug, colors]) => [tmdb?.films?.[slug]?.posterPath, colors])
      .filter(([posterPath]) => posterPath)),
  });
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
  }

  // A year emptied by lifting the upcoming pick out has nothing left to show.
  const archive = years.filter(y => y.films.length > 0);

  // Every watched film, most recently watched first - archive is already
  // in that order year-to-year (newest year first), so this just flattens
  // it, reading each year's own films newest-to-oldest the same way the
  // archive list below does ([...year.films].reverse()). history[0] is
  // the single most recently watched film; walking further into the
  // array is walking further back through club history. Powers the
  // hero's back arrow - an empty array just means nothing's been watched
  // yet, so there's nowhere for it to go.
  const history = archive.flatMap(y =>
    [...y.films].reverse().map(film => ({ film, year: y.year, meta: tmdb?.films?.[film.slug] })));

  // The hero flips between its normal state (upcoming pick, or waiting)
  // and however far back into history the prev/next arrows have gone -
  // showFront() and goToHistory() below are both callable more than once
  // (showFront() is also what "next" returns to once you're back at the
  // start), each render's own onOlder/onNewer closures carry whatever
  // index comes next, so there's no separate index variable to keep in
  // sync by hand.
  // Warms fetchBackdropColors()'s cache for whichever film a nav click
  // would take you to next, so by the time that click actually happens the
  // colour is usually already known instead of only starting to load then.
  function prefetchPoster(meta) {
    if (meta?.posterPath) fetchBackdropColors(`${imageBase}/w185${meta.posterPath}`);
  }

  function showFront() {
    if (history.length) prefetchPoster(history[0].meta);
    if (isUpcoming) {
      return renderHeroUpcoming(
        scheduledFilm, tmdb?.films?.[scheduledFilm.slug], imageBase, schedule.picker, schedule.scheduledFor,
        { onShowPrevious: history.length ? () => transitionHero(() => goToHistory(0), 'prev') : null },
      );
    }
    return renderHeroWaiting(nextPickerName(schedule, members), {
      onShowPrevious: history.length ? () => transitionHero(() => goToHistory(0), 'prev') : null,
    });
  }

  function goToHistory(index) {
    if (index + 1 < history.length) prefetchPoster(history[index + 1].meta);
    if (index > 0) prefetchPoster(history[index - 1].meta);
    else if (isUpcoming) prefetchPoster(tmdb?.films?.[scheduledFilm.slug]);

    const entry = history[index];
    const picker = pickers?.picks?.[`${entry.year}:${entry.film.slug}`];
    return renderHeroPrevious(entry.film, entry.meta, imageBase, picker, {
      onOlder: index + 1 < history.length ? () => transitionHero(() => goToHistory(index + 1), 'prev') : null,
      onNewer: () => transitionHero(index === 0 ? showFront : () => goToHistory(index - 1), 'next'),
    });
  }

  heroReserveEntries = history.map(entry => ({
    title: entry.film.title,
    meta: heroMetaText(entry.film, entry.meta),
    picker: pickers?.picks?.[`${entry.year}:${entry.film.slug}`],
  }));
  if (isUpcoming) {
    heroReserveEntries.push({
      title: scheduledFilm.title,
      meta: heroMetaText(scheduledFilm, tmdb?.films?.[scheduledFilm.slug]),
      picker: schedule.picker,
    });
  }

  showFront();

  const total = archive.reduce((n, y) => n + y.films.length, 0);
  const since = archive.length ? archive.at(-1).year : '';
  // The "o" in "movies" is the easter egg's trigger - it turns into a
  // popcorn kernel on hover (see .movies-o in styles.css) and starts the
  // effect when clicked. The rest of the line is plain text.
  const moviesO = el('span', 'movies-o', 'o');
  moviesO.addEventListener('click', () => triggerPopcornEffect());
  stats.replaceChildren(
    el('span', null, `${total} m`),
    moviesO,
    el('span', null, `vies since ${since}`),
  );
  POPCORN_KERNEL_COUNT = Math.min(total, POPCORN_MAX_KERNELS);

  setupArchiveFilters(archive, container, tmdb, pickers);
  renderStatsPage(archive, tmdb, pickers, members);

  document.getElementById('tmdb-note').textContent =
    tmdb?.note ?? 'Posters and credits from TMDB.';

  // TEMP — see the block above. Disabled (not deleted) - flip this back on
  // by uncommenting the call below if the effect sliders are needed again.
  // setupDebugPanel({
  //   allFilms: (films.years ?? []).flatMap(y => y.films),
  //   tmdb,
  //   imageBase,
  //   upcoming: scheduledFilm
  //     ? { film: scheduledFilm, meta: tmdb?.films?.[scheduledFilm.slug], imageBase, picker: schedule.picker, scheduledFor: schedule.scheduledFor }
  //     : null,
  //   waitingName: nextPickerName(schedule, members),
  // });
}

main();
