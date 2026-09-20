import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const read = name => readFileSync(new URL(`../public/commander/${name}`, import.meta.url), 'utf8');

// $('someId') resolves at call time, so an element removed from the page leaves a lookup that
// returns null and throws on first use — which can be a button that no longer starts the game,
// with nothing failing until someone clicks it. The page is static, so the pairing can just be
// checked: every id main.js reaches for has to exist in the markup.
test('every element main.js looks up exists in the page', () => {
  const html = read('index.html');
  const js = read('main.js');
  const ids = new Set([...html.matchAll(/id="([A-Za-z0-9_-]+)"/g)].map(m => m[1]));
  const used = [...new Set([...js.matchAll(/\$\('([A-Za-z0-9_-]+)'\)/g)].map(m => m[1]))];
  assert.ok(used.length > 20, `expected main.js to look up many elements, found ${used.length}`);
  const missing = used.filter(id => !ids.has(id));
  assert.deepEqual(missing, [], `main.js reaches for elements the page does not have: ${missing.join(', ')}`);
});

// Two elements sharing an id is invalid, and $ silently returns whichever comes first, so the
// other one is markup nobody can reach.
test('no id appears twice in the page', () => {
  const ids = [...read('index.html').matchAll(/id="([A-Za-z0-9_-]+)"/g)].map(m => m[1]);
  const duplicates = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];
  assert.deepEqual(duplicates, [], `duplicate ids: ${duplicates.join(', ')}`);
});
