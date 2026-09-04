/**
 * Background service worker for Beck Auto-Post.
 *
 * Two jobs only:
 *  1. Forward AI description requests to the Beck proxy, which holds the Anthropic
 *     key in its env — the key never ships in (or is stored by) the extension.
 *  2. Fetch vehicle photos for the content script. Extension context isn't bound
 *     by the page's CORS rules, so the granted image hosts can be read directly.
 * Everything else (inventory, gallery, settings) lives in popup.js.
 */

const DEFAULT_PROXY = 'https://beck-sftp-proxy-production.up.railway.app';
const AI_TIMEOUT_MS = 45000;     // the server gives up at ~40s; this bounds a hung socket
const IMAGE_TIMEOUT_MS = 20000;

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  const action = request && request.action;
  if (action === 'generateDescription') { handleGenerateDescription(request.data || {}, sendResponse); return true; }
  if (action === 'fetchImage') { handleFetchImage(request.data || {}, sendResponse); return true; }
  return false;   // progress pings etc. are addressed to the side panel, not us
});

async function proxyBase() {
  const s = await chrome.storage.local.get(['beckSettings']);
  return ((s.beckSettings && s.beckSettings.proxyUrl) || DEFAULT_PROXY).replace(/\/+$/, '');
}

async function handleGenerateDescription(data, sendResponse) {
  try {
    const [base, store] = await Promise.all([proxyBase(), chrome.storage.local.get(['accessCode'])]);
    const response = await fetch(`${base}/generate-description`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Access-Code': store.accessCode || '' },
      body: JSON.stringify({ vehicleData: data.vehicleData, userPrompt: data.userPrompt }),
      signal: AbortSignal.timeout(AI_TIMEOUT_MS)
    });

    if (response.status === 401) {
      sendResponse({ success: false, error: 'Your access code is invalid or was turned off.' });
      return;
    }
    if (!response.ok) {
      let msg = `Server error ${response.status}`;
      try { const e = await response.json(); if (e && e.error) msg = e.error; } catch (_) {}
      sendResponse({ success: false, error: msg });
      return;
    }
    const out = await response.json();
    sendResponse({ success: true, description: (out && out.description) || '' });
  } catch (error) {
    const timedOut = error && (error.name === 'TimeoutError' || error.name === 'AbortError');
    sendResponse({ success: false, error: timedOut ? 'The AI took too long — please try again.' : (error.message || 'Request failed') });
  }
}

// Basic SSRF guard: never fetch loopback / link-local / RFC1918 addresses.
function isPrivateHost(h) {
  return h === 'localhost' || h === '127.0.0.1' || h === '0.0.0.0' || h === '::1' ||
    h.startsWith('192.168.') || h.startsWith('10.') || h.startsWith('169.254.') ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h);
}

async function handleFetchImage(data, sendResponse) {
  try {
    const { imageUrl } = data;
    if (!imageUrl) { sendResponse({ success: false, error: 'No image URL provided' }); return; }
    let u;
    try { u = new URL(imageUrl); } catch (e) { sendResponse({ success: false, error: 'Invalid image URL' }); return; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') { sendResponse({ success: false, error: 'Image URL must be http(s)' }); return; }
    if (isPrivateHost(u.hostname.toLowerCase())) { sendResponse({ success: false, error: 'Cannot fetch from private network addresses' }); return; }

    let response;
    try {
      response = await fetch(imageUrl, { method: 'GET', mode: 'cors', cache: 'no-cache', signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) });
    } catch (fetchError) {
      // A host we lack permission for: no-cors yields an opaque body that may still be usable
      response = await fetch(imageUrl, { mode: 'no-cors', signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) });
    }
    if (!response || (!response.ok && response.type !== 'opaque')) {
      throw new Error(`Failed to fetch image: ${response ? response.status : 'no response'}`);
    }
    const blob = await response.blob();
    if (!blob || blob.size === 0) throw new Error('Received empty image');
    await sendBlobAsDataUrl(blob, sendResponse);
  } catch (error) {
    console.error('Background: image fetch failed:', error && error.message);
    sendResponse({ success: false, error: (error && error.message) || 'Unknown error fetching image' });
  }
}

function sendBlobAsDataUrl(blob, sendResponse) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      sendResponse({ success: true, dataUrl: reader.result, mimeType: blob.type || 'image/jpeg', size: blob.size });
      resolve();
    };
    reader.onerror = () => { sendResponse({ success: false, error: 'Failed to convert image' }); resolve(); };
    reader.readAsDataURL(blob);
  });
}

chrome.runtime.onInstalled.addListener(() => { console.log('Beck Auto-Post installed'); });

// Open the side panel when the toolbar icon is clicked
chrome.action.onClicked.addListener((tab) => { chrome.sidePanel.open({ tabId: tab.id }); });
