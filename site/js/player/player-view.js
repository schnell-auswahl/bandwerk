// The demo player: a compact Play/Pause + loop picker (for the hero, `root`) and a sticky bottom bar that
// appears after the first Play (play/pause, loop, amp/cab, volume, source, reset).
// Both are views on session.engine (js/audio/engine.js); see docs/STUDIO.md.
//
//   const player = mountPlayer(root, session, { sticky: true });
//   player.bar        the sticky bar element (null with sticky: false)
//   player.render()   redraws (called on its own for every session / audio event)

import { volumeToDb } from '../audio/engine.js';

const ICON_PLAY = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path d="M7 4.5v15l13-7.5z" fill="currentColor"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path d="M6 4.5h4.5v15H6zM13.5 4.5H18v15h-4.5z" fill="currentColor"/></svg>';
let uid = 0;

const fmtDb = (v) => { const d = volumeToDb(v); return d === -Infinity ? 'mute' : (Math.round(d) === 0 ? '0' : Math.round(d).toString().replace('-', '−')) + ' dB'; };

export function mountPlayer(root, session, options = {}) {
  return new Player(root, session, { sticky: true, ...options });
}

class Player {
  constructor(root, session, opts) {
    this.root = root; this.session = session; this.engine = session.engine;
    const n = 'pl' + (++uid);
    this.n = n;
    root.classList.add('pl-host');
    root.innerHTML = `
<div class="pl pl--compact" data-pl>
  <button type="button" class="pl-play" data-play>${ICON_PLAY}<span data-playlabel>Play</span></button>
  <label class="pl-field pl-field--loop"><span class="pl-lab">Loop</span><select data-loop></select></label>
  <p class="pl-msg" data-msg role="status" aria-live="polite"></p>
</div>`;
    this.bar = null;
    if (opts.sticky) {
      const bar = document.createElement('section');
      bar.className = 'pl pl--bar';
      bar.setAttribute('aria-label', 'Demo player');
      bar.hidden = true;
      bar.innerHTML = `
<div class="pl-row">
  <button type="button" class="pl-play" data-play>${ICON_PLAY}<span data-playlabel>Play</span></button>
  <label class="pl-field pl-field--loop"><span class="pl-lab">Loop</span><select data-loop></select></label>
  <label class="pl-field pl-field--vol"><span class="pl-lab">Volume <b data-voltext></b></span><input type="range" min="0" max="100" step="1" data-vol></label>
  <button type="button" class="pl-more" data-more aria-expanded="false" aria-controls="${n}-extra">Amp &amp; source</button>
  <div class="pl-extra" id="${n}-extra">
    <label class="pl-field pl-field--amp"><span class="pl-lab">Amp / cab</span><select data-amp></select></label>
    <fieldset class="pl-source"><legend class="pl-lab">Source</legend>
      <span class="pl-seg">
        <label><input type="radio" name="${n}-src" value="virtual" data-src><span>Virtual pedal</span></label>
        <label><input type="radio" name="${n}-src" value="real" data-src><span>Your pedal</span></label>
      </span>
    </fieldset>
    <button type="button" class="pl-reset" data-reset>Reset demo</button>
  </div>
</div>
<p class="pl-msg" data-msg role="status" aria-live="polite"></p>`;
      document.body.appendChild(bar);
      this.bar = bar;
    }
    this.views = [root.querySelector('[data-pl]'), this.bar].filter(Boolean);
    this.shownBar = false;
    this.bind();
    const rerender = () => this.render();
    session.addEventListener('audio', rerender);
    session.addEventListener('connection', rerender);
    this.render();
    if (this.bar && typeof ResizeObserver !== 'undefined') {
      this.ro = new ResizeObserver(() => document.documentElement.style.setProperty('--pl-h', this.bar.hidden ? '0px' : this.bar.offsetHeight + 'px'));
      this.ro.observe(this.bar);
    }
    this.timer = setInterval(() => { if (this.engine && this.engine.player && this.engine.player.pending) this.render(); }, 250);
  }

  all(sel) { return this.views.flatMap((v) => [...v.querySelectorAll(sel)]); }

  bind() {
    const e = this.engine;
    for (const v of this.views) {
      v.querySelector('[data-play]').addEventListener('click', () => this.toggle());
      v.querySelector('[data-loop]').addEventListener('change', (ev) => { if (e) e.setLoop(ev.target.value); });
      const amp = v.querySelector('[data-amp]');
      if (amp) amp.addEventListener('change', (ev) => e && e.setAmp(ev.target.value));
      const vol = v.querySelector('[data-vol]');
      if (vol) vol.addEventListener('input', (ev) => e && e.setVolume(+ev.target.value / 100));
      const more = v.querySelector('[data-more]');
      if (more) more.addEventListener('click', () => { const open = v.classList.toggle('is-open'); more.setAttribute('aria-expanded', String(open)); });
      const reset = v.querySelector('[data-reset]');
      if (reset) reset.addEventListener('click', () => this.session.resetDemo());
      v.querySelectorAll('[data-src]').forEach((r) => r.addEventListener('change', (ev) => this.source(ev.target.value)));
    }
  }

  async toggle() {
    const e = this.engine;
    if (!e) return;
    if (e.playing || e.status === 'loading') { e.pause(); return; }
    if (this.session.kind !== 'virtual') { this.render(); return; }
    this.shownBar = true;
    this.render();
    await e.play();
    this.render();
  }
  async source(v) {
    if (v === 'real') await this.session.connectSerial();
    else await this.session.disconnect();
    this.render();
  }

  message() {
    const e = this.engine, ses = this.session;
    if (!e) return 'The audio demo needs a current browser with WebAssembly and AudioWorklet.';
    if (ses.kind !== 'virtual') return 'The sound comes from your pedal. The demo audio is paused.';
    const st = e.status;
    if (st === 'unavailable') return 'Demo audio not available yet.';
    if (e.notice && st !== 'playing') return e.notice;
    if (st === 'loading') return 'Loading the loop…';
    if (st === 'playing') {
      const p = e.player, loop = e.loops.find((l) => l.id === e.loop);
      const next = p && p.pending ? 'Switching to the new loop at the next bar…' : '';
      return next || (e.notice || `Playing “${loop ? loop.name : ''}” through the virtual pedal.`);
    }
    if (st === 'paused') return 'Paused.';
    const cur = e.loops.find((l) => l.id === e.loop);
    if (cur && e.player && e.player.isAvailable(cur.id) === false) return 'This loop is not available yet. Pick another one.';
    return 'Play a bass loop through the virtual pedal. Turn the knobs and switches while it runs.';
  }

  render() {
    const e = this.engine, ses = this.session;
    const real = ses.kind === 'serial' || ses.kind === 'bridge';
    const st = e ? e.status : 'unavailable';
    const playing = !!e && (e.playing || st === 'loading');
    const noAudio = !e || st === 'unavailable' && !e.loops.length;
    if (this.bar) {
      const show = this.shownBar || (!!e && e.playing);
      if (!show !== this.bar.hidden) {
        this.bar.hidden = !show;
        document.documentElement.classList.toggle('has-player-bar', !!show);
        document.documentElement.style.setProperty('--pl-h', show ? this.bar.offsetHeight + 'px' : '0px');
      }
    }
    const msg = this.message();
    for (const v of this.views) {
      v.dataset.state = real ? 'suspended' : st;
      const play = v.querySelector('[data-play]');
      play.innerHTML = (playing ? ICON_PAUSE : ICON_PLAY) + `<span data-playlabel>${playing ? 'Pause' : 'Play'}</span>`;
      play.disabled = !e || real || noAudio;
      play.setAttribute('aria-label', playing ? 'Pause the demo' : 'Play the demo');
      const loops = e ? e.loops : [];
      const sel = v.querySelector('[data-loop]');
      const key = loops.map((l) => l.id + l.available).join('|') + '|' + (e ? e.loop : '');
      if (sel.dataset.key !== key) {
        sel.dataset.key = key;
        sel.innerHTML = loops.length
          ? loops.map((l) => `<option value="${l.id}"${l.available === false ? ' class="pl-missing"' : ''}>${esc(l.name)}${l.available === false ? ' (not available)' : ''}</option>`).join('')
          : '<option>No loops</option>';
        if (e && e.loop) sel.value = e.loop;
      }
      sel.disabled = !e || real || !loops.length;
      v.querySelector('[data-msg]').textContent = msg;
      const amp = v.querySelector('[data-amp]');
      if (amp) {
        if (!amp.options.length && e) amp.innerHTML = e.amps.map((a) => `<option value="${a.id}">${esc(a.name)}</option>`).join('');
        if (e) amp.value = e.amp;
        amp.disabled = !e || real;
      }
      const vol = v.querySelector('[data-vol]');
      if (vol && e) {
        if (document.activeElement !== vol || +vol.value !== Math.round(e.volume * 100)) vol.value = Math.round(e.volume * 100);
        vol.disabled = real;
        vol.setAttribute('aria-valuetext', fmtDb(e.volume));
        v.querySelector('[data-voltext]').textContent = fmtDb(e.volume);
      }
      const reset = v.querySelector('[data-reset]');
      if (reset) reset.disabled = real;
      v.querySelectorAll('[data-src]').forEach((r) => {
        r.checked = (r.value === 'real') === real;
        r.disabled = false;
      });
    }
  }
  dispose() {
    clearInterval(this.timer);
    if (this.ro) this.ro.disconnect();
    if (this.bar) this.bar.remove();
    document.documentElement.classList.remove('has-player-bar');
  }
}

function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
