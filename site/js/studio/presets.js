// Presets: the sound-relevant state as JSON (export/import, share link in the
// URL hash) and the command sequence that applies one to the pedal. Pure.

import { PARAM_NAMES, NUM_PARAMS, permille, DRIVE_CMDS, LOOP_CMDS } from './mapping.js';

export const PRESET_FORMAT = 'hothouse-bass-multiband-preset';
export const PRESET_VERSION = 1;
export const HASH_KEY = 'preset=';

// State (as in the [S] message) -> preset object.
export function presetFromState(S, name = 'My preset') {
  const params = {};
  PARAM_NAMES.forEach((n, i) => { params[n] = permille(S.pm[i]); });
  return {
    format: PRESET_FORMAT, version: PRESET_VERSION, name,
    params, octave: !!S.oct, drive: !!S.drv, driveType: DRIVE_CMDS[S.drive], loopMode: LOOP_CMDS[S.loop],
  };
}

// Checks and normalizes a parsed preset. Throws an Error with a readable message.
export function validatePreset(p) {
  if (!p || typeof p !== 'object' || p.format !== PRESET_FORMAT) throw new Error('This is not a Hothouse Bass Multiband preset.');
  if (p.version !== PRESET_VERSION) throw new Error('Unknown preset version ' + p.version + '.');
  if (!p.params || typeof p.params !== 'object') throw new Error('The preset has no parameters.');
  const params = {};
  for (const n of PARAM_NAMES) {
    const v = p.params[n];
    if (v === undefined) continue;   // missing values stay as they are on the pedal
    if (!Number.isInteger(v) || v < 0 || v > 1000) throw new Error('Bad value for ' + n + ': ' + v);
    params[n] = v;
  }
  const out = { format: PRESET_FORMAT, version: PRESET_VERSION, name: String(p.name || 'Preset').slice(0, 60), params };
  if (typeof p.octave === 'boolean') out.octave = p.octave;
  if (typeof p.drive === 'boolean') out.drive = p.drive;
  if (DRIVE_CMDS.includes(p.driveType)) out.driveType = p.driveType;
  if (LOOP_CMDS.includes(p.loopMode)) out.loopMode = p.loopMode;
  return out;
}

export const presetToJson = (p) => JSON.stringify(p, null, 2);
export const presetFromJson = (text) => {
  let p;
  try { p = JSON.parse(text); } catch (e) { throw new Error('The file is not valid JSON.'); }
  return validatePreset(p);
};

// Commands that apply a preset (the page on the pedal stays as it is).
export function presetCommands(p) {
  const c = [];
  PARAM_NAMES.forEach((n, i) => { if (p.params[n] !== undefined) c.push('set ' + i + ' ' + p.params[n]); });
  if (p.driveType) c.push('dtype ' + p.driveType);
  if (p.loopMode) c.push('lmode ' + p.loopMode);
  if (p.octave !== undefined) c.push('oct ' + (p.octave ? 'on' : 'off'));
  if (p.drive !== undefined) c.push('drv ' + (p.drive ? 'on' : 'off'));
  return c;
}

// ---- share link: #preset=<base64url of compact JSON>
const b64url = (s) => {
  const bytes = new TextEncoder().encode(s);
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
const unb64url = (s) => {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
};
export const presetToHash = (p) => '#' + HASH_KEY + b64url(JSON.stringify(p));
export function presetFromHash(hash) {
  const h = (hash || '').replace(/^#/, '');
  if (!h.startsWith(HASH_KEY)) return null;
  return validatePreset(JSON.parse(unb64url(h.slice(HASH_KEY.length))));
}
export const NUM_PRESET_PARAMS = NUM_PARAMS;
