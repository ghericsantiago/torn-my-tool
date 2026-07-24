// ==UserScript==
// @name         Torn Flight Planner v2
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  Plan sequential flights with scheduled departure times in Torn City Time (UTC)
// @author       Gheric
// @match        https://www.torn.com
// @match        https://www.torn.com/index.php
// @match        https://www.torn.com/page.php?sid=travel*
// @match        https://www.torn.com/gym.php
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  // =================== CONSTANTS ===================
  const PLAN_KEY = "tmFlightPlanV2";
  const OPTS_KEY = "tmAutoFlyV2Options";
  const SHOPPING_LIST_KEY = "tmShoppingList"; // shared with v1
  const COOLDOWN_KEY = "tmAutoFlyLast";
  const API_KEY = "v6Yo75UQIYvWYrhT";

  const VALID_DESTINATIONS = [
    "Mexico", "Cayman Islands", "Canada", "Hawaii",
    "United Kingdom", "Argentina", "Switzerland", "Japan",
    "China", "UAE", "South Africa",
  ];

  const SHOPPING_LIST_DEFAULT = [
    "Camel Plushie", "Chamois Plushie", "Jaguar Plushie", "Kitten Plushie",
    "Lion Plushie", "Monkey Plushie", "Nessie Plushie", "Panda Plushie",
    "Red Fox Plushie", "Sheep Plushie", "Stingray Plushie", "Teddy Bear Plushie",
    "Wolverine Plushie", "African Violet", "Banana Orchid", "Bunch of Black Roses",
    "Bunch of Carnations", "Bunch of Flowers", "Ceibo Flower", "Cherry Blossom",
    "Crocus", "Daffodil", "Dahlia", "Dozen Roses", "Dozen White Roses",
    "Edelweiss", "Funeral Wreath", "Heather", "Orchid", "Peony",
    "Single Red Rose", "Tribulus Omanense", "White Lily",
  ];

  // =================== OPTIONS ===================
  function loadOptions() {
    try {
      return Object.assign(
        { skipWarnings: false, flyBackEnabled: true, autoEnabled: false, repeatPlan: false, preflyDelay: 5, gymEnabled: false, gymStat: "strength" },
        JSON.parse(localStorage.getItem(OPTS_KEY) || "{}")
      );
    } catch (e) {
      return { skipWarnings: false, flyBackEnabled: true, autoEnabled: false, repeatPlan: false, preflyDelay: 5, gymEnabled: false, gymStat: "strength" };
    }
  }
  function saveOptions(o) {
    try { localStorage.setItem(OPTS_KEY, JSON.stringify(o)); } catch (e) {}
  }

  // =================== FLIGHT PLAN ===================
  // Each entry: { id, destination, departureTime ("HH:MM" TCT/UTC), status: "pending"|"flying"|"done", loop: false }
  // loop:true — flight resets to "pending" immediately after completing and always fires regardless of departure time
  function loadFlightPlan() {
    try {
      const plan = JSON.parse(localStorage.getItem(PLAN_KEY) || "[]");
      if (Array.isArray(plan)) return plan.map(f => {
        if (f.destination === "United Arab Emirates") f.destination = "UAE";
        return Object.assign({ loop: false }, f);
      });
    } catch (e) {}
    return [];
  }
  function saveFlightPlan(plan) {
    try { localStorage.setItem(PLAN_KEY, JSON.stringify(plan)); } catch (e) {}
  }
  function genId() {
    return Math.random().toString(36).slice(2, 10);
  }

  // Current TCT (= UTC) as "HH:MM"
  function getTCTTime() {
    const now = new Date();
    return String(now.getUTCHours()).padStart(2, "0") + ":" + String(now.getUTCMinutes()).padStart(2, "0");
  }

  // First "pending" flight that is ready to depart.
  // Priority: scheduled flights (time passed) > unscheduled flights (no time = fire immediately) > loop flights (filler).
  function getNextReadyFlight() {
    const now = getTCTTime();
    const plan = loadFlightPlan();
    // Flights execute strictly in list order. The first pending flight blocks
    // everything below it. Loop flights keep resetting to pending (blocking)
    // until untagged. Scheduled flights wait for their time before firing.
    const next = plan.find(f => f.status === "pending");
    if (!next) return null;
    if (!next.loop && next.departureTime && next.departureTime > now) return null;
    return next;
  }

  // The flight currently marked as in-progress
  function getActiveFlight() {
    return loadFlightPlan().find(f => f.status === "flying") || null;
  }

  function updateFlightStatus(id, status) {
    const plan = loadFlightPlan();
    const f = plan.find(f => f.id === id);
    if (f) { f.status = status; saveFlightPlan(plan); }
  }

  function resetDoneFlights() {
    const plan = loadFlightPlan();
    plan.forEach(f => { if (f.status === "done") f.status = "pending"; });
    saveFlightPlan(plan);
    renderFlightPlan();
  }

  // =================== SHOPPING LIST ===================
  function loadShoppingList() {
    try {
      const saved = JSON.parse(localStorage.getItem(SHOPPING_LIST_KEY) || "null");
      if (Array.isArray(saved)) return saved;
    } catch (e) {}
    return SHOPPING_LIST_DEFAULT.slice();
  }
  function saveShoppingList(list) {
    try { localStorage.setItem(SHOPPING_LIST_KEY, JSON.stringify(list)); } catch (e) {}
  }

  // =================== STATE ===================
  let options = loadOptions();
  let autoCheckIntervalId = null;
  let reviveTimer = null;
  let reviveCountdownTimer = null;
  let travelReloadTimer = null;
  let travelDomPollerId = null;
  let travelCountdownTimer = null;
  let tctClockTimer = null;

  // =================== UTILITIES ===================
  function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
  function delay(ms) { return new Promise(r => setTimeout(r, ms)); }
  function escHtml(s) {
    return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }
  function isMobile() {
    return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || window.innerWidth < 768;
  }
  function isTravelPage() {
    return !!(
      document.querySelector("#travel-root") ||
      (location.pathname.includes("page.php") && location.search.includes("sid=travel"))
    );
  }
  function isGymPage() {
    return !!(document.querySelector("#gymroot") || location.pathname.includes("gym.php"));
  }
  function isAbroad() {
    const b = document.body;
    return !!(b && b.dataset && b.dataset.abroad === "true");
  }
  function isTraveling() {
    const b = document.body;
    return !!(b && b.dataset && b.dataset.traveling === "true");
  }
  function isAbroadOrTraveling() { return isAbroad() || isTraveling(); }
  function isHospital() { return !!document.querySelector('li[class*="icon15"]'); }

  function setPanelStatus(text, color) {
    const el = document.getElementById("tm-af2-status");
    if (el) {
      el.textContent = text;
      el.style.color = color || "#f0a500";
      el.style.display = "";
    }
  }

  function safeClick(el) {
    if (!el) return false;
    try { el.focus && el.focus(); el.click(); return true; } catch (e) {}
    try {
      for (const t of ["pointerdown","pointerup","mousedown","mouseup","click"]) {
        el.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
      }
      return true;
    } catch (e) {}
    try { if (typeof el.onclick === "function") { el.onclick(); return true; } } catch (e) {}
    try {
      if (el.tagName && el.tagName.toLowerCase() === "a" && el.href) {
        location.href = el.href; return true;
      }
    } catch (e) {}
    return false;
  }

  function safeSetQty(row, qty) {
    if (!row) return false;
    const num = Math.max(1, Math.floor(Number(qty) || 1));
    const candidates = Array.from(row.querySelectorAll(
      'input[type=number], input.input-money, input[placeholder], input[name*="qty"], input[type=hidden]'
    ));
    for (const inp of candidates) {
      try {
        if (inp.type === "hidden") {
          inp.value = String(num); inp.setAttribute("value", String(num));
        } else {
          inp.focus && inp.focus();
          inp.value = String(num);
          inp.dispatchEvent(new Event("input", { bubbles: true }));
          inp.dispatchEvent(new Event("change", { bubbles: true }));
          inp.blur && inp.blur();
        }
        return true;
      } catch (e) {}
    }
    const sel = row.querySelector("select");
    if (sel) {
      try { sel.value = String(num); sel.dispatchEvent(new Event("change", { bubbles: true })); return true; } catch (e) {}
    }
    const maxBtn = row.querySelector(".input-money-symbol button, .input-money-symbol input.wai-btn, button.max, .max-button");
    if (maxBtn) { try { safeClick(maxBtn); return true; } catch (e) {} }
    return false;
  }

  // =================== BADGE ===================
  function getCountdownBadge() {
    let b = document.getElementById("tm-af2-badge");
    if (!b) {
      b = document.createElement("div");
      b.id = "tm-af2-badge";
      b.style.cssText = [
        "position:fixed","bottom:84px","right:16px","max-width:220px",
        "padding:8px 12px","background:#1a1a1a","border:2px solid #f0a500",
        "border-radius:10px","color:#f0a500","font-weight:bold",
        "font-family:Arial,sans-serif","font-size:13px","line-height:1.3",
        "z-index:999999","box-shadow:0 3px 10px rgba(0,0,0,0.6)",
        "display:none","text-align:center","pointer-events:none",
      ].join(";");
      document.body.appendChild(b);
    }
    return b;
  }

  // =================== API ===================
  async function apiRequest(section, selections) {
    const res = await fetch(`https://api.torn.com/${section}/?selections=${selections}&key=${API_KEY}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(`[${data.error.code}] ${data.error.error}`);
    return data;
  }

  async function getHospitalStatus() {
    const data = await apiRequest("user", "basic");
    const st = data.status || {};
    const now = Math.floor(Date.now() / 1000);
    const secondsRemaining = st.state === "Hospital" && st.until > now ? st.until - now : 0;
    return { state: st.state, until: st.until || 0, secondsRemaining };
  }

  // =================== COUNTDOWNS ===================
  // Uses wall-clock end timestamps instead of a decrementing counter so that
  // browser tab throttling cannot cause the display to drift behind real time.
  function setReviveCountdown(secs) {
    if (reviveCountdownTimer) { clearInterval(reviveCountdownTimer); reviveCountdownTimer = null; }
    const endAt = Date.now() + Math.max(0, Math.floor(secs)) * 1000;
    const render = () => {
      const remaining = Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
      const badge = getCountdownBadge();
      badge.style.borderColor = "#f0a500";
      badge.style.color = "#f0a500";
      const text = remaining <= 0
        ? "Out of hospital — resuming…"
        : `In hospital — ${Math.floor(remaining / 60)}m ${remaining % 60}s`;
      setPanelStatus(text);
      badge.textContent = text;
      badge.style.display = "";
      if (remaining <= 0) {
        clearInterval(reviveCountdownTimer); reviveCountdownTimer = null;
        setTimeout(() => {
          const b = document.getElementById("tm-af2-badge");
          if (b) b.style.display = "none";
        }, 4000);
      }
    };
    render();
    reviveCountdownTimer = setInterval(render, 1000);
    // Snap display back to correct time immediately when tab regains focus
    document.addEventListener("visibilitychange", function onVisible() {
      if (!document.hidden) { render(); }
      if (!reviveCountdownTimer) document.removeEventListener("visibilitychange", onVisible);
    });
  }

  function setTravelCountdown(secs, dest) {
    if (travelCountdownTimer) { clearInterval(travelCountdownTimer); travelCountdownTimer = null; }
    const endAt = Date.now() + Math.max(0, Math.floor(secs)) * 1000;
    const render = () => {
      const remaining = Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
      const badge = getCountdownBadge();
      badge.style.borderColor = "#4db8ff";
      badge.style.color = "#4db8ff";
      const text = remaining <= 0
        ? `Arrived at ${dest} — reloading…`
        : `Flying to ${dest} — ${Math.floor(remaining / 60)}m ${remaining % 60}s`;
      setPanelStatus(text, "#4db8ff");
      badge.textContent = text;
      badge.style.display = "";
      if (remaining <= 0) { clearInterval(travelCountdownTimer); travelCountdownTimer = null; }
    };
    render();
    travelCountdownTimer = setInterval(render, 1000);
    document.addEventListener("visibilitychange", function onVisible() {
      if (!document.hidden) { render(); }
      if (!travelCountdownTimer) document.removeEventListener("visibilitychange", onVisible);
    });
  }

  // =================== HOSPITAL WATCH ===================
  async function scheduleReviveReloadIfHospitalized() {
    let status;
    try { status = await getHospitalStatus(); }
    catch (e) {
      console.warn("[AutoFly2] Hospital API failed", e);
      if (!reviveTimer) reviveTimer = setTimeout(() => location.reload(), 30_000);
      return true;
    }
    if (!status.secondsRemaining) return false;
    setReviveCountdown(status.secondsRemaining);
    if (!reviveTimer) reviveTimer = setTimeout(() => location.reload(), status.secondsRemaining * 1000 + 3000);
    return true;
  }

  async function initHospitalWatch() {
    let status;
    try { status = await getHospitalStatus(); }
    catch (e) { setPanelStatus("Hospital check: API error"); return; }
    if (status.secondsRemaining <= 0) {
      setPanelStatus(`State: ${status.state || "Okay"}`, "#44cc88");
      return;
    }
    setReviveCountdown(status.secondsRemaining);
    if (isAbroadOrTraveling() && !reviveTimer) {
      reviveTimer = setTimeout(() => location.reload(), status.secondsRemaining * 1000 + 3000);
    }
  }

  // =================== TRAVEL WATCH ===================
  function startTravelDomPoller() {
    if (travelDomPollerId) return;
    travelDomPollerId = setInterval(() => {
      if (!document.body || document.body.dataset.traveling !== "true") {
        clearInterval(travelDomPollerId); travelDomPollerId = null;
        if (travelReloadTimer) { clearTimeout(travelReloadTimer); travelReloadTimer = null; }
        if (travelCountdownTimer) { clearInterval(travelCountdownTimer); travelCountdownTimer = null; }
        console.log("[AutoFly2] Travel cleared (DOM poller) — reloading");
        location.reload();
      }
    }, 5000);
  }

  async function initTravelWatch() {
    if (!document.body || document.body.dataset.traveling !== "true") return;
    let travelInfo;
    try {
      const data = await apiRequest("user", "basic,travel");
      travelInfo = data.travel;
    } catch (e) {
      console.warn("[AutoFly2] initTravelWatch API failed — DOM poller fallback", e);
      startTravelDomPoller();
      return;
    }
    const secs = Number((travelInfo && travelInfo.time_left) || 0);
    const dest = (travelInfo && travelInfo.destination) || "destination";
    if (secs <= 0) { location.reload(); return; }
    console.log(`[AutoFly2] Traveling to ${dest} — reloading in ${secs}s`);
    setTravelCountdown(secs, dest);
    if (!travelReloadTimer) {
      travelReloadTimer = setTimeout(() => { location.reload(); }, secs * 1000 + 3000);
    }
    startTravelDomPoller();
  }

  // =================== TRAVEL CONTROLS ===================
  function findFlyControl() {
    return [...document.querySelectorAll("button.torn-btn.btn-dark-bg")]
      .find(el => el.textContent.trim() === "Travel");
  }
  function findFlyContinueControl() {
    return [...document.querySelectorAll("button.torn-btn.btn-dark-bg")]
      .find(el => el.textContent.trim() === "Continue");
  }

  function clickFlyControl() {
    const btn = findFlyControl();
    if (!btn) return false;
    try { btn.click(); return true; } catch (e) {}
    try {
      for (const t of ["mousedown","mouseup","click"]) {
        btn.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
      }
      return true;
    } catch (err) {
      try {
        if (btn.tagName && btn.tagName.toLowerCase() === "a" && btn.href) {
          const href = (btn.href || "").toLowerCase();
          if (href.includes("sid=travel") || href.includes("travel") || href.includes("abroad")) {
            location.href = btn.href; return true;
          }
        }
      } catch (nerr) {}
      return false;
    }
  }

  function clickFlyContinueControl() {
    const btn = findFlyContinueControl();
    if (!btn) return false;
    try { btn.click(); return true; } catch (e) {}
    try {
      for (const t of ["mousedown","mouseup","click"]) {
        btn.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
      }
      return true;
    } catch (err) { return false; }
  }

  function waitForContinueAndClick(timeout = 5000) {
    return new Promise(resolve => {
      if (clickFlyContinueControl()) return resolve(true);
      const obs = new MutationObserver(() => {
        if (clickFlyContinueControl()) { obs.disconnect(); resolve(true); }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { obs.disconnect(); resolve(false); }, timeout);
    });
  }

  async function clickTravelDestination(countryName, retries = 3) {
    if (!countryName) return false;
    const low = countryName.toLowerCase();
    // Desktop: radio buttons
    for (const radio of document.querySelectorAll('input[type="radio"][name="destination"]')) {
      if ((radio.getAttribute("aria-label") || "").toLowerCase().includes(low)) {
        try { radio.click(); console.log("[AutoFly2] Clicked radio for " + countryName); return true; }
        catch (e) { return false; }
      }
    }
    // Mobile: expand buttons
    for (const btn of document.querySelectorAll('[class*="expandButton"]')) {
      const span = btn.querySelector('[class*="country"]');
      if (span && span.textContent.trim().toLowerCase().includes(low)) {
        try {
          safeClick(btn);
          await new Promise(resolve => {
            const obs = new MutationObserver(() => { if (findFlyControl()) { obs.disconnect(); resolve(); } });
            obs.observe(document.body, { childList: true, subtree: true });
            setTimeout(() => { obs.disconnect(); resolve(); }, 5000);
          });
          return true;
        } catch (e) { return false; }
      }
    }
    if (retries > 0) { await wait(300); return clickTravelDestination(countryName, retries - 1); }
    return false;
  }

  // =================== ABROAD SHOPPING ===================
  function waitForStockTable() {
    return new Promise(resolve => {
      const existing = document.querySelector('[class*="stockTableWrapper"]');
      if (existing) return resolve(existing);
      console.log("[AutoFly2] Waiting for stockTableWrapper…");
      const observer = new MutationObserver(() => {
        const el = document.querySelector('[class*="stockTableWrapper"]');
        if (el) { observer.disconnect(); resolve(el); }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { observer.disconnect(); resolve(null); }, 15000);
    });
  }

  function getPurchaseInfo() {
    const msgEl = document.querySelector('[class*="messageContent"]');
    if (!msgEl) return null;
    const match = (msgEl.textContent || "").match(/(\d+)\s*\/\s*(\d+)\s*items/i);
    if (!match) return null;
    return { purchased: parseInt(match[1], 10), limit: parseInt(match[2], 10) };
  }

  async function processAbroadShopping() {
    try {
      console.log("[AutoFly2] Processing abroad shopping");
      const stockTableWrapper = await waitForStockTable();
      if (!stockTableWrapper) { console.warn("[AutoFly2] No stock table — flying home anyway"); }

      if (stockTableWrapper) {
        const purchaseInfo = getPurchaseInfo();
        let remainingSlots = purchaseInfo ? purchaseInfo.limit - purchaseInfo.purchased : Infinity;

        if (remainingSlots > 0) {
          const rows = Array.from(stockTableWrapper.querySelectorAll('li > [class^="row___"]'));
          const nameToRow = new Map();
          for (const r of rows) {
            const nc = r.querySelector('[data-tt-content-type="name"]');
            const bc = r.querySelector('[data-tt-content-type="buy"]');
            if (nc && bc) nameToRow.set(nc.textContent.trim().toLowerCase(), r);
          }

          for (const listItem of loadShoppingList()) {
            if (remainingSlots <= 0) break;
            const lowerItem = listItem.toLowerCase();
            let matchKey = null;
            for (const shopName of nameToRow.keys()) {
              if (shopName.includes(lowerItem) || lowerItem.includes(shopName)) { matchKey = shopName; break; }
            }
            if (!matchKey) continue;

            const row = nameToRow.get(matchKey);
            nameToRow.delete(matchKey);
            const nameCell = row.querySelector('[data-tt-content-type="name"]');
            const buyCell = row.querySelector('[data-tt-content-type="buy"]');
            const amountCell = row.querySelector('[data-tt-content-type="amount"]');
            const itemName = nameCell.textContent.trim();
            console.log(`[AutoFly2] Buying ${itemName}`);

            const maxBtn = (amountCell || row).querySelector(
              '[class*="wai-btn"], .input-money-symbol input.wai-btn, .input-money-symbol button, input.wai-btn'
            );
            if (maxBtn) { safeClick(maxBtn); await delay(500); }

            const buyBtn = buyCell.querySelector("button");
            if (!buyBtn) continue;
            const panelId = buyBtn.getAttribute("aria-controls");
            safeClick(buyBtn);
            await delay(300);

            let yesBtn = null;
            let clickedBuyBtn = false;
            const deadline = Date.now() + 6000;
            while (Date.now() < deadline) {
              const panel = panelId ? document.getElementById(panelId) : null;
              const panelBtns = panel ? [...panel.querySelectorAll("button")] : [];
              yesBtn = panelBtns.find(b => /^yes$/i.test((b.textContent || "").trim()));
              if (!yesBtn) {
                for (const cp of document.querySelectorAll('[class*="confirmPanel"]')) {
                  yesBtn = [...cp.querySelectorAll("button")].find(b => /^yes$/i.test((b.textContent || "").trim()));
                  if (yesBtn) break;
                }
              }
              if (yesBtn) break;
              if (!clickedBuyBtn && panelBtns.length > 0) {
                const interimBuy = panelBtns.find(b => /^buy$/i.test((b.textContent || "").trim()));
                if (interimBuy) { safeClick(interimBuy); clickedBuyBtn = true; await delay(400); continue; }
              }
              await delay(100);
            }

            if (yesBtn) {
              try { yesBtn.click(); } catch (e) {}
              remainingSlots--;
              console.log(`[AutoFly2] Confirmed purchase: ${itemName}`);
              await delay(800);
            } else if (clickedBuyBtn) {
              remainingSlots--;
              await delay(800);
            }
          }
        }
      }

      // Fly home
      console.log("[AutoFly2] Shopping done. Flying home...");
      const travelHomeBtn = document.querySelector('[aria-controls="travel-home-panel"]');
      safeClick(travelHomeBtn);
      await delay(500);
      const travelHomeConfirm = document.querySelector('#travel-home-panel button, [class*="confirmCancel"] button');
      safeClick(travelHomeConfirm);
    } catch (e) {
      console.warn("[AutoFly2] processAbroadShopping error", e);
    }
  }

  // =================== GYM ===================
  async function getEnergyStatus() {
    const data = await apiRequest("user", "bars");
    const e = data.energy || {};
    return { current: Number(e.current || 0), maximum: Number(e.maximum || 0), isFull: Number(e.current) >= Number(e.maximum) && Number(e.maximum) > 0 };
  }

  async function processGymTraining() {
    options = loadOptions();
    const stat = (options.gymStat || "strength").toLowerCase();
    console.log(`[AutoFly2] Gym: training ${stat}`);
    setPanelStatus(`Auto-gym: training ${stat}…`, "#f0a500");

    // Wait for the gym root to fully render
    await new Promise(resolve => {
      if (document.querySelector("#gymroot ul")) return resolve();
      const obs = new MutationObserver(() => { if (document.querySelector("#gymroot ul")) { obs.disconnect(); resolve(); } });
      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { obs.disconnect(); resolve(); }, 10000);
    });
    await wait(500);

    // Find the stat list item by class substring (e.g. li[class*="strength"])
    const statLi = document.querySelector(`#gymroot li[class*="${stat}"]`);
    if (!statLi) {
      setPanelStatus(`Auto-gym: ${stat} not found`, "#f66");
      console.warn(`[AutoFly2] Gym: no li for ${stat}`);
      return;
    }

    // Check if locked at this gym
    if (statLi.className.includes("locked")) {
      setPanelStatus(`Auto-gym: ${stat} unavailable at this gym`, "#f66");
      console.warn(`[AutoFly2] Gym: ${stat} is locked`);
      return;
    }

    // Find enabled train button
    const trainBtn = statLi.querySelector(`button[aria-label="Train ${stat}"]:not([disabled])`);
    if (!trainBtn) {
      setPanelStatus(`Auto-gym: ${stat} train button unavailable`, "#f66");
      return;
    }

    // Parse energy cost per train from description text ("25 energy per train")
    const descText = statLi.querySelector('[class*="description"]')?.textContent || "";
    const costMatch = descText.match(/(\d+)\s*energy per train/i);
    const costPerTrain = costMatch ? parseInt(costMatch[1], 10) : 25;

    // Parse current energy from gym notification ("You have 150/150 energy")
    const energyEl = document.querySelector('[class*="energy___"]');
    let currentEnergy = 0;
    if (energyEl) {
      const m = energyEl.textContent.match(/(\d+)\s*\/\s*(\d+)/);
      if (m) currentEnergy = parseInt(m[1], 10);
    }

    const maxTrains = Math.floor(currentEnergy / costPerTrain);
    if (maxTrains <= 0) {
      setPanelStatus("Auto-gym: not enough energy", "#666");
      return;
    }

    // Set the training count input
    const trainInput = statLi.querySelector('input[class*="input"]');
    if (trainInput) {
      trainInput.focus && trainInput.focus();
      trainInput.value = String(maxTrains);
      trainInput.dispatchEvent(new Event("input", { bubbles: true }));
      trainInput.dispatchEvent(new Event("change", { bubbles: true }));
      trainInput.blur && trainInput.blur();
    }
    await wait(300);

    safeClick(trainBtn);
    console.log(`[AutoFly2] Gym: clicked TRAIN ${stat} x${maxTrains} (${maxTrains * costPerTrain} energy)`);
    setPanelStatus(`Gym: trained ${stat} ×${maxTrains} — going home…`, "#44cc88");

    await wait(2500);
    location.href = "/index.php";
  }

  async function checkAndGoToGym() {
    options = loadOptions();
    if (!options.gymEnabled) return false;
    let energy;
    try { energy = await getEnergyStatus(); }
    catch (e) { console.warn("[AutoFly2] Energy check failed", e); return false; }
    if (!energy.isFull) {
      console.log(`[AutoFly2] Energy ${energy.current}/${energy.maximum} — not full, skipping gym`);
      return false;
    }
    console.log("[AutoFly2] Energy full — navigating to gym");
    setPanelStatus("Energy full — going to gym…", "#44cc88");
    await wait(500);
    location.href = "/gym.php";
    return true;
  }

  // =================== AUTO-FLY CHECK ===================
  // Runs every 60s when autoEnabled. Compares current TCT to flight plan.
  async function autoFlyCheck() {
    options = loadOptions();
    if (!options.autoEnabled) return;
    await wait(500);

    // On gym page — run training
    if (isGymPage()) {
      await processGymTraining();
      return;
    }

    // In-flight — initTravelWatch handles it
    if (isTraveling()) {
      console.log("[AutoFly2] In transit — waiting for arrival");
      return;
    }

    // Abroad — shop then fly home
    if (isAbroad()) {
      if (options.flyBackEnabled) {
        const waiting = await scheduleReviveReloadIfHospitalized();
        if (!waiting) await processAbroadShopping();
      } else {
        console.log("[AutoFly2] Abroad, fly-back disabled");
      }
      return;
    }

    // Back home — check if a flight just completed (was "flying", now home)
    const activeFlight = getActiveFlight();
    if (activeFlight) {
      if (activeFlight.loop) {
        // Loop flight: reset to pending immediately so it fires again
        console.log(`[AutoFly2] Loop flight to ${activeFlight.destination} complete — resetting to pending`);
        updateFlightStatus(activeFlight.id, "pending");
      } else {
        console.log(`[AutoFly2] Flight to ${activeFlight.destination} complete — marking done`);
        updateFlightStatus(activeFlight.id, "done");

        // If all non-loop flights done and repeat is on, reset plan
        if (options.repeatPlan) {
          const plan = loadFlightPlan();
          if (plan.every(f => f.loop || f.status === "done")) {
            plan.forEach(f => { if (!f.loop) f.status = "pending"; });
            saveFlightPlan(plan);
            console.log("[AutoFly2] All flights done — plan reset (repeat mode)");
          }
        }
      }
      renderFlightPlan();
    }

    if (isHospital()) {
      setPanelStatus("In hospital — paused");
      return;
    }

    // Gym takes priority over flights — go train if energy is full
    const wentToGym = await checkAndGoToGym();
    if (wentToGym) return;

    // Find the next flight ready to depart
    const nextFlight = getNextReadyFlight();
    if (!nextFlight) {
      // Show countdown to the next scheduled departure
      const plan = loadFlightPlan();
      const pending = plan.filter(f => f.status === "pending" && !f.loop);
      // Pending flights with no time are always ready — getNextReadyFlight should have caught them;
      // only show countdown for flights that actually have a future departure time.
      const scheduled = pending.filter(f => f.departureTime);
      if (scheduled.length > 0) {
        const now = getTCTTime();
        const soonest = scheduled.slice().sort((a, b) => a.departureTime.localeCompare(b.departureTime))[0];
        const [nh, nm] = now.split(":").map(Number);
        const [dh, dm] = soonest.departureTime.split(":").map(Number);
        let diffMin = (dh * 60 + dm) - (nh * 60 + nm);
        if (diffMin < 0) diffMin += 1440; // wraps at midnight
        const h = Math.floor(diffMin / 60), m = diffMin % 60;
        setPanelStatus(
          `Next: ${soonest.destination} at ${soonest.departureTime} TCT (in ${h > 0 ? h + "h " : ""}${m}m)`,
          "#aaa"
        );
      } else {
        setPanelStatus("No pending flights", "#666");
      }
      return;
    }

    // Cooldown guard
    const last = Number(sessionStorage.getItem(COOLDOWN_KEY) || 0);
    if (Date.now() - last < 10_000) { console.log("[AutoFly2] Cooldown active"); return; }

    // Navigate to travel page first if needed.
    // Do NOT mark as "flying" here — the flight stays "pending" until Travel is
    // actually clicked. Marking early caused the next page load to detect
    // "flying but home" and incorrectly mark the flight as done before departure.
    if (!location.pathname.includes("page.php") || !location.search.includes("sid=travel")) {
      console.log(`[AutoFly2] Navigating to travel page for ${nextFlight.destination}`);
      location.href = "/page.php?sid=travel";
      return;
    }

    // On travel page — click destination then Travel
    if (isTravelPage()) {
      await clickTravelDestination(nextFlight.destination);
      await wait(1500);
    }

    // Pre-fly countdown — gives time to withdraw money before departing from Torn
    const preflyDelay = Math.max(0, options.preflyDelay ?? 5);
    for (let i = preflyDelay; i > 0; i--) {
      setPanelStatus(`Flying to ${nextFlight.destination} in ${i}s — withdraw money if needed!`, "#f0a500");
      await wait(1000);
    }

    if (options.skipWarnings && clickFlyContinueControl()) {
      sessionStorage.setItem(COOLDOWN_KEY, String(Date.now()));
      updateFlightStatus(nextFlight.id, "flying");
      renderFlightPlan();
      await wait(500);
      location.reload();
      return;
    }

    if (clickFlyControl()) {
      sessionStorage.setItem(COOLDOWN_KEY, String(Date.now()));
      updateFlightStatus(nextFlight.id, "flying");
      renderFlightPlan();
      console.log(`[AutoFly2] Travel clicked for ${nextFlight.destination}`);
      if (options.skipWarnings) {
        await waitForContinueAndClick(5000);
        await wait(500);
      }
      location.reload();
      return;
    }

    // Observer fallback — wait for Travel button to appear
    const mo = new MutationObserver(async (m, o) => {
      if (options.skipWarnings && clickFlyContinueControl()) {
        o.disconnect();
        sessionStorage.setItem(COOLDOWN_KEY, String(Date.now()));
        updateFlightStatus(nextFlight.id, "flying");
        renderFlightPlan();
        await wait(500);
        location.reload();
        return;
      }
      if (clickFlyControl()) {
        sessionStorage.setItem(COOLDOWN_KEY, String(Date.now()));
        updateFlightStatus(nextFlight.id, "flying");
        renderFlightPlan();
        if (options.skipWarnings) return; // keep observing for Continue
        o.disconnect();
        location.reload();
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
    setTimeout(() => mo.disconnect(), 15000);
    console.log(`[AutoFly2] Waiting for Travel button for ${nextFlight.destination}`);
  }

  function startAutoCheck() {
    stopAutoCheck();
    options = loadOptions();
    if (!options.autoEnabled) return;
    autoFlyCheck();
    autoCheckIntervalId = setInterval(autoFlyCheck, 60_000);
  }
  function stopAutoCheck() {
    if (autoCheckIntervalId) { clearInterval(autoCheckIntervalId); autoCheckIntervalId = null; }
  }

  // =================== TCT CLOCK ===================
  function updateTCTClock() {
    const el = document.getElementById("tm-af2-tct-clock");
    if (!el) return;
    const now = new Date();
    const h = String(now.getUTCHours()).padStart(2, "0");
    const m = String(now.getUTCMinutes()).padStart(2, "0");
    const s = String(now.getUTCSeconds()).padStart(2, "0");
    el.textContent = `TCT ${h}:${m}:${s}`;
  }

  // =================== RENDER FLIGHT PLAN ===================
  function renderFlightPlan() {
    const container = document.getElementById("tm-af2-plan-list");
    if (!container) return;
    const plan = loadFlightPlan();
    if (plan.length === 0) {
      container.innerHTML = '<div style="color:#666;font-size:12px;padding:8px 0;">No flights planned. Add one below.</div>';
      return;
    }
    const now = getTCTTime();
    container.innerHTML = "";
    plan.forEach((flight, i) => {
      let statusColor, statusIcon;
      if (flight.status === "done") { statusColor = "#555"; statusIcon = "✓"; }
      else if (flight.status === "flying") { statusColor = "#4db8ff"; statusIcon = "✈"; }
      else if (flight.loop || !flight.departureTime || flight.departureTime <= now) { statusColor = "#44cc88"; statusIcon = "●"; }
      else { statusColor = "#eee"; statusIcon = "○"; }

      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;gap:4px;padding:4px 0;border-bottom:1px solid #2a2a2a;";
      const btnS = "padding:1px 5px;background:#222;border:1px solid #444;color:#ccc;border-radius:3px;cursor:pointer;font-size:11px;";
      const editS = "padding:1px 5px;background:#1a2a3a;border:1px solid #2a4a6a;color:#6af;border-radius:3px;cursor:pointer;font-size:11px;";
      const delS = "padding:1px 5px;background:#220000;border:1px solid #622;color:#f66;border-radius:3px;cursor:pointer;font-size:11px;";
      const loopS = flight.loop
        ? "padding:1px 5px;background:#1a3a1a;border:1px solid #2a6a2a;color:#4f4;border-radius:3px;cursor:pointer;font-size:11px;"
        : "padding:1px 5px;background:#222;border:1px solid #444;color:#555;border-radius:3px;cursor:pointer;font-size:11px;";
      const timeLabel = flight.loop
        ? `<span style="color:#4f4;font-size:10px;min-width:40px;font-weight:bold;" title="Loop — ignores schedule time">∞</span>`
        : flight.departureTime
          ? `<span style="color:#aaa;font-size:11px;min-width:40px;font-weight:bold;">${escHtml(flight.departureTime)}</span>`
          : `<span style="color:#44cc88;font-size:10px;min-width:40px;font-weight:bold;" title="No scheduled time — flies when ready">ASAP</span>`;
      row.innerHTML = [
        `<span style="color:${statusColor};font-size:13px;min-width:18px;text-align:center;">${statusIcon}</span>`,
        timeLabel,
        `<span style="flex:1;font-size:12px;color:${statusColor};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(flight.destination)}</span>`,
        `<button data-action="toggle-loop" data-idx="${i}" style="${loopS}" title="${flight.loop ? "Loop ON — click to disable" : "Loop OFF — click to enable continuous repeat"}">&#x21bb;</button>`,
        `<button data-action="edit-flight" data-idx="${i}" style="${editS}">✎</button>`,
        `<button data-action="up" data-idx="${i}" style="${btnS}"${i === 0 ? " disabled" : ""}>↑</button>`,
        `<button data-action="down" data-idx="${i}" style="${btnS}"${i === plan.length - 1 ? " disabled" : ""}>↓</button>`,
        `<button data-action="remove" data-idx="${i}" style="${delS}">×</button>`,
      ].join("");
      container.appendChild(row);
    });
  }

  // =================== RENDER SHOPPING LIST ===================
  function renderShoppingList() {
    const container = document.getElementById("tm-af2-items-list");
    const summary = document.getElementById("tm-af2-items-summary");
    if (!container) return;
    const list = loadShoppingList();
    if (summary) summary.textContent = `Shopping List (${list.length} item${list.length !== 1 ? "s" : ""}) — top = first bought`;
    container.innerHTML = "";
    list.forEach((item, i) => {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;gap:4px;padding:3px 0;border-bottom:1px solid #2a2a2a;";
      const btnS = "padding:1px 5px;background:#222;border:1px solid #444;color:#ccc;border-radius:3px;cursor:pointer;font-size:11px;line-height:1.4;";
      const editS = "padding:1px 5px;background:#1a2a3a;border:1px solid #2a4a6a;color:#6af;border-radius:3px;cursor:pointer;font-size:11px;line-height:1.4;";
      const delS = "padding:1px 5px;background:#220000;border:1px solid #622;color:#f66;border-radius:3px;cursor:pointer;font-size:11px;line-height:1.4;";
      row.innerHTML = [
        `<span style="color:#666;font-size:10px;min-width:16px;text-align:right;">${i + 1}.</span>`,
        `<button data-action="up" data-idx="${i}" style="${btnS}"${i === 0 ? " disabled" : ""}>↑</button>`,
        `<button data-action="down" data-idx="${i}" style="${btnS}"${i === list.length - 1 ? " disabled" : ""}>↓</button>`,
        `<span style="flex:1;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 4px;">${escHtml(item)}</span>`,
        `<button data-action="edit" data-idx="${i}" style="${editS}">✎</button>`,
        `<button data-action="remove" data-idx="${i}" style="${delS}">×</button>`,
      ].join("");
      container.appendChild(row);
    });
  }

  // =================== BUILD PANEL HTML ===================
  function buildPanel() {
    const el = document.createElement("div");
    el.id = "tm-af2-panel";
    el.style.cssText = "color:#eee;font-family:Arial,sans-serif;font-size:13px;box-sizing:border-box;width:100%;";
    el.innerHTML = `
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;box-sizing:border-box;width:100%;">

        <!-- Header -->
        <div style="display:flex;justify-content:space-between;align-items:center;flex:1 1 100%;">
          <strong>&#9992; Torn Flight Planner v2</strong>
          <span id="tm-af2-tct-clock" style="font-size:11px;color:#f0a500;font-weight:bold;font-variant-numeric:tabular-nums;"></span>
        </div>

        <!-- Status line -->
        <span id="tm-af2-status" style="flex:1 1 100%;color:#f0a500;font-weight:bold;font-size:12px;display:none;"></span>

        <!-- Options -->
        <div style="flex:1 1 100%;display:flex;gap:12px;flex-wrap:wrap;align-items:center;border-top:1px solid #333;padding-top:8px;">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;">
            <input id="tm-af2-auto-enabled" type="checkbox"> Auto-fly
          </label>
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;">
            <input id="tm-af2-fly-back" type="checkbox"> Fly back
          </label>
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;">
            <input id="tm-af2-skip-warnings" type="checkbox"> Skip warnings
          </label>
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;" title="When all flights are done, reset the whole plan and start over automatically">
            <input id="tm-af2-repeat-plan" type="checkbox"> Loop plan &#x21ba;
          </label>
          <label style="display:flex;align-items:center;gap:6px;user-select:none;" title="Seconds to wait on the travel page before clicking Travel — use this to withdraw money first">
            Delay:
            <input id="tm-af2-prefly-delay" type="number" min="0" max="120" step="1"
              style="width:44px;padding:2px 4px;border-radius:3px;border:1px solid #555;background:#111;color:#eee;font-size:12px;text-align:center;">
            s
          </label>
        </div>

        <!-- Flight Plan -->
        <details id="tm-af2-plan-toggle" open style="flex:1 1 100%;border-top:1px solid #333;padding-top:6px;">
          <summary style="cursor:pointer;color:#aaa;font-size:12px;user-select:none;list-style:none;display:flex;justify-content:space-between;align-items:center;">
            <span style="font-weight:bold;">Flight Plan <span style="font-weight:normal;color:#666;font-size:11px;">(sorted by departure time)</span></span>
            <button id="tm-af2-reset-done" style="padding:2px 8px;background:#222;border:1px solid #444;color:#aaa;border-radius:3px;cursor:pointer;font-size:11px;">Reset Done</button>
          </summary>
          <div id="tm-af2-plan-list" style="margin-top:6px;max-height:220px;overflow-y:auto;"></div>
          <!-- Add flight row -->
          <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;align-items:center;">
            <select id="tm-af2-new-dest" style="flex:1;min-width:130px;padding:4px 6px;border-radius:4px;border:1px solid #555;background:#111;color:#eee;font-size:12px;box-sizing:border-box;">
              ${VALID_DESTINATIONS.map(d => `<option>${escHtml(d)}</option>`).join("")}
            </select>
            <input id="tm-af2-new-time" type="text" placeholder="HH:MM" maxlength="5"
              title="Enter time in TCT (UTC) 24-hour format, e.g. 14:30. Leave blank to fly immediately (ASAP)."
              style="padding:4px 6px;border-radius:4px;border:1px solid #555;background:#111;color:#eee;font-size:12px;box-sizing:border-box;width:70px;">
            <button id="tm-af2-add-flight" style="padding:4px 10px;border-radius:4px;border:1px solid #555;background:#333;color:#eee;cursor:pointer;font-size:12px;white-space:nowrap;">+ Add Flight</button>
          </div>
          <div style="color:#555;font-size:10px;margin-top:4px;">Time is optional (TCT/UTC). ASAP = no time set, flies when ready. ● = ready. ✈ = flying. ✓ = done. &#x21bb; = loop.</div>
        </details>

        <!-- Gym -->
        <details id="tm-af2-gym-toggle" style="flex:1 1 100%;border-top:1px solid #333;padding-top:6px;">
          <summary style="cursor:pointer;color:#aaa;font-size:12px;user-select:none;list-style:none;font-weight:bold;">Auto-Gym &#x1F3CB;</summary>
          <div style="margin-top:8px;display:flex;gap:12px;flex-wrap:wrap;align-items:center;">
            <label style="display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;" title="Automatically go to gym and train when energy is full (priority over flights)">
              <input id="tm-af2-gym-enabled" type="checkbox"> Enable (trains before flying when full)
            </label>
            <label style="display:flex;align-items:center;gap:6px;user-select:none;">
              Stat:
              <select id="tm-af2-gym-stat" style="padding:2px 6px;border-radius:3px;border:1px solid #555;background:#111;color:#eee;font-size:12px;">
                <option value="strength">Strength</option>
                <option value="defense">Defense</option>
                <option value="speed">Speed</option>
                <option value="dexterity">Dexterity</option>
              </select>
            </label>
          </div>
        </details>

        <!-- Shopping List -->
        <details id="tm-af2-items-toggle" style="flex:1 1 100%;border-top:1px solid #333;padding-top:6px;">
          <summary id="tm-af2-items-summary" style="cursor:pointer;color:#aaa;font-size:12px;user-select:none;list-style:none;">Shopping List (0 items) — top = first bought</summary>
          <div id="tm-af2-items-list" style="margin-top:6px;max-height:200px;overflow-y:auto;"></div>
          <div style="display:flex;gap:6px;margin-top:6px;">
            <input id="tm-af2-item-input" type="text" placeholder="Item name to add..."
              style="flex:1;padding:4px 6px;border-radius:4px;border:1px solid #555;background:#111;color:#eee;font-size:12px;box-sizing:border-box;">
            <button id="tm-af2-item-add" style="padding:4px 8px;border-radius:4px;border:1px solid #555;background:#333;color:#eee;cursor:pointer;font-size:12px;white-space:nowrap;">+ Add</button>
          </div>
        </details>

      </div>
    `;
    return el;
  }

  // =================== WIRE UI EVENTS ===================
  function wireUI() {
    options = loadOptions();

    // Options checkboxes
    const autoEl = document.getElementById("tm-af2-auto-enabled");
    const flyBackEl = document.getElementById("tm-af2-fly-back");
    const skipEl = document.getElementById("tm-af2-skip-warnings");
    const repeatEl = document.getElementById("tm-af2-repeat-plan");
    const delayEl = document.getElementById("tm-af2-prefly-delay");

    if (autoEl) {
      autoEl.checked = !!options.autoEnabled;
      flyBackEl && (flyBackEl.checked = !!options.flyBackEnabled);
      skipEl && (skipEl.checked = !!options.skipWarnings);
      repeatEl && (repeatEl.checked = !!options.repeatPlan);
      delayEl && (delayEl.value = String(options.preflyDelay ?? 5));

      autoEl.addEventListener("change", () => {
        options.autoEnabled = !!autoEl.checked;
        saveOptions(options);
        if (options.autoEnabled) startAutoCheck(); else stopAutoCheck();
      });
      flyBackEl && flyBackEl.addEventListener("change", () => {
        options.flyBackEnabled = !!flyBackEl.checked; saveOptions(options);
      });
      skipEl && skipEl.addEventListener("change", () => {
        options.skipWarnings = !!skipEl.checked; saveOptions(options);
      });
      repeatEl && repeatEl.addEventListener("change", () => {
        options.repeatPlan = !!repeatEl.checked; saveOptions(options);
      });
      delayEl && delayEl.addEventListener("change", () => {
        const v = Math.max(0, Math.min(120, parseInt(delayEl.value, 10) || 0));
        delayEl.value = String(v);
        options.preflyDelay = v;
        saveOptions(options);
      });
    }

    // Gym controls
    const gymEnabledEl = document.getElementById("tm-af2-gym-enabled");
    const gymStatEl = document.getElementById("tm-af2-gym-stat");
    if (gymEnabledEl) {
      gymEnabledEl.checked = !!options.gymEnabled;
      gymEnabledEl.addEventListener("change", () => {
        options.gymEnabled = !!gymEnabledEl.checked; saveOptions(options);
      });
    }
    if (gymStatEl) {
      gymStatEl.value = options.gymStat || "strength";
      gymStatEl.addEventListener("change", () => {
        options.gymStat = gymStatEl.value; saveOptions(options);
      });
    }

    // Reset Done button
    const resetBtn = document.getElementById("tm-af2-reset-done");
    if (resetBtn) {
      resetBtn.addEventListener("click", e => { e.stopPropagation(); resetDoneFlights(); });
    }

    // Flight plan list — up/down/edit/remove via event delegation
    const planList = document.getElementById("tm-af2-plan-list");
    if (planList) {
      renderFlightPlan();
      planList.addEventListener("click", e => {
        const btn = e.target.closest("button[data-action]");
        if (!btn) return;
        const action = btn.dataset.action;
        const idx = parseInt(btn.dataset.idx, 10);
        const plan = loadFlightPlan();

        if (action === "edit-flight") {
          const flight = plan[idx];
          if (!flight) return;
          const row = btn.closest("div");
          const timeInpS = "padding:2px 4px;border-radius:3px;border:1px solid #555;background:#111;color:#eee;font-size:11px;box-sizing:border-box;width:80px;";
          const destSelS = "flex:1;min-width:0;padding:2px 4px;border-radius:3px;border:1px solid #555;background:#111;color:#eee;font-size:11px;box-sizing:border-box;";
          const saveS = "padding:1px 5px;background:#1a3a1a;border:1px solid #2a6a2a;color:#6f6;border-radius:3px;cursor:pointer;font-size:11px;";
          const cancelS = "padding:1px 5px;background:#220000;border:1px solid #622;color:#f66;border-radius:3px;cursor:pointer;font-size:11px;";
          row.innerHTML = [
            `<input type="text" placeholder="HH:MM" maxlength="5" data-edit-time="${idx}" value="${escHtml(flight.departureTime)}" style="${timeInpS}">`,
            `<select data-edit-dest="${idx}" style="${destSelS}">`,
            VALID_DESTINATIONS.map(d => `<option${d === flight.destination ? " selected" : ""}>${escHtml(d)}</option>`).join(""),
            `</select>`,
            `<button data-action="save-flight" data-idx="${idx}" style="${saveS}">✓</button>`,
            `<button data-action="cancel-flight" data-idx="${idx}" style="${cancelS}">✗</button>`,
          ].join("");
          const timeInp = row.querySelector("input[data-edit-time]");
          timeInp && timeInp.focus();
          timeInp && timeInp.addEventListener("keydown", ev => {
            if (ev.key === "Enter") { ev.preventDefault(); row.querySelector('[data-action="save-flight"]').click(); }
            if (ev.key === "Escape") { ev.preventDefault(); renderFlightPlan(); }
          });

        } else if (action === "save-flight") {
          const row = btn.closest("div");
          const newTime = (row.querySelector("input[data-edit-time]") || {}).value || "";
          const newDest = (row.querySelector("select[data-edit-dest]") || {}).value || "";
          if (newDest && plan[idx]) {
            plan[idx].departureTime = newTime; // empty string = no scheduled time, fires ASAP
            plan[idx].destination = newDest;
            // Re-activate "done" flights that are being rescheduled
            if (plan[idx].status === "done") plan[idx].status = "pending";
            saveFlightPlan(plan);
          }
          renderFlightPlan();
          // Re-evaluate immediately so the new time takes effect without waiting 60s
          autoFlyCheck();

        } else if (action === "cancel-flight") {
          renderFlightPlan();

        } else if (action === "toggle-loop") {
          if (plan[idx]) {
            plan[idx].loop = !plan[idx].loop;
            // A newly-looped flight that is "done" should be reset to "pending"
            if (plan[idx].loop && plan[idx].status === "done") plan[idx].status = "pending";
            saveFlightPlan(plan);
            renderFlightPlan();
            autoFlyCheck();
          }
        } else {
          if (action === "remove") plan.splice(idx, 1);
          else if (action === "up" && idx > 0) [plan[idx - 1], plan[idx]] = [plan[idx], plan[idx - 1]];
          else if (action === "down" && idx < plan.length - 1) [plan[idx], plan[idx + 1]] = [plan[idx + 1], plan[idx]];
          saveFlightPlan(plan);
          renderFlightPlan();
          autoFlyCheck();
        }
      });
    }

    // Add flight button
    const addFlightBtn = document.getElementById("tm-af2-add-flight");
    if (addFlightBtn) {
      addFlightBtn.addEventListener("click", () => {
        const destEl = document.getElementById("tm-af2-new-dest");
        const timeEl = document.getElementById("tm-af2-new-time");
        const dest = (destEl && destEl.value) || "";
        const time = (timeEl && timeEl.value) || "";
        if (!dest) return;
        const plan = loadFlightPlan();
        plan.push({ id: genId(), destination: dest, departureTime: time, status: "pending", loop: false });
        saveFlightPlan(plan);
        renderFlightPlan();
        const toggle = document.getElementById("tm-af2-plan-toggle");
        if (toggle && !toggle.open) toggle.open = true;
      });
    }

    // Shopping list — up/down/edit/remove via event delegation
    const itemsList = document.getElementById("tm-af2-items-list");
    if (itemsList) {
      renderShoppingList();
      itemsList.addEventListener("click", e => {
        const btn = e.target.closest("button[data-action]");
        if (!btn) return;
        const action = btn.dataset.action;
        const idx = parseInt(btn.dataset.idx, 10);
        const list = loadShoppingList();

        if (action === "edit") {
          // Switch row to inline edit mode
          const row = btn.closest("div");
          const inputS = "flex:1;padding:2px 5px;border-radius:3px;border:1px solid #555;background:#111;color:#eee;font-size:12px;box-sizing:border-box;min-width:0;";
          const saveS = "padding:1px 5px;background:#1a3a1a;border:1px solid #2a6a2a;color:#6f6;border-radius:3px;cursor:pointer;font-size:11px;line-height:1.4;";
          const cancelS = "padding:1px 5px;background:#220000;border:1px solid #622;color:#f66;border-radius:3px;cursor:pointer;font-size:11px;line-height:1.4;";
          row.innerHTML = [
            `<span style="color:#666;font-size:10px;min-width:16px;text-align:right;">${idx + 1}.</span>`,
            `<input type="text" data-edit-idx="${idx}" value="${escHtml(list[idx])}" style="${inputS}">`,
            `<button data-action="save-edit" data-idx="${idx}" style="${saveS}">✓</button>`,
            `<button data-action="cancel-edit" data-idx="${idx}" style="${cancelS}">✗</button>`,
          ].join("");
          const input = row.querySelector("input");
          input.focus();
          input.select();
          input.addEventListener("keydown", ev => {
            if (ev.key === "Enter") { ev.preventDefault(); row.querySelector('[data-action="save-edit"]').click(); }
            if (ev.key === "Escape") { ev.preventDefault(); renderShoppingList(); }
          });

        } else if (action === "save-edit") {
          const row = btn.closest("div");
          const input = row.querySelector("input[data-edit-idx]");
          const newVal = (input ? input.value : "").trim();
          if (newVal && !list.some((x, i) => i !== idx && x.toLowerCase() === newVal.toLowerCase())) {
            list[idx] = newVal;
            saveShoppingList(list);
          }
          renderShoppingList();

        } else if (action === "cancel-edit") {
          renderShoppingList();

        } else {
          if (action === "remove") list.splice(idx, 1);
          else if (action === "up" && idx > 0) [list[idx - 1], list[idx]] = [list[idx], list[idx - 1]];
          else if (action === "down" && idx < list.length - 1) [list[idx], list[idx + 1]] = [list[idx + 1], list[idx]];
          saveShoppingList(list);
          renderShoppingList();
        }
      });
    }

    // Shopping list add
    const itemAddBtn = document.getElementById("tm-af2-item-add");
    const itemInput = document.getElementById("tm-af2-item-input");
    if (itemAddBtn && itemInput) {
      const doAdd = () => {
        const val = itemInput.value.trim();
        if (!val) return;
        const list = loadShoppingList();
        if (!list.some(x => x.toLowerCase() === val.toLowerCase())) {
          list.push(val);
          saveShoppingList(list);
          renderShoppingList();
          const t = document.getElementById("tm-af2-items-toggle");
          if (t && !t.open) t.open = true;
        }
        itemInput.value = "";
      };
      itemAddBtn.addEventListener("click", doAdd);
      itemInput.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); doAdd(); } });
    }
  }

  // =================== INJECT UI ===================
  function injectUI() {
    if (document.getElementById("tm-af2-panel")) return;
    const panel = buildPanel();

    if (isMobile()) {
      if (document.getElementById("tm-af2-fab")) return;
      console.log("[AutoFly2] Mobile — injecting FAB");

      const fab = document.createElement("button");
      fab.id = "tm-af2-fab";
      fab.innerHTML = "&#9992;";
      fab.style.cssText = [
        "position:fixed","bottom:24px","right:16px",
        "width:52px","height:52px","border-radius:50%",
        "background:#1a1a1a","border:2px solid #555",
        "color:#eee","font-size:26px","line-height:1",
        "z-index:999999","cursor:pointer",
        "display:flex","align-items:center","justify-content:center",
        "box-shadow:0 3px 10px rgba(0,0,0,0.6)","touch-action:manipulation",
      ].join(";");
      document.body.appendChild(fab);

      const backdrop = document.createElement("div");
      backdrop.id = "tm-af2-modal";
      backdrop.style.cssText = [
        "position:fixed","inset:0","background:rgba(0,0,0,0.65)",
        "z-index:999998","display:none","align-items:flex-end",
      ].join(";");
      const sheet = document.createElement("div");
      sheet.style.cssText = [
        "background:#1a1a1a","border:1px solid #444","border-radius:16px 16px 0 0",
        "padding:16px","width:100%","box-sizing:border-box","max-height:85vh","overflow-y:auto",
      ].join(";");
      const handle = document.createElement("div");
      handle.style.cssText = "width:40px;height:4px;background:#555;border-radius:2px;margin:0 auto 14px;";
      sheet.appendChild(handle);
      sheet.appendChild(panel);
      backdrop.appendChild(sheet);
      document.body.appendChild(backdrop);

      const openModal = () => { backdrop.style.display = "flex"; initHospitalWatch(); };
      const closeModal = () => { backdrop.style.display = "none"; };
      fab.addEventListener("click", () => { backdrop.style.display === "flex" ? closeModal() : openModal(); });
      backdrop.addEventListener("click", e => { if (e.target === backdrop) closeModal(); });

    } else {
      const onTravel = isTravelPage();
      const target = onTravel
        ? document.querySelector("#travel-root .wrapper") || document.querySelector("#travel-root") ||
          document.querySelector(".content-title") || document.querySelector("main") ||
          document.querySelector('[role="main"]') || document.querySelector(".maincon") || document.body
        : document.querySelector(".content-title") || document.querySelector("main") ||
          document.querySelector('[role="main"]') || document.querySelector(".maincon") || document.body;

      panel.style.cssText += ";background:#1a1a1a;border:1px solid #444;border-radius:8px;padding:12px;margin:10px 0;max-width:100%;";

      if (onTravel && (target.classList.contains("wrapper") || target.id === "travel-root")) {
        target.insertBefore(panel, target.firstChild);
      } else if (target === document.body) {
        document.body.insertAdjacentElement("afterbegin", panel);
      } else {
        target.parentNode.insertBefore(panel, target.nextSibling);
      }
    }

    wireUI();

    // Live TCT clock
    if (tctClockTimer) clearInterval(tctClockTimer);
    updateTCTClock();
    tctClockTimer = setInterval(updateTCTClock, 1000);

    // Re-render flight plan colors every 30s (time passing may change "ready" status)
    setInterval(renderFlightPlan, 30_000);
  }

  // =================== INIT ===================
  console.log("[AutoFly2] starting. mobile=" + isMobile() + " ua=" + navigator.userAgent.slice(0, 60));

  try { injectUI(); } catch (e) { console.error("[AutoFly2] injectUI failed:", e); }

  // Re-inject if SPA wipes the panel
  setInterval(() => {
    if (isMobile() && !document.getElementById("tm-af2-fab")) {
      console.log("[AutoFly2] FAB missing — re-injecting");
      try { injectUI(); } catch (e) {}
    }
  }, 1000);

  const uiObserver = new MutationObserver(() => {
    if (isMobile()) {
      if (!document.getElementById("tm-af2-fab") && !document.getElementById("tm-af2-panel")) injectUI();
    } else {
      injectUI();
    }
  });
  uiObserver.observe(document.documentElement, { childList: true, subtree: true });

  startAutoCheck();
  initHospitalWatch();
  initTravelWatch();
  if (isGymPage()) {
    options = loadOptions();
    if (options.gymEnabled) processGymTraining().catch(e => console.warn("[AutoFly2] gymTraining error", e));
  }

  try {
    window.tmAutoFly2 = {
      loadFlightPlan, saveFlightPlan, loadOptions, saveOptions,
      getTCTTime, getNextReadyFlight, getActiveFlight,
      resetDoneFlights, autoFlyCheck, startAutoCheck, stopAutoCheck,
      renderFlightPlan,
    };
    console.log("[AutoFly2] helpers at window.tmAutoFly2");
  } catch (e) {}
})();
