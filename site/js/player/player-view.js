// The demo player: a compact Play/Pause + loop picker (for the hero, `root`) and a sticky bottom bar that
// appears after the first Play (play/pause, loop, amp/cab, volume, source, reset).
// Both are views on session.engine (js/audio/engine.js); see docs/STUDIO.md.
//
//   const player = mountPlayer(root, session, { sticky: true });
//   player.bar        the sticky bar element (null with sticky: false)
//   player.render()   redraws (called on its own for every session / audio event)

import { volumeToDb } from '../audio/engine.js';
import { GAIN_MIN_DB, GAIN_MAX_DB } from '../audio/live-input.js';

const ICON_PLAY = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path d="M7 4.5v15l13-7.5z" fill="currentColor"/></svg>';
const ICON_PAUSE = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path d="M6 4.5h4.5v15H6zM13.5 4.5H18v15h-4.5z" fill="currentColor"/></svg>';
let uid = 0;
let headphonesConfirmed = false;      // the headphone notice is confirmed once per page visit

const METER_MIN_DB = -60;
const fmtGain = (db) => (db > 0 ? '+' : db < 0 ? '−' : '') + Math.abs(Math.round(db)) + ' dB';
const SRC_SEG = (name) => `
  <fieldset class="pl-source pl-source--in"><legend class="pl-lab">Input</legend>
    <span class="pl-seg">
      <label><input type="radio" name="${name}" value="loop" data-in><span>Loop</span></label>
      <label><input type="radio" name="${name}" value="live" data-in><span>Live input</span></label>
    </span>
  </fieldset>`;

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
  <label class="pl-field pl-field--loop"><span class="pl-lab">Loop</span><select data-loop></select></label>${SRC_SEG(n + '-inc')}
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
  <div class="pl-extra" id="${n}-extra">${SRC_SEG(n + '-inb')}
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
<div class="pl-live" data-live hidden>
  <div class="pl-notice" data-notice hidden>
    <p>Use headphones. With speakers, the microphone or interface input can pick up the sound and feed back loudly.</p>
    <span class="pl-notice-btns"><button type="button" class="pl-reset" data-confirm>I am wearing headphones</button><button type="button" class="pl-reset" data-cancel>Cancel</button></span>
  </div>
  <div class="pl-live-row" data-livectl hidden>
    <label class="pl-field pl-field--dev"><span class="pl-lab">Audio input</span><select data-dev></select></label>
    <label class="pl-field pl-field--ch"><span class="pl-lab">Channel</span><select data-ch></select></label>
    <label class="pl-field pl-field--gain"><span class="pl-lab">Input gain <b data-gaintext></b></span><input type="range" min="${GAIN_MIN_DB}" max="${GAIN_MAX_DB}" step="1" value="0" data-gain></label>
    <div class="pl-field pl-field--meter"><span class="pl-lab">Level <b data-peaktext></b></span>
      <span class="pl-meter"><i data-meterbar></i></span><span class="pl-clip" data-clip hidden>CLIP</span></div>
    <p class="pl-latency" data-latency></p>
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
    this.pending = false;     // the headphone notice waits for confirmation
    this.meterTimer = null;
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
      v.querySelectorAll('[data-in]').forEach((r) => r.addEventListener('change', (ev) => this.input(ev.target.value)));
      const on = (sel, ev, fn) => { const el = v.querySelector(sel); if (el) el.addEventListener(ev, fn); };
      on('[data-confirm]', 'click', () => { headphonesConfirmed = true; this.input('live'); });
      on('[data-cancel]', 'click', () => { this.pending = false; this.render(); });
      on('[data-dev]', 'change', (ev) => e && e.live.setDevice(ev.target.value));
      on('[data-ch]', 'change', (ev) => e && e.live.setChannel(ev.target.value));
      on('[data-gain]', 'input', (ev) => e && e.live.setGainDb(+ev.target.value));
    }
  }

  async toggle() {
    const e = this.engine;
    if (!e) return;
    if (e.playing || e.status === 'loading' || e.source === 'live') { e.pause(); this.pending = false; return; }
    if (this.session.kind !== 'virtual') { this.render(); return; }
    this.shownBar = true;
    this.render();
    await e.play();
    this.render();
  }
  // The Loop / Live input choice. Live input needs the headphone confirmation (once) and a user gesture.
  async input(v) {
    const e = this.engine;
    if (!e) return;
    if (v === 'live') {
      if (this.session.kind !== 'virtual') { this.render(); return; }
      if (!headphonesConfirmed) { this.pending = true; this.shownBar = true; this.render(); return; }
      this.pending = false; this.shownBar = true;
      const p = e.setSource('live');
      this.render();
      await p;
    } else {
      this.pending = false;
      await e.setSource('loop');
    }
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
    if (this.pending) return 'Confirm the headphone notice to switch on the live input.';
    if (e.source === 'live') return e.live.state === 'starting' ? 'Opening the audio input…' : 'Live input: your instrument goes through the virtual pedal.';
    if (e.live.error && st !== 'playing') return e.live.error.message;
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
    const live = !!e && e.source === 'live';
    const playing = !!e && (e.playing || st === 'loading' || live);
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
      play.innerHTML = (playing ? ICON_PAUSE : ICON_PLAY) + `<span data-playlabel>${live ? 'Stop' : playing ? 'Pause' : 'Play'}</span>`;
      play.disabled = !e || real || (noAudio && !live);
      play.setAttribute('aria-label', live ? 'Stop the live input' : playing ? 'Pause the demo' : 'Play the demo');
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
      sel.disabled = !e || real || !loops.length || live;
      v.querySelectorAll('[data-in]').forEach((r) => {
        r.checked = r.value === (live || this.pending ? 'live' : 'loop');
        r.disabled = !e || real || (r.value === 'live' && !e.liveSupported && !(e.live.error && e.live.error.code !== 'unsupported' && e.live.error.code !== 'insecure'));
      });
      this.renderLive(v, e, live, real);
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
  renderLive(v, e, live, real) {
    const box = v.querySelector('[data-live]');
    if (!box) return;
    box.hidden = real || !(this.pending || live);
    box.querySelector('[data-notice]').hidden = !this.pending;
    const ctl = box.querySelector('[data-livectl]');
    ctl.hidden = !live;
    if (live && e) {
      const L = e.live;
      const dev = ctl.querySelector('[data-dev]');
      const dkey = L.devices.map((d) => d.id + d.label).join('|') + '|' + L.deviceId;
      if (dev.dataset.key !== dkey) {
        dev.dataset.key = dkey;
        dev.innerHTML = '<option value="">Default input</option>' + L.devices.map((d) => `<option value="${esc(d.id)}">${esc(d.label)}</option>`).join('');
        dev.value = L.deviceId;
      }
      const ch = ctl.querySelector('[data-ch]');
      const ckey = L.channels.map((c) => c.id).join('|') + '|' + L.channel;
      if (ch.dataset.key !== ckey) {
        ch.dataset.key = ckey;
        ch.innerHTML = L.channels.map((c) => `<option value="${c.id}">${esc(c.label)}</option>`).join('');
        ch.value = L.channels.some((c) => c.id === L.channel) ? L.channel : '1';
      }
      const gain = ctl.querySelector('[data-gain]');
      if (document.activeElement !== gain) gain.value = L.gainDb;
      gain.setAttribute('aria-valuetext', fmtGain(L.gainDb));
      ctl.querySelector('[data-gaintext]').textContent = fmtGain(L.gainDb);
      const lat = e.latency;
      ctl.querySelector('[data-latency]').textContent = lat
        ? `Browser audio latency: about ${Math.round(lat.totalMs)} ms (plus your interface’s own buffer).`
        : '';
    }
    if (live && !this.meterTimer) this.meterTimer = setInterval(() => this.meter(), 60);
    else if (!live && this.meterTimer) { clearInterval(this.meterTimer); this.meterTimer = null; }
  }
  meter() {
    const e = this.engine;
    if (!e || e.source !== 'live') return;
    const { peakDb, clip } = e.live.readLevel();
    const pct = peakDb === -Infinity ? 0 : Math.max(0, Math.min(1, (peakDb - METER_MIN_DB) / -METER_MIN_DB)) * 100;
    const txt = peakDb === -Infinity ? '−∞ dBFS' : Math.round(peakDb).toString().replace('-', '−') + ' dBFS';
    for (const v of this.views) {
      const bar = v.querySelector('[data-meterbar]');
      if (!bar) continue;
      bar.style.width = pct + '%';
      v.querySelector('[data-clip]').hidden = !clip;
      v.querySelector('[data-peaktext]').textContent = txt;
      v.querySelector('.pl-meter').classList.toggle('is-clip', clip);
    }
  }
  dispose() {
    clearInterval(this.timer);
    if (this.meterTimer) clearInterval(this.meterTimer);
    if (this.ro) this.ro.disconnect();
    if (this.bar) this.bar.remove();
    document.documentElement.classList.remove('has-player-bar');
  }
}

function esc(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
