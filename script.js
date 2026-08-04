// ==UserScript==
// @name         Torn - Auto Medical Item Healer & Attack Redirect
// @namespace    http://tampermonkey.net/
// @version      2.3
// @description  Automates medical item healing, auto Xanax (default ON), max runs (default 13), item counts, and forces page reloads.
// @author       arhi [4392583]
// @match        https://www.torn.com/*
// @match        https://www.torn.com/item.php*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_setClipboard
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  // --- Configuration & Persistent State ---
  const CONFIG = {
    CHECK_INTERVAL_MS: 500,   // Check status every 0.1 second
    REDIRECT_DELAY_MS: 0,    // 0s delay after sending heal request
    THRESHOLD_SECONDS: 1203,   // 20 minutes and 3 seconds
    MAX_HOSPITAL_SECONDS: 3600 // 1 hour
  };

  let state = {
    active: GM_getValue('autoHeal_active', false),
    useXanax: GM_getValue('autoHeal_useXanax', true),       // Default: ON
    targetCount: GM_getValue('autoHeal_targetCount', 13),   // Default: 13 runs
    completedCount: GM_getValue('autoHeal_completedCount', 0),
    wasInHospital: GM_getValue('autoHeal_wasInHospital', false),
    isProcessing: false,
    posX: GM_getValue('autoHeal_posX', null),
    posY: GM_getValue('autoHeal_posY', null)
  };

  // Helper: Check if current page is an attack loader page
  function isCurrentlyOnAttackPage() {
    return window.location.href.includes('sid=attack') || window.location.href.includes('loader.php?sid=attack');
  }

  // Helper: Force reload attack loader screen
  function forceAttackPageRefresh() {
    // 1. Try finding and clicking Torn's native refresh/again button on attack loader
    const attackAgainBtn = document.querySelector('a[href*="sid=attack"], button[class*="attack"], [data-action="reload"], .title-black___x_34s button');
    if (attackAgainBtn && typeof attackAgainBtn.click === 'function') {
      console.log('🚀 Triggering Torn native UI attack refresh button...');
      attackAgainBtn.click();
      return;
    }

    // 2. Cache-busting hard reload (Appends timestamp to URL to force React re-render)
    const currentUrl = new URL(window.location.href);
    currentUrl.searchParams.set('_t', Date.now()); // Add unique timestamp parameter
    console.log(`🚀 Performing hard cache-busting redirect to: ${currentUrl.toString()}`);
    window.location.href = currentUrl.toString();
  }

  // Helper: Extract cookie values
  const getCookie = (name) =>
    document.cookie.split('; ').find(row => row.startsWith(`${name}=`))?.split('=')[1];

  // Helper: Extract player's own ID from cookies or DOM
  function getMyPlayerId() {
    const uidCookie = getCookie('uid') || getCookie('user');
    if (uidCookie && /^\d+$/.test(uidCookie)) return uidCookie;

    const userProfileLink = document.querySelector('a[href*="profiles.php?XID="]');
    if (userProfileLink) {
      const match = userProfileLink.href.match(/XID=(\d+)/);
      if (match) return match[1];
    }
    return 'Unknown';
  }

  // Helper: Get energy value from topbar UI
  function getCurrentEnergy() {
    const energyElem = document.querySelector('#user-bar #energyval') || 
                       document.querySelector('[class*="energy"] [class*="value"]') ||
                       document.querySelector('#barEnergy .val');
    if (energyElem) {
      const match = energyElem.textContent.match(/\d+/);
      return match ? parseInt(match[0], 10) : null;
    }
    return null;
  }

  // Helper: Fast fetch wrapper for item requests
  async function useItemRequest(itemId, rfcToken) {
    const body = new URLSearchParams();
    body.set('step', 'useItem');
    body.set('id', itemId);
    body.set('itemID', itemId);

    const response = await fetch(`/item.php?rfcv=${rfcToken}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
        'X-Requested-With': 'XMLHttpRequest'
      },
      body: body
    });

    return await response.json();
  }

  // Helper: Fetch Inventory item amounts
  async function fetchItemCounts() {
    let smallAid = 0, firstAid = 0, xanax = 0;
    let found = false;

    try {
      const rfcToken = getCookie('rfc_v') || getCookie('rfc_id');
      const response = await fetch(`/item.php?rfcv=${rfcToken}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
          'X-Requested-With': 'XMLHttpRequest'
        },
        body: new URLSearchParams({ step: 'getInventoryData' })
      });
      const data = await response.json();
      
      const items = data?.inventory || data?.items || data;
      if (items && typeof items === 'object') {
        Object.values(items).forEach(item => {
          const id = parseInt(item.ID || item.itemID || item.id, 10);
          const qty = parseInt(item.qty || item.quantity || item.amount || 1, 10);
          if (id === 67) smallAid += qty;
          if (id === 68) firstAid += qty;
          if (id === 206) xanax += qty;
        });
        found = true;
      }
    } catch (e) {
      // Fall through to DOM scan
    }

    if (!found) {
      document.querySelectorAll('[data-item], .item-hoolder, [class*="item_"]').forEach(el => {
        const text = el.textContent || '';
        if (text.includes('Small First Aid Kit')) smallAid++;
        if (text.includes('First Aid Kit') && !text.includes('Small')) firstAid++;
        if (text.includes('Xanax')) xanax++;
      });
    }

    updateDashboardCounts(smallAid, firstAid, xanax);
  }

  function updateDashboardCounts(smallAid, firstAid, xanax) {
    const sElem = document.getElementById('auto-heal-small-aid');
    const fElem = document.getElementById('auto-heal-first-aid');
    const xElem = document.getElementById('auto-heal-xanax-count');

    if (sElem) sElem.innerText = smallAid;
    if (fElem) fElem.innerText = firstAid;
    if (xElem) xElem.innerText = xanax;
  }

  // --- Core Logic ---
  async function checkAndHeal() {
    if (!state.active || state.isProcessing) return;

    // Check target runs limit
    if (state.completedCount >= state.targetCount) {
      console.log('🏁 Auto-Healer: Target hospital count reached. Turning OFF.');
      toggleActive(false);
      updateUI();
      return;
    }

    // 1. Locate Hospital Status Link
    const hospLink = document.querySelector('a[aria-label^="Hospital:"]') ||
                     document.querySelector('a[aria-label*="Hospital"]') ||
                     document.querySelector('a[href*="hospital"]');

    if (!hospLink) {
      updateStatus('Monitoring... (Not in Hospital)');
      return;
    }

    if (!state.wasInHospital) {
      state.wasInHospital = true;
      GM_setValue('autoHeal_wasInHospital', true);
    }

    const rfcToken = getCookie('rfc_v') || getCookie('rfc_id');
    if (!rfcToken) {
      updateStatus('Error: Missing RFC Token');
      return;
    }

    // 2. Time Extraction
    let statusContainer = hospLink;
    for (let i = 0; i < 4; i++) {
      if (statusContainer.parentElement) statusContainer = statusContainer.parentElement;
    }

    const ariaLabel = hospLink.getAttribute('aria-label') || '';
    const searchSubject = `${ariaLabel} ${statusContainer ? statusContainer.textContent : ''}`;
    const timerMatch = searchSubject.match(/(\d{1,2}):(\d{2}):(\d{2})/) || searchSubject.match(/(\d{1,2}):(\d{2})/);

    if (!timerMatch) {
      updateStatus('Hospital detected (parsing timer...)');
      return;
    }

    let hospitalSeconds = 0;
    if (timerMatch.length === 4) {
      hospitalSeconds = (parseInt(timerMatch[1], 10) * 3600) + (parseInt(timerMatch[2], 10) * 60) + parseInt(timerMatch[3], 10);
    } else if (timerMatch.length === 3) {
      hospitalSeconds = (parseInt(timerMatch[1], 10) * 60) + parseInt(timerMatch[2], 10);
    }

    if (hospitalSeconds > CONFIG.MAX_HOSPITAL_SECONDS) {
      updateStatus('Hospital time > 1hr (Skipping actions)');
      return;
    }

    state.isProcessing = true;

    // 3. Auto-Xanax Check
    const currentEnergy = getCurrentEnergy();
    if (state.useXanax && currentEnergy === 0) {
      updateStatus('Energy is 0! Taking Xanax...');
      try {
        const xanaxData = await useItemRequest('206', rfcToken);
        if (xanaxData.success) {
          console.log('✅ Auto-Healer: Used Xanax.');
          updateStatus('Used Xanax successfully!');
          fetchItemCounts();
          setTimeout(() => { state.isProcessing = false; }, 500);
        } else {
          updateStatus(`Xanax Failed: ${xanaxData.text || 'Server error'}`);
          setTimeout(() => { state.isProcessing = false; }, 1500);
        }
      } catch (err) {
        console.error('❌ Xanax Error:', err);
        updateStatus('Xanax Request Failed');
        setTimeout(() => { state.isProcessing = false; }, 1500);
      }
      return;
    }

    // 4. Select Medical Item
    const itemId = (hospitalSeconds <= CONFIG.THRESHOLD_SECONDS) ? "67" : "68";
    const itemName = itemId === "67" ? "Small First Aid Kit (67)" : "First Aid Kit (68)";

    updateStatus(`Healing with ${itemName}...`);

    // 5. Send POST Request & Refresh
    try {
      const data = await useItemRequest(itemId, rfcToken);

      if (data.success) {
        state.completedCount += 1;
        GM_setValue('autoHeal_completedCount', state.completedCount);
        console.log(`✅ Auto-Healer: Used ${itemName}. Total runs: ${state.completedCount}/${state.targetCount}`);
        fetchItemCounts();

        // ONLY refresh if currently on an attack page
        if (isCurrentlyOnAttackPage()) {
          updateStatus(`Healed! Triggering refresh in 0.3s...`);
          setTimeout(() => {
            forceAttackPageRefresh();
          }, CONFIG.REDIRECT_DELAY_MS);
        } else {
          updateStatus(`Healed! (${state.completedCount}/${state.targetCount}) - Not on attack loader`);
          setTimeout(() => { state.isProcessing = false; }, 500);
        }
      } else {
        updateStatus(`Failed: ${data.text || 'Server error'}`);
        setTimeout(() => { state.isProcessing = false; }, 1500);
      }
    } catch (err) {
      console.error('❌ Auto-Healer Error:', err);
      updateStatus('Request Failed');
      setTimeout(() => { state.isProcessing = false; }, 1500);
    }
  }

  // --- State Controllers ---
  function toggleActive(val) {
    state.active = val;
    GM_setValue('autoHeal_active', val);
    if (val && state.completedCount >= state.targetCount) {
      state.completedCount = 0;
      GM_setValue('autoHeal_completedCount', 0);
    }
    updateUI();
  }

  function toggleXanax(val) {
    state.useXanax = val;
    GM_setValue('autoHeal_useXanax', val);
    updateUI();
  }

  function setTargetCount(val) {
    const num = Math.max(1, parseInt(val, 10) || 1);
    state.targetCount = num;
    GM_setValue('autoHeal_targetCount', num);
    updateUI();
  }

  // --- Inject UI Controls ---
  function createUI() {
    if (document.getElementById('auto-heal-widget')) return;

    const myId = getMyPlayerId();
    const widget = document.createElement('div');
    widget.id = 'auto-heal-widget';

    const positionStyles = (state.posX !== null && state.posY !== null)
      ? `top: ${state.posY}px; left: ${state.posX}px;`
      : `bottom: 20px; right: 20px;`;

    widget.style.cssText = `
      position: fixed;
      ${positionStyles}
      z-index: 999999;
      background: #222;
      color: #fff;
      border: 1px solid #444;
      border-radius: 8px;
      padding: 12px 16px;
      font-family: Arial, sans-serif;
      font-size: 13px;
      box-shadow: 0 4px 12px rgba(0,0,0,0.5);
      width: 235px;
      user-select: none;
    `;

    widget.innerHTML = `
      <div id="auto-heal-header" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; border-bottom: 1px solid #333; padding-bottom: 6px; cursor: move;">
        <strong style="color: #4caf50;">arhi's Auto Healer</strong>
        <span id="auto-heal-status-indicator" style="font-size: 10px; padding: 2px 6px; border-radius: 4px; background: #555;">OFF</span>
      </div>

      <div style="margin-bottom: 8px; display: flex; align-items: center; justify-content: space-between;">
        <label style="font-size: 12px; color: #ccc;">Your ID:</label>
        <div style="display: flex; gap: 4px;">
          <input type="text" id="auto-heal-my-id" readonly value="${myId}"
                 style="width: 75px; background: #111; color: #4caf50; font-weight: bold; border: 1px solid #555; border-radius: 4px; text-align: center; padding: 2px; cursor: text;">
          <button id="auto-heal-copy-id-btn" style="background: #333; color: #fff; border: 1px solid #555; border-radius: 4px; padding: 2px 6px; font-size: 11px; cursor: pointer;">Copy</button>
        </div>
      </div>

      <div style="background: #181818; border: 1px solid #333; border-radius: 6px; padding: 6px 8px; margin-bottom: 8px; font-size: 11px;">
        <div style="display: flex; justify-content: space-between; margin-bottom: 3px;">
          <span>Small First Aid:</span>
          <strong id="auto-heal-small-aid" style="color: #ff9800;">0</strong>
        </div>
        <div style="display: flex; justify-content: space-between; margin-bottom: 3px;">
          <span>First Aid Kit:</span>
          <strong id="auto-heal-first-aid" style="color: #2196f3;">0</strong>
        </div>
        <div style="display: flex; justify-content: space-between;">
          <span>Xanax:</span>
          <strong id="auto-heal-xanax-count" style="color: #e91e63;">0</strong>
        </div>
      </div>

      <div style="margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center;">
        <label for="auto-heal-target">Max Runs:</label>
        <input type="number" id="auto-heal-target" min="1" max="999" value="${state.targetCount}"
               style="width: 55px; background: #333; color: #fff; border: 1px solid #555; border-radius: 4px; text-align: center; padding: 2px;">
      </div>

      <div style="margin-bottom: 8px; display: flex; align-items: center; gap: 6px;">
        <input type="checkbox" id="auto-heal-xanax" ${state.useXanax ? 'checked' : ''} style="cursor: pointer;">
        <label for="auto-heal-xanax" style="cursor: pointer; font-size: 12px;">Auto Xanax on 0 Energy</label>
      </div>

      <div style="margin-bottom: 10px; font-size: 11px; color: #aaa;" id="auto-heal-progress">
        Progress: ${state.completedCount} / ${state.targetCount} times
      </div>

      <div style="margin-bottom: 8px;" id="auto-heal-message">
        Status: Idle
      </div>

      <button id="auto-heal-toggle-btn" style="
        width: 100%;
        padding: 6px;
        border: none;
        border-radius: 4px;
        font-weight: bold;
        cursor: pointer;
        background: #4caf50;
        color: #fff;
      ">TURN ON</button>
    `;

    document.body.appendChild(widget);

    makeWidgetDraggable(widget, document.getElementById('auto-heal-header'));

    document.getElementById('auto-heal-toggle-btn').addEventListener('click', () => {
      toggleActive(!state.active);
    });

    document.getElementById('auto-heal-xanax').addEventListener('change', (e) => {
      toggleXanax(e.target.checked);
    });

    document.getElementById('auto-heal-target').addEventListener('change', (e) => {
      setTargetCount(e.target.value);
    });

    const copyBtn = document.getElementById('auto-heal-copy-id-btn');
    const idInput = document.getElementById('auto-heal-my-id');
    copyBtn.addEventListener('click', () => {
      idInput.select();
      navigator.clipboard.writeText(idInput.value).then(() => {
        copyBtn.innerText = 'Copied!';
        copyBtn.style.background = '#4caf50';
        setTimeout(() => {
          copyBtn.innerText = 'Copy';
          copyBtn.style.background = '#333';
        }, 1200);
      });
    });

    updateUI();
    fetchItemCounts();
  }

  // --- Drag and Drop Functionality ---
  function makeWidgetDraggable(elmnt, dragHandle) {
    let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;

    dragHandle.onmousedown = dragMouseDown;

    function dragMouseDown(e) {
      e.preventDefault();
      pos3 = e.clientX;
      pos4 = e.clientY;

      document.onmouseup = closeDragElement;
      document.onmousemove = elementDrag;
    }

    function elementDrag(e) {
      e.preventDefault();
      pos1 = pos3 - e.clientX;
      pos2 = pos4 - e.clientY;
      pos3 = e.clientX;
      pos4 = e.clientY;

      const newTop = elmnt.offsetTop - pos2;
      const newLeft = elmnt.offsetLeft - pos1;

      elmnt.style.bottom = 'auto';
      elmnt.style.right = 'auto';
      elmnt.style.top = newTop + "px";
      elmnt.style.left = newLeft + "px";
    }

    function closeDragElement() {
      document.onmouseup = null;
      document.onmousemove = null;

      GM_setValue('autoHeal_posX', elmnt.offsetLeft);
      GM_setValue('autoHeal_posY', elmnt.offsetTop);
    }
  }

  function updateUI() {
    const btn = document.getElementById('auto-heal-toggle-btn');
    const indicator = document.getElementById('auto-heal-status-indicator');
    const progress = document.getElementById('auto-heal-progress');

    if (!btn) return;

    if (state.active) {
      btn.innerText = 'TURN OFF';
      btn.style.background = '#f44336';
      indicator.innerText = 'RUNNING';
      indicator.style.background = '#4caf50';
    } else {
      btn.innerText = 'TURN ON';
      btn.style.background = '#4caf50';
      indicator.innerText = 'OFF';
      indicator.style.background = '#555';
    }

    if (progress) {
      progress.innerText = `Progress: ${state.completedCount} / ${state.targetCount} times`;
    }
  }

  function updateStatus(text) {
    const msg = document.getElementById('auto-heal-message');
    if (msg) msg.innerText = `Status: ${text}`;
  }

  // --- Initialization ---
  function init() {
    createUI();
    setInterval(checkAndHeal, CONFIG.CHECK_INTERVAL_MS);
  }

  if (document.body) {
    init();
  } else {
    window.addEventListener('DOMContentLoaded', init);
  }
})();
