// ==UserScript==
// @name         Torn - Auto Medical Item Healer
// @namespace    http://tampermonkey.net/
// @version      4.9
// @description  Automated hospital healer using Torn API v2 with precise DOM parsing and double-fire prevention.
// @author       arhi [4392583]
// @match        https://www.torn.com/item.php*
// @noframes
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  // Prevent double-firing across embedded iframe contexts
  if (window.top !== window.self) return;

  // Prevent double-firing within the same window context
  if (window.__AUTO_HEALER_INITIALIZED__) return;
  window.__AUTO_HEALER_INITIALIZED__ = true;

  if (!window.location.pathname.endsWith('/item.php')) return;

  const CONFIG = {
    DOM_CHECK_INTERVAL_MS: 400,
    API_CHECK_INTERVAL_MS: 5000,
    POST_HEAL_WAIT_MS: 1500, // Mandatory pause between heals to allow Torn server sync
    THRESHOLD_SECONDS: 1200, // 20 minutes: >20m uses First Aid Kit (67), <=20m uses Small Aid (68)
    MAX_HOSPITAL_SECONDS: 3600
  };

  let state = {
    active: GM_getValue('autoHeal_active', false),
    useXanax: GM_getValue('autoHeal_useXanax', true),
    targetCount: GM_getValue('autoHeal_targetCount', 13),
    apiKey: GM_getValue('autoHeal_apiKey', ''),
    completedCount: GM_getValue('autoHeal_completedCount', 0),
    isProcessing: false,
    posX: GM_getValue('autoHeal_posX', null),
    posY: GM_getValue('autoHeal_posY', null)
  };

  let inventoryCache = { 
    lastFetch: 0, 
    smallAid: GM_getValue('autoHeal_smallAid', 0), 
    firstAid: GM_getValue('autoHeal_firstAid', 0), 
    xanax: GM_getValue('autoHeal_xanax', 0) 
  };

  const getCookie = (name) =>
    document.cookie.split('; ').find(row => row.startsWith(`${name}=`))?.split('=')[1];

  function getMyPlayerId() {
    const uid = getCookie('uid') || getCookie('user');
    if (uid && /^\d+$/.test(uid)) return uid;
    const link = document.querySelector('a[href*="profiles.php?XID="]');
    return link ? link.href.match(/XID=(\d+)/)?.[1] || 'Unknown' : 'Unknown';
  }

  function getCurrentEnergy() {
    const elem = document.querySelector('#user-bar #energyval') || 
                 document.querySelector('[class*="energy"] [class*="value"]') ||
                 document.querySelector('#barEnergy .val');
    return elem ? parseInt(elem.textContent.match(/\d+/)?.[0] || 0, 10) : null;
  }

  function parseHospitalSeconds(text) {
    if (!text) return 0;

    // Match "1h 25m 10s", "0h 26m", "15m 30s", "26m"
    const textMatch = text.match(/(?:(\d+)h\s*)?(?:(\d+)m\s*)?(?:(\d+)s)?/i);
    if (textMatch && (textMatch[1] || textMatch[2] || textMatch[3])) {
      const h = parseInt(textMatch[1] || 0, 10);
      const m = parseInt(textMatch[2] || 0, 10);
      const s = parseInt(textMatch[3] || 0, 10);
      if (h > 0 || m > 0 || s > 0) return (h * 3600) + (m * 60) + s;
    }

    // Match "01:25:10" or "25:10"
    const clockMatch = text.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
    if (clockMatch) {
      if (clockMatch[3] !== undefined) {
        return (parseInt(clockMatch[1], 10) * 3600) + (parseInt(clockMatch[2], 10) * 60) + parseInt(clockMatch[3], 10);
      }
      return (parseInt(clockMatch[1], 10) * 60) + parseInt(clockMatch[2], 10);
    }

    return 0;
  }

  async function useItemRequest(itemId, rfcToken) {
    const body = new URLSearchParams({ step: 'useItem', id: itemId, itemID: itemId });
    const res = await fetch(`/item.php?rfcv=${rfcToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8', 'X-Requested-With': 'XMLHttpRequest' },
      body
    });
    return res.json();
  }

  function fetchApiGM(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        onload: (res) => {
          try { resolve(JSON.parse(res.responseText)); } 
          catch (e) { reject(e); }
        },
        onerror: reject
      });
    });
  }

  async function fetchItemCounts(forceRefresh = false) {
    const now = Date.now();
    if (!forceRefresh && (now - inventoryCache.lastFetch < CONFIG.API_CHECK_INTERVAL_MS)) return;
    if (!state.apiKey) return;

    try {
      const [medData, drugData] = await Promise.all([
        fetchApiGM(`https://api.torn.com/v2/user/inventory?cat=Medical&key=${state.apiKey}`),
        fetchApiGM(`https://api.torn.com/v2/user/inventory?cat=Drug&key=${state.apiKey}`)
      ]);

      if (medData.error || drugData.error) {
        const err = medData.error || drugData.error;
        updateStatus(`API Error: ${err.error || err.code}`);
        return;
      }

      let smallAid = 0, firstAid = 0, xanax = 0;
      const medItems = medData?.inventory?.items || [];
      const drugItems = drugData?.inventory?.items || [];

      medItems.forEach(item => {
        const id = parseInt(item.id, 10);
        const qty = parseInt(item.amount || 0, 10);
        if (id === 68) smallAid += qty;       // Small First Aid Kit
        else if (id === 67) firstAid += qty;  // First Aid Kit
      });

      drugItems.forEach(item => {
        const id = parseInt(item.id, 10);
        const qty = parseInt(item.amount || 0, 10);
        if (id === 206) xanax += qty;          // Xanax
      });

      inventoryCache = { lastFetch: now, smallAid, firstAid, xanax };

      GM_setValue('autoHeal_smallAid', smallAid);
      GM_setValue('autoHeal_firstAid', firstAid);
      GM_setValue('autoHeal_xanax', xanax);

      updateDashboardCounts(smallAid, firstAid, xanax);
    } catch (err) {
      updateStatus('API Fetch Failed');
    }
  }

  function updateDashboardCounts(smallAid, firstAid, xanax) {
    const sElem = document.getElementById('auto-heal-small-aid');
    const fElem = document.getElementById('auto-heal-first-aid');
    const xElem = document.getElementById('auto-heal-xanax-count');
    if (sElem) sElem.innerText = smallAid;
    if (fElem) fElem.innerText = firstAid;
    if (xElem) xElem.innerText = xanax;
  }

  async function checkAndHeal() {
    if (!state.active || state.isProcessing) return;

    if (state.completedCount >= state.targetCount) {
      toggleActive(false);
      return;
    }

    const hospLink = document.querySelector('a[aria-label*="Hospital"]');
    if (!hospLink) {
      updateStatus('Not in Hospital');
      return;
    }

    const ariaLabel = hospLink.getAttribute('aria-label') || '';
    const parentText = hospLink.parentElement ? hospLink.parentElement.textContent : '';
    const hospitalSeconds = parseHospitalSeconds(ariaLabel) || parseHospitalSeconds(parentText);

    if (hospitalSeconds <= 0) {
      updateStatus('Not in Hospital');
      return;
    }

    if (hospitalSeconds > CONFIG.MAX_HOSPITAL_SECONDS) {
      updateStatus('Hospital > 1hr (Skipped)');
      return;
    }

    const rfcToken = getCookie('rfc_v') || getCookie('rfc_id');
    if (!rfcToken) {
      updateStatus('Error: Missing RFC Token');
      return;
    }

    state.isProcessing = true;

    if (state.useXanax && getCurrentEnergy() === 0) {
      updateStatus('Taking Xanax...');
      try {
        const res = await useItemRequest('206', rfcToken);
        if (res.success) {
          updateStatus('Used Xanax!');
          fetchItemCounts(true);
        } else {
          updateStatus(`Xanax Failed: ${res.text || 'Error'}`);
        }
      } catch (err) {
        updateStatus('Xanax Request Failed');
      }
      setTimeout(() => { state.isProcessing = false; }, CONFIG.POST_HEAL_WAIT_MS);
      return;
    }

    // Determine correct item based on parsed time
    const itemId = (hospitalSeconds > CONFIG.THRESHOLD_SECONDS) ? "67" : "68";
    const itemName = itemId === "67" ? 'First Aid Kit' : 'Small Aid';
    updateStatus(`Healing (${itemName} - ${Math.floor(hospitalSeconds / 60)}m left)...`);

    try {
      const res = await useItemRequest(itemId, rfcToken);
      if (res.success) {
        state.completedCount += 1;
        GM_setValue('autoHeal_completedCount', state.completedCount);
        fetchItemCounts(true);
        updateStatus(`Healed with ${itemName}! (${state.completedCount}/${state.targetCount})`);
      } else {
        updateStatus(`Failed: ${res.text || 'Error'}`);
      }
    } catch (err) {
      updateStatus('Heal Request Failed');
    }

    // Prevent re-executing until backend synchronizes
    setTimeout(() => { state.isProcessing = false; }, CONFIG.POST_HEAL_WAIT_MS);
  }

  function toggleActive(val) {
    state.active = val;
    GM_setValue('autoHeal_active', val);
    if (val && state.completedCount >= state.targetCount) {
      state.completedCount = 0;
      GM_setValue('autoHeal_completedCount', 0);
    }
    updateUI();
  }

  function createUI() {
    if (document.getElementById('auto-heal-widget')) return;

    const widget = document.createElement('div');
    widget.id = 'auto-heal-widget';
    const positionStyles = (state.posX !== null && state.posY !== null)
      ? `top: ${state.posY}px; left: ${state.posX}px;`
      : `bottom: 20px; right: 20px;`;

    widget.style.cssText = `
      position: fixed; ${positionStyles} z-index: 999999; background: #222; color: #fff;
      border: 1px solid #444; border-radius: 8px; padding: 12px 16px; font-family: Arial, sans-serif;
      font-size: 13px; box-shadow: 0 4px 12px rgba(0,0,0,0.5); width: 250px; user-select: none;
    `;

    widget.innerHTML = `
      <div id="auto-heal-header" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; border-bottom: 1px solid #333; padding-bottom: 6px; cursor: move;">
        <strong style="color: #4caf50;">Auto Healer</strong>
        <span id="auto-heal-status-indicator" style="font-size: 10px; padding: 2px 6px; border-radius: 4px; background: #555;">OFF</span>
      </div>

      <div style="margin-bottom: 8px; display: flex; align-items: center; justify-content: space-between;">
        <label style="font-size: 12px; color: #ccc;">Your ID:</label>
        <div style="display: flex; gap: 4px;">
          <input type="text" id="auto-heal-my-id" readonly value="${getMyPlayerId()}" style="width: 75px; background: #111; color: #4caf50; font-weight: bold; border: 1px solid #555; border-radius: 4px; text-align: center; padding: 2px;">
          <button id="auto-heal-copy-id-btn" style="background: #333; color: #fff; border: 1px solid #555; border-radius: 4px; padding: 2px 6px; font-size: 11px; cursor: pointer;">Copy</button>
        </div>
      </div>

      <div style="margin-bottom: 8px; display: flex; align-items: center; justify-content: space-between;">
        <label for="auto-heal-api-key" style="font-size: 11px; color: #ccc;">API Key:</label>
        <input type="password" id="auto-heal-api-key" value="${state.apiKey}" placeholder="Torn API Key" style="width: 140px; background: #111; color: #fff; border: 1px solid #555; border-radius: 4px; padding: 2px 4px; font-size: 11px;">
      </div>

      <div style="background: #181818; border: 1px solid #333; border-radius: 6px; padding: 6px 8px; margin-bottom: 8px; font-size: 11px;">
        <div style="display: flex; justify-content: space-between; margin-bottom: 3px;"><span>Small First Aid:</span><strong id="auto-heal-small-aid" style="color: #ff9800;">${inventoryCache.smallAid}</strong></div>
        <div style="display: flex; justify-content: space-between; margin-bottom: 3px;"><span>First Aid Kit:</span><strong id="auto-heal-first-aid" style="color: #2196f3;">${inventoryCache.firstAid}</strong></div>
        <div style="display: flex; justify-content: space-between;"><span>Xanax:</span><strong id="auto-heal-xanax-count" style="color: #e91e63;">${inventoryCache.xanax}</strong></div>
      </div>

      <div style="margin-bottom: 8px; display: flex; justify-content: space-between; align-items: center;">
        <label for="auto-heal-target">Max Runs:</label>
        <input type="number" id="auto-heal-target" min="1" max="999" value="${state.targetCount}" style="width: 55px; background: #333; color: #fff; border: 1px solid #555; border-radius: 4px; text-align: center; padding: 2px;">
      </div>

      <div style="margin-bottom: 8px; display: flex; align-items: center; gap: 6px;">
        <input type="checkbox" id="auto-heal-xanax" ${state.useXanax ? 'checked' : ''} style="cursor: pointer;">
        <label for="auto-heal-xanax" style="cursor: pointer; font-size: 12px;">Auto Xanax on 0 Energy</label>
      </div>

      <div style="margin-bottom: 4px; font-size: 11px; color: #aaa;" id="auto-heal-progress">Progress: ${state.completedCount} / ${state.targetCount} times</div>
      <div style="margin-bottom: 8px; font-size: 12px;" id="auto-heal-message">Status: Idle</div>

      <button id="auto-heal-toggle-btn" style="width: 100%; padding: 6px; border: none; border-radius: 4px; font-weight: bold; cursor: pointer; background: #4caf50; color: #fff;">TURN ON</button>
    `;

    document.body.appendChild(widget);
    makeWidgetDraggable(widget, document.getElementById('auto-heal-header'));

    document.getElementById('auto-heal-toggle-btn').addEventListener('click', () => toggleActive(!state.active));
    document.getElementById('auto-heal-xanax').addEventListener('change', (e) => {
      state.useXanax = e.target.checked;
      GM_setValue('autoHeal_useXanax', state.useXanax);
    });
    document.getElementById('auto-heal-target').addEventListener('change', (e) => {
      state.targetCount = Math.max(1, parseInt(e.target.value, 10) || 1);
      GM_setValue('autoHeal_targetCount', state.targetCount);
      updateUI();
    });
    document.getElementById('auto-heal-api-key').addEventListener('change', (e) => {
      state.apiKey = e.target.value.trim();
      GM_setValue('autoHeal_apiKey', state.apiKey);
      fetchItemCounts(true);
    });

    const copyBtn = document.getElementById('auto-heal-copy-id-btn');
    const idInput = document.getElementById('auto-heal-my-id');
    copyBtn.addEventListener('click', () => {
      idInput.select();
      navigator.clipboard.writeText(idInput.value).then(() => {
        copyBtn.innerText = 'Copied!';
        setTimeout(() => { copyBtn.innerText = 'Copy'; }, 1200);
      });
    });

    updateUI();
    fetchItemCounts(true);
  }

  function makeWidgetDraggable(elmnt, dragHandle) {
    let pos1 = 0, pos2 = 0, pos3 = 0, pos4 = 0;
    dragHandle.onmousedown = (e) => {
      e.preventDefault();
      pos3 = e.clientX;
      pos4 = e.clientY;
      document.onmouseup = () => {
        document.onmouseup = null;
        document.onmousemove = null;
        GM_setValue('autoHeal_posX', elmnt.offsetLeft);
        GM_setValue('autoHeal_posY', elmnt.offsetTop);
      };
      document.onmousemove = (e) => {
        e.preventDefault();
        pos1 = pos3 - e.clientX;
        pos2 = pos4 - e.clientY;
        pos3 = e.clientX;
        pos4 = e.clientY;
        elmnt.style.bottom = 'auto';
        elmnt.style.right = 'auto';
        elmnt.style.top = (elmnt.offsetTop - pos2) + "px";
        elmnt.style.left = (elmnt.offsetLeft - pos1) + "px";
      };
    };
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

    if (progress) progress.innerText = `Progress: ${state.completedCount} / ${state.targetCount} times`;
  }

  function updateStatus(text) {
    const msg = document.getElementById('auto-heal-message');
    if (msg) msg.innerText = `Status: ${text}`;
  }

  function init() {
    createUI();
    setInterval(checkAndHeal, CONFIG.DOM_CHECK_INTERVAL_MS);
    setInterval(() => fetchItemCounts(), CONFIG.API_CHECK_INTERVAL_MS);
  }

  let hasInitialized = false;
  function safeInit() {
    if (hasInitialized) return;
    hasInitialized = true;
    init();
  }

  if (document.readyState === 'interactive' || document.readyState === 'complete') {
    safeInit();
  } else {
    window.addEventListener('DOMContentLoaded', safeInit, { once: true });
  }
})();
