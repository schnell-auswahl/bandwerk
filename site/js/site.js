// Landing page script: navigation (mobile menu, active section), the shared session
// (js/core/session.js) and mounting of the studio (js/studio/main.js), the player
// (js/player/player-view.js) and the flasher (js/flasher/main.js).
// Both modules are loaded dynamically; if one is missing or fails, a tidy
// placeholder is shown instead and the rest of the page keeps working.

document.documentElement.classList.add("js");

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ------------------------------------------------------------------ navigation
function initNav() {
  const header = document.querySelector(".site-nav");
  const toggle = document.querySelector(".nav-toggle");
  const menu = document.getElementById("site-menu");
  if (!header || !toggle || !menu) return;

  const setOpen = (open) => {
    header.classList.toggle("is-open", open);
    toggle.setAttribute("aria-expanded", String(open));
  };
  toggle.addEventListener("click", () => setOpen(toggle.getAttribute("aria-expanded") !== "true"));
  menu.addEventListener("click", (e) => {
    if (e.target.closest("a")) setOpen(false);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && header.classList.contains("is-open")) {
      setOpen(false);
      toggle.focus();
    }
  });
  document.addEventListener("click", (e) => {
    if (header.classList.contains("is-open") && !header.contains(e.target)) setOpen(false);
  });

  // Active section: highlight the nav link of the section in view.
  const links = new Map();
  for (const a of menu.querySelectorAll('a[href^="#"]')) {
    const section = document.getElementById(a.getAttribute("href").slice(1));
    if (section) links.set(section, a);
  }
  // Sections without their own nav link count towards the previous one.
  const extra = { idea: "features", cables: "guide", faq: "developers" };
  for (const [id, target] of Object.entries(extra)) {
    const s = document.getElementById(id);
    const a = menu.querySelector(`a[href="#${target}"]`);
    if (s && a) links.set(s, a);
  }
  if (!("IntersectionObserver" in window) || links.size === 0) return;
  const visible = new Set();
  const update = () => {
    let best = null;
    for (const s of visible) {
      if (!best || s.getBoundingClientRect().top > best.getBoundingClientRect().top) {
        // the lowest section whose top has passed the probe line wins
        if (s.getBoundingClientRect().top <= window.innerHeight * 0.35) best = s;
      }
    }
    for (const a of links.values()) {
      a.classList.remove("is-active");
      a.removeAttribute("aria-current");
    }
    if (best) {
      const a = links.get(best);
      a.classList.add("is-active");
      a.setAttribute("aria-current", "location");
    }
  };
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) visible.add(e.target);
      else visible.delete(e.target);
    }
    update();
  }, { rootMargin: "0px 0px -40% 0px" });
  for (const s of links.keys()) io.observe(s);
  window.addEventListener("scroll", update, { passive: true });
}

// ------------------------------------------------------------------ mounting
function placeholder(root, { label, title, text, link }) {
  const box = document.createElement("div");
  box.className = "mount-placeholder";
  box.dataset.state = "unavailable";
  const eb = document.createElement("p");
  eb.className = "eyebrow";
  eb.textContent = label;
  const h = document.createElement("p");
  h.className = "mount-placeholder__title";
  h.textContent = title;
  const p = document.createElement("p");
  p.textContent = text;
  box.append(eb, h, p);
  if (link) {
    const a = document.createElement("a");
    a.className = "btn btn--ghost";
    a.href = link.href;
    a.textContent = link.text;
    box.append(a);
  }
  root.replaceChildren(box);
}

function highlightConnect() {
  const lab = document.getElementById("lab");
  const root = document.getElementById("studio-root");
  if (!lab || !root) return;
  lab.scrollIntoView({ behavior: reducedMotion() ? "auto" : "smooth", block: "start" });
  const target = [...root.querySelectorAll("button, a")].find((el) => /connect/i.test(el.textContent || ""))
    || root;
  target.classList.remove("site-callout");
  void target.offsetWidth;  // restart the animation
  target.classList.add("site-callout");
  if (target !== root && typeof target.focus === "function") {
    setTimeout(() => target.focus({ preventScroll: true }), reducedMotion() ? 0 : 600);
  }
  setTimeout(() => target.classList.remove("site-callout"), 6000);
}

// Options of the shared session from the page URL (development switches):
//   ?transport=demo|bridge|auto  ?bridge=http://host:port  ?pedal=standin (no WebAssembly build needed)
//   ?loops=audio/dev/loops.json  (the loops folder is gitignored; on localhost it is tried first)
function sessionOptions() {
  const q = new URLSearchParams(location.search);
  const local = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  const opts = { transport: q.get("transport") || "auto" };
  if (q.get("bridge")) opts.bridgeUrl = q.get("bridge");
  if (q.get("pedal") === "standin") opts.pedalModule = new URL("./audio/virtual-pedal-standin.js", import.meta.url).href;
  opts.loopsUrl = q.get("loops") || (local ? ["audio/dev/loops.json", "audio/loops.json"] : "audio/loops.json");
  return opts;
}

async function mountAll() {
  const studioRoot = document.getElementById("studio-root");
  const flasherRoot = document.getElementById("flasher-root");
  const playerRoot = document.getElementById("player-root");

  // One session for the whole page: the virtual pedal (or the connected pedal), the store, the audio.
  let session = null;
  try {
    const mod = await import("./core/session.js");
    session = await mod.createSession(sessionOptions());
    window.hothouse = { session };
  } catch (err) {
    console.warn("Session not available:", err);
  }

  if (studioRoot) {
    try {
      if (!session) throw new Error("no session");
      const mod = await import("./studio/main.js");
      studioRoot.replaceChildren();
      window.hothouse.studio = mod.mountStudio(studioRoot, session, { compact: true });
    } catch (err) {
      console.warn("Studio not available:", err);
      placeholder(studioRoot, {
        label: "Signal lab",
        title: "Interactive studio loads here",
        text: "This copy of the page doesn’t include the studio module. Meanwhile, the deep dives below explain every block of the chain.",
        link: { href: "#effects", text: "Read about the effects" },
      });
    }
  }

  const pedalRoot = document.getElementById("pedal-root");
  if (pedalRoot) {
    try {
      if (!session) throw new Error("no session");
      const mod = await import("./pedal/pedal-view.js");
      mod.mountPedal(pedalRoot, session, {
        // a click on a knob marks the blocks it controls in the studio chain
        onKnobFocus: (k) => { const st = window.hothouse && window.hothouse.studio; if (st && st.hlKnob !== k) st.highlightKnob(k); },
      });
    } catch (err) {
      console.warn("Pedal not available (showing the picture):", err);
    }
  }

  if (playerRoot) {
    try {
      if (!session) throw new Error("no session");
      const mod = await import("./player/player-view.js");
      playerRoot.replaceChildren();
      mod.mountPlayer(playerRoot, session);
    } catch (err) {
      console.warn("Player not available:", err);
      playerRoot.hidden = true;
    }
  }

  if (flasherRoot) {
    try {
      const mod = await import("./flasher/main.js");
      flasherRoot.replaceChildren();
      mod.mountFlasher(flasherRoot, {
        // Uses the session's open connection to restart the pedal into update mode.
        enterBootloader: () => (session ? session.enterBootloader() : null),
        onFlashed: () => highlightConnect(),
      });
    } catch (err) {
      console.warn("Installer not available:", err);
      placeholder(flasherRoot, {
        label: "Installer",
        title: "Installer loads here",
        text: "This copy of the page doesn’t include the installer module. You can flash the files from the GitHub releases with the Electro-Smith Daisy Web Programmer instead.",
        link: { href: "https://github.com/schnell-auswahl/hothouse-bass-multiband/releases", text: "GitHub releases" },
      });
    }
  }
}

initNav();
mountAll();
