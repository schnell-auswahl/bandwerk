// Loop manifest (site/audio/loops.json) and loop loading.
//
// Format: [{ id, name, file, bpm, gainDb, style, suggestedFor: ['comp', ...] }]
//   id            short unique id ("funk")
//   name          label in the picker ("Example 1 · Funk")
//   file          URL of the audio file, relative to the manifest
//   bpm           tempo (bars are 4 beats); the loop is a whole number of bars. 0/absent: switch with a short crossfade
//   gainDb        level trim so all loops sound equally loud at the pedal input (default 0)
//   style         free text ("funk")
//   suggestedFor  effect sections this loop shows off well: 'xover' 'comp' 'loop' 'oct' 'drive' 'mix'
//   note          optional free text (how the file was processed); not used by the player
// Any number of loops works (four are planned); the committed files are mono 48 kHz FLAC without metadata.
// The committed manifest may list files that do not exist yet; loading them then fails softly.

export const EFFECT_KEYS = ['xover', 'comp', 'loop', 'oct', 'drive', 'mix'];

// Normalizes and validates a parsed manifest. Invalid entries are dropped. Never throws.
// `base` (a URL string) resolves relative file names.
export function parseManifest(data, base = null) {
  const list = Array.isArray(data) ? data : data && Array.isArray(data.loops) ? data.loops : [];
  const seen = new Set(), out = [];
  for (const e of list) {
    if (!e || typeof e !== 'object') continue;
    const id = typeof e.id === 'string' ? e.id.trim() : '';
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id) || seen.has(id) || typeof e.file !== 'string' || !e.file) continue;
    seen.add(id);
    let url = e.file;
    if (base) { try { url = new URL(e.file, base).href; } catch (err) { /* keep as is */ } }
    const bpm = Number.isFinite(+e.bpm) && +e.bpm >= 30 && +e.bpm <= 300 ? +e.bpm : 0;
    const gainDb = Number.isFinite(+e.gainDb) ? Math.max(-24, Math.min(12, +e.gainDb)) : 0;
    out.push({
      id, name: typeof e.name === 'string' && e.name ? e.name : id, file: e.file, url, bpm, gainDb,
      style: typeof e.style === 'string' ? e.style : '', note: typeof e.note === 'string' ? e.note : '',
      suggestedFor: Array.isArray(e.suggestedFor) ? e.suggestedFor.filter((k) => EFFECT_KEYS.includes(k)) : [],
    });
  }
  return out;
}

// First manifest of `urls` that loads and has at least one valid loop. -> { loops, url } ({ loops: [] } if none).
export async function loadManifest(urls, fetchFn = globalThis.fetch) {
  const list = Array.isArray(urls) ? urls : [urls];
  for (const u of list) {
    if (!u) continue;
    try {
      const r = await fetchFn(u, { cache: 'no-cache' });
      if (!r || !r.ok) continue;
      const base = typeof location !== 'undefined' ? new URL(u, location.href).href : u;
      const loops = parseManifest(await r.json(), base);
      if (loops.length) return { loops, url: u };
    } catch (e) { /* try the next one */ }
  }
  return { loops: [], url: null };
}

// Loader with a cache: load(loop) -> Promise<AudioBuffer>; a failure rejects with Error.code = 'missing' | 'decode'.
export function createLoopLoader(ctx, fetchFn = globalThis.fetch) {
  const cache = new Map();
  return function load(loop) {
    if (cache.has(loop.id)) return cache.get(loop.id);
    const p = (async () => {
      let r;
      try { r = await fetchFn(loop.url); } catch (e) { throw Object.assign(new Error('network'), { code: 'missing' }); }
      if (!r || !r.ok) throw Object.assign(new Error('missing'), { code: 'missing' });
      const bytes = await r.arrayBuffer();
      try { return await ctx.decodeAudioData(bytes); } catch (e) { throw Object.assign(new Error('decode'), { code: 'decode' }); }
    })();
    cache.set(loop.id, p);
    p.catch(() => { if (cache.get(loop.id) === p) cache.delete(loop.id); });
    return p;
  };
}
