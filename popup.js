/* ============================================================
   Beck Auto-Post — side panel controller (Studio redesign)
   Flow: Inventory (auto-synced) -> Photos (pick <=20) -> Description -> auto-fill Marketplace
   ============================================================ */
'use strict';

const DEFAULTS = {
  proxyUrl: 'https://beck-sftp-proxy-production.up.railway.app',
  refreshMin: 15
};
const MAX_PHOTOS = 20;
const FB_CREATE_URL = 'https://www.facebook.com/marketplace/create/vehicle';
const STORE_LABELS = {
  'beck-cdjr': 'Beck CDJR', 'beck-chevy': 'Beck Chevy',
  'beck-ford': 'Beck Ford', 'beck-nissan': 'Beck Nissan'
};

const FILTERS = [
  { t: 'New', kind: 'cond', val: 'New' },
  { t: 'Pre-owned', kind: 'cond', val: 'Used' },
  { t: 'Truck', kind: 'body', val: 'Truck' },
  { t: 'SUV', kind: 'body', val: 'SUV' },
  { t: 'Van', kind: 'body', val: 'Van' },
  { t: 'Sedan', kind: 'body', val: 'Sedan' }
];

const state = {
  settings: { ...DEFAULTS },
  accessCode: null,
  store: null,
  storeName: '',
  userName: '',
  step: 1,
  loading: true,
  vehicles: [],
  lastSync: null,
  search: '',
  fCond: {}, fBody: {},
  sel: null,            // selected vehicle index
  photos: [],           // photo URLs for selected vehicle
  picked: new Set(),    // indices of selected photos
  pickedDirty: false,   // rep changed the selection by hand (don't reset it when the gallery arrives)
  focus: 0,             // focused photo in hero
  desc: '', generated: false,
  filling: false
};

/* ---------- tiny helpers ---------- */
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = (n) => (n || n === 0) ? '$' + Number(n).toLocaleString('en-US') : '—';
const milesFmt = (n, u) => (n || n === 0) ? Number(n).toLocaleString('en-US') + ' ' + (u || 'mi').toLowerCase() : '—';
// (store + feed key are decided by the server from the user's access code)

function toast(msg, kind) {
  const c = $('toasts'); if (!c) return;
  const d = document.createElement('div');
  d.className = 'toast toast--' + (kind || 'ok');
  const icon = kind === 'err' ? 'circle-x' : kind === 'warn' ? 'alert-triangle' : 'circle-check';
  d.innerHTML = `<i class="ti ti-${icon}"></i><span>${esc(msg)}</span>`;
  c.appendChild(d);
  setTimeout(() => { d.style.transition = '.3s'; d.style.opacity = '0'; setTimeout(() => d.remove(), 320); }, 2800);
}

/* ---------- storage / messaging ---------- */
function sget(keys) { return new Promise(r => chrome.storage.local.get(keys, r)); }
function sset(obj) { return new Promise(r => chrome.storage.local.set(obj, r)); }
function send(action, data) {
  return new Promise(resolve => {
    try { chrome.runtime.sendMessage({ action, data }, (resp) => { void chrome.runtime.lastError; resolve(resp || { success: false }); }); }
    catch (e) { resolve({ success: false, error: e.message }); }
  });
}

// Live progress from the content script while a fill is running.
chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.action !== 'formFillProgress' || !state.filling) return;
  const bar = $('fillBar'); if (bar) bar.style.width = Math.max(5, Math.min(100, Number(msg.progress) || 0)) + '%';
  const nb = $('dockNext'); if (nb && msg.stage) nb.innerHTML = `<span class="spinner"></span><span>${esc(msg.stage)}</span>`;
});

function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60); if (m < 60) return m + ' min ago';
  const h = Math.round(m / 60); return h + (h === 1 ? ' hr ago' : ' hrs ago');
}

/* ============================================================
   CSV parsing (RFC4180-ish: quotes, embedded commas + newlines)
   ============================================================ */
function parseCSV(text) {
  const rows = []; let row = [], field = '', i = 0, inQ = false;
  text = text.replace(/^﻿/, '');
  while (i < text.length) {
    const ch = text[i];
    if (inQ) {
      if (ch === '"') { if (text[i + 1] === '"') { field += '"'; i += 2; continue; } inQ = false; i++; continue; }
      field += ch; i++; continue;
    }
    if (ch === '"') { inQ = true; i++; continue; }
    if (ch === ',') { row.push(field); field = ''; i++; continue; }
    if (ch === '\r') { i++; continue; }
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; i++; continue; }
    field += ch; i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  if (!rows.length) return [];
  const header = rows[0].map(h => h.trim());
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    if (rows[r].length === 1 && rows[r][0] === '') continue;
    const obj = {};
    for (let c = 0; c < header.length; c++) obj[header[c]] = rows[r][c] !== undefined ? rows[r][c] : '';
    out.push(obj);
  }
  return out;
}

function bodyCategory(raw) {
  const s = String(raw || '').toUpperCase();
  if (s.includes('TRUCK') || s.includes('PICKUP')) return 'Truck';
  if (s.includes('SUV') || s.includes('SPORT UTILITY') || s.includes('CROSSOVER')) return 'SUV';
  if (s.includes('VAN')) return 'Van';
  if (s.includes('SEDAN') || s.includes('COUPE') || s.includes('HATCH') || s.includes('CONVERT') || s.includes('WAGON')) return 'Sedan';
  return 'Other';
}
function num(v) { const n = parseFloat(String(v || '').replace(/[^0-9.]/g, '')); return isNaN(n) ? null : n; }
// First non-empty trimmed value among candidate column names (handles feed naming variants).
function pick(o, keys) { for (const k of keys) { const v = (o[k] || '').trim(); if (v) return v; } return ''; }
// First numeric value among candidate column names.
function numAny(o, keys) { for (const k of keys) { const n = num(o[k]); if (n != null) return n; } return null; }

function mapVehicle(o) {
  const vin = (o['vin'] || o['vehicle_id'] || '').trim();
  const year = (o['year'] || '').trim();
  const make = (o['make'] || '').trim();
  const model = (o['model'] || '').trim();
  const trim = (o['Trim'] || o['trim'] || '').trim();
  const price = num(o['sale_price']) || num(o['price']);
  const condRaw = (o['state_of_vehicle'] || o['condition'] || '').trim().toUpperCase();
  const cond = condRaw.includes('NEW') ? 'New' : 'Used';
  // Collect every photo the feed provides (image[0].url, image[1].url, …).
  // Today vAuto exports only image[0]; this is ready for when it exports more.
  const images = [];
  for (let i = 0; i < 60; i++) {
    const u = (o[`image[${i}].url`] || '').trim();
    if (u) images.push(u);
  }
  // Mileage from the feed, tolerant of column-name variants. Dealership rule:
  // a NEW unit with no/zero odometer in the feed is listed at 301 miles.
  let mileage = numAny(o, ['mileage.value', 'mileage', 'Mileage', 'odometer', 'Odometer', 'odometer.value', 'miles']);
  if ((mileage == null || mileage === 0) && cond === 'New') mileage = 301;
  // The feed's vehicle_id is often just the VIN — only treat it as a stock number
  // when it's actually different. The real stock comes from DealerMade on select.
  const vehId = (o['vehicle_id'] || '').trim();
  const stock = (vehId && vehId.toUpperCase() !== vin.toUpperCase()) ? vehId : '';
  return {
    vin, year, make, model, trim,
    title: [year, make, model, trim].filter(Boolean).join(' '),
    price,
    mileage,
    mileageUnit: pick(o, ['mileage.unit', 'mileage_unit']) || 'MI',
    color: pick(o, ['exterior_color', 'Exterior Color', 'ExteriorColor', 'exteriorColor', 'color', 'Color', 'exterior_color_name', 'ext_color']),
    body: bodyCategory(o['body_style']),
    bodyRaw: (o['body_style'] || '').trim(),
    cond,
    stock,
    address: (o['address'] || '').trim(),
    vdp: (o['url'] || '').trim(),
    condition: cond,
    bodyStyle: (o['body_style'] || '').trim(),
    transmission: (o['transmission'] || '').trim(),
    fuelType: (o['fuel_type'] || '').trim(),
    drivetrain: (o['drivetrain'] || '').trim(),
    description: (o['description'] || '').trim(),
    primary: images[0] || '',
    images,
    hasPhoto: images.length > 0
  };
}

/* ============================================================
   Inventory load + auto-refresh
   ============================================================ */
async function loadInventory(silent) {
  const base = state.settings.proxyUrl.replace(/\/+$/, '');
  try {
    if (!silent) { state.loading = true; if (state.step === 1) renderStep(); }
    const res = await fetch(`${base}/feed`, { cache: 'no-store', headers: { 'X-Access-Code': state.accessCode || '' } });
    if (res.status === 401) { showGate('Your access was turned off. Ask your manager for a new code.'); return false; }
    if (!res.ok) throw new Error('Feed returned ' + res.status);
    const text = await res.text();
    const rows = parseCSV(text);
    const vehicles = rows.map(mapVehicle).filter(v => v.vin && v.make);
    state.vehicles = vehicles;
    state.lastSync = Date.now();
    state.loading = false;
    if (state.step === 1) renderStep();
    enrichStocks(vehicles);   // fire-and-forget: backfill real DealerMade stock numbers
    if (!silent) toast(`${vehicles.length} vehicles synced`);
    return true;
  } catch (e) {
    state.loading = false;
    if (state.step === 1) renderStep();
    toast('Could not reach the inventory feed', 'err');
    console.error('loadInventory failed:', e);
    return false;
  }
}

// Backfill real DealerMade stock numbers for the whole list (the feed's vehicle_id
// is just the VIN). Fire-and-forget: the list shows instantly, then re-renders once
// stocks arrive so cards display — and search matches — the real stock number.
async function enrichStocks(vehicles) {
  const base = state.settings.proxyUrl.replace(/\/+$/, '');
  const byDomain = new Map();
  for (const v of vehicles) {
    let domain = '';
    try { domain = v.vdp ? new URL(v.vdp).hostname : ''; } catch (e) {}
    if (!domain || !v.vin) continue;
    if (!byDomain.has(domain)) byDomain.set(domain, []);
    byDomain.get(domain).push(v.vin);
  }
  let any = false;
  for (const [domain, vins] of byDomain) {
    try {
      const res = await fetch(`${base}/stocks`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Access-Code': state.accessCode || '' },
        body: JSON.stringify({ domain, vins })
      });
      if (!res.ok) continue;
      const data = await res.json();
      const stocks = (data && data.stocks) || {};
      for (const v of vehicles) {
        if (stocks[v.vin] && v.stock !== stocks[v.vin]) { v.stock = stocks[v.vin]; any = true; }
      }
    } catch (e) { /* keep VIN-only on failure */ }
  }
  if (any && state.step === 1 && state.vehicles === vehicles) renderInventory();
}

let refreshTimer = null;
function scheduleRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  const min = Math.max(5, Number(state.settings.refreshMin) || 15);
  refreshTimer = setInterval(() => loadInventory(true), min * 60 * 1000);
}

/* ============================================================
   Filtering
   ============================================================ */
function filteredVehicles() {
  let list = state.vehicles.map((v, i) => ({ v, i }));
  const conds = Object.keys(state.fCond).filter(k => state.fCond[k]);
  const bodies = Object.keys(state.fBody).filter(k => state.fBody[k]);
  if (conds.length) list = list.filter(o => conds.includes(o.v.cond));
  if (bodies.length) list = list.filter(o => bodies.includes(o.v.body));
  const q = state.search.trim().toLowerCase();
  if (q) {
    const terms = q.split(/\s+/).filter(Boolean);
    list = list.filter(o => {
      const v = o.v;
      const hay = [v.year, v.make, v.model, v.trim, v.color, v.body, v.cond, v.vin, v.stock, v.price].join(' ').toLowerCase();
      return terms.every(t => hay.includes(t));
    });
  }
  return list;
}

/* ============================================================
   Rendering
   ============================================================ */
function setStepUI() {
  const segs = $('stepSegs');
  Array.from(segs.children).forEach((el, idx) => {
    const n = idx + 1;
    el.classList.toggle('is-done', n < state.step);
    el.classList.toggle('is-on', n === state.step);
  });
  segs.setAttribute('aria-valuenow', state.step);
  $('stepNum').textContent = state.step;
  $('stepName').textContent = ['Inventory', 'Photos', 'Description'][state.step - 1];
  const v = curVehicle();
  $('stepCnt').textContent = v ? v.title : '';
  document.querySelectorAll('.step').forEach(s => s.classList.remove('is-active'));
  const sec = ['step-inventory', 'step-photos', 'step-description'][state.step - 1];
  $(sec).classList.add('is-active');
}

function curVehicle() { return state.sel == null ? null : state.vehicles[state.sel]; }

function renderStep() {
  setStepUI();
  if (state.step === 1) renderInventory();
  else if (state.step === 2) renderPhotos();
  else renderDescription();
  updateDock();
  const sc = $('scroll'); if (sc) sc.scrollTop = 0;
}

function renderChips() {
  const c = $('invChips');
  c.innerHTML = FILTERS.map(f => {
    const on = (f.kind === 'cond' ? state.fCond[f.val] : state.fBody[f.val]);
    const icon = f.kind === 'body' ? `<i class="ti ti-${f.val === 'Truck' ? 'truck' : 'car'}"></i>` : '';
    return `<button class="fchip${on ? ' is-on' : ''}" data-kind="${f.kind}" data-val="${f.val}">${icon}${f.t}</button>`;
  }).join('');
  c.querySelectorAll('.fchip').forEach(b => b.onclick = () => {
    const kind = b.getAttribute('data-kind'), val = b.getAttribute('data-val');
    const bag = kind === 'cond' ? state.fCond : state.fBody;
    bag[val] = !bag[val];
    renderInventory();
  });
}

function renderInventory() {
  renderChips();
  const skel = $('invSkeleton'), empty = $('invEmpty'), list = $('invList'), synced = $('invSynced'), status = $('invStatus');
  if (state.loading) {
    skel.hidden = false; empty.hidden = true; list.innerHTML = ''; synced.textContent = '';
    status.textContent = 'Syncing live inventory…';
    return;
  }
  skel.hidden = true;
  status.textContent = 'Live feed · auto-updates every ' + (Number(state.settings.refreshMin) || 15) + ' min';
  const rows = filteredVehicles();
  synced.textContent = `${rows.length} of ${state.vehicles.length} vehicles` + (state.lastSync ? ' · synced ' + ago(state.lastSync) : '');
  if (!rows.length) {
    list.innerHTML = ''; empty.hidden = false;
    $('invEmptyT').textContent = state.vehicles.length ? 'No matches' : 'No inventory';
    $('invEmptyD').textContent = state.vehicles.length ? 'Try a different search or clear the filters.' : 'Check the feed settings, then refresh.';
    return;
  }
  empty.hidden = true;
  list.innerHTML = rows.map(o => {
    const v = o.v;
    const chip = v.hasPhoto
      ? `<span class="chip chip--ok"><i class="ti ti-photo"></i>Photo</span>`
      : `<span class="chip chip--warn"><i class="ti ti-photo-off"></i>0</span>`;
    const badge = v.cond === 'New' ? '<span class="vbadge">NEW</span>' : '';
    const thumb = v.primary
      ? `<span class="vth-wrap">${badge}<img class="vthumb" loading="lazy" src="${esc(v.primary)}" alt=""></span>`
      : `<span class="vth-wrap">${badge}<span class="vthumb"><i class="ti ti-car"></i></span></span>`;
    return `<button class="vrow${state.sel === o.i ? ' is-selected' : ''}" data-i="${o.i}" role="option">
      ${thumb}
      <span class="vrow__main">
        <span class="vtitle">${esc(v.title)}</span>
        <span class="vmeta">${money(v.price)} · ${milesFmt(v.mileage, v.mileageUnit)} · ${esc(v.body)}</span>
        <span class="vvin">${v.stock ? 'Stock ' + esc(v.stock) + ' · ' : ''}VIN ·${esc(v.vin.slice(-6))}</span>
      </span>${chip}</button>`;
  }).join('');
  list.querySelectorAll('.vrow').forEach(b => b.onclick = () => selectVehicle(+b.getAttribute('data-i')));
}

function selectVehicle(i) {
  state.sel = i;
  const v = state.vehicles[i];
  state.focus = 0; state.generated = false; state.desc = '';
  state.photos = (v.images || []).slice();   // instant: the feed's primary photo
  state.picked = new Set(state.photos.map((_, k) => k).slice(0, MAX_PHOTOS));
  state.pickedDirty = false;
  go(2);
  toast(`${v.title} selected`);
  loadGallery(i, v);                          // then pull the full DealerMade gallery
}

// Pull the vehicle's full photo gallery from the proxy (DealerMade) and swap it in.
async function loadGallery(i, v) {
  let domain = '';
  try { domain = v.vdp ? new URL(v.vdp).hostname : ''; } catch (e) {}
  if (!v.vin || !domain) return;
  try {
    const base = state.settings.proxyUrl.replace(/\/+$/, '');
    const res = await fetch(`${base}/photos?vin=${encodeURIComponent(v.vin)}&domain=${encodeURIComponent(domain)}`,
      { headers: { 'X-Access-Code': state.accessCode || '' } });
    if (!res.ok) return;
    const data = await res.json();
    // DealerMade also carries color; use it to backfill what the vAuto feed omits
    // (new units often ship with no exterior color, and the feed has no interior color).
    if (data) {
      if (data.exteriorColor && !v.color) v.color = data.exteriorColor;
      if (data.interiorColor && !v.interiorColor) v.interiorColor = data.interiorColor;
      if (data.stockNumber) v.stock = data.stockNumber;
    }
    const gallery = (data && data.photos) || [];
    if (gallery.length && state.sel === i) {
      // If the rep already touched the selection, carry it over by URL instead of
      // silently resetting to "first 20" underneath them.
      const keepUrls = state.pickedDirty ? new Set([...state.picked].map(k => state.photos[k])) : null;
      state.photos = gallery;
      state.picked = keepUrls
        ? new Set(gallery.map((u, k) => keepUrls.has(u) ? k : -1).filter(k => k >= 0).slice(0, MAX_PHOTOS))
        : new Set(gallery.map((_, k) => k).slice(0, MAX_PHOTOS));
      if (state.focus >= gallery.length) state.focus = 0;
      if (state.step === 2) renderPhotos();
      updateDock();
    }
  } catch (e) { /* keep the feed photo on failure */ }
}

function renderPhotos() {
  const v = curVehicle(); if (!v) return;
  $('phTitle').textContent = v.title;
  $('phSub').textContent = [v.trim, v.color, milesFmt(v.mileage, v.mileageUnit)].filter(Boolean).join(' · ');
  $('phPrice').textContent = money(v.price);

  const hero = $('hero'), img = $('heroImg'), ph = $('heroPlaceholder'), warn = $('photoWarn');
  const tools = $('ptools'), grid = $('pgrid'), toggle = $('heroToggle'), label = $('heroLabel');

  if (!state.photos.length) {
    warn.hidden = false; hero.classList.add('hero--warn');
    img.hidden = true; ph.hidden = false; ph.innerHTML = '<i class="ti ti-photo-off"></i>';
    toggle.style.display = 'none'; label.textContent = '';
    tools.style.display = 'none'; grid.innerHTML = '';
    $('heroPrev').style.display = $('heroNext').style.display = 'none';
    return;
  }
  warn.hidden = true; tools.style.display = '';
  $('heroPrev').style.display = $('heroNext').style.display = state.photos.length > 1 ? '' : 'none';
  const cur = state.photos[state.focus];
  ph.hidden = true; img.hidden = false; img.src = cur;
  label.textContent = `${state.focus + 1} / ${state.photos.length}`;
  toggle.style.display = '';
  const inc = state.picked.has(state.focus);
  toggle.className = 'hero__toggle ' + (inc ? 'inc' : 'exc');
  toggle.innerHTML = `<i class="ti ti-${inc ? 'check' : 'plus'}"></i><span>${inc ? 'In listing' : 'Add'}</span>`;

  $('selCount').textContent = state.picked.size;
  $('selMax').textContent = state.photos.length > MAX_PHOTOS ? ` · ${state.photos.length} available, 20 max` : '';

  grid.innerHTML = state.photos.map((u, j) => {
    const on = state.picked.has(j);
    return `<button class="ptile${on ? ' is-sel' : ' is-off'}${j === state.focus ? ' is-focus' : ''}" data-p="${j}">
      <img loading="lazy" src="${esc(u)}" alt=""><span class="ptile__ck"><i class="ti ti-${on ? 'check' : 'plus'}"></i></span></button>`;
  }).join('');
  grid.querySelectorAll('.ptile').forEach(t => t.onclick = () => {
    const j = +t.getAttribute('data-p'); state.focus = j; togglePhoto(j);
  });
  toggle.onclick = () => togglePhoto(state.focus);
  $('heroPrev').onclick = () => { state.focus = (state.focus - 1 + state.photos.length) % state.photos.length; renderPhotos(); };
  $('heroNext').onclick = () => { state.focus = (state.focus + 1) % state.photos.length; renderPhotos(); };
  $('btnSelAll').onclick = () => {
    state.pickedDirty = true;
    state.picked = new Set(state.photos.map((_, k) => k).slice(0, MAX_PHOTOS));
    if (state.photos.length > MAX_PHOTOS) toast('Facebook allows 20 — selected the first 20', 'warn');
    renderPhotos(); updateDock();
  };
  $('btnSelNone').onclick = () => { state.pickedDirty = true; state.picked = new Set(); renderPhotos(); updateDock(); };
}

function togglePhoto(j) {
  state.pickedDirty = true;
  if (state.picked.has(j)) state.picked.delete(j);
  else {
    if (state.picked.size >= MAX_PHOTOS) { toast('Facebook allows up to 20 photos', 'warn'); renderPhotos(); return; }
    state.picked.add(j);
  }
  renderPhotos(); updateDock();
}

function renderDescription() {
  const wrap = $('descWrap');
  if (state.generated) {
    wrap.hidden = false;
    $('descOutput').textContent = state.desc;
    $('btnGenerate').innerHTML = '<i class="ti ti-sparkles"></i>Regenerate description';
  } else {
    wrap.hidden = true;
    $('btnGenerate').innerHTML = '<i class="ti ti-sparkles"></i>Generate description';
  }
  $('fillPhotoN').textContent = state.picked.size;
  $('btnGenerate').onclick = generateDescription;
  $('btnRegen').onclick = generateDescription;
  $('btnCopy').onclick = async () => { try { await navigator.clipboard.writeText($('descOutput').textContent); toast('Description copied'); } catch (e) { toast('Copy failed', 'err'); } };
}

/* ============================================================
   Description generation (via worker)
   ============================================================ */
async function generateDescription() {
  const v = curVehicle(); if (!v) return;
  const btn = $('btnGenerate');
  btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Generating…';
  const prompt = $('aiPrompt').value.trim();
  const resp = await send('generateDescription', {
    vehicleData: v,
    userPrompt: prompt
  });
  btn.disabled = false;
  if (resp && resp.success && resp.description) {
    state.desc = resp.description; state.generated = true;
    renderDescription(); updateDock(); toast('Description generated');
  } else {
    renderDescription();
    const msg = (resp && resp.error) || 'Generation failed';
    toast(msg, 'err');
  }
}

/* ============================================================
   Dock / navigation
   ============================================================ */
function go(n) { state.step = n; renderStep(); }

function updateDock() {
  const dock = $('dock');
  if (state.step === 1) { dock.hidden = true; return; }
  dock.hidden = false;
  const nb = $('dockNext'), hint = $('dockHint');
  nb.disabled = false; hint.textContent = '';
  if (state.step === 2) {
    const v = curVehicle(); const n = state.picked.size;
    nb.innerHTML = '<span>Continue to description</span><i class="ti ti-arrow-right"></i>';
    if (!v || !state.photos.length || n === 0) {
      nb.disabled = true;
      hint.textContent = (v && !state.photos.length) ? 'This vehicle has no photos' : 'Select at least one photo';
    }
  } else {
    nb.innerHTML = '<i class="ti ti-brand-facebook"></i><span>Fill Marketplace listing</span>';
    if (!state.generated) { nb.disabled = true; hint.textContent = 'Generate a description first'; }
  }
  nb.onclick = () => { if (state.step === 3) fillMarketplace(); else go(state.step + 1); };
  $('dockBack').onclick = () => { if (state.step > 1) go(state.step - 1); };
}

/* ============================================================
   Fill: auto-navigate to FB, inject if needed, fill, verify
   ============================================================ */
function queryTabs(q) { return new Promise(r => chrome.tabs.query(q, r)); }
function createTab(opts) { return new Promise(r => chrome.tabs.create(opts, r)); }
function updateTab(id, opts) { return new Promise(r => chrome.tabs.update(id, opts, r)); }
function sendToTab(id, msg) { return new Promise(r => { try { chrome.tabs.sendMessage(id, msg, resp => { void chrome.runtime.lastError; r(resp); }); } catch (e) { r(null); } }); }
const wait = (ms) => new Promise(r => setTimeout(r, ms));

// Resolve once the tab finishes loading a new page (next 'complete' after we
// start watching), or after a timeout. Used to wait out a renavigation so we
// don't talk to the previous page's content script.
function waitForTabComplete(tabId, timeoutMs = 15000) {
  return new Promise(resolve => {
    let settled = false;
    const done = (val) => {
      if (settled) return;
      settled = true;
      try { chrome.tabs.onUpdated.removeListener(onUpdated); } catch (e) {}
      resolve(val);
    };
    const onUpdated = (id, info) => {
      if (id === tabId && info.status === 'complete') done(true);
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    setTimeout(() => done(false), timeoutMs);
  });
}

async function ensureMarketplaceTab() {
  let tabs = await queryTabs({ url: '*://*.facebook.com/marketplace/create/*' });
  if (tabs && tabs.length) {
    const t = tabs[0];
    // Renavigate to a fresh create form so a re-run starts clean (otherwise the
    // prior run's photos/fields linger and new photos stack on top of them).
    // Attach the load listener BEFORE navigating, then wait for the new page to
    // finish loading — otherwise we'd ping the stale content script from the
    // previous run and fire fillForm into a page that's about to be torn down
    // (which is exactly why a second fill silently did nothing).
    const navDone = waitForTabComplete(t.id);
    await updateTab(t.id, { url: FB_CREATE_URL, active: true });
    try { chrome.windows.update(t.windowId, { focused: true }); } catch (e) {}
    await navDone;
    return t.id;
  }
  const t = await createTab({ url: FB_CREATE_URL, active: true });
  return t ? t.id : null;
}

async function waitForContentScript(tabId) {
  for (let i = 0; i < 30; i++) {            // ~15s
    const resp = await sendToTab(tabId, { action: 'ping' });
    if (resp && resp.success) return true;
    if (i === 6) { // after ~3s try injecting in case auto-inject didn't run
      try { await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] }); } catch (e) {}
    }
    await wait(500);
  }
  return false;
}

async function fillMarketplace() {
  if (state.filling) return;
  const v = curVehicle(); if (!v) return;
  const pickedUrls = [...state.picked].sort((a, b) => a - b).map(j => state.photos[j]);
  if (!pickedUrls.length) { toast('Select at least one photo first', 'warn'); return; }

  state.filling = true;
  const nb = $('dockNext');
  nb.disabled = true; nb.innerHTML = '<span class="spinner"></span><span>Opening Marketplace…</span>';
  const prog = $('fillProgress'); prog.hidden = false; $('fillBar').style.width = '5%';
  $('fillResult').innerHTML = '';

  // Persist what the content script needs
  await sset({
    selectedVehicle: {
      vin: v.vin, year: v.year, make: v.make, model: v.model, trim: v.trim,
      title: v.title, price: v.price, mileage: v.mileage, mileageUnit: v.mileageUnit,
      exterior_color: v.color, body: v.body, condition: v.cond, address: v.address,
      bodyStyle: v.bodyStyle, fuelType: v.fuelType, transmission: v.transmission,
      interiorColor: v.interiorColor
    },
    generatedDescription: state.desc,
    selectedPhotoData: {
      vin: v.vin,
      imageUrl: pickedUrls[0] || '',
      imageUrls: pickedUrls.slice()   // fetched directly from the granted image host (no proxy hop)
    }
  });

  try {
    const tabId = await ensureMarketplaceTab();
    if (!tabId) throw new Error('Could not open the Marketplace tab');
    $('fillBar').style.width = '12%';
    nb.innerHTML = '<span class="spinner"></span><span>Loading page…</span>';
    const ready = await waitForContentScript(tabId);
    if (!ready) throw new Error('Marketplace page did not respond. Make sure you are logged into Facebook.');
    $('fillBar').style.width = '20%';   // the content script reports 25→100 from here
    nb.innerHTML = '<span class="spinner"></span><span>Filling listing…</span>';
    const resp = await sendToTab(tabId, { action: 'fillForm' });
    $('fillBar').style.width = '100%';
    await wait(250);
    finishFill(resp, pickedUrls.length);
  } catch (e) {
    finishFill({ success: false, error: e.message }, pickedUrls.length);
  }
}

// Report a usage event to the proxy for per-rep stats. Fire-and-forget.
function trackEvent(event, vin) {
  try {
    const base = state.settings.proxyUrl.replace(/\/+$/, '');
    fetch(`${base}/track`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Access-Code': state.accessCode || '' },
      body: JSON.stringify({ event, vin: vin || '' })
    }).catch(() => {});
  } catch (e) {}
}

const FIELD_LABELS = {
  year: 'Year', vehicleType: 'Vehicle type', make: 'Make', model: 'Model', mileage: 'Mileage',
  title: 'Title', price: 'Price', description: 'Description', category: 'Category',
  location: 'Location', additionalFields: 'Body style / color'
};

function finishFill(resp, requested) {
  state.filling = false;
  updateDock();
  const r = $('fillResult');
  const attached = resp && typeof resp.photosAttached === 'number' ? resp.photosAttached
    : (resp && resp.success ? requested : 0);
  // The content script verifies each field it filled; surface anything that didn't
  // stick so the rep checks it instead of publishing a listing with a blank price.
  const fields = (resp && resp.fields) || {};
  const missing = Object.keys(fields).filter(k => fields[k] === false && k !== 'photos').map(k => FIELD_LABELS[k] || k);
  const checkNote = missing.length ? ` <b>Check before publishing:</b> ${esc(missing.join(', '))}.` : '';
  if (resp && resp.success && attached > 0 && !missing.length) {
    r.innerHTML = `<div class="result result--ok"><i class="ti ti-circle-check"></i><div><b>Listing filled — ${attached} of ${requested} photos attached.</b> Switch to the Facebook tab to review and publish.</div></div>`;
    toast(`Filled with ${attached} photos`);
  } else if (resp && resp.success && attached > 0) {
    r.innerHTML = `<div class="result result--warn"><i class="ti ti-alert-triangle"></i><div><b>Listing filled — ${attached} of ${requested} photos attached.</b>${checkNote}</div></div>`;
    toast('Filled — check ' + missing.join(', '), 'warn');
  } else if (resp && resp.success) {
    r.innerHTML = `<div class="result result--warn"><i class="ti ti-alert-triangle"></i><div><b>Listing filled, but no photos attached.</b> Do not publish — add photos manually, or try again.${checkNote}</div></div>`;
    toast('No photos attached', 'warn');
  } else {
    const msg = (resp && resp.error) || 'Fill failed — is the Marketplace page open and logged in?';
    r.innerHTML = `<div class="result result--err"><i class="ti ti-circle-x"></i><div><b>Couldn't fill the listing.</b> ${esc(msg)}</div></div>`;
    toast('Fill failed', 'err');
  }

  if (resp && resp.success) {
    trackEvent('fill', (curVehicle() || {}).vin);
    // After a successful fill, the primary action becomes starting a new vehicle.
    const nb = $('dockNext'), hint = $('dockHint');
    nb.disabled = false; if (hint) hint.textContent = '';
    nb.innerHTML = '<i class="ti ti-plus"></i><span>Post Another Vehicle</span>';
    nb.onclick = postAnother;
  }
}

// Reset the flow to step 1 to post another vehicle. The filled Facebook tab stays
// open for the rep to review and publish.
function postAnother() {
  state.sel = null;
  state.photos = [];
  state.picked = new Set();
  state.desc = '';
  state.generated = false;
  state.focus = 0;
  const r = $('fillResult'); if (r) r.innerHTML = '';
  go(1);
}

/* ============================================================
   Settings drawer
   ============================================================ */
function openSettings() {
  const s = state.settings;
  $('setProxyUrl').value = s.proxyUrl;
  $('setRefresh').value = s.refreshMin;
  $('acctName').textContent = state.userName || 'Signed in';
  $('acctStore').textContent = state.storeName || STORE_LABELS[state.store] || state.store || '';
  $('acctAv').textContent = (state.userName || '?').trim().charAt(0).toUpperCase();
  $('settingsDrawer').classList.add('is-open');
  $('settingsBackdrop').classList.add('is-open');
}
function closeSettings() { $('settingsDrawer').classList.remove('is-open'); $('settingsBackdrop').classList.remove('is-open'); }
async function saveSettings() {
  const prevProxy = state.settings.proxyUrl;
  state.settings = {
    proxyUrl: ($('setProxyUrl').value || DEFAULTS.proxyUrl).trim(),
    refreshMin: Math.max(5, Number($('setRefresh').value) || 15)
  };
  await sset({ beckSettings: state.settings });
  closeSettings();
  scheduleRefresh();
  toast('Settings saved');
  if (state.settings.proxyUrl !== prevProxy) { state.sel = null; loadInventory(); }
}

/* ============================================================
   Access-code gate + auth
   ============================================================ */
function showGate(err) {
  $('app').hidden = true;
  $('gate').hidden = false;
  $('gateErr').textContent = err || '';
  const b = $('gateBtn'); if (b) b.disabled = false;
  $('gateBtnLabel').textContent = 'Continue';
  setTimeout(() => { const c = $('gateCode'); if (c) c.focus(); }, 50);
}
function showApp() { $('gate').hidden = true; $('app').hidden = false; }

async function authenticate(code) {
  const base = state.settings.proxyUrl.replace(/\/+$/, '');
  try {
    const res = await fetch(`${base}/auth`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code })
    });
    if (res.status === 401) { showGate("That code isn't valid or has been turned off."); return false; }
    if (res.status === 503) { showGate("Setup isn't finished yet — contact your admin."); return false; }
    if (!res.ok) { showGate('Could not verify your code (server ' + res.status + ').'); return false; }
    const data = await res.json();
    if (!data || !data.success) { showGate((data && data.error) || 'Could not verify your code.'); return false; }
    state.accessCode = code;
    state.store = data.store;
    state.storeName = data.storeName || STORE_LABELS[data.store] || data.store;
    state.userName = data.name || '';
    await sset({ accessCode: code });
    $('storeName').textContent = state.storeName;
    showApp();
    return true;
  } catch (e) {
    showGate("Can't reach the server. Check your connection.");
    return false;
  }
}

async function submitCode() {
  const code = ($('gateCode').value || '').trim().toUpperCase();
  if (!code) { $('gateErr').textContent = 'Enter your access code.'; return; }
  $('gateBtn').disabled = true; $('gateBtnLabel').textContent = 'Checking…';
  const ok = await authenticate(code);
  if (ok) { await loadInventory(); scheduleRefresh(); }
}

async function signOut() {
  state.accessCode = null; state.store = null; state.sel = null; state.vehicles = [];
  if (refreshTimer) clearInterval(refreshTimer);
  await sset({ accessCode: null });
  closeSettings();
  $('gateCode').value = '';
  showGate();
}

/* ============================================================
   Init
   ============================================================ */
let booted = false;
async function init() {
  if (booted) return;   // DOMContentLoaded and the readyState fallback can both fire
  booted = true;
  const saved = await sget(['beckSettings', 'accessCode']);
  state.settings = { ...DEFAULTS, ...(saved.beckSettings || {}) };
  state.accessCode = saved.accessCode || null;

  $('btnSettings').onclick = openSettings;
  $('btnCloseSettings').onclick = closeSettings;
  $('settingsBackdrop').onclick = closeSettings;
  $('btnSaveSettings').onclick = saveSettings;
  $('btnSignOut').onclick = signOut;
  $('gateBtn').onclick = submitCode;
  $('gateCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitCode(); });

  $('invSearch').oninput = (e) => {
    state.search = e.target.value;
    renderInventory();
    const x = $('invSearch'); if (x && document.activeElement !== x) x.focus();
  };

  Array.from($('stepSegs').children).forEach((el, idx) => el.onclick = () => {
    const n = idx + 1;
    if (n < state.step || (state.sel != null && n <= 3)) go(n);
  });

  renderStep();
  if (!state.accessCode) { showGate(); return; }
  const ok = await authenticate(state.accessCode);
  if (!ok) return;
  await loadInventory();
  scheduleRefresh();
}

document.addEventListener('DOMContentLoaded', init);
if (document.readyState !== 'loading') init();
