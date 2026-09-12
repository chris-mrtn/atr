import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  parseFilms, parseListTitle, parseNextPage, splitTitleYear, decodeEntities,
} from './letterboxd.mjs';

const html = await readFile(new URL('./fixtures/list-2020.html', import.meta.url), 'utf8');

test('parses every entry on the page', () => {
  assert.equal(parseFilms(html).length, 5);
});

test('reads title, year, slug and absolute url', () => {
  const [first] = parseFilms(html);
  assert.deepEqual(first, {
    position: 1,
    title: 'The Two Popes',
    year: 2019,
    slug: 'the-two-popes',
    letterboxdUrl: 'https://letterboxd.com/film/the-two-popes/',
  });
});

test('position follows data-list-index, 1-based', () => {
  assert.deepEqual(parseFilms(html).map(f => f.position), [1, 2, 3, 4, 5]);
});

test('a question mark in the title survives', () => {
  const film = parseFilms(html).find(f => f.slug === 'am-i-ok');
  assert.equal(film.title, 'Am I OK?');
  assert.equal(film.year, 2022);
});

test('html entities are decoded', () => {
  const films = parseFilms(html);
  assert.equal(films.find(f => f.slug === 'dont-look-up').title, "Don't Look Up");
  assert.equal(films.find(f => f.slug === 'fanny-and-alexander').title, 'Fanny & Alexander');
});

test('a title with no year yields a null year rather than a broken title', () => {
  const film = parseFilms(html).find(f => f.slug === 'fanny-and-alexander');
  assert.equal(film.year, null);
  assert.equal(film.title, 'Fanny & Alexander');
});

test('list title comes from og:title', () => {
  assert.equal(parseListTitle(html), 'Avoid the Rut 2020');
});

test('a year in the title is not mistaken for the release year', () => {
  assert.deepEqual(splitTitleYear('Nineteen Eighty-Four (1984)'), { title: 'Nineteen Eighty-Four', year: 1984 });
  assert.deepEqual(splitTitleYear('2001: A Space Odyssey (1968)'), { title: '2001: A Space Odyssey', year: 1968 });
  assert.deepEqual(splitTitleYear('Blade Runner 2049 (2017)'), { title: 'Blade Runner 2049', year: 2017 });
});

test('empty or junk html yields no films rather than throwing', () => {
  assert.deepEqual(parseFilms(''), []);
  assert.deepEqual(parseFilms('<html><body>Rate limited</body></html>'), []);
});

test('no next link on a single-page list', () => {
  assert.equal(parseNextPage(html), null);
});

test('finds the next page link when present', () => {
  const paged = '<div class="paginate-nextprev"><a class="next" href="/chrismrtn/list/x/page/2/">Next</a></div>';
  assert.equal(parseNextPage(paged), '/chrismrtn/list/x/page/2/');
});

test('numeric entities decode', () => {
  assert.equal(decodeEntities('caf&#233;'), 'café');
});
