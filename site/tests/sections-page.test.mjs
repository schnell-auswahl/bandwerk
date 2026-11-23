// The landing page: nav targets exist, no commented-out blocks, every effect section has what the mount code
// needs (pedal, graphs, Hear it) and a showcase, and the old static plots are gone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { SHOWCASE_IDS } from '../js/core/showcase.js';
import { GRAPH_KINDS } from '../js/sections/effect-graphs.js';
import { SECTION_PEDALS } from '../js/sections/sections.js';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));

test('every nav link points to an existing section', () => {
  const nav = html.match(/<nav class="site-menu"[\s\S]*?<\/nav>/)[0];
  const hrefs = [...nav.matchAll(/href="#([^"]+)"/g)].map((m) => m[1]);
  assert.ok(hrefs.length >= 5);
  for (const h of hrefs) assert.ok(ids.has(h), 'dead nav link #' + h);
  assert.ok(!hrefs.includes('features'));
  for (const h of html.matchAll(/href="#([^"]+)"/g)) if (h[1] !== 'top') assert.ok(ids.has(h[1]), 'dead link #' + h[1]);
});

test('no commented-out markup is left in the page', () => {
  const comments = [...html.matchAll(/<!--([\s\S]*?)-->/g)].map((m) => m[1]);
  for (const c of comments) assert.ok(!/<[a-z]/i.test(c), 'commented-out block: ' + c.slice(0, 60));
});

test('effect sections: pedal copy, graphs, Hear it, ranges in a details element, no static plots', () => {
  const sections = [...html.matchAll(/<article [^>]*data-fxs="([^"]+)"[\s\S]*?<\/article>/g)];
  assert.deepEqual(sections.map((m) => m[1]).sort(), [...SHOWCASE_IDS].sort());
  assert.deepEqual([...GRAPH_KINDS].sort(), [...SHOWCASE_IDS].sort());
  assert.deepEqual(Object.keys(SECTION_PEDALS).sort(), [...SHOWCASE_IDS].sort());
  for (const [block, id] of sections) {
    for (const hook of ['data-fxs-pedal', 'data-fxs-graphs', 'data-fxs-bar']) assert.ok(block.includes(hook), id + ' misses ' + hook);
    assert.match(block, /<details class="fxs__ranges">\s*<summary>All ranges<\/summary>[\s\S]*<table>/, id);
    assert.ok(block.indexOf('data-fxs-pedal') < block.indexOf('How it works') && block.indexOf('How it works') < block.indexOf('fxs__ranges'), id + ' order');
    assert.ok(!block.includes('<svg'), id + ' still has an inline plot');
  }
  assert.ok(!html.includes('class="plot"'));
});

test('the pedal guide keeps gestures, pickup, LEDs, saving and power-up but not the page table', () => {
  const guide = html.match(/<section class="guide"[\s\S]*?<\/section>/)[0];
  for (const t of ['Footswitches', 'Knob pickup', 'LED language', 'What is saved', 'Power-up']) assert.ok(guide.includes(t), t);
  assert.ok(!guide.includes('pages-table'));
  assert.ok(html.includes('css/sections.css') && html.includes('css/pedal.css'));
});
