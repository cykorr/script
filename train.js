// ==UserScript==
// @name         Torn - Auto Xanax & Train (Page Swap & Auto Train)
// @namespace    http://tampermonkey.net/
// @version      1.8
// @description  Automated Xanax user. Swaps to gym page when energy >= 150 or Xanax used, clicks the gym train button, then swaps back at 0 energy.
// @author       arhi
// @match        https://www.torn.com/item.php*
// @match        https://www.torn.com/gym.php*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  // --- GLOBAL HELPERS ---
  const getCookie = (name) =>
    document.cookie.split('; ').find(row => row.startsWith(`${name}=`))?.split('=')[1];

  // Helper to read your current energy directly from the webpage top bar
  function getCurrentEnergy() {
    const elem = document.querySelector('#user-bar #energyval') ||
                 document.querySelector('[class*="energy"] [class*="value"]') ||
                 document.querySelector('#barEnergy .val');
    return elem ? parseInt(elem.textContent.replace(/,/g, '').match(/\d+/)?.[0] || 0, 10) : null;
  }

  // --- GYM PAGE LOGIC ---
  if (window.location.pathname.endsWith('/gym.php')) {
    if (GM_getValue('autoXanax_pendingGym', false)) {
      
      const statToTrain = GM_getValue('autoXanax_trainStat', 'strength');

      // Inject banner
      const indicator = document.createElement('div');
      indicator.innerHTML = `<div style="position:fixed; top:10px; left:50%; transform:translateX(-50%); background:#e91e63; color:#fff; padding:6px 20px; border-radius:6px; z-index:999999; font-weight:bold; box-shadow: 0 4px 6px rgba(0,0,0,0.3); border: 2px solid #fff;">Auto-Gym Active: Training ${statToTrain}...</div>`;
      document.body.appendChild(indicator);

      function executeTrainClick() {
        const energy = getCurrentEnergy();
        
        // If energy is already 0, we are done. Return to Items.
        if (energy !== null && energy === 0) {
          GM_setValue('autoXanax_pendingGym', false);
          window.location.href = '/item.php';
          return;
        }

        // Search for the train button matching the target stat
        const targetAriaLabel = `Train ${statToTrain.toLowerCase()}`;
        const buttons = document.querySelectorAll('button.torn-btn');
        let trainButton = null;

        for (const btn of buttons) {
          const ariaLabel = btn.getAttribute('aria-label');
          if (ariaLabel && ariaLabel.toLowerCase() === targetAriaLabel) {
            trainButton = btn;
            break;
          }
        }

        // Fallback: search by text content if aria-label doesn't match precisely
        if (!trainButton) {
          for (const btn of buttons) {
            if (btn.textContent.trim().toUpperCase() === 'TRAIN' && 
                btn.closest(`.${statToTrain.toLowerCase()}, [class*="${statToTrain.toLowerCase()}"]`)) {
              trainButton = btn;
              break;
            }
          }
        }

        if (trainButton) {
          trainButton.click();
        } else {
          console.warn(`Auto-Gym: Could not find train button for ${statToTrain}`);
        }

        // Reload the page to securely update Torn's UI/energy bar and trigger the script again
        setTimeout(() => {
          window.location.reload();
        }, 1500);
      }

      // Wait 2 seconds upon landing on the gym page to allow elements to load fully before clicking
      setTimeout(executeTrainClick, 2000);
    }
    
    // Stop the rest of the script from running on the gym page
    return;
  }

  // --- ITEM PAGE LOGIC ---
  const CONFIG = {
    CHECK_INTERVAL_MS: 5000 // Check API every 5 seconds
  };

  let state = {
    active: GM_getValue('autoXanax_active', false),
    autoTrain: GM_getValue('autoXanax_autoTrain', false),
    trainStat: GM_getValue('autoXanax_trainStat', 'strength'),
    targetCount: GM_getValue('autoXanax_targetCount', 1),
    apiKey: GM_getValue('autoXanax_apiKey', ''),
    completedCount: GM_getValue('autoXanax_completedCount', 0),
    isProcessing: false
  };

  let inventoryCache = {
    xanax: GM_getValue('autoXanax_xanax', 0)
  };

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

  async function checkAndUseXanax() {
    if (!state.active || state.isProcessing || !state.apiKey) return;

    if (state.completedCount >= state.targetCount) {
      toggleActive(false);
      return;
    }

    state.isProcessing = true;

    // CRITERIA 1: If Auto-Gym is ON and Energy is >= 150, go to gym before taking Xanax
    const currentEnergy = getCurrentEnergy();
    if (state.autoTrain && currentEnergy !== null && currentEnergy >= 150) {
      updateStatus('Energy >= 150. Swapping to Gym...');
      GM_setValue('autoXanax_pendingGym', true);
      window.location.href = '/gym.php';
      return; 
    }

    try {
      const [drugData, cooldownData] = await Promise.all([
        fetchApiGM(`https://api.torn.com/v2/user/inventory?cat=Drug&key=${state.apiKey}`),
        fetchApiGM(`https://api.torn.com/v2/user/cooldowns?key=${state.apiKey}`)
      ]);

      if (drugData.error || cooldownData.error) {
        const err = drugData.error || cooldownData.error;
        updateStatus(`API Error: ${err.error || err.code}`);
        state.isProcessing = false;
        return;
      }

      let xanax = 0;
      const drugItems = drugData?.inventory?.items || [];
      drugItems.forEach(item => {
        if (parseInt(item.id, 10) === 206) xanax += parseInt(item.amount || 0, 10);
      });

      inventoryCache.xanax = xanax;
      GM_setValue('autoXanax_xanax', xanax);
      updateDashboardCounts();

      const drugCooldown = cooldownData?.cooldowns?.drug || cooldownData?.drug || 0;

      if (drugCooldown === 0) {
        if (xanax === 0) {
          updateStatus('Out of Xanax!');
          state.isProcessing = false;
          return;
        }

        const rfcToken = getCookie('rfc_v') || getCookie('rfc_id');
        if (!rfcToken) {
          updateStatus('Error: Missing RFC Token');
          state.isProcessing = false;
          return;
        }

        updateStatus('Taking Xanax...');
        const res = await useItemRequest('206', rfcToken);
        
        if (res.success) {
          state.completedCount += 1;
          GM_setValue('autoXanax_completedCount', state.completedCount);
          updateStatus(`Used Xanax! (${state.completedCount}/${state.targetCount})`);
          updateUI();

          // CRITERIA 2: If Auto-Gym is ON, swap to gym immediately after successfully using a Xanax
          if (state.autoTrain) {
            updateStatus('Xanax used. Swapping to Gym...');
            GM_setValue('autoXanax_pendingGym', true);
            setTimeout(() => { window.location.href = '/gym.php'; }, 1000);
            return;
          }
        } else {
          updateStatus(`Failed: ${res.text || 'Error'}`);
        }
      } else {
        updateStatus(`Drug Cooldown: ${drugCooldown}s`);
      }
    } catch (err) {
      updateStatus('API Fetch Failed');
    }

    setTimeout(() => { state.isProcessing = false; }, 1000);
  }

  function updateDashboardCounts() {
    const xElem = document.getElementById('auto-xanax-count');
    if (xElem) xElem.innerText = inventoryCache.xanax;
  }

  function toggleActive(val) {
    state.active = val;
    GM_setValue('autoXanax_active', val);
    if (val && state.completedCount >= state.targetCount) {
      state.completedCount = 0;
      GM_setValue('autoXanax_completedCount', 0);
    }
    updateUI();
  }

  function createUI() {
    if (document.getElementById('auto-xanax-widget')) return;

    const widget = document.createElement('div');
    widget.id = 'auto-xanax-widget';

    widget.style.cssText = `
      position: fixed; bottom: 0; left: 0; width: 100%; z-index: 999999; 
      background: #222; color: #fff; border-top: 2px solid #e91e63; 
      padding: 10px 20px; box-sizing: border-box; font-family: Arial, sans-serif; 
      font-size: 13px; display: flex; align-items: center; justify-content: space-between;
      box-shadow: 0 -2px 10px rgba(0,0,0,0.5);
    `;

    widget.innerHTML = `
      <div style="display: flex; align-items: center; gap: 15px;">
        <strong style="color: #e91e63; font-size: 15px; letter-spacing: 0.5px;">Auto Xanax</strong>
        <span id="auto-xanax-status-indicator" style="font-size: 11px; font-weight: bold; padding: 4px 8px; border-radius: 4px; background: #555;">OFF</span>
      </div>

      <div style="display: flex; align-items: center; gap: 20px;">
        <div style="display: flex; align-items: center; gap: 5px;">
          <label for="auto-xanax-api-key" style="color: #ccc;">API Key:</label>
          <input type="password" id="auto-xanax-api-key" value="${state.apiKey}" placeholder="Torn API Key" style="width: 140px; background: #111; color: #fff; border: 1px solid #555; border-radius: 4px; padding: 4px 6px; font-size: 12px;">
        </div>

        <div style="display: flex; align-items: center; gap: 8px; background: #181818; border: 1px solid #333; border-radius: 4px; padding: 4px 10px;">
          <span style="color: #ccc;">Xanax:</span><strong id="auto-xanax-count" style="color: #e91e63; font-size: 14px;">${inventoryCache.xanax}</strong>
        </div>

        <div style="display: flex; align-items: center; gap: 5px;">
          <label for="auto-xanax-target" style="color: #ccc;">Target Uses:</label>
          <input type="number" id="auto-xanax-target" min="1" max="999" value="${state.targetCount}" style="width: 50px; background: #333; color: #fff; border: 1px solid #555; border-radius: 4px; text-align: center; padding: 4px;">
          <span id="auto-xanax-progress" style="color: #aaa; margin-left: 5px; font-size: 12px;">(${state.completedCount}/${state.targetCount})</span>
        </div>

        <div style="display: flex; align-items: center; gap: 5px;">
          <input type="checkbox" id="auto-xanax-train" ${state.autoTrain ? 'checked' : ''} style="cursor: pointer;">
          <label for="auto-xanax-train" style="cursor: pointer; color: #ccc;">Swap to Gym</label>
          
          <select id="auto-xanax-stat" style="background: #111; color: #fff; border: 1px solid #555; border-radius: 4px; padding: 2px 4px; font-size: 11px; margin-left: 5px; cursor: pointer;">
            <option value="strength" ${state.trainStat === 'strength' ? 'selected' : ''}>Strength</option>
            <option value="defense" ${state.trainStat === 'defense' ? 'selected' : ''}>Defense</option>
            <option value="speed" ${state.trainStat === 'speed' ? 'selected' : ''}>Speed</option>
            <option value="dexterity" ${state.trainStat === 'dexterity' ? 'selected' : ''}>Dexterity</option>
          </select>

          <button id="auto-xanax-test-swap-btn" style="margin-left: 10px; padding: 4px 8px; border: none; border-radius: 4px; font-size: 11px; cursor: pointer; background: #2196f3; color: #fff;">Test Swap & Train</button>
        </div>
      </div>

      <div style="display: flex; align-items: center; gap: 15px;">
        <div id="auto-xanax-message" style="color: #aaa; font-style: italic; min-width: 150px; text-align: right;">Status: Idle</div>
        <button id="auto-xanax-toggle-btn" style="padding: 6px 20px; border: none; border-radius: 4px; font-weight: bold; font-size: 13px; cursor: pointer; background: #4caf50; color: #fff; transition: background 0.2s;">TURN ON</button>
      </div>
    `;

    document.body.appendChild(widget);

    document.getElementById('auto-xanax-toggle-btn').addEventListener('click', () => toggleActive(!state.active));
    
    document.getElementById('auto-xanax-test-swap-btn').addEventListener('click', () => {
      GM_setValue('autoXanax_pendingGym', true);
      window.location.href = '/gym.php';
    });

    document.getElementById('auto-xanax-target').addEventListener('change', (e) => {
      state.targetCount = Math.max(1, parseInt(e.target.value, 10) || 1);
      GM_setValue('autoXanax_targetCount', state.targetCount);
      updateUI();
    });

    document.getElementById('auto-xanax-train').addEventListener('change', (e) => {
      state.autoTrain = e.target.checked;
      GM_setValue('autoXanax_autoTrain', state.autoTrain);
    });

    document.getElementById('auto-xanax-stat').addEventListener('change', (e) => {
      state.trainStat = e.target.value;
      GM_setValue('autoXanax_trainStat', state.trainStat);
    });
    
    document.getElementById('auto-xanax-api-key').addEventListener('change', (e) => {
      state.apiKey = e.target.value.trim();
      GM_setValue('autoXanax_apiKey', state.apiKey);
    });

    updateUI();
  }

  function updateUI() {
    const btn = document.getElementById('auto-xanax-toggle-btn');
    const indicator = document.getElementById('auto-xanax-status-indicator');
    const progress = document.getElementById('auto-xanax-progress');
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

    if (progress) progress.innerText = `(${state.completedCount}/${state.targetCount})`;
  }

  function updateStatus(text) {
    const msg = document.getElementById('auto-xanax-message');
    if (msg) msg.innerText = `Status: ${text}`;
  }

  function init() {
    createUI();
    document.body.style.paddingBottom = '60px'; 
    setInterval(checkAndUseXanax, CONFIG.CHECK_INTERVAL_MS);
  }

  if (document.body) init();
  else window.addEventListener('DOMContentLoaded', init);
})();
