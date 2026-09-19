/* intro.js — plays the opening sequence once per session. ?intro=1 replays, ?intro=0 skips,
   ?intro=record freezes timing so scripts/render-intro.js can render it to video frame by frame. */
(function () {
  const el = document.getElementById('intro');
  if (!el) return;
  const q = new URLSearchParams(location.search);
  const mode = q.get('intro');
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  let seen = false;
  try { seen = sessionStorage.getItem('rasta.intro') === '1'; } catch {}
  const record = mode === 'record';
  // Automation (tests, screenshot scripts) skips the intro unless it asks for it.
  const automated = !!navigator.webdriver && mode !== '1' && !record;
  if (mode === '0' || automated || (seen && mode !== '1' && !record) || (reduced && !record)) { el.remove(); return; }

  // Deterministic scatter in record mode so every frame render matches; random otherwise.
  let seed = 7;
  const rnd = record ? () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; } : Math.random;
  const between = (a, b) => a + rnd() * (b - a);
  const strokes = [...el.querySelectorAll('.st')];
  strokes.forEach((p, i) => {
    p.style.setProperty('--dx', `${between(-300, 300).toFixed(1)}px`);
    p.style.setProperty('--dy', `${between(-180, 180).toFixed(1)}px`);
    p.style.setProperty('--r', `${between(-150, 150).toFixed(1)}deg`);
    p.style.setProperty('--d', `${(i * 0.04 + between(0, 0.3)).toFixed(2)}s`);
  });
  el.querySelectorAll('.tick').forEach((p, i) => p.style.setProperty('--dl', `${(2.35 + i * 0.22).toFixed(2)}s`));

  document.body.classList.add('intro-playing');
  el.setAttribute('aria-hidden', 'false');
  requestAnimationFrame(() => el.classList.add('play'));

  let finished = false;
  function done() {
    if (finished) return;
    finished = true;
    el.remove();
    document.body.classList.remove('intro-playing');
    try { sessionStorage.setItem('rasta.intro', '1'); } catch {}
    window.dispatchEvent(new CustomEvent('rasta:intro-done'));
  }
  if (!record) {
    el.querySelector('#intro-skip').addEventListener('click', done);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' || e.key === ' ') done(); }, { once: true });
    setTimeout(done, 5150);
  }
  // Seek every animation on the page to a moment in time (used by the video renderer).
  window.__introSeek = (ms) => { for (const a of document.getAnimations()) { a.pause(); a.currentTime = ms; } };
  window.__introDone = done;
})();
