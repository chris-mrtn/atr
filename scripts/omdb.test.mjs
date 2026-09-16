import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseRating, createClient } from './omdb.mjs';

test('parseRating handles a normal rating, N/A, and junk', () => {
  assert.equal(parseRating('8.4'), 8.4);
  assert.equal(parseRating('N/A'), null);
  assert.equal(parseRating(''), null);
  assert.equal(parseRating(undefined), null);
  assert.equal(parseRating('not a number'), null);
});

test('fetches a rating for a known id', async () => {
  const fake = async url => {
    assert.equal(url.searchParams.get('i'), 'tt1285016');
    assert.equal(url.searchParams.get('apikey'), 'k');
    return { ok: true, status: 200, json: async () => ({ Response: 'True', imdbRating: '7.5' }) };
  };
  const got = await createClient('k', { fetchImpl: fake }).rating('tt1285016');
  assert.equal(got, 7.5);
});

test('a film OMDb has no rating for yet comes back null, not an error', async () => {
  const fake = async () => ({ ok: true, status: 200, json: async () => ({ Response: 'True', imdbRating: 'N/A' }) });
  const got = await createClient('k', { fetchImpl: fake }).rating('tt0000001');
  assert.equal(got, null);
});

test('an id OMDb does not recognise is a refusal, not a silent null', async () => {
  const fake = async () => ({ ok: true, status: 200, json: async () => ({ Response: 'False', Error: 'Incorrect IMDb ID.' }) });
  await assert.rejects(
    createClient('k', { fetchImpl: fake }).rating('tt0000000'),
    /Incorrect IMDb ID/,
  );
});

test('a bad key fails loudly', async () => {
  const fake = async () => ({ ok: false, status: 401 });
  await assert.rejects(
    createClient('k', { fetchImpl: fake }).rating('tt1285016'),
    /rejected the key/,
  );
});

test('retries once on a 429 before succeeding', async () => {
  let calls = 0;
  const fake = async () => {
    calls++;
    if (calls === 1) return { ok: false, status: 429, headers: { get: () => '0' } };
    return { ok: true, status: 200, json: async () => ({ Response: 'True', imdbRating: '9.0' }) };
  };
  const got = await createClient('k', { fetchImpl: fake }).rating('tt1285016');
  assert.equal(calls, 2);
  assert.equal(got, 9.0);
});

test('a key is required', () => {
  assert.throws(() => createClient(''), /key is required/);
});
