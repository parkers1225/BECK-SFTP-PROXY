/**
 * Open-animation for Beck Auto-Post — a vanilla-web port of the Beck Line app's
 * BeckLogoIntro / HeroScene. A wireframe icosahedron cage with an orbiting light
 * ring (live three.js) breathes behind the chrome "beck" badge, which punches in
 * with a blue bloom, then the whole thing fades and the WebGL context is disposed
 * (the showpiece greets you and leaves — 3D shouldn't linger). Plays once per
 * browser session — the first open, not every time the panel is re-opened mid-shift.
 */
import * as THREE from './lib/three.module.min.js';

(async function runIntro() {
  // Respect reduced-motion: skip the showpiece entirely.
  try {
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  } catch (e) {}
  // Once per session (chrome.storage.session clears when the browser closes).
  try {
    const s = await chrome.storage.session.get('introShown');
    if (s && s.introShown) return;
    chrome.storage.session.set({ introShown: true });
  } catch (e) { /* no session storage here — just play it */ }

  const overlay = document.createElement('div');
  overlay.id = 'introOverlay';
  overlay.setAttribute('role', 'presentation');
  overlay.innerHTML =
    '<div class="intro-stage">' +
      '<canvas class="intro-canvas"></canvas>' +
      '<div class="intro-center">' +
        '<div class="intro-badge-wrap">' +
          '<div class="intro-glow intro-glow-far"></div>' +
          '<div class="intro-glow intro-glow-near"></div>' +
          '<img class="intro-badge" src="icons/beck-wordmark.png" alt="">' +
          '<div class="intro-glow intro-flash"></div>' +
        '</div>' +
        '<div class="intro-subtitle">Auto-Post</div>' +
      '</div>' +
      '<div class="intro-floor"></div>' +
    '</div>';
  document.body.appendChild(overlay);

  let renderer = null, rafId = 0, disposed = false, ro = null;

  // --- three.js scene: ported 1:1 from HeroScene (Beck Line app) ---
  try {
    const stage = overlay.querySelector('.intro-stage');
    const canvas = overlay.querySelector('.intro-canvas');

    renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(0, 0, 4.4);

    // Size the buffer + camera to the canvas's ACTUAL displayed box, and keep
    // them in sync. Measuring too early (stale/zero size) is what squished it.
    const resize = () => {
      const w = canvas.clientWidth || stage.clientWidth || 380;
      const h = canvas.clientHeight || stage.clientHeight || 250;
      if (!w || !h) return;
      renderer.setSize(w, h, false);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    ro = new ResizeObserver(resize);
    ro.observe(canvas);
    resize();

    scene.add(new THREE.AmbientLight(0xffffff, 0.5));
    const p1 = new THREE.PointLight(0x818cf8, 60); p1.position.set(4, 4, 5); scene.add(p1);
    const p2 = new THREE.PointLight(0x22d3ee, 25); p2.position.set(-5, -3, 2); scene.add(p2);

    const group = new THREE.Group();
    const cage = new THREE.Mesh(
      new THREE.IcosahedronGeometry(1.55, 1),
      new THREE.MeshStandardMaterial({ color: 0x6366f1, emissive: 0x4f46e5, emissiveIntensity: 0.45, wireframe: true })
    );
    group.add(cage);
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(2.05, 0.012, 12, 128),
      new THREE.MeshBasicMaterial({ color: 0x818cf8, transparent: true, opacity: 0.45 })
    );
    ring.rotation.set(Math.PI / 2.4, 0, 0);
    group.add(ring);
    scene.add(group);

    const clock = new THREE.Clock();
    const tick = () => {
      if (disposed) return;
      const delta = clock.getDelta();
      const t = clock.elapsedTime;
      group.rotation.y += delta * 0.22;
      group.rotation.x = Math.sin(t * 0.35) * 0.14;
      group.position.y = Math.sin(t * 0.8) * 0.08;
      ring.rotation.z += delta * 0.4;
      const s = 1 + Math.sin(t * 1.2) * 0.02;
      cage.scale.set(s, s, s);
      renderer.render(scene, camera);
      rafId = requestAnimationFrame(tick);
    };
    tick();
  } catch (e) {
    // Fail-safe: if WebGL is unavailable, the badge layer still shows (no black screen).
    console.warn('[intro] 3D scene unavailable, showing badge only:', e && e.message);
  }

  const cleanup = () => {
    if (disposed) return;
    disposed = true;
    if (rafId) cancelAnimationFrame(rafId);
    try { if (ro) ro.disconnect(); } catch (e) {}
    try { if (renderer) { renderer.dispose(); renderer.forceContextLoss && renderer.forceContextLoss(); } } catch (e) {}
    overlay.remove();
  };
  const dismiss = () => {
    overlay.classList.add('intro-out');
    setTimeout(cleanup, 480);
  };

  // Auto-dismiss after the badge has settled; click to skip.
  overlay.addEventListener('click', dismiss);
  const auto = setTimeout(dismiss, 2300);
  overlay.addEventListener('click', () => clearTimeout(auto), { once: true });
})();
