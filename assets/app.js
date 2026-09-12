/* Renders the club page from data/club.json. No build step, no dependencies. */

const REL = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
const DATE = new Intl.DateTimeFormat('en-AU', {
  day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC'
});

/**
 * Next picker is whoever follows lastPickedBy in the rotation order.
 * Falls back to the first person if lastPickedBy is missing or unknown,
 * so a typo degrades to "start of the list" rather than a blank page.
 */
function nextPicker(rotation) {
  const order = Array.isArray(rotation?.order) ? rotation.order : [];
  if (order.length === 0) return null;
  const i = order.indexOf(rotation?.lastPickedBy);
  return i === -1 ? order[0] : order[(i + 1) % order.length];
}

function parseDate(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

function relativeDays(date) {
  const days = Math.round((date - new Date()) / 86400000);
  if (Math.abs(days) < 31) return REL.format(days, 'day');
  return REL.format(Math.round(days / 30), 'month');
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function renderHeader(club) {
  if (club?.name) {
    document.getElementById('club-name').textContent = club.name;
    document.title = club.name;
  }
  document.getElementById('club-tagline').textContent = club?.tagline ?? '';
}

function renderTurn(rotation, archive) {
  const who = nextPicker(rotation);
  document.getElementById('next-picker').textContent = who ?? 'Nobody yet';

  const note = document.getElementById('turn-note');
  if (!who) {
    note.textContent = 'Add names to "rotation.order" in data/club.json.';
  } else if (rotation?.lastPickedBy) {
    const last = archive?.[0];
    note.textContent = last
      ? `${rotation.lastPickedBy} picked last — ${last.title}.`
      : `${rotation.lastPickedBy} picked last.`;
  } else {
    note.textContent = 'First pick of the rotation.';
  }

  const list = document.getElementById('rotation-order');
  list.replaceChildren();
  for (const name of rotation?.order ?? []) {
    const li = el('li', null, name);
    if (name === who) li.setAttribute('aria-current', 'true');
    list.append(li);
  }
}

function renderArchive(archive) {
  const list = document.getElementById('archive');
  list.replaceChildren();

  if (!archive?.length) {
    list.append(el('li', 'empty', 'Nothing watched yet.'));
    return;
  }

  for (const film of archive) {
    const li = el('li');
    li.append(el('span', 'film-title', film.title));
    if (film.year) li.append(el('span', 'film-year', String(film.year)));

    const bits = [];
    if (film.director) bits.push(film.director);
    const date = film.watchedOn ? parseDate(film.watchedOn) : null;
    if (date) bits.push(DATE.format(date));
    if (film.pickedBy) bits.push(`${film.pickedBy}'s pick`);

    const meta = el('span', 'film-meta', bits.join(' · '));
    if (date) meta.title = relativeDays(date);
    li.append(meta);

    list.append(li);
  }
}

async function main() {
  let data;
  try {
    const res = await fetch('data/club.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data = await res.json();
  } catch (err) {
    document.getElementById('next-picker').textContent = 'Data unavailable';
    document.getElementById('turn-note').textContent =
      `Could not load data/club.json (${err.message}).`;
    document.getElementById('archive').replaceChildren(
      el('li', 'empty', 'Serve this page over http:// — opening the file directly blocks the fetch.')
    );
    return;
  }

  // Newest first, regardless of the order they were typed in.
  const archive = [...(data.archive ?? [])].sort((a, b) =>
    String(b.watchedOn ?? '').localeCompare(String(a.watchedOn ?? ''))
  );

  renderHeader(data.club);
  renderTurn(data.rotation, archive);
  renderArchive(archive);
}

main();
