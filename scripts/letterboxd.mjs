/**
 * Reads a public Letterboxd list into plain data.
 *
 * This is the ONLY module that knows Letterboxd exists. Everything downstream
 * consumes the shape returned by fetchList(), so if the official API ever
 * becomes available, replacing the internals here is the whole migration.
 *
 *   fetchList(url) -> { title, url, films: [{ position, title, year, slug, letterboxdUrl }] }
 *
 * Letterboxd renders each list entry server-side as a <div> carrying its own
 * data-* attributes. We read those rather than the visible text: they are
 * structural, they survive styling changes, and they give us the canonical
 * film slug.
 */

const ORIGIN = 'https://letterboxd.com';

const ENTITIES = {
  '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"',
  '&#039;': "'", '&#39;': "'", '&apos;': "'", '&nbsp;': ' ',
  '&mdash;': '—', '&ndash;': '–', '&lrm;': '', '&bull;': '•',
};

export function decodeEntities(s) {
  if (!s) return s;
  return s
    .replace(/&(?:amp|lt|gt|quot|#0?39|apos|nbsp|mdash|ndash|lrm|bull);/g, m => ENTITIES[m] ?? m)
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function attr(tag, name) {
  // Letterboxd uses both double and single quotes for attribute values.
  const m = tag.match(new RegExp(`\\b${name}=(?:"([^"]*)"|'([^']*)')`));
  if (!m) return null;
  return decodeEntities(m[1] ?? m[2]);
}

/**
 * "Sweet Country (2017)" -> { title: "Sweet Country", year: 2017 }
 * Only a trailing 4-digit parenthesised group counts as the year, so a film
 * genuinely called "Nineteen Eighty-Four (1984)" still parses correctly and
 * something like "Am I OK?" survives untouched.
 */
export function splitTitleYear(displayName) {
  const m = displayName?.match(/^(.*?)\s*\((\d{4})\)\s*$/);
  if (!m) return { title: displayName ?? null, year: null };
  return { title: m[1].trim(), year: Number(m[2]) };
}

/** Extracts every list entry from one page of list HTML. */
export function parseFilms(html) {
  const tags = html.match(/<div\b[^>]*\bdata-item-slug=(?:"[^"]*"|'[^']*')[^>]*>/g) ?? [];
  return tags.map(tag => {
    const display = attr(tag, 'data-item-name') ?? attr(tag, 'data-item-full-display-name');
    const { title, year } = splitTitleYear(display);
    const slug = attr(tag, 'data-item-slug');
    const link = attr(tag, 'data-item-link');
    const index = Number(attr(tag, 'data-list-index'));
    return {
      position: Number.isFinite(index) ? index + 1 : null,
      title,
      year,
      slug,
      letterboxdUrl: link ? new URL(link, ORIGIN).href : null,
    };
  });
}

/** The list's own name, e.g. "Avoid the Rut 2020". */
export function parseListTitle(html) {
  const og = html.match(/<meta\s+property="og:title"\s+content="([^"]*)"/i);
  return og ? decodeEntities(og[1]).trim() : null;
}

/** Href of the next page of a paginated list, or null. */
export function parseNextPage(html) {
  const m = html.match(/<a\b[^>]*\bclass="[^"]*\bnext\b[^"]*"[^>]*\bhref="([^"]+)"/i)
    ?? html.match(/<a\b[^>]*\bhref="([^"]+)"[^>]*\bclass="[^"]*\bnext\b[^"]*"/i);
  return m ? m[1] : null;
}

async function getHtml(url) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: {
      // Identify honestly rather than impersonating a browser.
      'user-agent': 'atr-movie-club-sync (+https://github.com/chris-mrtn/atr)',
      'accept': 'text/html',
    },
  });
  if (res.status === 404) return { status: 404, html: null };
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return { status: res.status, html: await res.text() };
}

/**
 * Fetches a list, following pagination.
 * Returns null when the list does not exist (404), so callers can skip a year
 * without treating it as a failure.
 */
export async function fetchList(url) {
  const first = await getHtml(url);
  if (first.status === 404) return null;

  let html = first.html;
  const title = parseListTitle(html);
  const films = parseFilms(html);

  const seen = new Set([url]);
  let next = parseNextPage(html);
  while (next) {
    const nextUrl = new URL(next, url).href;
    if (seen.has(nextUrl)) break; // defensive: never loop
    seen.add(nextUrl);
    const page = await getHtml(nextUrl);
    if (page.status === 404) break;
    html = page.html;
    films.push(...parseFilms(html));
    next = parseNextPage(html);
  }

  // Positions are per-page in the markup; renumber across the whole list.
  films.forEach((f, i) => { f.position = i + 1; });

  return { title, url, films };
}

export function listUrlFor(member, year) {
  return `${ORIGIN}/${member}/list/avoid-the-rut-${year}/`;
}
