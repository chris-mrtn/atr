import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTitle, releaseYear, chooseMatch, summarize, createClient } from './tmdb.mjs';

const r = (id, title, date, extra = {}) =>
  ({ id, title, original_title: title, release_date: date, ...extra });

test('normalize strips case, accents, apostrophes and punctuation', () => {
  assert.equal(normalizeTitle('Amélie'), 'amelie');
  assert.equal(normalizeTitle("Don't Look Up"), 'dont look up');
  assert.equal(normalizeTitle('Fanny & Alexander'), 'fanny alexander');
  assert.equal(normalizeTitle('WALL·E'), 'wall e');
  assert.equal(normalizeTitle('Am I OK?'), 'am i ok');
});

test('releaseYear handles missing and malformed dates', () => {
  assert.equal(releaseYear({ release_date: '1994-07-14' }), 1994);
  assert.equal(releaseYear({ release_date: '' }), null);
  assert.equal(releaseYear({}), null);
});

test('matches on exact title and year', () => {
  const got = chooseMatch(
    { title: 'Chungking Express', year: 1994 },
    [r(11104, 'Chungking Express', '1994-07-14')],
  );
  assert.equal(got.match.id, 11104);
  assert.equal(got.confidence, 'exact');
});

test('matches when Letterboxd shows the English title and TMDB the original', () => {
  const got = chooseMatch(
    { title: 'Beyond Utopia', year: 2023 },
    [r(1, 'Flucht aus Nordkorea', '2023-01-20', { original_title: 'Beyond Utopia' })],
  );
  assert.equal(got.match.id, 1);
});

test('refuses to guess between two films of the same title and year', () => {
  const got = chooseMatch(
    { title: 'Persuasion', year: 2022 },
    [r(1, 'Persuasion', '2022-07-15', { popularity: 900 }), r(2, 'Persuasion', '2022-04-01', { popularity: 3 })],
  );
  assert.equal(got.match, null);
  assert.match(got.reason, /share that title and year/);
  assert.equal(got.candidates.length, 2);
});

test('popularity is never used as a tiebreaker', () => {
  // A hugely popular film with the wrong title must not win.
  const got = chooseMatch(
    { title: 'Old Joy', year: 2006 },
    [r(99, 'Old', '2021-07-21', { popularity: 5000 }), r(100, 'Joy', '2015-12-24', { popularity: 4000 })],
  );
  assert.equal(got.match, null);
});

test('accepts a release year one out, for festival vs general release', () => {
  const got = chooseMatch(
    { title: 'Broker', year: 2022 },
    [r(7, 'Broker', '2023-03-02')],
  );
  assert.equal(got.match.id, 7);
  assert.equal(got.confidence, 'year-off-by-one');
});

test('a wide year gap is refused once there is more than one candidate', () => {
  // With alternatives in play, a two-year gap is not good enough: this is the
  // case where a remake or a same-titled film could be picked by mistake.
  const got = chooseMatch({ title: 'Broker', year: 2022 }, [
    r(7, 'Broker', '2024-03-02', { poster_path: '/a.jpg', vote_count: 10 }),
    r(8, 'Broker', '1998-01-01', { poster_path: '/b.jpg', vote_count: 10 }),
  ]);
  assert.equal(got.match, null);
});

test('a sole result with the right year is accepted even if the title differs', () => {
  const got = chooseMatch(
    { title: 'In This Corner of the World', year: 2016 },
    [r(8, 'In This Corner of the World (and Other Corners)', '2016-11-12')],
  );
  assert.equal(got.match.id, 8);
  assert.equal(got.confidence, 'sole-result');
});

test('no results is a clean refusal', () => {
  const got = chooseMatch({ title: 'Nonexistent', year: 1999 }, []);
  assert.equal(got.match, null);
  assert.equal(got.reason, 'no results');
});

test('without a year, only an unambiguous title match is accepted', () => {
  assert.equal(chooseMatch({ title: 'Stalker', year: null },
    [r(1, 'Stalker', '1979-05-25'), r(2, 'Stalker', '2010-01-01')]).match, null);
  assert.equal(chooseMatch({ title: 'Stalker', year: null },
    [r(1, 'Stalker', '1979-05-25')]).match.id, 1);
});

test('summarize pulls directors out of the credits crew', () => {
  const got = summarize({
    id: 5, original_title: 'Stalker', release_date: '1979-05-25', runtime: 162,
    overview: 'A guide leads two men.', poster_path: '/p.jpg', backdrop_path: '/b.jpg',
    credits: { crew: [
      { job: 'Director', name: 'Andrei Tarkovsky' },
      { job: 'Editor', name: 'Lyudmila Feiginova' },
    ] },
  });
  assert.deepEqual(got.directors, ['Andrei Tarkovsky']);
  assert.equal(got.runtime, 162);
  assert.equal(got.tmdbUrl, 'https://www.themoviedb.org/movie/5');
});

test('summarize takes the top 4 billed cast, in order, regardless of input order', () => {
  const got = summarize({
    id: 6, original_title: 'Ensemble', release_date: '2020-01-01', runtime: 100,
    credits: { cast: [
      { order: 2, name: 'Third Billed' },
      { order: 0, name: 'Lead' },
      { order: 4, name: 'Fifth Billed' },
      { order: 1, name: 'Second Billed' },
      { order: 3, name: 'Fourth Billed' },
    ] },
  });
  assert.deepEqual(got.cast, ['Lead', 'Second Billed', 'Third Billed', 'Fourth Billed']);
});

test('summarize returns an empty cast when there are no credits', () => {
  const got = summarize({ id: 7, original_title: 'No Credits', release_date: '2020-01-01' });
  assert.deepEqual(got.cast, []);
});

test('summarize builds an IMDb url from imdb_id, or null without one', () => {
  const withId = summarize({ id: 8, original_title: 'Has IMDb', release_date: '2020-01-01', imdb_id: 'tt1234567' });
  assert.equal(withId.imdbUrl, 'https://www.imdb.com/title/tt1234567/');

  const withoutId = summarize({ id: 9, original_title: 'No IMDb', release_date: '2020-01-01', imdb_id: null });
  assert.equal(withoutId.imdbUrl, null);
});

test('a v3 key goes in the query string, a v4 token in the header', async () => {
  const seen = [];
  const fake = async (url, opts) => {
    seen.push({ url: url.toString(), auth: opts.headers.authorization });
    return { ok: true, status: 200, json: async () => ({ results: [] }) };
  };
  await createClient('abc123', { fetchImpl: fake }).search('Stalker', 1979);
  assert.match(seen[0].url, /api_key=abc123/);
  assert.equal(seen[0].auth, undefined);

  await createClient('eyJhbGciOi.fake.token', { fetchImpl: fake }).search('Stalker', 1979);
  assert.doesNotMatch(seen[1].url, /api_key=/);
  assert.match(seen[1].auth, /^Bearer eyJ/);
});

test('a rate limit is retried, not thrown', async () => {
  let calls = 0;
  const fake = async () => {
    calls++;
    if (calls === 1) return { ok: false, status: 429, headers: { get: () => '0' } };
    return { ok: true, status: 200, json: async () => ({ results: [r(1, 'X', '2000-01-01')] }) };
  };
  const out = await createClient('k', { fetchImpl: fake }).search('X', 2000);
  assert.equal(calls, 2);
  assert.equal(out.length, 1);
});

test('a bad key fails loudly', async () => {
  const fake = async () => ({ ok: false, status: 401, headers: { get: () => null } });
  await assert.rejects(
    createClient('k', { fetchImpl: fake }).search('X', 2000),
    /rejected the key/,
  );
});

test('an empty duplicate record is discarded rather than causing a refusal', () => {
  const got = chooseMatch(
    { title: 'Aftersun', year: 2022 },
    [
      r(1, 'Aftersun', '2022-11-18', { poster_path: '/a.jpg', vote_count: 2200 }),
      r(2, 'Aftersun', '2022-01-01', { poster_path: null, vote_count: 0, release_date: '2022-01-01' }),
    ],
  );
  assert.equal(got.match.id, 1);
  assert.equal(got.confidence, 'exact-deduped');
});

test('two real duplicates are still a refusal', () => {
  const got = chooseMatch(
    { title: 'Close', year: 2022 },
    [
      r(1, 'Close', '2022-11-01', { poster_path: '/a.jpg', vote_count: 900 }),
      r(2, 'Close', '2022-03-01', { poster_path: '/b.jpg', vote_count: 400 }),
    ],
  );
  assert.equal(got.match, null);
});

test('a lone exact title is accepted when the year is well out, and flagged', () => {
  const got = chooseMatch(
    { title: 'Hundreds of Beavers', year: 2022 },
    [r(1, 'Hundreds of Beavers', '2024-01-26', { poster_path: '/a.jpg', vote_count: 300 })],
  );
  assert.equal(got.match.id, 1);
  assert.equal(got.confidence, 'title-exact-year-differs');
});

test('a lone result whose title does not match is still refused', () => {
  const got = chooseMatch(
    { title: 'Old Joy', year: 2006 },
    [r(1, 'Old', '2021-07-21', { poster_path: '/a.jpg', vote_count: 5000 })],
  );
  assert.equal(got.match, null);
});
