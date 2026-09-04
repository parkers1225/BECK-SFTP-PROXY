/**
 * Content Script for Facebook Marketplace
 * Auto-fills the Marketplace listing form
 */

// Wrap in IIFE to prevent redeclaration errors on SPA navigation
(function() {
  'use strict';
  
  // Check if already injected
  if (window.fbMarketplaceAutoPosterLoaded) {
    return;
  }
  window.fbMarketplaceAutoPosterLoaded = true;

let vehicleData = null;
let generatedDescription = null;

/**
 * Send progress update to popup
 * @param {number} progress - Progress percentage (0-100)
 * @param {string} stage - Current stage description
 */
function sendProgressUpdate(progress, stage) {
  try {
    chrome.runtime.sendMessage({
      action: 'formFillProgress',
      progress: progress,
      stage: stage
    }).catch(() => {
      // Ignore errors if popup is closed
    });
  } catch (error) {
    // Ignore errors
  }
}

// Listen for messages from popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'ping') {
    sendResponse({ success: true, message: 'Content script is ready' });
    return false;
  }
  
  if (request.action === 'fillForm') {
    // Wrap in try-catch to handle any unexpected errors
    (async () => {
      try {
        const fillResult = await fillMarketplaceForm();
        sendResponse({
          success: true,
          photosAttached: (fillResult && fillResult.photosAttached) || 0,
          fields: (fillResult && fillResult.fields) || null
        });
      } catch (error) {
        console.error('Error in fillMarketplaceForm:', error);
        sendResponse({ 
          success: false, 
          error: error.message || 'Unknown error occurred',
          stack: error.stack
        });
      }
    })();
    return true; // Keep channel open for async response
  }
  
  return false;
});

// Load saved vehicle data
async function loadVehicleData() {
  try {
    const result = await chrome.storage.local.get(['selectedVehicle', 'generatedDescription']);
    if (result.selectedVehicle) {
      vehicleData = result.selectedVehicle;
      generatedDescription = result.generatedDescription;
      
      // Keep the page console free of full vehicle records (address etc.); log only what
      // matters for diagnosing a missed fill.
      console.log('Loaded vehicle data:', { vin: vehicleData.vin, mileage: vehicleData.mileage, keys: Object.keys(vehicleData).length });
      if (!vehicleData.mileage) console.warn('⚠️ Mileage is missing from vehicle data');
      
      return true;
    }
  } catch (error) {
    console.error('Failed to load vehicle data:', error);
  }
  return false;
}

/**
 * Set an <input>/<textarea> value the React way, using the prototype's native
 * value setter so the framework's value tracker registers the change instead of
 * silently reverting a plain `.value =` assignment.
 */
function setNativeValue(el, value) {
  try {
    const proto = (el.tagName === 'TEXTAREA') ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) { desc.set.call(el, value); return true; }
  } catch (e) { /* fall through to plain assignment */ }
  try { el.value = value; return true; } catch (e) { return false; }
}

// Compare numeric field values (mileage, price) ignoring commas / $ / spaces.
function normalizeDigits(v) { return String(v == null ? '' : v).replace(/[^0-9]/g, ''); }

// Single source of truth for the mileage value we WRITE and VERIFY against.
function getMileageTarget() {
  // Honor the exact mileage we were given — new units are already set to 30 by
  // the dealership rule in popup mapVehicle. No artificial Facebook minimum.
  return String(parseInt(vehicleData && vehicleData.mileage, 10) || 0);
}

// Cheap, universal current-value reader for any found field. INPUT/TEXTAREA read
// .value; everything else (combobox/contenteditable) reads textContent.
function readFieldText(el) {
  if (!el) return '';
  if (typeof el.then === 'function') { console.error('readFieldText got a Promise — missing await'); return ''; }
  if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return (el.value || '').trim();
  return (el.textContent || el.innerText || '').trim();
}

// Verify-and-repair pass. Runs AFTER the fast linear first pass: reads each field's
// real DOM value, sets results.X honestly from that read, and re-fills ONLY the
// fields that are empty/wrong. This is the safety net that catches mileage (or
// anything) cleared by a late React re-render from the dropdown cascade. It reuses
// the existing fillers, never touches photos, and is bounded so it always converges.
async function verifyAndRepairForm(results, maxRounds = 2) {
  const checks = [
    { name: 'title', read: async () => readFieldText(findTitleInput()), ok: (v) => v.length > 0, refill: () => fillTitle() },
    { name: 'price', read: async () => normalizeDigits(readFieldText(findPriceInput())), ok: (v) => v.length > 0, refill: () => fillPrice() },
  ];
  // Mileage is checked LAST and only when we have a value — it's the field most
  // prone to being cleared, so we verify it after every other repair has settled.
  if (vehicleData && vehicleData.mileage) {
    checks.push({
      name: 'mileage',
      // Branch on element type: findMileageField can return a combobox/label whose
      // textContent is the whole label container ("Mileage…"), which would never
      // match and would loop. Only verify a real INPUT; treat a non-input mileage
      // as already-handled by its own click-to-select path.
      read: async () => {
        const el = await findMileageField();
        if (!el) return '';
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return normalizeDigits(el.value);
        return getMileageTarget();
      },
      ok: (v) => v === getMileageTarget(),
      refill: () => fillMileageField(),
    });
  }

  for (let round = 0; round < maxRounds; round++) {
    let allGood = true;
    for (const c of checks) {
      let cur = await c.read();
      if (!c.ok(cur)) cur = await c.read();            // re-read once: dodge a transient null mid-render
      if (c.ok(cur)) { results[c.name] = true; continue; }
      allGood = false;
      console.warn(`Repair: ${c.name} empty/wrong ("${cur}") — re-filling...`);
      try { await c.refill(); } catch (e) { console.warn(`Repair of ${c.name} failed:`, e); }
      results[c.name] = c.ok(await c.read());          // honest flag even on the final round
    }
    if (allGood) break;
  }
}

/**
 * Honest photo counter: counts the actual uploaded vehicle photo previews in the
 * listing form. Facebook renders uploaded photos as sizeable blob: <img> previews,
 * so we count those (ignoring tiny UI blobs and Facebook's own scontent CDN chrome).
 */
function countVehiclePhotos() {
  try {
    const scope = document.querySelector('[role="main"]') || document.body;
    // Best signal: Facebook's own "Photos · N / 20" counter in the listing form.
    const text = scope.innerText || '';
    const m = text.match(/Photos\s*[·•∙]?\s*(\d{1,2})\s*\/\s*20/i);
    if (m) return parseInt(m[1], 10) || 0;
    // Fallback: count sizeable uploaded-photo thumbnails (blob: or scontent CDN).
    let count = 0;
    scope.querySelectorAll('img[src^="blob:"], img[src*="scontent"]').forEach((img) => {
      const w = img.naturalWidth || img.clientWidth || 0;
      const h = img.naturalHeight || img.clientHeight || 0;
      if (w >= 80 && h >= 80) count++;
    });
    return count;
  } catch (e) {
    return 0;
  }
}

/**
 * Main function to fill Facebook Marketplace form
 */
async function fillMarketplaceForm() {
  try {
    // Check if we're on the right page
    const currentUrl = window.location.href;
    if (!currentUrl.includes('/marketplace/create') && !currentUrl.includes('/marketplace/sell')) {
      throw new Error('Please navigate to Facebook Marketplace Create Listing page first. Go to: facebook.com/marketplace/create/vehicle');
    }

    // Load vehicle data
    const hasData = await loadVehicleData();
    if (!hasData || !vehicleData) {
      throw new Error('No vehicle data found. Please select a vehicle and generate a description first.');
    }
  } catch (error) {
    console.error('Error in fillMarketplaceForm setup:', error);
    throw error;
  }

  // Wait for page to be ready
  sendProgressUpdate(25, 'Waiting for form...');
  await waitForPageReady();
  sendProgressUpdate(30, 'Form ready!');
  
  // Debug: Log all form elements (only once)
  if (!window.fbMarketplaceDebugged) {
    // Use a distinctive console style to make our logs stand out
    console.log(
      '%c=== Facebook Marketplace Auto-Poster ===',
      'background: #1877f2; color: white; padding: 4px 8px; border-radius: 3px; font-weight: bold;'
    );
    console.log('Note: Facebook\'s form fields often lack id/name attributes.');
    console.log('Our extension uses multiple detection strategies to work around this.');
    console.log('');
    console.log(
      '%c⚠️ IMPORTANT: Errors like "getByTag", CSP violations, and service worker errors are from Facebook\'s own code, NOT our extension. These are normal and don\'t affect form filling.',
      'color: #f39c12; font-weight: bold;'
    );
    console.log(
      '%c==========================================',
      'background: #1877f2; color: white; padding: 4px 8px; border-radius: 3px;'
    );
    debugFormElements();
    debugYearMakeModelFields(); // Also debug Year/Make/Model specifically
    window.fbMarketplaceDebugged = true;
  }
  
  // Also log vehicle data being used
  console.log('Vehicle data being used:', {
    year: vehicleData.year,
    make: vehicleData.make,
    model: vehicleData.model,
    price: vehicleData.price,
    bodyStyle: vehicleData.bodyStyle
  });

  // Fill form fields with error handling - fill in order
  const results = {
    title: false,
    price: false,
    description: false,
    category: false,
    location: false,
    year: false,
    make: false,
    model: false,
    vehicleType: false,
    mileage: false,
    photos: false
  };

  // Fill Year field first (this doesn't get cleared by Vehicle Type)
  sendProgressUpdate(32, 'Filling Year...');
  try {
    await fillYearFieldOnly();
    console.log('%c✓ Year field handled', 'color: #27ae60; font-weight: bold;');
    results.year = true;
    sendProgressUpdate(35, 'Year filled ✓');
  } catch (error) {
    console.warn('%c⚠ Year field not found or failed:', 'color: #e74c3c; font-weight: bold;', error.message || error);
  }
  
  // Smart wait - only wait if needed
  await smartSleep(100, () => {
    // Check if we can proceed immediately
    const yearField = document.querySelector('input[placeholder*="Year" i], input[aria-label*="Year" i]');
    return yearField && yearField.value;
  });

  // Fill Vehicle Type field
  sendProgressUpdate(37, 'Filling Vehicle Type...');
  try {
    await fillVehicleType();
    console.log('%c✓ Vehicle Type field handled', 'color: #27ae60; font-weight: bold;');
    results.vehicleType = true;
    sendProgressUpdate(40, 'Vehicle Type filled ✓');
  } catch (error) {
    console.warn('%c⚠ Vehicle Type field not found or failed:', 'color: #e74c3c; font-weight: bold;', error.message || error);
  }
  
  // Smart wait for form to update after Vehicle Type selection (new fields appear)
  // Wait for Make/Model fields to appear instead of fixed delay
  const makeModelReady = await waitForCondition(() => {
    // Check if Make or Model fields have appeared
    const makeField = document.querySelector('input[placeholder*="Make" i], input[aria-label*="Make" i], button[aria-label*="Make" i]');
    const modelField = document.querySelector('input[placeholder*="Model" i], input[aria-label*="Model" i], button[aria-label*="Model" i]');
    return !!(makeField || modelField);
  }, { timeout: 5000, interval: 100 }); // Max 5s wait, check every 100ms
  
  if (!makeModelReady) {
    // Fallback: wait a bit more if fields didn't appear
    await smartSleep(500);
  }
  
  // NOW fill Make, Model, and Mileage for the first time (after Vehicle Type)
  sendProgressUpdate(42, 'Filling Make/Model...');
  try {
    // Fill Make
    if (vehicleData.make) {
      await fillMakeFieldAfterVehicleType();
      results.make = true;
      sendProgressUpdate(45, 'Make filled ✓');
    }
    
    // Fill Model
    if (vehicleData.model) {
      await fillModelFieldAfterVehicleType();
      results.model = true;
      sendProgressUpdate(47, 'Model filled ✓');
    }
    
    // Fill Mileage (first pass; verifyAndRepairForm re-checks it at the end)
    if (vehicleData.mileage) {
      results.mileage = await fillMileageFieldAfterVehicleType();
      sendProgressUpdate(48, 'Mileage filled ✓');
    }
  } catch (error) {
    console.warn('Failed to fill Make/Model/Mileage after Vehicle Type:', error);
  }
  
  // Fill additional vehicle fields that appear after Vehicle Type selection
  sendProgressUpdate(50, 'Filling additional fields...');
  await smartSleep(200);
  try {
    await fillAdditionalVehicleFields();
    console.log('%c✓ Additional vehicle fields handled', 'color: #27ae60; font-weight: bold;');
    sendProgressUpdate(52, 'Additional fields filled ✓');
  } catch (error) {
    console.warn('Failed to fill additional vehicle fields:', error);
  }


  // Fill title
  sendProgressUpdate(55, 'Filling Title...');
  try {
    const titleFilled = await fillTitle();
    if (titleFilled) {
      results.title = true;
      console.log('%c✓ Title filled', 'color: #27ae60; font-weight: bold;');
      sendProgressUpdate(58, 'Title filled ✓');
    } else {
      console.warn('%c⚠ Title field not found', 'color: #e74c3c; font-weight: bold;');
    }
  } catch (error) {
    console.warn('%c⚠ Failed to fill title:', 'color: #e74c3c; font-weight: bold;', error.message || error);
  }
  
  // Smart wait between fields - only wait if previous field isn't ready
  await smartSleep(100, () => {
    const titleInput = findTitleInput();
    return titleInput && titleInput.value && titleInput.value.length > 0;
  });

  // Fill price
  sendProgressUpdate(60, 'Filling Price...');
  try {
    const priceFilled = await fillPrice();
    if (priceFilled) {
      results.price = true;
      console.log('%c✓ Price filled', 'color: #27ae60; font-weight: bold;');
      sendProgressUpdate(63, 'Price filled ✓');
    } else {
      console.warn('%c⚠ Price field not found', 'color: #e74c3c; font-weight: bold;');
    }
  } catch (error) {
    console.warn('%c⚠ Failed to fill price:', 'color: #e74c3c; font-weight: bold;', error.message || error);
  }
  
  // Smart wait between fields
  await smartSleep(100, () => {
    const priceInput = findPriceInput();
    return priceInput && priceInput.value && priceInput.value.length > 0;
  });

  // Fill description
  sendProgressUpdate(65, 'Filling Description...');
  try {
    const descFilled = await fillDescription();
    if (descFilled) {
      results.description = true;
      console.log('%c✓ Description filled', 'color: #27ae60; font-weight: bold;');
      sendProgressUpdate(70, 'Description filled ✓');
    } else {
      console.warn('%c⚠ Description field not found', 'color: #e74c3c; font-weight: bold;');
    }
  } catch (error) {
    console.warn('%c⚠ Failed to fill description:', 'color: #e74c3c; font-weight: bold;', error.message || error);
  }

  sendProgressUpdate(72, 'Filling Category/Location...');
  try {
    await fillCategory();
    results.category = true;
    sendProgressUpdate(75, 'Category filled ✓');
  } catch (error) {
    console.warn('Failed to fill category:', error);
  }

  try {
    await fillLocation();
    results.location = true;
    sendProgressUpdate(78, 'Location filled ✓');
  } catch (error) {
    console.warn('Failed to fill location:', error);
  }

  // Upload photo if available
  sendProgressUpdate(80, 'Uploading Photos...');
  try {
    const photoUploaded = await fillPhotos();
    if (photoUploaded) {
      results.photos = true;
      console.log('%c✓ Photo uploaded', 'color: #27ae60; font-weight: bold;');
      sendProgressUpdate(90, 'Photos uploaded ✓');
    } else {
      console.warn('%c⚠ Photo upload attempted but may require manual upload', 'color: #f39c12; font-weight: bold;');
      sendProgressUpdate(85, 'Photo upload attempted');
    }
  } catch (error) {
    console.warn('%c⚠ Photo upload error:', 'color: #e74c3c; font-weight: bold;', error.message || error);
  }

  // Honest photo verification: Facebook adds the uploaded photos to its "N / 20"
  // counter over a few seconds. Poll, but exit the instant we reach the requested
  // count or the count plateaus — don't always burn the full loop.
  let photosAttached = 0;
  try {
    let target = 0;
    try {
      const pd = await chrome.storage.local.get(['selectedPhotoData']);
      const u = pd.selectedPhotoData && pd.selectedPhotoData.imageUrls;
      target = Math.min(20, (u && u.length) ? u.length : (pd.selectedPhotoData && pd.selectedPhotoData.imageUrl ? 1 : 0));
    } catch (e) {}
    let stable = 0;
    for (let t = 0; t < 9; t++) {
      await new Promise(r => setTimeout(r, 350));
      const n = countVehiclePhotos();
      if (n > photosAttached) { photosAttached = n; stable = 0; }
      else { stable++; }
      if (target && photosAttached >= target) break;  // all photos in → stop
      if (stable >= 2) break;                          // count plateaued → stop
    }
  } catch (e) {}
  results.photos = photosAttached > 0;

  // Verify-and-repair pass — LOAD-BEARING ORDER: this must run AFTER photos are
  // attached and after every dropdown-driven re-render has settled, so it can
  // re-fill mileage (or anything) that a late re-render cleared, without ever
  // competing with photo upload for focus. Do not move it earlier.
  sendProgressUpdate(92, 'Verifying fields...');
  try { await verifyAndRepairForm(results, 2); } catch (e) { console.warn('verify-and-repair failed:', e); }

  const successCount = Object.values(results).filter(Boolean).length;
  const totalFields = Object.keys(results).length;
  
  // Final summary with styled output
  console.log(
    `%cMarketplace form filled: ${successCount}/${totalFields} fields filled successfully`,
    successCount === totalFields 
      ? 'background: #27ae60; color: white; padding: 4px 8px; border-radius: 3px; font-weight: bold;'
      : 'background: #f39c12; color: white; padding: 4px 8px; border-radius: 3px; font-weight: bold;',
    results
  );
  
  // Send final progress update
  if (successCount === totalFields) {
    sendProgressUpdate(100, 'Complete! All fields filled ✓');
  } else {
    sendProgressUpdate(95, `Complete! ${successCount}/${totalFields} fields filled`);
  }
  
  // Show notification if some fields failed
  if (successCount < totalFields) {
    const failedFields = Object.entries(results)
      .filter(([_, success]) => !success)
      .map(([field]) => field);
    console.warn(
      `%c⚠ Some fields may need manual filling: ${failedFields.join(', ')}`,
      'color: #e74c3c; font-weight: bold;'
    );
    console.log(
      '%cℹ Note: Facebook\'s console errors (getByTag, CSP violations, etc.) are normal and don\'t affect form filling.',
      'color: #3498db; font-style: italic;'
    );
  } else {
    console.log(
      '%c✓ All fields filled successfully!',
      'background: #27ae60; color: white; padding: 4px 8px; border-radius: 3px; font-weight: bold;'
    );
  }

  return { fields: results, photosAttached };
}

/**
 * Wait for Marketplace form to be ready - Optimized with smart waiting
 */
async function waitForPageReady() {
  // Check if we're on the create listing page
  const currentUrl = window.location.href;
  if (!currentUrl.includes('/marketplace/create') && 
      !currentUrl.includes('/marketplace/sell') &&
      !currentUrl.includes('/marketplace/create/vehicle')) {
    console.error('Not on Marketplace create page. Current URL:', currentUrl);
    return;
  }
  
  // Use smart waiting with DOM change detection
  const isFormReady = () => {
    // Strategy 1: Check for specific form fields
    const titleInput = findTitleInput();
    const priceInput = findPriceInput();
    const descField = findDescriptionTextarea();
    
    // Strategy 2: Check for Marketplace-specific UI indicators
    const pageText = document.body.textContent || document.body.innerText || '';
    const hasMarketplaceIndicators = 
      pageText.includes('Vehicle for sale') ||
      pageText.includes('Listing to Marketplace') ||
      pageText.includes('About this vehicle') ||
      pageText.includes('Enter your price') ||
      pageText.includes('Tell buyers') ||
      pageText.includes('Year') ||
      pageText.includes('Make') ||
      pageText.includes('Model');
    
    // Strategy 3: Check for any interactive form elements
    const anyInputs = document.querySelectorAll('input, textarea, [contenteditable="true"], select, button[role="combobox"]');
    const visibleInputs = Array.from(anyInputs).filter(el => el.offsetParent !== null && !el.disabled);
    
    return !!(titleInput || priceInput || descField || (hasMarketplaceIndicators && visibleInputs.length > 0));
  };
  
  // Try immediate check first
  if (isFormReady()) {
    console.log('Form detected immediately!');
    // Small delay to ensure form is fully interactive (reduced from 2000ms)
    await smartSleep(300, () => {
      // Early exit if we can interact with fields
      const titleInput = findTitleInput();
      return titleInput && !titleInput.disabled;
    });
    console.log('Form ready, proceeding...');
    return;
  }
  
  // Use DOM change observer for faster detection
  console.log('Waiting for form to appear...');
  const found = await waitForDOMChange(isFormReady, {
    timeout: 30000, // Reduced from 60s to 30s
    subtree: true,
    childList: true
  });
  
  if (found) {
    const titleInput = findTitleInput();
    const priceInput = findPriceInput();
    const descField = findDescriptionTextarea();
    const pageText = document.body.textContent || document.body.innerText || '';
    const hasMarketplaceIndicators = pageText.includes('Vehicle for sale') || pageText.includes('Year');
    const anyInputs = document.querySelectorAll('input, textarea, [contenteditable="true"], select, button[role="combobox"]');
    const visibleInputs = Array.from(anyInputs).filter(el => el.offsetParent !== null && !el.disabled);
    
    console.log('Form detected! Found:', {
      title: !!titleInput,
      price: !!priceInput,
      description: !!descField,
      marketplaceIndicators: hasMarketplaceIndicators,
      visibleInputs: visibleInputs.length
    });
    
    // Smart wait for interactivity (reduced from 2000ms)
    await smartSleep(300, () => {
      const titleInput = findTitleInput();
      return titleInput && !titleInput.disabled && titleInput.offsetParent !== null;
    });
    console.log('Form ready, proceeding...');
  } else {
    // Fallback: try to find any form elements
    console.warn('Form ready timeout - proceeding anyway. Form may not be fully loaded.');
    const allInputs = document.querySelectorAll('input, textarea, [contenteditable="true"], select, button');
    const visibleInputs = Array.from(allInputs).filter(el => el.offsetParent !== null && !el.disabled);
    console.log(`Found ${visibleInputs.length} visible interactive elements on page`);
    
    if (visibleInputs.length > 0) {
      console.log('Proceeding with available elements...');
      await smartSleep(200);
    }
  }
}

/**
 * Debug: Specifically look for Year/Make/Model fields
 */
function debugYearMakeModelFields() {
  console.log('=== DEBUGGING YEAR/MAKE/MODEL FIELDS ===');
  
  // Find all text containing "Year", "Make", "Model"
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    null
  );
  
  const fieldLabels = { year: [], make: [], model: [] };
  let node;
  while (node = walker.nextNode()) {
    const text = node.textContent.trim().toLowerCase();
    if (text === 'year' || text === 'year:') {
      fieldLabels.year.push(node);
    } else if (text === 'make' || text === 'make:') {
      fieldLabels.make.push(node);
    } else if (text === 'model' || text === 'model:') {
      fieldLabels.model.push(node);
    }
  }
  
  console.log(`Found labels: Year=${fieldLabels.year.length}, Make=${fieldLabels.make.length}, Model=${fieldLabels.model.length}`);
  
  // For each Year label, try to find nearby interactive elements
  for (let i = 0; i < fieldLabels.year.length; i++) {
    const yearNode = fieldLabels.year[i];
    let parent = yearNode.parentElement;
    let depth = 0;
    
    console.log(`Year label ${i + 1}:`, {
      text: yearNode.textContent,
      parentTag: parent?.tagName,
      parentClass: parent?.className
    });
    
    while (parent && depth < 5) {
      const interactive = parent.querySelector('input, select, button, [contenteditable="true"], [role="button"], [role="combobox"]');
      if (interactive && interactive.offsetParent !== null) {
        console.log(`  Found interactive element at depth ${depth}:`, {
          tag: interactive.tagName,
          role: interactive.getAttribute('role'),
          type: interactive.type,
          className: interactive.className.substring(0, 50),
          ariaLabel: interactive.getAttribute('aria-label')
        });
      }
      parent = parent.parentElement;
      depth++;
    }
  }
  
  console.log('=== END YEAR/MAKE/MODEL DEBUG ===');
}

/**
 * Debug: Log all form elements found on page
 */
function debugFormElements() {
  console.log('=== DEBUGGING FORM ELEMENTS ===');
  
  const allInputs = document.querySelectorAll('input');
  console.log(`Total inputs found: ${allInputs.length}`);
  const visibleInputs = Array.from(allInputs).filter(input => input.offsetParent !== null);
  console.log(`Visible inputs: ${visibleInputs.length}`);
  
  visibleInputs.forEach((input, idx) => {
    const hasId = !!input.id;
    const hasName = !!input.name;
    const hasPlaceholder = !!input.placeholder;
    const hasAriaLabel = !!input.getAttribute('aria-label');
    
    console.log(`Input ${idx}:`, {
      type: input.type,
      placeholder: input.placeholder || '(none)',
      ariaLabel: input.getAttribute('aria-label') || '(none)',
      value: input.value || '(empty)',
      id: input.id || '(no id)',
      name: input.name || '(no name)',
      hasStandardAttrs: hasId || hasName,
      className: input.className.substring(0, 50)
    });
    
    // Warn if input lacks standard attributes (common on Facebook)
    if (!hasId && !hasName && !hasPlaceholder && !hasAriaLabel) {
      console.warn(`  ⚠️ Input ${idx} has no id, name, placeholder, or aria-label - using context-based detection`);
    }
  });
  
  const allTextareas = document.querySelectorAll('textarea');
  console.log(`Total textareas found: ${allTextareas.length}`);
  allTextareas.forEach((textarea, idx) => {
    if (textarea.offsetParent !== null) {
      console.log(`Textarea ${idx}:`, {
        placeholder: textarea.placeholder,
        ariaLabel: textarea.getAttribute('aria-label'),
        id: textarea.id,
        className: textarea.className
      });
    }
  });
  
  const allContentEditable = document.querySelectorAll('[contenteditable="true"]');
  console.log(`Total contenteditable found: ${allContentEditable.length}`);
  allContentEditable.forEach((elem, idx) => {
    if (elem.offsetParent !== null) {
      console.log(`ContentEditable ${idx}:`, {
        role: elem.getAttribute('role'),
        placeholder: elem.getAttribute('placeholder'),
        ariaLabel: elem.getAttribute('aria-label'),
        className: elem.className,
        textContent: elem.textContent.substring(0, 50)
      });
    }
  });
  
  console.log('=== END DEBUG ===');
}

/**
 * Find title input field - Facebook uses React components
 * IMPORTANT: Must NOT be Year, Make, or Model field
 */
function findTitleInput() {
  // First try standard input selectors
  const standardSelectors = [
    'input[placeholder*="What are you selling" i]',
    'input[aria-label*="What are you selling" i]',
    'input[placeholder*="Title" i]',
    'input[aria-label*="Title" i]',
    'input[placeholder*="Item name" i]',
    'input[aria-label*="Item name" i]',
    'input[data-testid*="title" i]',
    'input[aria-label*="Listing title" i]',
    'div[contenteditable="true"][placeholder*="Title" i]',
    'div[contenteditable="true"][aria-label*="Title" i]'
  ];

  for (const selector of standardSelectors) {
    try {
      const inputs = document.querySelectorAll(selector);
      for (const input of inputs) {
        if (input && input.offsetParent !== null && !input.disabled) {
          // Verify it's not Year/Make/Model
          const parentText = (input.closest('div')?.textContent || '').toLowerCase();
          if (!parentText.includes('year') && !parentText.includes('make') && !parentText.includes('model')) {
            return input;
          }
        }
      }
    } catch (e) {
      continue;
    }
  }

  // Facebook React pattern: Look for elements with "Title" label nearby
  // BUT exclude Year/Make/Model fields
  const allPossibleInputs = document.querySelectorAll('input, [contenteditable="true"], textarea, div[role="textbox"]');
  
  for (const elem of allPossibleInputs) {
    if (elem.offsetParent === null || elem.disabled) continue;
    
    // Look for "Title" text in nearby elements
    let current = elem;
    for (let i = 0; i < 8; i++) { // Increased depth
      if (!current) break;
      const parentText = (current.textContent || '').toLowerCase();
      
      // Must have "Title" but NOT Year/Make/Model
      if (parentText.includes('title') && 
          !parentText.includes('year') && 
          !parentText.includes('make') && 
          !parentText.includes('model') &&
          !parentText.includes('price') && 
          !parentText.includes('description') && 
          !parentText.includes('location')) {
        return elem;
      }
      current = current.parentElement;
    }
  }
  
  // Fallback: Find first large input/textarea that's not Year/Make/Model/Price/Description
  const allInputs = document.querySelectorAll('input[type="text"], textarea, [contenteditable="true"]');
  for (const input of allInputs) {
    if (input.offsetParent === null || input.disabled) continue;
    const rect = input.getBoundingClientRect();
    if (rect.width > 200 && rect.height > 20) { // Large enough to be a title field
      const context = (input.closest('div')?.textContent || '').toLowerCase();
      if (!context.includes('year') && !context.includes('make') && !context.includes('model') &&
          !context.includes('price') && !context.includes('description') && !context.includes('location')) {
        return input;
      }
    }
  }

  return null;
}

/**
 * Find and fill Year field - Enhanced detection
 */
function findYearField() {
  console.log('=== Searching for Year field ===');
  
  // Try specific selectors first
  const specificSelectors = [
    'input[aria-label*="Year" i]',
    'select[aria-label*="Year" i]',
    'input[placeholder*="Year" i]',
    'select[placeholder*="Year" i]',
    'button[aria-label*="Year" i]',
    'div[role="button"][aria-label*="Year" i]',
    'div[role="combobox"][aria-label*="Year" i]'
  ];
  
  for (const selector of specificSelectors) {
    try {
      const elem = document.querySelector(selector);
      if (elem && elem.offsetParent !== null && !elem.disabled) {
        console.log('Found Year field via selector:', selector);
        return elem;
      }
    } catch (e) {
      continue;
    }
  }
  
  // Method: Find all text nodes containing "Year" and locate nearby inputs
  const walker = document.createTreeWalker(
    document.body,
    NodeFilter.SHOW_TEXT,
    null
  );
  
  const yearTextNodes = [];
  let node;
  while (node = walker.nextNode()) {
    const text = node.textContent.trim().toLowerCase();
    if (text === 'year' || text === 'year:') {
      yearTextNodes.push(node);
    }
  }
  
  console.log(`Found ${yearTextNodes.length} "Year" text nodes`);
  
  for (const textNode of yearTextNodes) {
    // Find the parent element that likely contains the label
    let labelElement = textNode.parentElement;
    while (labelElement && labelElement !== document.body) {
      // Look for interactive elements in the same container or next sibling
      const container = labelElement.parentElement;
      if (container) {
        // Check siblings
        let sibling = container.firstElementChild;
        while (sibling) {
          if (sibling !== labelElement) {
            const interactive = sibling.querySelector('input, select, button, [contenteditable="true"], [role="button"], [role="combobox"]');
            if (interactive && interactive.offsetParent !== null && !interactive.disabled) {
              // Verify it's not Make or Model
              const siblingText = (sibling.textContent || '').toLowerCase();
              if (!siblingText.includes('make') && !siblingText.includes('model')) {
                console.log('Found Year field via text node traversal');
                return interactive;
              }
            }
          }
          sibling = sibling.nextElementSibling;
        }
        
        // Check children of container for interactive elements
        const allInteractive = container.querySelectorAll('input, select, button, [contenteditable="true"], [role="button"], [role="combobox"]');
        for (const elem of allInteractive) {
          if (elem.offsetParent !== null && !elem.disabled) {
            // Check if this element is after the Year label in DOM order
            const elemText = (elem.closest('div')?.textContent || '').toLowerCase();
            if (elemText.includes('year') && !elemText.includes('make') && !elemText.includes('model')) {
              console.log('Found Year field in container with Year label');
              return elem;
            }
          }
        }
      }
      labelElement = labelElement.parentElement;
    }
  }
  
  // Method: Look through all inputs and check their position relative to "Year" text
  const allInputs = document.querySelectorAll('input, select, [contenteditable="true"], button[role="combobox"], div[role="button"], div[role="combobox"]');
  
  for (const elem of allInputs) {
    if (elem.offsetParent === null || elem.disabled) continue;
    
    // Look for "Year" text nearby - check more levels
    let current = elem;
    for (let i = 0; i < 10; i++) { // Increased depth
      if (!current) break;
      const text = (current.textContent || '').toLowerCase();
      const ariaLabel = (current.getAttribute('aria-label') || '').toLowerCase();
      const placeholder = (current.getAttribute('placeholder') || '').toLowerCase();
      
      // Must have "year" and NOT have "make" or "model" in same context
      if ((text.includes('year') || ariaLabel.includes('year') || placeholder.includes('year')) && 
          !text.includes('make') && !text.includes('model') && !text.includes('price')) {
        // Double check - make sure it's actually the year field
        const parentText = (current.parentElement?.textContent || '').toLowerCase();
        if (parentText.includes('year') && !parentText.includes('make') && !parentText.includes('model')) {
          console.log('Found Year field via parent text search');
          return elem;
        }
      }
      current = current.parentElement;
    }
  }
  
  // Method: Find form fields by order (Year is typically first)
  // Look for a container that has Year, Make, Model labels
  const formContainers = document.querySelectorAll('div[role="group"], form, fieldset, div[class*="form"], div[class*="field"]');
  for (const container of formContainers) {
    const containerText = (container.textContent || '').toLowerCase();
    if (containerText.includes('year') && containerText.includes('make') && containerText.includes('model')) {
      // Find the first interactive element (likely Year)
      const firstInteractive = container.querySelector('input, select, button, [contenteditable="true"], [role="button"], [role="combobox"]');
      if (firstInteractive && firstInteractive.offsetParent !== null && !firstInteractive.disabled) {
        // Verify it's near "Year" text
        const nearbyText = (firstInteractive.closest('div')?.textContent || '').toLowerCase();
        if (nearbyText.includes('year') && !nearbyText.includes('make') && !nearbyText.includes('model')) {
          console.log('Found Year field as first field in form container');
          return firstInteractive;
        }
      }
    }
  }
  
  console.warn('Year field not found with any method');
  return null;
}

/**
 * Find and fill Make field
 */
function findMakeField() {
  // Search for all interactive elements, not just inputs
  const allInputs = document.querySelectorAll('input, select, [contenteditable="true"], button, [role="combobox"], label[role="combobox"], [role="button"]');
  
  console.log(`Searching for Make field among ${allInputs.length} interactive elements`);
  
  for (const elem of allInputs) {
    if (elem.offsetParent === null || elem.disabled) continue;
    
    // Look for "Make" text nearby - search deeper
    let current = elem;
    for (let i = 0; i < 10; i++) {
      if (!current) break;
      const text = (current.textContent || '').toLowerCase();
      const ariaLabel = (current.getAttribute('aria-label') || '').toLowerCase();
      const placeholder = (current.getAttribute('placeholder') || '').toLowerCase();
      
      // Must have "make" and NOT have "year" or "model" in same context
      if ((text.includes('make') || ariaLabel.includes('make') || placeholder.includes('make')) && 
          !text.includes('year') && !text.includes('model') && !text.includes('vehicle type')) {
        // Double check - make sure it's actually the make field
        const parentText = (current.parentElement?.textContent || '').toLowerCase();
        if (parentText.includes('make') && !parentText.includes('year') && !parentText.includes('model')) {
          console.log('Found Make field via text search:', elem.tagName, elem.getAttribute('role'));
          return elem;
        }
      }
      current = current.parentElement;
    }
  }
  
  // Method 2: Find by form order (Make is typically second after Year)
  const formContainers = document.querySelectorAll('div[role="group"], form, fieldset, div[class*="form"], div[class*="field"]');
  for (const container of formContainers) {
    const containerText = (container.textContent || '').toLowerCase();
    if (containerText.includes('year') && containerText.includes('make') && containerText.includes('model')) {
      // Find all interactive elements in order
      const interactiveElements = container.querySelectorAll('input, select, button, [contenteditable="true"], [role="button"], [role="combobox"], label[role="combobox"]');
      const elementsArray = Array.from(interactiveElements).filter(el => 
        el.offsetParent !== null && !el.disabled
      );
      
      // Make should be the second element (after Year)
      if (elementsArray.length >= 2) {
        const makeCandidate = elementsArray[1];
        const nearbyText = (makeCandidate.closest('div')?.textContent || '').toLowerCase();
        if (nearbyText.includes('make') && !nearbyText.includes('year') && !nearbyText.includes('model')) {
          console.log('Found Make field via form order (second element):', makeCandidate.tagName, makeCandidate.getAttribute('role'));
          return makeCandidate;
        }
      }
    }
  }
  
  console.log('Make field not found with any method');
  return null;
}

/**
 * Find and fill Model field
 */
function findModelField() {
  const allInputs = document.querySelectorAll('input, select, [contenteditable="true"]');
  
  for (const elem of allInputs) {
    if (elem.offsetParent === null || elem.disabled) continue;
    
    // Look for "Model" text nearby
    let current = elem;
    for (let i = 0; i < 5; i++) {
      if (!current) break;
      const text = (current.textContent || '').toLowerCase();
      const ariaLabel = (current.getAttribute('aria-label') || '').toLowerCase();
      
      if ((text.includes('model') || ariaLabel.includes('model')) && 
          !text.includes('year') && !text.includes('make')) {
        return elem;
      }
      current = current.parentElement;
    }
  }
  return null;
}

/**
 * Helper function to fill Year value into different input types
 */
async function fillYearValue(elem, yearValue) {
  elem.focus();
  await sleep(200);
  
  // Handle button/combobox (dropdown)
  if (elem.tagName === 'BUTTON' || elem.getAttribute('role') === 'button' || 
      elem.getAttribute('role') === 'combobox' || elem.getAttribute('role') === 'listbox') {
    console.log('Year field is a button/combobox, clicking to open dropdown...');
    elem.click();
    await sleep(1000); // Wait for dropdown to open
    
    // Try multiple strategies to find and click the year option
    const yearStr = String(yearValue);
    
    // Strategy 1: Look for exact match in option text
    const yearOptions = document.querySelectorAll('div[role="option"], div[role="menuitem"], li[role="option"], li[role="menuitem"], span[role="option"]');
    for (const opt of yearOptions) {
      const optText = (opt.textContent || '').trim();
      if (optText === yearStr || optText.includes(yearStr)) {
        console.log('Clicking year option:', optText);
        opt.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await sleep(200);
        opt.click();
        await sleep(500);
        return;
      }
    }
    
    // Strategy 2: Look for any element containing the year
    const allClickable = document.querySelectorAll('div, li, span, button');
    for (const clickable of allClickable) {
      const text = (clickable.textContent || '').trim();
      if (text === yearStr || text === `Year ${yearStr}`) {
        const rect = clickable.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) { // Visible
          console.log('Clicking year option (strategy 2):', text);
          clickable.scrollIntoView({ behavior: 'smooth', block: 'center' });
          await sleep(200);
          clickable.click();
          await sleep(500);
          return;
        }
      }
    }
    
    console.warn('Year option not found in dropdown');
    
  } else if (elem.tagName === 'SELECT') {
    // Handle select dropdown
    const option = Array.from(elem.options).find(opt => 
      opt.text.includes(yearValue) || opt.value === yearValue || opt.value === String(yearValue)
    );
    if (option) {
      elem.value = option.value;
      elem.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
      await sleep(200);
    } else {
      console.warn('Year option not found in select');
    }
  } else {
    // Handle input or contenteditable
    // Clear first
    if (elem.value !== undefined) {
      elem.value = '';
    } else if (elem.textContent !== undefined) {
      elem.textContent = '';
    }
    await sleep(50);
    
    // Fill value
    if (elem.value !== undefined) {
      elem.value = yearValue;
    } else {
      elem.textContent = yearValue;
      elem.innerText = yearValue;
    }
    
    // Dispatch events for React
    elem.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    elem.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    elem.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter' }));
    elem.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: 'Enter' }));
    await sleep(200);
  }
}

/**
 * Fill Year field only (before Vehicle Type selection)
 */
async function fillYearFieldOnly() {
  console.log('Filling Year field...');
  
  if (!vehicleData.year) return;
  
  const yearField = findYearField();
  if (yearField) {
    console.log('Found Year field, filling:', vehicleData.year);
    yearField.focus();
    await smartSleep(50);
    
    // Try clicking if it's a button/combobox
    if (yearField.tagName === 'BUTTON' || yearField.getAttribute('role') === 'combobox' || 
        yearField.getAttribute('role') === 'button' || yearField.getAttribute('role') === 'listbox') {
      yearField.click();
      
      // Smart wait for dropdown to open
      const yearStr = String(vehicleData.year);
      const dropdownReady = await waitForCondition(() => {
        const allOptions = document.querySelectorAll('div[role="option"], div[role="menuitem"], li[role="option"], li[role="menuitem"], span[role="option"]');
        return allOptions.length > 0;
      }, { timeout: 2000, interval: 50 });
      
      if (dropdownReady) {
        // Look for the year option in dropdown
        const allOptions = document.querySelectorAll('div[role="option"], div[role="menuitem"], li[role="option"], li[role="menuitem"], span[role="option"]');
        
        let yearOption = null;
        for (const opt of allOptions) {
          const optText = (opt.textContent || '').trim();
          if (optText === yearStr || optText.includes(yearStr)) {
            // Make sure it's visible
            const rect = opt.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              yearOption = opt;
              break;
            }
          }
        }
        
        if (yearOption) {
          console.log('Clicking year option:', yearOption.textContent);
          yearOption.scrollIntoView({ behavior: 'smooth', block: 'center' });
          await smartSleep(100);
          yearOption.click();
          await smartSleep(200);
          return;
        }
        
        console.warn('Year option not found in dropdown');
      }
    } else if (yearField.tagName === 'SELECT') {
      // Handle select dropdown
      const option = Array.from(yearField.options).find(opt => 
        opt.text.includes(vehicleData.year) || opt.value === vehicleData.year || opt.value === String(vehicleData.year)
      );
      if (option) {
        yearField.value = option.value;
        yearField.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        await smartSleep(100);
      } else {
        console.warn('Year option not found in select');
      }
    } else {
      // Handle input or contenteditable
      await fillYearValue(yearField, vehicleData.year);
    }
  } else {
    console.warn('Year field not found');
  }
}

/**
 * Fill Make field after Vehicle Type selection
 */
async function fillMakeFieldAfterVehicleType() {
  if (!vehicleData.make) return false;
  
  // Try multiple times as the field might not be ready immediately (reduced attempts)
  for (let attempt = 0; attempt < 5; attempt++) { // Reduced from 8 to 5
    if (attempt > 0) {
      // Smart wait - check if field is ready early
      const earlyField = await waitForElement(findMakeField, { timeout: 1000, interval: 100 });
      if (!earlyField) {
        await smartSleep(400); // Reduced from 800ms
      }
    }
    const makeField = findMakeField();
    if (makeField) {
      console.log(`Filling Make field after Vehicle Type (attempt ${attempt + 1}):`, vehicleData.make);
      makeField.focus();
      await smartSleep(100);
      
      // Check if it's a combobox/dropdown (needs to be clicked to open)
      if (makeField.getAttribute('role') === 'combobox' || makeField.tagName === 'LABEL' || 
          makeField.tagName === 'BUTTON' || makeField.getAttribute('role') === 'button') {
        console.log('Make field is a combobox, opening dropdown...');
        makeField.click();
        
        // Smart wait for dropdown to open
        const dropdownReady = await waitForCondition(() => {
          const options = document.querySelectorAll('[role="option"], [role="menuitem"]');
          return options.length > 0;
        }, { timeout: 2000, interval: 50 }); // Check every 50ms, max 2s
        
        // Search for the make option in the dropdown
        const options = document.querySelectorAll('[role="option"], [role="menuitem"], div[class*="option"], li[role="option"], label[role="option"], span[role="option"]');
        const makeOption = Array.from(options).find(opt => {
          const optText = (opt.textContent || '').toLowerCase().trim();
          const makeLower = vehicleData.make.toLowerCase().trim();
          return optText === makeLower || optText.includes(makeLower) || makeLower.includes(optText);
        });
        
        if (makeOption) {
          console.log('Found Make option in dropdown:', makeOption.textContent);
          makeOption.scrollIntoView({ behavior: 'smooth', block: 'center' });
          await smartSleep(100);
          makeOption.click();
          await smartSleep(200);
          console.log('✓ Make field filled successfully via dropdown');
          return true;
        } else {
          console.warn('Make option not found in dropdown. Available options (first 5):', 
            Array.from(options).slice(0, 5).map(o => o.textContent.trim()));
        }
      } else if (makeField.tagName === 'SELECT') {
        // Handle select dropdown
        const option = Array.from(makeField.options).find(opt => 
          opt.text.toLowerCase().includes(vehicleData.make.toLowerCase()) ||
          opt.value.toLowerCase().includes(vehicleData.make.toLowerCase())
        );
        if (option) {
          makeField.value = option.value;
          makeField.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
          await smartSleep(100);
          console.log('✓ Make field filled successfully via select');
          return true;
        }
      } else {
        // Regular input field
        // Clear the field first
        if (makeField.value !== undefined) {
          makeField.value = '';
        } else if (makeField.textContent !== undefined) {
          makeField.textContent = '';
        } else if (makeField.innerText !== undefined) {
          makeField.innerText = '';
        }
        
        // Dispatch events to clear
        makeField.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
        makeField.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        await smartSleep(50);
        
        // Fill with the make value
        if (makeField.value !== undefined) {
          makeField.value = vehicleData.make;
        } else if (makeField.textContent !== undefined) {
          makeField.textContent = vehicleData.make;
        } else if (makeField.innerText !== undefined) {
          makeField.innerText = vehicleData.make;
        }
        
        // Dispatch comprehensive events for React
        makeField.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
        makeField.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        await smartSleep(100);
        console.log('✓ Make field filled successfully via input');
        return true;
      }
    }
  }
  
  console.warn('Make field not found when trying to fill after Vehicle Type (tried 5 times)');
  return false;
}

/**
 * Fill Model field after Vehicle Type selection
 */
async function fillModelFieldAfterVehicleType() {
  if (!vehicleData.model) return false;

  // Same shape as the Make filler: wait for the field to exist rather than sleeping
  // a fixed 800ms between attempts (the Model field appears right after Make is set).
  for (let attempt = 0; attempt < 5; attempt++) {
    if (attempt > 0) {
      const earlyField = await waitForElement(findModelField, { timeout: 1000, interval: 100 });
      if (!earlyField) await smartSleep(400);
    }
    const modelField = findModelField();
    if (!modelField) continue;

    console.log(`Filling Model field after Vehicle Type (attempt ${attempt + 1}):`, vehicleData.model);
    modelField.focus();
    await smartSleep(100);

    // Combobox/dropdown: open it and pick the matching option
    if (modelField.getAttribute('role') === 'combobox' || modelField.tagName === 'LABEL' ||
        modelField.tagName === 'BUTTON' || modelField.getAttribute('role') === 'button') {
      console.log('Model field is a combobox, opening dropdown...');
      modelField.click();
      await waitForCondition(() => document.querySelectorAll('[role="option"], [role="menuitem"]').length > 0,
        { timeout: 2000, interval: 50 });

      const options = document.querySelectorAll('[role="option"], [role="menuitem"], div[class*="option"], li[role="option"], label[role="option"], span[role="option"]');
      const modelLower = vehicleData.model.toLowerCase().trim();
      const modelOption = Array.from(options).find(opt => {
        const optText = (opt.textContent || '').toLowerCase().trim();
        return optText === modelLower || optText.includes(modelLower) || modelLower.includes(optText);
      });

      if (modelOption) {
        console.log('Found Model option in dropdown:', modelOption.textContent);
        modelOption.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await smartSleep(100);
        modelOption.click();
        await smartSleep(200);
        console.log('✓ Model field filled successfully via dropdown');
        return true;
      }
      console.warn('Model option not found in dropdown. Available options (first 5):',
        Array.from(options).slice(0, 5).map(o => o.textContent.trim()));
    } else if (modelField.tagName === 'SELECT') {
      const option = Array.from(modelField.options).find(opt =>
        opt.text.toLowerCase().includes(vehicleData.model.toLowerCase()) ||
        opt.value.toLowerCase().includes(vehicleData.model.toLowerCase())
      );
      if (option) {
        modelField.value = option.value;
        modelField.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        await smartSleep(100);
        console.log('✓ Model field filled successfully via select');
        return true;
      }
    } else {
      // Plain text input: set it the React way so the value tracker registers it
      setNativeValue(modelField, '');
      await smartSleep(50);
      setNativeValue(modelField, vehicleData.model);
      await smartSleep(100);
      console.log('✓ Model field filled successfully via input');
      return true;
    }
  }

  console.warn('Model field not found when trying to fill after Vehicle Type (tried 5 times)');
  return false;
}

/**
 * Fill Mileage field after Vehicle Type selection
 */
async function fillMileageFieldAfterVehicleType() {
  if (!vehicleData.mileage) return false;
  
  // Wait for form to be fully ready
  await sleep(300);
  
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) {
      await sleep(300);
    }
    const filled = await fillMileageField();
    if (filled) {
      // Wait and verify it persists
      await sleep(300);
      const mileageField = await findMileageField();
      const expectedMileage = getMileageTarget();
      const currentValue = mileageField ? (mileageField.value || mileageField.textContent || '') : null;
      if (currentValue && normalizeDigits(currentValue) === expectedMileage) {
        console.log(`✓ Mileage field filled and persisted successfully (attempt ${attempt + 1})`);
        return true;
      } else {
        console.warn(`Mileage field value cleared after fill (attempt ${attempt + 1}). Expected: ${expectedMileage}, Got: ${currentValue}. Retrying...`);
      }
    }
  }
  
  console.warn('Mileage field not found when trying to fill after Vehicle Type (tried 2 times)');
  return false;
}

/**
 * Find Mileage field
 */
async function findMileageField() {
  // Find Mileage field - be very specific to avoid matching Location field
  const labels = Array.from((document.querySelector('[role="main"]') || document.body).querySelectorAll('*')).filter(el => {
    if (el.offsetParent === null) return false;
    
    const text = (el.textContent || '').toLowerCase().trim();
    const fullText = (el.textContent || '').toLowerCase();
    
    // Must contain "mileage" or "odometer" but NOT "location"
    const hasMileage = text.includes('mileage') || text.includes('odometer');
    const hasLocation = fullText.includes('location') || fullText.includes('city') || fullText.includes('address');
    
    // Check if this is actually a label for Mileage (not just text that happens to contain the word)
    // Look for patterns like "Mileage" as a standalone word or label
    const isMileageLabel = (text === 'mileage' || text === 'odometer' || 
                           text.startsWith('mileage') || text.startsWith('odometer') ||
                           text.includes('mileage') && !hasLocation);
    
    return hasMileage && !hasLocation && isMileageLabel;
  });
  
  if (labels.length === 0) {
    console.log('Mileage label not found');
    return null;
  }
  
  // Find the best label (prefer exact "Mileage" matches)
  const label = labels.find(l => {
    const text = (l.textContent || '').toLowerCase().trim();
    return text === 'mileage' || text === 'odometer';
  }) || labels[0];
  
  // Only log on first call (avoid spam from polling loops)
  if (!findMileageField._logged) {
    console.log('Found Mileage label:', label.textContent.trim());
    findMileageField._logged = true;
  }
  
  let field = null;
  let current = label;
  
  // Method 1: Look in label container and siblings - check for both inputs AND comboboxes
  for (let i = 0; i < 15; i++) {
    if (!current) break;
    
    // Check for input fields - EXCLUDE Location fields
    const inputs = current.querySelectorAll('input[type="text"], input[type="number"], input:not([type])');
    const input = Array.from(inputs).find(inp => {
      if (inp.offsetParent === null || inp.disabled) return false;
      // Exclude Location fields
      const ariaLabel = (inp.getAttribute('aria-label') || '').toLowerCase();
      const placeholder = (inp.getAttribute('placeholder') || '').toLowerCase();
      if (ariaLabel.includes('location') || placeholder.includes('location') || 
          ariaLabel.includes('city') || placeholder.includes('city')) {
        return false;
      }
      return true;
    });
    
    // Also check for combobox/dropdown elements (but not Location)
    const comboboxes = current.querySelectorAll('[role="combobox"], [role="button"], label[role="combobox"], button');
    const combobox = Array.from(comboboxes).find(cb => {
      if (cb.offsetParent === null || cb.disabled || cb === label) return false;
      // Exclude Location comboboxes
      const ariaLabel = (cb.getAttribute('aria-label') || '').toLowerCase();
      const text = (cb.textContent || '').toLowerCase();
      if (ariaLabel.includes('location') || text.includes('location') || 
          ariaLabel.includes('city') || text.includes('city')) {
        return false;
      }
      return true;
    });
    
    if (input) {
      // Verify this input is actually in a container with "Mileage" label
      const container = input.closest('div');
      if (container && (container.textContent.toLowerCase().includes('mileage') || 
                       container.textContent.toLowerCase().includes('odometer'))) {
        // Double-check it's not the Location field
        const containerText = container.textContent.toLowerCase();
        if (!containerText.includes('location') && !containerText.includes('city')) {
          field = input;
          break;
        }
      }
    }
    
    if (combobox && !field) {
      // Verify this combobox is actually in a container with "Mileage" label
      const container = combobox.closest('div');
      if (container && (container.textContent.toLowerCase().includes('mileage') || 
                       container.textContent.toLowerCase().includes('odometer'))) {
        // Double-check it's not the Location field
        const containerText = container.textContent.toLowerCase();
        if (!containerText.includes('location') && !containerText.includes('city')) {
          field = combobox;
          break;
        }
      }
    }
    
    // Also check all siblings
    let sibling = current.nextElementSibling;
    while (sibling && !field) {
      const siblingInputs = sibling.querySelectorAll('input[type="text"], input[type="number"], input:not([type])');
      const siblingInput = Array.from(siblingInputs).find(inp => {
        if (inp.offsetParent === null || inp.disabled) return false;
        // Exclude Location fields
        const ariaLabel = (inp.getAttribute('aria-label') || '').toLowerCase();
        const placeholder = (inp.getAttribute('placeholder') || '').toLowerCase();
        if (ariaLabel.includes('location') || placeholder.includes('location') || 
            ariaLabel.includes('city') || placeholder.includes('city')) {
          return false;
        }
        // Verify it's in a Mileage container
        const container = inp.closest('div');
        return container && (container.textContent.toLowerCase().includes('mileage') || 
                           container.textContent.toLowerCase().includes('odometer')) &&
               !container.textContent.toLowerCase().includes('location');
      });
      
      if (siblingInput) {
        field = siblingInput;
        break;
      }
      
      sibling = sibling.nextElementSibling;
    }
    
    if (field) break;
    
    current = current.parentElement;
  }
  
  // Method 2: If still not found, search all inputs and comboboxes and match by proximity
  if (!field) {
    const allInputs = document.querySelectorAll('input[type="text"], input[type="number"], input:not([type]), [role="combobox"], [role="button"], label[role="combobox"]');
    const labelRect = label.getBoundingClientRect();
    
    for (const input of allInputs) {
      if (input.offsetParent === null || input.disabled || input === label) continue;
      
      // Exclude Location fields
      const ariaLabel = (input.getAttribute('aria-label') || '').toLowerCase();
      const placeholder = (input.getAttribute('placeholder') || '').toLowerCase();
      if (ariaLabel.includes('location') || placeholder.includes('location') || 
          ariaLabel.includes('city') || placeholder.includes('city')) {
        continue;
      }
      
      const inputRect = input.getBoundingClientRect();
      // Check if input is near the label (within reasonable distance)
      const distance = Math.abs(inputRect.top - labelRect.bottom) + Math.abs(inputRect.left - labelRect.left);
      if (distance < 300) {
        // Verify it's related by checking if they share a common parent with "mileage" text
        const commonParent = input.closest('div');
        if (commonParent) {
          const parentText = commonParent.textContent.toLowerCase();
          if ((parentText.includes('mileage') || parentText.includes('odometer')) &&
              !parentText.includes('location') && !parentText.includes('city')) {
            field = input;
            break;
          }
        }
      }
    }
  }
  
  if (field) {
    // Final validation: make sure this is NOT the Location field
    const fieldAriaLabel = (field.getAttribute('aria-label') || '').toLowerCase();
    const fieldPlaceholder = (field.getAttribute('placeholder') || '').toLowerCase();
    if (fieldAriaLabel.includes('location') || fieldPlaceholder.includes('location') || 
        fieldAriaLabel.includes('city') || fieldPlaceholder.includes('city')) {
      console.warn('Found field appears to be Location field, rejecting');
      return null;
    }
    if (!findMileageField._fieldLogged) {
      console.log('Found Mileage field, aria-label:', fieldAriaLabel, 'placeholder:', fieldPlaceholder);
      findMileageField._fieldLogged = true;
    }
  }
  
  return field;
}

/**
 * Fill title field
 */
async function fillTitle() {
  const titleInput = findTitleInput();
  if (!titleInput) {
    console.warn('Title input not found');
    return false;
  }

  const title = buildTitle();
  console.log('Filling title:', title);
  
  // Focus first
  titleInput.focus();
  await sleep(100);
  
  // Clear existing value
  if (titleInput.value !== undefined) {
    setNativeValue(titleInput, '');
  }
  if (titleInput.textContent !== undefined) {
    titleInput.textContent = '';
  }
  if (titleInput.innerText !== undefined) {
    titleInput.innerText = '';
  }
  
  await sleep(50);
  
  // Set new value - handle both input and contenteditable
  if (titleInput.tagName === 'INPUT' || titleInput.tagName === 'TEXTAREA') {
    setNativeValue(titleInput, title);
  } else {
    titleInput.textContent = title;
    titleInput.innerText = title;
  }
  
  // Trigger multiple events for React
  titleInput.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
  titleInput.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  titleInput.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: ' ' }));
  titleInput.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: ' ' }));
  
  // Blur and refocus to trigger React's onChange
  titleInput.blur();
  await sleep(50);
  titleInput.focus();

  await sleep(200);
  // Verify the value actually stuck (React can silently revert a plain assignment)
  if (titleInput.tagName === 'INPUT' || titleInput.tagName === 'TEXTAREA') {
    return (titleInput.value || '').trim().length > 0;
  }
  return (titleInput.textContent || titleInput.innerText || '').trim().length > 0;
}

/**
 * Build title from vehicle data
 */
function buildTitle() {
  const parts = [];
  if (vehicleData.year) parts.push(vehicleData.year);
  if (vehicleData.make) parts.push(vehicleData.make);
  if (vehicleData.model) parts.push(vehicleData.model);
  if (vehicleData.trim && !vehicleData.model?.includes(vehicleData.trim)) {
    parts.push(vehicleData.trim);
  }
  
  const title = parts.join(' ') || 'Vehicle for Sale';
  console.log('Built title from vehicle data:', title);
  return title;
}

/**
 * Find price input field - Facebook uses React components
 */
function findPriceInput() {
  // Standard selectors first
  const standardSelectors = [
    'input[placeholder*="Price" i]',
    'input[placeholder*="Enter your price" i]',
    'input[aria-label*="Price" i]',
    'input[placeholder*="$"]',
    'input[inputmode="decimal"]',
    'input[inputmode="numeric"]',
    'input[type="number"]',
    'input[data-testid*="price" i]',
    'div[contenteditable="true"][placeholder*="Price" i]'
  ];

  for (const selector of standardSelectors) {
    try {
      const inputs = document.querySelectorAll(selector);
      for (const input of inputs) {
        if (input && input.offsetParent !== null && !input.disabled) {
          return input;
        }
      }
    } catch (e) {
      continue;
    }
  }

  // Facebook React pattern: Look for "Price" or "Enter your price" text nearby
  const allPossibleInputs = document.querySelectorAll('input, [contenteditable="true"], div[role="textbox"]');
  
  for (const elem of allPossibleInputs) {
    if (elem.offsetParent === null || elem.disabled) continue;
    
    // Look for "Price" text in nearby elements
    let current = elem;
    for (let i = 0; i < 8; i++) { // Increased depth
      if (!current) break;
      const text = (current.textContent || '').toLowerCase();
      const ariaLabel = (current.getAttribute('aria-label') || '').toLowerCase();
      
      if (text.includes('enter your price') || text.includes('price') ||
          ariaLabel.includes('price')) {
        // Make sure it's not the description field
        if (!text.includes('description') && !text.includes('tell buyers')) {
          return elem;
        }
      }
      current = current.parentElement;
    }
  }

  // Look for numeric inputs near "Price" text
  const numericInputs = document.querySelectorAll('input[type="number"], input[inputmode="decimal"], input[inputmode="numeric"]');
  for (const input of numericInputs) {
    if (input.offsetParent !== null && !input.disabled) {
      // Check if "Price" is nearby
      let container = input.parentElement;
      for (let i = 0; i < 5; i++) {
        if (!container) break;
        const text = (container.textContent || '').toLowerCase();
        if (text.includes('price') || text.includes('enter your price')) {
          return input;
        }
        container = container.parentElement;
      }
    }
  }
  
  // Fallback: Find numeric input that's not Year field
  for (const input of numericInputs) {
    if (input.offsetParent !== null && !input.disabled) {
      const context = (input.closest('div')?.textContent || '').toLowerCase();
      if (!context.includes('year') && !context.includes('make') && !context.includes('model')) {
        return input;
      }
    }
  }

  return null;
}

/**
 * Fill price field
 */
async function fillPrice() {
  const price = vehicleData.price != null ? vehicleData.price : '';
  const priceValue = String(price).replace(/[^0-9]/g, '');
  
  if (!priceValue) {
    console.warn('No price value to fill. Original price:', price);
    return false;
  }

  console.log('Filling price:', priceValue, '(from:', price, ')');
  
  let priceInput = findPriceInput();
  
  // If not found, try alternative method
  if (!priceInput) {
    console.warn('Price input not found via standard method, trying alternative...');
    
    // Look for "Enter your price" or "Price" text and find nearby input
    const allText = document.body.innerText || document.body.textContent || '';
    const priceTextIndex = allText.toLowerCase().indexOf('enter your price');
    
    if (priceTextIndex !== -1) {
      // Find all inputs near "Price" text
      const allInputs = document.querySelectorAll('input, [contenteditable="true"]');
      for (const input of allInputs) {
        if (input.offsetParent === null || input.disabled) continue;
        if (input.type === 'search' || input.type === 'email' || input.type === 'password') continue;
        
        const rect = input.getBoundingClientRect();
        const inputY = rect.top;
        
        // Check if there's "Price" text nearby
        const nearbyElements = document.elementsFromPoint(rect.left, inputY);
        for (const el of nearbyElements) {
          const elText = (el.textContent || '').toLowerCase();
          if (elText.includes('price') || elText.includes('enter your price')) {
            priceInput = input;
            console.log('Found Price field via proximity');
            break;
          }
        }
        if (priceInput) break;
      }
    }
  }
  
  if (!priceInput) {
    console.warn('Price input not found after all attempts');
    return false;
  }
  
  // Focus first
  priceInput.focus();
  await sleep(100);
  
  // Clear existing value
  if (priceInput.value !== undefined) {
    setNativeValue(priceInput, '');
  }
  if (priceInput.textContent !== undefined) {
    priceInput.textContent = '';
  }
  
  await sleep(50);
  
  // Set new value
  if (priceInput.tagName === 'INPUT' || priceInput.tagName === 'TEXTAREA') {
    setNativeValue(priceInput, priceValue);
  } else {
    priceInput.textContent = priceValue;
    priceInput.innerText = priceValue;
  }
  
  // Trigger multiple events for React
  priceInput.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
  priceInput.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  priceInput.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: ' ' }));
  priceInput.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: ' ' }));
  
  // Blur and refocus to trigger React's onChange
  priceInput.blur();
  await sleep(50);
  priceInput.focus();

  await sleep(200);
  // Verify the value actually stuck (React can silently revert a plain assignment)
  if (priceInput.tagName === 'INPUT' || priceInput.tagName === 'TEXTAREA') {
    return (priceInput.value || '').trim().length > 0;
  }
  return (priceInput.textContent || priceInput.innerText || '').trim().length > 0;
}

/**
 * Find description textarea - Facebook uses React components
 */
function findDescriptionTextarea() {
  // Standard selectors first
  const standardSelectors = [
    'textarea[placeholder*="Description" i]',
    'textarea[placeholder*="Tell buyers" i]',
    'textarea[aria-label*="Description" i]',
    'div[contenteditable="true"][role="textbox"]',
    'div[contenteditable="true"][placeholder*="Description" i]',
    'div[contenteditable="true"][placeholder*="Tell buyers" i]'
  ];

  for (const selector of standardSelectors) {
    try {
      const elements = document.querySelectorAll(selector);
      for (const elem of elements) {
        if (elem.offsetParent !== null && !elem.disabled) {
          const placeholder = (elem.getAttribute('placeholder') || '').toLowerCase();
          const ariaLabel = (elem.getAttribute('aria-label') || '').toLowerCase();
          if (placeholder.includes('description') || placeholder.includes('tell buyers') ||
              ariaLabel.includes('description')) {
            return elem;
          }
        }
      }
    } catch (e) {
      continue;
    }
  }

  // Facebook React pattern: Look for "Description" or "Tell buyers" text nearby
  const allEditable = document.querySelectorAll('div[contenteditable="true"], textarea, div[role="textbox"]');
  
  for (const elem of allEditable) {
    if (elem.offsetParent === null || elem.disabled) continue;
    
    // Look for "Description" or "Tell buyers" text in nearby elements
    let current = elem;
    for (let i = 0; i < 8; i++) { // Increased depth
      if (!current) break;
      const text = (current.textContent || '').toLowerCase();
      const ariaLabel = (current.getAttribute('aria-label') || '').toLowerCase();
      
      if (text.includes('tell buyers') || text.includes('description') ||
          text.includes('anything that you haven\'t') ||
          ariaLabel.includes('description')) {
        return elem;
      }
      current = current.parentElement;
    }
  }

  // Last resort: find largest contenteditable or textarea (likely description)
  let largest = null;
  let largestSize = 0;
  for (const elem of allEditable) {
    if (elem.offsetParent !== null && !elem.disabled) {
      const rect = elem.getBoundingClientRect();
      const size = rect.width * rect.height;
      // Look for tall textarea/div (description fields are usually tall)
      if (size > largestSize && rect.height > 100) {
        // Make sure it's not title or price
        const context = (elem.closest('div')?.textContent || '').toLowerCase();
        if (!context.includes('title') && !context.includes('price') && 
            !context.includes('year') && !context.includes('make') && !context.includes('model')) {
          largest = elem;
          largestSize = size;
        }
      }
    }
  }
  
  if (largest) {
    return largest;
  }

  return null;
}

/**
 * Fill description field
 */
async function fillDescription() {
  if (!generatedDescription) {
    console.warn('No description generated');
    return false;
  }

  const textarea = findDescriptionTextarea();
  if (!textarea) {
    console.warn('Description textarea not found');
    return false;
  }

  console.log('Filling description (length:', generatedDescription.length, ')');

  // Focus first
  textarea.focus();
  await sleep(150);
  
  // Clear existing content - try multiple methods
  if (textarea.tagName === 'TEXTAREA' || textarea.tagName === 'INPUT') {
    setNativeValue(textarea, '');
  } else {
    textarea.textContent = '';
    textarea.innerText = '';
    if (textarea.innerHTML !== undefined) {
      textarea.innerHTML = '';
    }
  }
  
  await sleep(100);
  
  // Set new content - handle both textarea and contenteditable
  if (textarea.tagName === 'TEXTAREA' || textarea.tagName === 'INPUT') {
    setNativeValue(textarea, generatedDescription);
  } else {
    // Contenteditable div: build real text + <br> nodes. Never innerHTML — the
    // description is model output, and any markup in it would run in Facebook's page.
    textarea.textContent = '';
    String(generatedDescription).split('\n').forEach((line, i) => {
      if (i) textarea.appendChild(document.createElement('br'));
      if (line) textarea.appendChild(document.createTextNode(line));
    });
  }
  
  // Trigger multiple events for React
  textarea.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
  textarea.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
  textarea.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: ' ' }));
  textarea.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: ' ' }));
  
  // For contenteditable, also trigger composition events
  if (textarea.contentEditable === 'true' || textarea.getAttribute('contenteditable') === 'true') {
    textarea.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    textarea.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, data: generatedDescription }));
    textarea.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: generatedDescription }));
  }
  
  // Blur and refocus to trigger React's onChange
  textarea.blur();
  await sleep(100);
  textarea.focus();

  // Honest result: succeed only if the text actually stuck (React can silently
  // revert a value it didn't register), so the popup can warn the rep instead of
  // reporting a description that isn't there.
  await sleep(300);
  const now = (textarea.tagName === 'TEXTAREA' || textarea.tagName === 'INPUT') ? (textarea.value || '') : (textarea.textContent || '');
  const ok = now.trim().length >= Math.min(40, generatedDescription.trim().length * 0.5);
  if (!ok) console.warn('Description did not stick (read back', now.length, 'chars)');
  return ok;
}

/**
 * Fill category (Vehicles)
 */
async function fillCategory() {
  // Look for category selector - Facebook uses various patterns
  const categorySelectors = [
    'div[role="button"][aria-label*="Category"]',
    'div[role="button"][aria-label*="category"]',
    'button[aria-label*="Category"]',
    '[data-testid*="category"]',
    'div[aria-haspopup="listbox"]'
  ];

  for (const selector of categorySelectors) {
    try {
      const buttons = document.querySelectorAll(selector);
      for (const button of buttons) {
        if (button && button.offsetParent !== null) {
          const text = (button.textContent || button.getAttribute('aria-label') || '').toLowerCase();
          if (text.includes('category')) {   // 'select' alone matched unrelated pickers
            button.click();
            await sleep(800); // Wait longer for dropdown
            
            // Look for Vehicles option
            const vehiclesOption = findVehiclesOption();
            if (vehiclesOption) {
              vehiclesOption.click();
              await sleep(500);
              return;
            }
            
            // Close dropdown if option not found
            document.body.click();
            await sleep(300);
          }
        }
      }
    } catch (e) {
      // Continue to next selector
    }
  }
  
  console.log('Category selector not found or Vehicles option not available');
}

/**
 * Find Vehicles category option
 */
function findVehiclesOption() {
  const options = document.querySelectorAll('div[role="option"], div[role="menuitem"], span');
  for (const option of options) {
    const text = option.textContent?.toLowerCase() || '';
    if (text.includes('vehicle') || text.includes('car') || text.includes('auto')) {
      return option;
    }
  }
  return null;
}

/**
 * Fill location
 */
async function fillLocation() {
  if (!vehicleData.address) return;

  const locationSelectors = [
    'input[placeholder*="Location"]',
    'input[aria-label*="Location"]',
    'input[placeholder*="City"]'
  ];

  for (const selector of locationSelectors) {
    const input = document.querySelector(selector);
    if (input && input.offsetParent !== null) {
      // Try to extract city from address
      const city = extractCityFromAddress(vehicleData.address);
      if (city) {
        input.focus();
        setNativeValue(input, city);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        await sleep(500);
        
        // Try to select from dropdown
        const suggestion = findLocationSuggestion(city);
        if (suggestion) {
          suggestion.click();
          await sleep(300);
        }
        return;
      }
    }
  }
}

/**
 * Map body style to vehicle type for Facebook
 * Facebook has "Car/Truck" as a single dropdown option
 */
function getVehicleType() {
  // Facebook's dropdown has "Car/Truck" as a single option
  // We always select this option regardless of the actual vehicle type
  return 'Car/Truck';
}

/**
 * Find and fill Vehicle Type field
 */
async function fillVehicleType() {
  const vehicleType = getVehicleType(); // Always "Car/Truck"
  console.log('%cVehicle Type to fill:', 'color: #3498db; font-weight: bold;', vehicleType);
  
  let found = false; // Track if we successfully filled the field - declared at function level
  
  // Method 1: Find "Vehicle type" label and get the next interactive element
  // Also look for combobox elements that are near "Vehicle type" text
  const vehicleTypeLabels = Array.from(document.querySelectorAll('*')).filter(el => {
    const text = (el.textContent || '').toLowerCase();
    return (text.includes('vehicle type') || (text === 'type' && el.closest('div')?.textContent.toLowerCase().includes('vehicle'))) &&
           el.offsetParent !== null;
  });
  
  console.log(`Found ${vehicleTypeLabels.length} Vehicle Type labels`);
  
  // Also look for combobox elements that might be the Vehicle Type field
  const allComboboxes = document.querySelectorAll('[role="combobox"], label[role="combobox"]');
  console.log(`Found ${allComboboxes.length} combobox elements on page`);
  
  // Only process the first label to avoid multiple attempts
  if (vehicleTypeLabels.length > 0) {
    const label = vehicleTypeLabels[0];
    console.log('Processing Vehicle Type label:', label.textContent);
  
    // Walk through siblings and children to find input
    let current = label;
    for (let i = 0; i < 10 && !found; i++) {
      let next = current.nextElementSibling;
      while (next && !found) {
        // Make sure it's NOT the Make or Model field - check if it's near "Make" or "Model" text
        const nextContext = (next.textContent || '').toLowerCase();
        if ((nextContext.includes('make') || nextContext.includes('model')) && !nextContext.includes('vehicle type')) {
          next = next.nextElementSibling;
          continue;
        }
        
        // Check if it's a combobox, button, or input
        const isInteractive = (next.tagName === 'INPUT' || next.tagName === 'SELECT' || 
             next.tagName === 'BUTTON' || next.tagName === 'LABEL' ||
             next.getAttribute('role') === 'combobox' ||
             next.getAttribute('role') === 'button' || 
             next.getAttribute('contenteditable') === 'true');
        
        if (isInteractive && next.offsetParent !== null && !next.disabled) {
          // Double-check it's not Make or Model by checking parent context
          const parentContext = (next.closest('div')?.textContent || '').toLowerCase();
          if (parentContext.includes('make') || parentContext.includes('model')) {
            if (!parentContext.includes('vehicle type')) {
              next = next.nextElementSibling;
              continue;
            }
          }
          
          console.log('Found Vehicle Type field after label:', next.tagName, next.getAttribute('role'));
          next.focus();
          await sleep(300);
          
          if (next.tagName === 'BUTTON' || next.tagName === 'LABEL' ||
              next.getAttribute('role') === 'button' || 
              next.getAttribute('role') === 'combobox') {
            console.log('Clicking Vehicle Type field to open dropdown...');
            next.click();
            await waitForElement(() => document.querySelector('[role="listbox"]:not([hidden]), [role="menu"]:not([hidden]), [role="option"]'), { timeout: 4000, interval: 50 }); // wait for dropdown to open
            
            // Wait for dropdown to appear - check multiple times with more patience
            let dropdownContainer = null;
            for (let attempt = 0; attempt < 15; attempt++) {
              // Try multiple ways to find the dropdown
              dropdownContainer = next.closest('[role="listbox"], [role="menu"]') ||
                                 document.querySelector('[role="listbox"]:not([hidden]), [role="menu"]:not([hidden]), [role="listbox"][aria-expanded="true"], [role="listbox"][aria-expanded="true"]') ||
                                 document.querySelector('div[role="listbox"], ul[role="listbox"], div[role="menu"]');
              if (dropdownContainer) {
                console.log('Dropdown container found');
                break;
              }
              await sleep(300);
            }
            
            // Search for options - try multiple selectors and broader search
            const searchScope = dropdownContainer || document;
            let options = searchScope.querySelectorAll('div[role="option"], div[role="menuitem"], li[role="option"], li[role="menuitem"], [data-testid*="option"], div[class*="option"], span[role="option"], label[role="option"]');
            
            console.log(`Found ${options.length} options with standard selectors`);
            
            // If still no options, try searching the entire document for elements with "car/truck" text
            if (options.length === 0) {
              console.log('No options found with standard selectors, searching document for "car/truck" text...');
              const rect = next.getBoundingClientRect();
              
              // Search all elements that might be dropdown options - be more aggressive
              const allElements = document.querySelectorAll('div, span, li, button, a, label');
              options = Array.from(allElements).filter(el => {
                const text = (el.textContent || '').toLowerCase().trim();
                const hasCarTruck = (text.includes('car') && text.includes('truck')) && text.length <= 25;
                if (hasCarTruck) {
                  // Make sure it's visible and near the button
                  const elRect = el.getBoundingClientRect();
                  const isVisible = elRect.width > 0 && elRect.height > 0;
                  const isNearButton = Math.abs(elRect.top - rect.bottom) < 800 && Math.abs(elRect.left - rect.left) < 400;
                  return isVisible && isNearButton;
                }
                return false;
              });
              console.log(`Found ${options.length} options via document search`);
            }
            
            console.log(`Searching for vehicle type "${vehicleType}" in ${options.length} options`);
            
            // Log first few options for debugging
            if (options.length > 0) {
              console.log('First 5 options found:', Array.from(options).slice(0, 5).map(o => ({
                text: o.textContent.trim().substring(0, 50),
                length: o.textContent.trim().length,
                role: o.getAttribute('role'),
                tag: o.tagName
              })));
            }
            
            for (const option of options) {
              const optionText = (option.textContent || '').toLowerCase().trim();
              // Match "Car/Truck" or "car/truck" (Facebook's single option)
              // Also try matching with various separators and case variations
              const isMatch = optionText === 'car/truck' || 
                              optionText === 'car / truck' ||
                              optionText === 'car&truck' ||
                              optionText === 'car & truck' ||
                              (optionText.includes('car') && optionText.includes('truck') && optionText.length <= 25);
              
              if (isMatch) {
                // Make sure it's visible
                const rect = option.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                  // Additional check: make sure it's not in the main page content
                  const formArea = document.querySelector('form, [role="dialog"], [role="main"]');
                  if (formArea) {
                    const formRect = formArea.getBoundingClientRect();
                    const optionY = rect.top;
                    const formTop = formRect.top;
                    const formBottom = formRect.bottom;
                    
                    // Option should be near the form (within reasonable distance)
                    if (optionY >= formTop - 200 && optionY <= formBottom + 500) {
                      console.log('%c✓ Clicking vehicle type option (Method 1):', 'color: #27ae60; font-weight: bold;', option.textContent);
                      option.scrollIntoView({ behavior: 'smooth', block: 'center' });
                      await sleep(300);
                      option.click();
                      await sleep(500);
                      found = true;
                      return; // Success!
                    }
                  } else {
                    // If no form found, just check if it has the right role or is clickable
                    if (option.getAttribute('role') === 'option' || option.getAttribute('role') === 'menuitem' || 
                        option.tagName === 'BUTTON' || option.tagName === 'LABEL') {
                      console.log('%c✓ Clicking vehicle type option (Method 1):', 'color: #27ae60; font-weight: bold;', option.textContent);
                      option.scrollIntoView({ behavior: 'smooth', block: 'center' });
                      await sleep(300);
                      option.click();
                      await sleep(500);
                      found = true;
                      return; // Success!
                    }
                  }
                }
              }
            }
            
            if (!found) {
              console.warn('Vehicle type option not found. Available options (first 5):', 
                Array.from(options).slice(0, 5).map(o => ({ 
                  text: o.textContent.trim().substring(0, 50), 
                  length: o.textContent.trim().length,
                  role: o.getAttribute('role') 
                })));
            }
          } else if (next.tagName === 'SELECT') {
            const option = Array.from(next.options).find(opt => {
              const optText = opt.text.toLowerCase();
              return optText.includes('car') && optText.includes('truck');
            });
            if (option) {
              next.value = option.value;
              next.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
              await sleep(200);
              found = true;
              return;
            }
          } else {
            if (next.value !== undefined) {
              next.value = vehicleType;
            } else {
              next.textContent = vehicleType;
            }
            next.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
            next.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
            await sleep(200);
            found = true;
            return;
          }
        }
        next = next.nextElementSibling;
      }
      current = current.parentElement;
      if (!current) break;
    }
    
    if (found) return; // Success from Method 1
  }
  
  // Method 1.5: Directly search for combobox elements that are NOT Year/Make/Model
  if (!found && allComboboxes.length > 0) {
    console.log('Trying Method 1.5: Searching combobox elements directly...');
    for (const combobox of allComboboxes) {
      if (found) break;
      if (combobox.offsetParent === null || combobox.disabled) continue;
      
      // Get the context around this combobox
      const container = combobox.closest('div[class*="x"], div[class*="x1"]') || combobox.parentElement;
      const containerText = (container?.textContent || '').toLowerCase();
      
      // Skip if it's Year, Make, or Model
      if (containerText.includes('year') || containerText.includes('make') || containerText.includes('model')) {
        if (!containerText.includes('vehicle type')) {
          continue;
        }
      }
      
      // Check if it's near "Vehicle type" text
      if (containerText.includes('vehicle type') || 
          (containerText.includes('type') && !containerText.includes('make') && !containerText.includes('model'))) {
        console.log('Found potential Vehicle Type combobox:', combobox);
        combobox.focus();
        await sleep(300);
        combobox.click();
        await sleep(3000);
        
        // Search for options
        let options = document.querySelectorAll('div[role="option"], div[role="menuitem"], li[role="option"], label[role="option"], span[role="option"]');
        if (options.length === 0) {
          // Broader search
          const rect = combobox.getBoundingClientRect();
          const allElements = document.querySelectorAll('div, span, li, button, a, label');
          options = Array.from(allElements).filter(el => {
            const text = (el.textContent || '').toLowerCase().trim();
            return (text.includes('car') && text.includes('truck')) && text.length <= 25;
          });
        }
        
        console.log(`Found ${options.length} options for combobox`);
        
        for (const option of options) {
          const optionText = (option.textContent || '').toLowerCase().trim();
          if (optionText === 'car/truck' || optionText === 'car / truck' ||
              (optionText.includes('car') && optionText.includes('truck') && optionText.length <= 25)) {
            const rect = option.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              console.log('%cClicking vehicle type option (Method 1.5):', 'color: #27ae60; font-weight: bold;', option.textContent);
              option.scrollIntoView({ behavior: 'smooth', block: 'center' });
              await sleep(300);
              option.click();
              await sleep(500);
              found = true;
              return;
            }
          }
        }
      }
    }
  }
  
  // Method 2: Look for "Vehicle type" text and find nearby input (only if Method 1 failed)
  if (!found) {
    const allText = document.body.innerText || document.body.textContent || '';
    const vehicleTypeIndex = allText.toLowerCase().indexOf('vehicle type');
    
    if (vehicleTypeIndex !== -1) {
      const allInputs = document.querySelectorAll('input, select, button, div[role="button"], [contenteditable="true"]');
      for (const elem of allInputs) {
        if (found) break; // Stop if we already found it
        if (elem.offsetParent === null || elem.disabled) continue;
        
        // Make sure it's NOT the Make or Model field - be very strict
        const elemContext = (elem.closest('div')?.textContent || '').toLowerCase();
        if (elemContext.includes('make') || elemContext.includes('model')) {
          continue; // Skip Make and Model fields
        }
        
        // Check if element is in a container with "Vehicle type" text
        let container = elem.parentElement;
        let isVehicleTypeField = false;
        for (let i = 0; i < 10; i++) {
          if (!container) break;
          const containerText = (container.textContent || '').toLowerCase();
          // Must have "vehicle type" and NOT have "make" or "model" nearby.
          // (The old `indexOf('make') || 999` guard compared against -1 when "make"
          // was absent, so this fallback could never match.)
          if (containerText.includes('vehicle type') &&
              !containerText.includes('make') &&
              !containerText.includes('model')) {
            isVehicleTypeField = true;
            break;
          }
          container = container.parentElement;
        }
        
        if (!isVehicleTypeField) continue;
        
        console.log('Found Vehicle Type field in container (Method 2)');
        elem.focus();
        await sleep(300);
        
        let processed = false; // Track if we processed this element
          
          if (elem.tagName === 'BUTTON' || elem.getAttribute('role') === 'button' || 
              elem.getAttribute('role') === 'combobox') {
            elem.click();
            await waitForElement(() => document.querySelector('[role="listbox"]:not([hidden]), [role="menu"]:not([hidden]), [role="option"]'), { timeout: 4000, interval: 50 }); // wait for dropdown to open
            
            // Wait for dropdown to appear - check multiple times
            let dropdownContainer = null;
            for (let attempt = 0; attempt < 10; attempt++) {
              dropdownContainer = elem.closest('[role="listbox"], [role="menu"]') ||
                                 document.querySelector('[role="listbox"]:not([hidden]), [role="menu"]:not([hidden]), [role="listbox"][aria-expanded="true"]');
              if (dropdownContainer) {
                console.log('Dropdown container found (Method 2)');
                break;
              }
              await sleep(200);
            }
            
            // Search for options - try multiple selectors and broader search
            const searchScope = dropdownContainer || document;
            let options = searchScope.querySelectorAll('div[role="option"], div[role="menuitem"], li[role="option"], li[role="menuitem"], [data-testid*="option"], div[class*="option"], span[role="option"]');
            
            // If still no options, search the entire document for elements with "car/truck" text
            if (options.length === 0) {
              console.log('No options found with standard selectors, searching document for "car/truck" text...');
              const rect = elem.getBoundingClientRect();
              
              // Search all elements that might be dropdown options
              const allElements = document.querySelectorAll('div, span, li, button, a');
              options = Array.from(allElements).filter(el => {
                const text = (el.textContent || '').toLowerCase().trim();
                const hasCarTruck = (text.includes('car') && text.includes('truck')) && text.length <= 25;
                if (hasCarTruck) {
                  // Make sure it's visible and near the button
                  const elRect = el.getBoundingClientRect();
                  const isVisible = elRect.width > 0 && elRect.height > 0;
                  const isNearButton = Math.abs(elRect.top - rect.bottom) < 500 && Math.abs(elRect.left - rect.left) < 300;
                  return isVisible && isNearButton;
                }
                return false;
              });
            }
            
            console.log(`Searching for vehicle type "${vehicleType}" in ${options.length} options (Method 2)`);
            
            // Log first few options for debugging
            if (options.length > 0) {
              console.log('First 5 options found (Method 2):', Array.from(options).slice(0, 5).map(o => ({
                text: o.textContent.trim().substring(0, 50),
                length: o.textContent.trim().length,
                role: o.getAttribute('role'),
                tag: o.tagName
              })));
            }
            
            for (const option of options) {
              const optionText = (option.textContent || '').toLowerCase().trim();
              
              // Match "Car/Truck" or "car/truck" (Facebook's single option)
              const isMatch = optionText === 'car/truck' || 
                              optionText === 'car / truck' ||
                              (optionText.includes('car') && optionText.includes('truck') && optionText.length <= 25);
              
              if (isMatch) {
                // Make sure it's visible and actually in a dropdown
                const rect = option.getBoundingClientRect();
                if (rect.width > 0 && rect.height > 0) {
                  // Additional check: make sure it's not in the main page content
                  // Dropdowns are usually positioned near the form, not in the center of the page
                  const formArea = document.querySelector('form, [role="dialog"], [role="main"]');
                  if (formArea) {
                    const formRect = formArea.getBoundingClientRect();
                    const optionY = rect.top;
                    const formTop = formRect.top;
                    const formBottom = formRect.bottom;
                    
                    // Option should be near the form (within reasonable distance)
                    if (optionY >= formTop - 200 && optionY <= formBottom + 500) {
                      console.log('%cClicking vehicle type option (Method 2):', 'color: #27ae60; font-weight: bold;', option.textContent);
                      option.scrollIntoView({ behavior: 'smooth', block: 'center' });
                      await sleep(300);
                      option.click();
                      await sleep(500);
                      found = true;
                      return; // Success!
                    }
                  } else {
                    // If no form found, just check if it has the right role
                    if (option.getAttribute('role') === 'option' || option.getAttribute('role') === 'menuitem') {
                      console.log('%cClicking vehicle type option (Method 2):', 'color: #27ae60; font-weight: bold;', option.textContent);
                      option.scrollIntoView({ behavior: 'smooth', block: 'center' });
                      await sleep(300);
                      option.click();
                      await sleep(500);
                      found = true;
                      return; // Success!
                    }
                  }
                }
              }
            }
            
            if (!found) {
              console.warn('Vehicle type option not found (Method 2). Available options (first 5):', 
                Array.from(options).slice(0, 5).map(o => ({ 
                  text: o.textContent.trim().substring(0, 50), 
                  length: o.textContent.trim().length,
                  role: o.getAttribute('role') 
                })));
            }
            
            // Mark as processed to prevent further attempts
            found = true;
            processed = true;
          } else if (elem.tagName === 'SELECT') {
            const option = Array.from(elem.options).find(opt => {
              const optText = opt.text.toLowerCase();
              return optText.includes('car') && optText.includes('truck');
            });
            if (option) {
              elem.value = option.value;
              elem.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
              await sleep(200);
              found = true;
              return; // Success!
            }
        } else {
          // Don't fill input fields directly - Vehicle Type should be a dropdown
          console.warn('Vehicle Type field is not a button/select - skipping direct fill');
          processed = true; // Mark as processed
        }
        
        // If we processed this element, break out of the main loop
        if (processed || found) {
          found = true; // Mark as processed even if dropdown didn't work
          break; // Break out of the allInputs loop (line 1783)
        }
      }
    }
  }
  
  if (!found) {
    console.warn('%cVehicle Type field could not be filled. Please select "Car/Truck" manually from the dropdown.', 'color: #e74c3c; font-weight: bold;');
  }
}

/**
 * Fill additional vehicle fields that appear after Vehicle Type selection:
 * Body Style, Exterior Color, Interior Color, Vehicle Condition, Fuel Type, Transmission Type, Mileage
 */
// Map the feed's free-text body style onto Facebook Marketplace's fixed options.
// The feed says things like "Sport Utility" / "Crew Cab Pickup"; Facebook's list
// is SUV / Truck / Sedan / … — without this mapping they never lexically match.
function normalizeBodyStyle(raw) {
  const s = String(raw || '').toLowerCase().trim();
  if (!s) return '';
  if (/\b(suv|sport utility|crossover|cuv)\b/.test(s)) return 'SUV';
  if (/(pickup|crew cab|quad cab|double cab|extended cab|regular cab|supercrew|supercab|king cab|access cab|mega cab|\btruck\b)/.test(s)) return 'Truck';
  if (/\bmini-?van\b/.test(s)) return 'Minivan';
  if (/(cargo van|passenger van|\bvan\b)/.test(s)) return 'Van';
  if (/\b(convertible|cabriolet|roadster|spyder|spider)\b/.test(s)) return 'Convertible';
  if (/\b(coupe|2[\s-]?door|2[\s-]?dr)\b/.test(s)) return 'Coupe';
  if (/\b(hatchback|hatch|liftback)\b/.test(s)) return 'Hatchback';
  if (/\b(wagon|estate)\b/.test(s)) return 'Wagon';
  if (/\b(sedan|saloon|4[\s-]?door|4[\s-]?dr)\b/.test(s)) return 'Sedan';
  return raw; // unknown → let the dropdown matcher try the raw value
}

async function fillAdditionalVehicleFields() {
  if (!vehicleData) return;

  // Fill Body Style — normalize the feed's body style (e.g. "Sport Utility",
  // "Crew Cab Pickup") onto Facebook's option set (SUV, Truck, …) so it matches.
  const bodyStyleVal = normalizeBodyStyle(vehicleData.bodyStyle || vehicleData.body);
  if (bodyStyleVal) {
    await fillDropdownField('body style', bodyStyleVal);
  }
  
  // Fill Exterior Color (popup saves it under exterior_color)
  const extColor = vehicleData.exterior_color || vehicleData.color || vehicleData.exteriorColor;
  if (extColor) {
    await fillDropdownField('exterior color', extColor);
  }
  
  // Fill Interior Color (if available, otherwise default to "Black")
  // Check multiple possible sources and column name variations
  let interiorColor = vehicleData.interiorColor;
  
  // If not found directly, search rawData with case-insensitive matching
  if (!interiorColor && vehicleData.rawData) {
    const rawDataKeys = Object.keys(vehicleData.rawData);
    console.log('Searching for Interior Color in rawData. Available keys:', rawDataKeys);
    
    // Try various possible column names (case-insensitive)
    for (const key of rawDataKeys) {
      const lowerKey = key.toLowerCase().trim();
      if (lowerKey === 'interior_color' || 
          lowerKey === 'interiorcolor' || 
          lowerKey === 'interior color' ||
          lowerKey === 'interiorcolor' ||
          lowerKey.includes('interior') && lowerKey.includes('color')) {
        interiorColor = vehicleData.rawData[key];
        console.log(`Found Interior Color in rawData['${key}']:`, interiorColor);
        break;
      }
    }
  }
  
  // Clean up the value (remove extra whitespace, etc.)
  if (interiorColor) {
    interiorColor = String(interiorColor).trim();
    // Remove any quotes if present
    interiorColor = interiorColor.replace(/^["']|["']$/g, '');
  }
  
  // Default to "Black" if no Interior Color data is found
  if (!interiorColor || interiorColor === '' || interiorColor === 'null' || interiorColor === 'undefined') {
    console.log('No Interior Color data available. Defaulting to "Black"');
    interiorColor = 'Black';
  }
  
  console.log('Attempting to fill Interior Color:', interiorColor);
  const filled = await fillDropdownField('interior color', interiorColor);
  if (!filled) {
    console.warn('Interior Color field not found or could not be filled');
  } else {
    console.log('✓ Interior Color filled successfully');
  }
  
  // Fill Vehicle Condition - ALWAYS set to "Excellent"
  await fillDropdownField('condition', 'Excellent');
  
  // Fill Fuel Type
  if (vehicleData.fuelType) {
    await fillDropdownField('fuel type', vehicleData.fuelType);
  }
  
  // Fill Transmission Type
  if (vehicleData.transmission) {
    await fillDropdownField('transmission', vehicleData.transmission);
  }
  
  // Mileage is filled earlier (right after Vehicle Type) and re-verified by
  // verifyAndRepairForm() after this runs, so we don't fill it again here.
}

/**
 * Helper function to fill a dropdown field by label text
 */
async function fillDropdownField(labelText, value) {
  if (!value) return false;
  
  // Find the label - try multiple variations
  const labelTextLower = labelText.toLowerCase();
  const labelVariations = [
    labelTextLower,
    labelTextLower.replace(' ', ''),
    labelTextLower.replace('interior color', 'interior'),
    labelTextLower.replace('exterior color', 'exterior')
  ];
  
  const labels = Array.from(document.querySelectorAll('*')).filter(el => {
    const text = (el.textContent || '').toLowerCase();
    return labelVariations.some(variation => text.includes(variation)) && el.offsetParent !== null;
  });
  
  if (labels.length === 0) {
    console.log(`Label "${labelText}" not found (searched for: ${labelVariations.join(', ')})`);
    return false;
  }
  
  console.log(`Found ${labels.length} potential labels for "${labelText}"`);
  const label = labels[0];
  console.log(`Using first label, searching for field...`);
  
  // Find the associated field (combobox, button, or input)
  // Facebook's structure can vary, so we need to search more broadly
  let field = null;
  let current = label;
  
  // Method 1: Look in the label's container and siblings
  for (let i = 0; i < 15; i++) {
    if (!current) break;
    
    // Look for combobox, button, or input in current element
    const interactive = current.querySelector('[role="combobox"], [role="button"], button, input, select, label[role="combobox"]');
    
    if (interactive && interactive.offsetParent !== null && !interactive.disabled) {
      // Make sure it's not the label itself
      if (interactive !== label) {
        field = interactive;
        break;
      }
    }
    
    // Also check siblings
    let sibling = current.nextElementSibling;
    while (sibling && !field) {
      const siblingInteractive = sibling.querySelector('[role="combobox"], [role="button"], button, input, select, label[role="combobox"]') ||
                                (sibling.matches('[role="combobox"], [role="button"], button, input, select, label[role="combobox"]') ? sibling : null);
      if (siblingInteractive && siblingInteractive.offsetParent !== null && !siblingInteractive.disabled) {
        field = siblingInteractive;
        break;
      }
      sibling = sibling.nextElementSibling;
    }
    
    if (field) break;
    
    current = current.parentElement;
  }
  
  // Method 2: If still not found, search all comboboxes and match by proximity
  if (!field) {
    const allComboboxes = document.querySelectorAll('[role="combobox"], label[role="combobox"]');
    const labelRect = label.getBoundingClientRect();
    
    for (const cb of allComboboxes) {
      if (cb.offsetParent === null || cb.disabled) continue;
      if (cb === label) continue; // Skip the label itself
      
      const cbRect = cb.getBoundingClientRect();
      // Check if combobox is near the label (within reasonable distance)
      const distance = Math.abs(cbRect.top - labelRect.bottom) + Math.abs(cbRect.left - labelRect.left);
      if (distance < 500) {
        // Verify it's related by checking if they share a common parent with the label text
        const commonParent = cb.closest('div');
        if (commonParent && commonParent.textContent.toLowerCase().includes(labelText.toLowerCase())) {
          field = cb;
          break;
        }
      }
    }
  }
  
  if (!field) {
    console.log(`Field for "${labelText}" not found after searching`);
    return false;
  }
  
  console.log(`Found "${labelText}" field, filling with:`, value);
  field.focus();
  await sleep(300);
  
  // If it's a button or combobox, click to open dropdown
  if (field.tagName === 'BUTTON' || field.getAttribute('role') === 'combobox' || field.getAttribute('role') === 'button') {
    field.click();
    await waitForElement(() => document.querySelector('[role="option"], [role="menuitem"], div[class*="option"]'), { timeout: 3000, interval: 50 });
    
    // Search for the option - try multiple times as dropdown might be animating
    let matchingOption = null;
    for (let attempt = 0; attempt < 5; attempt++) {
      const options = document.querySelectorAll('[role="option"], [role="menuitem"], div[class*="option"], li[role="option"], label[role="option"], span[role="option"]');
      
      matchingOption = Array.from(options).find(opt => {
      const optText = (opt.textContent || '').toLowerCase().trim();
      let valueLower = value.toLowerCase().trim();
      
      // Normalize color values - remove common prefixes/suffixes
      const normalizeColor = (color) => {
        return color
          .replace(/^interior\s*/i, '')
          .replace(/^exterior\s*/i, '')
          .replace(/\s*color\s*$/i, '')
          .trim();
      };
      
      const normalizedValue = normalizeColor(valueLower);
      const normalizedOptText = normalizeColor(optText);
      
      // Try exact match first
      if (optText === valueLower || normalizedOptText === normalizedValue) return true;
      
      // Try partial match
      if (optText.includes(valueLower) || valueLower.includes(optText)) return true;
      if (normalizedOptText.includes(normalizedValue) || normalizedValue.includes(normalizedOptText)) return true;
      
      // For color fields, try word-by-word matching (e.g., "BLACK" matches "Black")
      if (labelText.toLowerCase().includes('color')) {
        const valueWords = normalizedValue.split(/\s+/);
        const optWords = normalizedOptText.split(/\s+/);
        if (valueWords.length > 0 && optWords.length > 0) {
          // Check if all value words are in option words (case-insensitive)
          const allWordsMatch = valueWords.every(vw => 
            optWords.some(ow => ow === vw || ow.includes(vw) || vw.includes(ow))
          );
          if (allWordsMatch) return true;
        }
      }
      
      // Special handling for condition field - map common variations to "Excellent"
      if (labelText.toLowerCase().includes('condition') && valueLower === 'excellent') {
        const excellentVariations = ['excellent', 'excellent condition', 'like new', 'new'];
        if (excellentVariations.some(v => optText.includes(v))) {
          return true;
        }
        // Also try reverse - if option contains "excellent" and we're looking for "excellent"
        if (optText.includes('excellent')) {
          return true;
        }
      }
      
      // Try word-by-word matching for multi-word values
      const valueWords = valueLower.split(/\s+/);
      const optWords = optText.split(/\s+/);
      if (valueWords.every(word => optWords.some(optWord => optWord.includes(word) || word.includes(optWord)))) {
        return true;
      }
      
      // Try matching first word only (e.g., "USED" matches "Used", "AUTOMATIC" matches "Automatic")
      if (valueWords.length > 0 && optWords.length > 0) {
        if (optWords[0].includes(valueWords[0]) || valueWords[0].includes(optWords[0])) {
          return true;
        }
      }
      
      return false;
      });
      
      if (matchingOption) break;
      await sleep(300);
    }
    
    if (matchingOption) {
      console.log(`✓ Clicking "${labelText}" option:`, matchingOption.textContent);
      matchingOption.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await sleep(300);
      matchingOption.click();
      await sleep(500);
      return true;
    } else {
      console.warn(`Option "${value}" not found for "${labelText}". Available options (first 5):`, 
        Array.from(document.querySelectorAll('[role="option"], [role="menuitem"]')).slice(0, 5).map(o => o.textContent.trim()));
    }
  } else if (field.tagName === 'SELECT') {
    const option = Array.from(field.options).find(opt => {
      const optText = opt.text.toLowerCase();
      const valueLower = value.toLowerCase();
      return optText.includes(valueLower) || valueLower.includes(optText);
    });
    if (option) {
      field.value = option.value;
      field.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
      await sleep(200);
      return true;
    }
  } else {
    // Regular input field
    if (field.value !== undefined) {
      field.value = value;
    } else {
      field.textContent = value;
    }
    field.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    field.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    await sleep(200);
    return true;
  }
  
  return false;
}

/**
 * Fill Mileage field
 */
async function fillMileageField() {
  if (!vehicleData.mileage) {
    console.warn('⚠️ Cannot fill mileage: vehicleData.mileage is missing or undefined', {
      vehicleData: vehicleData,
      hasVehicleData: !!vehicleData,
      mileage: vehicleData?.mileage,
      allKeys: vehicleData ? Object.keys(vehicleData) : []
    });
    return false;
  }
  
  // Use the shared findMileageField function
  const field = await findMileageField();
  
  if (!field) {
    console.log('Mileage field not found after searching');
    return false;
  }
  
  console.log('Found Mileage field, type:', field.tagName, 'role:', field.getAttribute('role'), 'tagName:', field.tagName);
  
  const mileageValue = getMileageTarget();
  console.log('Mileage value to fill:', mileageValue, '(field type:', field.tagName + ')');

  // Rare path: a true dropdown/combobox (LABEL/BUTTON), not a text input.
  const isInputElement = field.tagName === 'INPUT';
  const isCombobox = (field.getAttribute('role') === 'combobox' || field.tagName === 'LABEL' ||
                      field.tagName === 'BUTTON' || field.getAttribute('role') === 'button') && !isInputElement;
  if (isCombobox) {
    console.log('Mileage field is a combobox dropdown, selecting option...');
    field.focus();
    await sleep(150);
    field.click();
    await waitForElement(() => document.querySelector('[role="option"], [role="menuitem"]'), { timeout: 2500, interval: 50 });
    const options = document.querySelectorAll('[role="option"], [role="menuitem"], div[class*="option"], li[role="option"], label[role="option"], span[role="option"]');
    const mileageOption = Array.from(options).find(opt => {
      const optText = (opt.textContent || '').trim();
      return optText === mileageValue || normalizeDigits(optText) === mileageValue;
    });
    if (mileageOption) {
      mileageOption.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await sleep(150);
      mileageOption.click();
      await sleep(300);
      console.log('✓ Mileage filled via dropdown');
      return true;
    }
    console.warn('Mileage option not found in dropdown; falling through to input handling');
  }

  // Normal path: a text INPUT. Use the same React-safe setNativeValue mechanism
  // that makes title/price reliable — far faster than char-by-char typing and it
  // survives React re-renders. Read back; if React reverted it, re-find once and retry.
  for (let attempt = 0; attempt < 2; attempt++) {
    const input = (attempt === 0 && isInputElement) ? field : await findMileageField();
    if (!input || (input.tagName !== 'INPUT' && input.tagName !== 'TEXTAREA')) {
      await sleep(150);
      continue;
    }
    input.focus();
    setNativeValue(input, '');
    setNativeValue(input, mileageValue);
    // setNativeValue + an input dispatch is the load-bearing pair that fires React's
    // onChange (same as title/price). Do not collapse to setNativeValue alone.
    input.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    input.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: ' ' }));
    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, cancelable: true, key: ' ' }));
    input.blur();
    await sleep(50);
    input.focus();
    await sleep(150);
    // Read back from a fresh lookup in case the node was replaced by a re-render.
    const check = await findMileageField();
    const got = normalizeDigits(readFieldText(check));
    if (got === mileageValue) {
      console.log(`✓ Mileage filled via setNativeValue (attempt ${attempt + 1}):`, got);
      return true;
    }
    console.warn(`Mileage didn't stick (attempt ${attempt + 1}); want ${mileageValue}, got "${got}". Retrying...`);
    await sleep(150);
  }

  console.warn('Mileage could not be filled after 2 attempts');
  return false;
}

/**
 * Extract city from address string
 */
function extractCityFromAddress(address) {
  if (!address) return null;
  
  // Try to parse address object or string
  try {
    if (address.includes('city')) {
      const match = address.match(/city['":\s]+['"]?([^'",}]+)/i);
      if (match) return match[1].trim();
    }
    
    // Try common patterns
    const parts = address.split(',');
    if (parts.length >= 2) {
      return parts[parts.length - 2].trim();
    }
    
    return address.split(',')[0].trim();
  } catch (error) {
    return null;
  }
}

/**
 * Find location suggestion in dropdown
 */
function findLocationSuggestion(city) {
  const suggestions = document.querySelectorAll('div[role="option"], div[role="menuitem"]');
  for (const suggestion of suggestions) {
    const text = suggestion.textContent?.toLowerCase() || '';
    if (text.includes(city.toLowerCase())) {
      return suggestion;
    }
  }
  return null;
}

/**
 * Fill photos (supports multiple photos per vehicle)
 * Uses multiple upload strategies since Facebook blocks simple programmatic file sets
 */
async function fillPhotos() {
  try {
    // Get photo data from storage
    const photoData = await chrome.storage.local.get(['selectedPhotoData']);
    if (!photoData.selectedPhotoData) {
      console.log('No photo data found in storage');
      return false;
    }

    const { imageUrl, imageUrls, vin } = photoData.selectedPhotoData;
    
    // Build the list of URLs to upload
    const urlsToUpload = imageUrls && imageUrls.length > 0 
      ? imageUrls 
      : (imageUrl ? [imageUrl] : []);
    
    if (urlsToUpload.length === 0) {
      console.log('No image URLs found for photo upload');
      return false;
    }

    // Cap at 20 (Facebook Marketplace maximum)
    const MAX_PHOTOS = 20;
    if (urlsToUpload.length > MAX_PHOTOS) {
      console.log(`Capping photos from ${urlsToUpload.length} to ${MAX_PHOTOS} (Facebook Marketplace limit)`);
      urlsToUpload.length = MAX_PHOTOS;
    }

    console.log(`Attempting to upload ${urlsToUpload.length} photo(s) for VIN: ${vin}`);

    // Download ALL images in parallel via background script (bypasses CORS)
    console.log(`Downloading ${urlsToUpload.length} images via background script...`);
    
    const downloadPromises = urlsToUpload.map(async (url, index) => {
      try {
        const imageResponse = await chrome.runtime.sendMessage({
          action: 'fetchImage',
          data: { imageUrl: url }
        });

        if (!imageResponse || !imageResponse.success) {
          console.warn(`Failed to fetch image ${index + 1}/${urlsToUpload.length}: ${imageResponse?.error || 'No response'}`);
          return null;
        }

        const { dataUrl, mimeType, size } = imageResponse;
        console.log(`Image ${index + 1}/${urlsToUpload.length} fetched: ${size} bytes, ${mimeType}`);

        // Convert data URL to File
        const response = await fetch(dataUrl);
        const blob = await response.blob();
        const fileName = url.split('/').pop()?.split('?')[0] || `vehicle_${vin || 'photo'}_${index}.jpg`;
        return new File([blob], fileName, { type: mimeType || 'image/jpeg' });
      } catch (error) {
        console.warn(`Error fetching image ${index + 1}: ${error.message}`);
        return null;
      }
    });

    const files = (await Promise.all(downloadPromises)).filter(f => f !== null);

    if (files.length === 0) {
      console.error('No images were successfully downloaded');
      return false;
    }

    console.log(`Successfully downloaded ${files.length}/${urlsToUpload.length} images.`);

    // ====================================================================
    // STRATEGY 1: Drag-and-Drop on the photo upload zone
    // ====================================================================
    console.log('Strategy 1: Drag-and-Drop upload...');
    let dropZone = findPhotoDropZone();

    if (dropZone) {
      try {
        const dt = new DataTransfer();
        files.forEach(file => dt.items.add(file));
        
        dropZone.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
        await sleep(100);
        dropZone.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
        await sleep(100);
        dropZone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
        
        console.log('Drag-and-drop events dispatched, waiting...');
        await waitForCondition(() => detectUploadedPhotos(), { timeout: 1500, interval: 100 });
        
        if (detectUploadedPhotos()) {
          console.log('✓ Strategy 1 (Drag-and-Drop) succeeded!');
          return true;
        }
        console.log('Strategy 1: no visible results, trying next...');
      } catch (e) {
        console.warn('Strategy 1 error:', e.message);
      }
    } else {
      console.log('No drop zone found, skipping Strategy 1');
    }

    // ====================================================================
    // STRATEGY 2: React fiber onChange invocation
    // ====================================================================
    console.log('Strategy 2: React fiber onChange...');
    let fileInput = findFileInput();
    
    if (fileInput) {
      try {
        const dt = new DataTransfer();
        files.forEach(file => dt.items.add(file));
        fileInput.files = dt.files;
        
        const propsKey = Object.keys(fileInput).find(k => k.startsWith('__reactProps'));
        const fiberKey = Object.keys(fileInput).find(k => 
          k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance')
        );
        
        let called = false;
        
        if (propsKey) {
          const props = fileInput[propsKey];
          if (props && props.onChange) {
            console.log('Calling React onChange via __reactProps...');
            props.onChange({ target: fileInput, currentTarget: fileInput, type: 'change' });
            called = true;
          }
        }
        
        if (!called && fiberKey) {
          let fiber = fileInput[fiberKey];
          let depth = 0;
          while (fiber && depth < 20) {
            const props = fiber.memoizedProps || fiber.pendingProps;
            if (props && props.onChange) {
              console.log(`Calling React onChange at fiber depth ${depth}...`);
              props.onChange({ target: fileInput, currentTarget: fileInput, type: 'change' });
              called = true;
              break;
            }
            fiber = fiber.return;
            depth++;
          }
        }
        
        if (called) {
          await waitForCondition(() => detectUploadedPhotos(), { timeout: 2500, interval: 100 });
          if (detectUploadedPhotos()) {
            console.log('✓ Strategy 2 (React fiber) succeeded!');
            return true;
          }
        }
        
        fileInput.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
        await waitForCondition(() => detectUploadedPhotos(), { timeout: 2500, interval: 100 });
        if (detectUploadedPhotos()) {
          console.log('✓ Strategy 2 (change event) succeeded!');
          return true;
        }
        console.log('Strategy 2: no visible results, trying next...');
      } catch (e) {
        console.warn('Strategy 2 error:', e.message);
      }
    }

    // ====================================================================
    // STRATEGY 3: Clipboard paste on the upload area
    // ====================================================================
    console.log('Strategy 3: Clipboard paste...');
    const pasteTarget = dropZone || fileInput?.closest('div') || document.querySelector('[role="main"]');
    
    if (pasteTarget) {
      try {
        const dt = new DataTransfer();
        files.forEach(file => dt.items.add(file));
        
        const pasteEvent = new ClipboardEvent('paste', {
          bubbles: true,
          cancelable: true,
          clipboardData: dt
        });
        pasteTarget.dispatchEvent(pasteEvent);
        
        console.log('Paste event dispatched, waiting...');
        await waitForCondition(() => detectUploadedPhotos(), { timeout: 3000, interval: 100 });
        
        if (detectUploadedPhotos()) {
          console.log('✓ Strategy 3 (Clipboard paste) succeeded!');
          return true;
        }
        console.log('Strategy 3: no visible results, trying next...');
      } catch (e) {
        console.warn('Strategy 3 error:', e.message);
      }
    }

    // ====================================================================
    // STRATEGY 4: Override files property + comprehensive events
    // ====================================================================
    console.log('Strategy 4: Property override + events...');
    if (!fileInput) fileInput = findFileInput();
    
    if (fileInput) {
      try {
        const dt = new DataTransfer();
        files.forEach(file => dt.items.add(file));
        
        const origDescriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'files');
        Object.defineProperty(fileInput, 'files', {
          get: () => dt.files,
          configurable: true
        });
        
        fileInput.dispatchEvent(new Event('change', { bubbles: true }));
        fileInput.dispatchEvent(new Event('input', { bubbles: true }));

        await waitForCondition(() => detectUploadedPhotos(), { timeout: 2000, interval: 100 });

        if (origDescriptor) {
          Object.defineProperty(fileInput, 'files', origDescriptor);
        } else {
          delete fileInput.files;
        }
        
        if (detectUploadedPhotos()) {
          console.log('✓ Strategy 4 (property override) succeeded!');
          return true;
        }
        console.log('Strategy 4: no visible results.');
      } catch (e) {
        console.warn('Strategy 4 error:', e.message);
      }
    }

    console.warn('⚠ All photo upload strategies attempted. Photos may need manual upload.');
    console.log('TIP: Open DevTools Console and run this to download photos for manual upload:');
    files.forEach((f, i) => {
      const blobUrl = URL.createObjectURL(f);
      console.log(`  Photo ${i + 1}: ${f.name} (${f.size} bytes) — ${blobUrl}`);
    });
    
    return false;

  } catch (error) {
    console.error('Error uploading photos:', error);
    return false;
  }
}

/**
 * Find the photo upload drop zone on Facebook Marketplace
 */
function findPhotoDropZone() {
  const dropZoneSelectors = [
    'div[aria-label*="photo" i]',
    'div[aria-label*="Photo" i]',
    'div[aria-label*="Add photo" i]',
    'div[aria-label*="Add Photo" i]',
    'div[aria-label*="Upload" i]',
    'div[aria-label*="Drag" i]',
    'div[role="button"][aria-label*="photo" i]',
    'div[role="button"][aria-label*="Photo" i]',
  ];
  
  for (const selector of dropZoneSelectors) {
    const el = document.querySelector(selector);
    if (el && el.offsetParent !== null) return el;
  }
  
  const allDivs = document.querySelectorAll('div[role="button"], div[tabindex]');
  for (const div of allDivs) {
    const text = (div.textContent || '').toLowerCase();
    if ((text.includes('add photo') || text.includes('drag') || text.includes('upload photo')) && 
        div.offsetParent !== null) {
      return div;
    }
  }
  
  return null;
}

/**
 * Find the file input element for photo uploads
 */
function findFileInput() {
  const selectors = [
    'input[type="file"][accept*="image"]',
    'input[type="file"][accept*="video"]',
    'input[type="file"][multiple]',
    'input[type="file"]'
  ];
  
  for (const selector of selectors) {
    const el = document.querySelector(selector);
    if (el) return el;
  }
  
  return null;
}

/**
 * Detect if photos were successfully uploaded
 */
function detectUploadedPhotos() {
  const indicators = [
    'img[src*="blob:"]',
    'img[src*="scontent"]',
    'div[aria-label*="photo" i] img',
    'div[aria-label*="Photo" i] img',
    '[data-testid*="photo"] img',
    'div[aria-label*="Edit"] img',
    'div[aria-label*="edit"] img',
    'div[aria-label*="uploaded" i]',
    'div[aria-label*="Added" i]',
  ];
  
  const formArea = document.querySelector('[role="main"]') || document.body;
  // Facebook's chrome is full of small scontent images (avatars, icons); only a
  // thumbnail-sized image counts as an attached listing photo.
  const isPhotoSized = (el) => el.tagName !== 'IMG' || (el.clientWidth || el.naturalWidth || 0) >= 80;

  for (const selector of indicators) {
    try {
      const found = document.querySelectorAll(selector);
      const inForm = Array.from(found).filter(el => formArea.contains(el) && isPhotoSized(el));
      if (inForm.length > 0) {
        console.log(`detectUploadedPhotos: Found ${inForm.length} via "${selector}"`);
        return true;
      }
    } catch (e) {
      continue;
    }
  }
  
  return false;
}

/**
 * Smart wait utilities - Optimized for speed and accuracy
 */

/**
 * Wait for an element to appear in the DOM with efficient polling
 * @param {Function} finder - Function that returns the element when found
 * @param {Object} options - { timeout: ms, interval: ms, immediate: boolean }
 * @returns {Promise<Element|null>}
 */
function waitForElement(finder, options = {}) {
  const { timeout = 10000, interval = 50, immediate = false } = options;
  
  return new Promise((resolve) => {
    // Check immediately first
    if (immediate) {
      const element = finder();
      if (element) {
        resolve(element);
        return;
      }
    }
    
    const startTime = Date.now();
    let lastCheck = 0;
    
    // Use requestAnimationFrame for smooth, efficient checking
    function check() {
      const now = Date.now();
      
      // Throttle checks to interval (but use RAF for smoothness)
      if (now - lastCheck >= interval) {
        const element = finder();
        if (element) {
          resolve(element);
          return;
        }
        lastCheck = now;
      }
      
      if (now - startTime < timeout) {
        requestAnimationFrame(check);
      } else {
        resolve(null);
      }
    }
    
    requestAnimationFrame(check);
  });
}

/**
 * Wait for a condition to become true with efficient polling
 * @param {Function} condition - Function that returns true when condition is met
 * @param {Object} options - { timeout: ms, interval: ms }
 * @returns {Promise<boolean>}
 */
function waitForCondition(condition, options = {}) {
  const { timeout = 10000, interval = 50 } = options;
  
  return new Promise((resolve) => {
    const startTime = Date.now();
    let lastCheck = 0;
    
    function check() {
      const now = Date.now();
      
      if (now - lastCheck >= interval) {
        if (condition()) {
          resolve(true);
          return;
        }
        lastCheck = now;
      }
      
      if (now - startTime < timeout) {
        requestAnimationFrame(check);
      } else {
        resolve(false);
      }
    }
    
    requestAnimationFrame(check);
  });
}

/**
 * Wait for DOM changes using MutationObserver (faster than polling)
 * @param {Function} condition - Function that returns true when condition is met
 * @param {Object} options - { timeout: ms, subtree: boolean, childList: boolean }
 * @returns {Promise<boolean>}
 */
function waitForDOMChange(condition, options = {}) {
  const { timeout = 10000, subtree = true, childList = true, attributes = false } = options;
  
  return new Promise((resolve) => {
    // Check immediately first
    if (condition()) {
      resolve(true);
      return;
    }
    
    const startTime = Date.now();
    let timeoutId;
    
    const observer = new MutationObserver(() => {
      if (condition()) {
        observer.disconnect();
        if (timeoutId) clearTimeout(timeoutId);
        resolve(true);
      } else if (Date.now() - startTime >= timeout) {
        observer.disconnect();
        if (timeoutId) clearTimeout(timeoutId);
        resolve(false);
      }
    });
    
    observer.observe(document.body, { subtree, childList, attributes });
    
    // Fallback timeout
    timeoutId = setTimeout(() => {
      observer.disconnect();
      resolve(false);
    }, timeout);
  });
}

/**
 * Smart sleep - only waits if element/condition not ready
 * @param {number} ms - Maximum delay in ms
 * @param {Function} earlyExit - Optional function that returns true to exit early
 * @returns {Promise<void>}
 */
async function smartSleep(ms, earlyExit = null) {
  if (earlyExit && earlyExit()) {
    return;
  }
  
  const startTime = Date.now();
  const checkInterval = Math.min(50, ms / 10); // Check every 50ms or 10% of total time
  
  return new Promise((resolve) => {
    function check() {
      const elapsed = Date.now() - startTime;
      
      if (earlyExit && earlyExit()) {
        resolve();
        return;
      }
      
      if (elapsed >= ms) {
        resolve();
      } else {
        setTimeout(check, Math.min(checkInterval, ms - elapsed));
      }
    }
    
    check();
  });
}

/**
 * Utility: Sleep/delay (kept for backward compatibility, but prefer smartSleep)
 */
function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

})(); // End IIFE

