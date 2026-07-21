// ==UserScript==
// @name         Torn Auto Fly Abroad
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  Auto-fly to abroad on Torn with an injected UI (settings saved to localStorage)
// @author       GitHub Copilot
// @match        https://www.torn.com
// @match        https://www.torn.com/index.php
// @match        https://www.torn.com/page.php?sid=travel*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const KEY = "tmAutoFlySettings";
  const COOLDOWN_KEY = "tmAutoFlyLast";
  const VALID_DESTINATIONS = [
    "Mexico",
    "Cayman Islands",
    "Canada",
    "Hawaii",
    "United Kingdom",
    "Argentina",
    "Switzerland",
    "Japan",
    "China",
    "United Arab Emirates",
    "South Africa",
  ];

  // Default shopping list — used when no user-managed list is saved.
  const SHOPPING_LIST_DEFAULT = [
    "Camel Plushie",
    "Chamois Plushie",
    "Jaguar Plushie",
    "Kitten Plushie",
    "Lion Plushie",
    "Monkey Plushie",
    "Nessie Plushie",
    "Panda Plushie",
    "Red Fox Plushie",
    "Sheep Plushie",
    "Stingray Plushie",
    "Teddy Bear Plushie",
    "Wolverine Plushie",
    "African Violet",
    "Banana Orchid",
    "Bunch of Black Roses",
    "Bunch of Carnations",
    "Bunch of Flowers",
    "Ceibo Flower",
    "Cherry Blossom",
    "Crocus",
    "Daffodil",
    "Dahlia",
    "Dozen Roses",
    "Dozen White Roses",
    "Edelweiss",
    "Funeral Wreath",
    "Heather",
    "Orchid",
    "Peony",
    "Single Red Rose",
    "Tribulus Omanense",
    "White Lily",
  ];

  function loadSettings() {
    try {
      return Object.assign(
        { flyOutEnabled: false, flyBackEnabled: false, intervalMinutes: 5, skipWarnings: false },
        JSON.parse(localStorage.getItem(KEY) || "{}"),
      );
    } catch (e) {
      return { flyOutEnabled: false, flyBackEnabled: false, intervalMinutes: 5, skipWarnings: false };
    }
  }
  function saveSettings(s) {
    try {
      localStorage.setItem(KEY, JSON.stringify(s));
    } catch (e) {}
  }

  // --- Shopping list management ---
  const SHOPPING_LIST_KEY = "tmShoppingList";

  function loadShoppingList() {
    try {
      const saved = JSON.parse(localStorage.getItem(SHOPPING_LIST_KEY) || "null");
      if (Array.isArray(saved)) return saved;
    } catch (e) {}
    return SHOPPING_LIST_DEFAULT.slice();
  }

  function saveShoppingList(list) {
    try {
      localStorage.setItem(SHOPPING_LIST_KEY, JSON.stringify(list));
    } catch (e) {}
  }

  function escHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function renderShoppingList() {
    const container = document.getElementById("tm-autofly-items-list");
    const summary = document.getElementById("tm-autofly-items-summary");
    if (!container) return;
    const list = loadShoppingList();
    if (summary) {
      summary.textContent = `Shopping List (${list.length} item${list.length !== 1 ? "s" : ""}) — top = first bought`;
    }
    container.innerHTML = "";
    list.forEach((item, i) => {
      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;gap:4px;padding:3px 0;border-bottom:1px solid #2a2a2a;";
      const btnStyle = "padding:1px 5px;background:#222;border:1px solid #444;color:#ccc;border-radius:3px;cursor:pointer;font-size:11px;line-height:1.4;";
      row.innerHTML = [
        `<span style="color:#666;font-size:10px;min-width:16px;text-align:right;">${i + 1}.</span>`,
        `<button data-action="up" data-idx="${i}" style="${btnStyle}"${i === 0 ? " disabled" : ""}>↑</button>`,
        `<button data-action="down" data-idx="${i}" style="${btnStyle}"${i === list.length - 1 ? " disabled" : ""}>↓</button>`,
        `<span style="flex:1;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 4px;">${escHtml(item)}</span>`,
        `<button data-action="remove" data-idx="${i}" style="${btnStyle.replace("#ccc","#f66").replace("#444","#622")}">×</button>`,
      ].join("");
      container.appendChild(row);
    });
  }
  // --- end shopping list management ---

  let settings = loadSettings();
  let intervalId = null;
  let reviveTimer = null; // scheduled reload when hospital ends abroad
  let reviveCountdownTimer = null;
  let travelReloadTimer = null;
  let travelDomPollerId = null;
  let travelCountdownTimer = null;

  function formatMs(ms) {
    return Math.round(ms / 1000) + "s";
  }

  // ------------------------------------------------------------------
  // Torn API (reuses the key/request pattern from property-vault.user.js).
  // Used to find the exact hospital release time when abroad.
  // ------------------------------------------------------------------
  const API_KEY = "v6Yo75UQIYvWYrhT";

  async function apiRequest(section, selections) {
    const res = await fetch(
      `https://api.torn.com/${section}/?selections=${selections}&key=${API_KEY}`,
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(`[${data.error.code}] ${data.error.error}`);
    return data;
  }

  // Returns { state, until, secondsRemaining }; secondsRemaining is 0 when not
  // hospitalised. `until` is a UNIX timestamp (seconds) — the revive time.
  async function getHospitalStatus() {
    const data = await apiRequest("user", "basic");
    const st = data.status || {};
    const now = Math.floor(Date.now() / 1000);
    const secondsRemaining =
      st.state === "Hospital" && st.until > now ? st.until - now : 0;
    return { state: st.state, until: st.until || 0, secondsRemaining };
  }

  // Always-visible floating badge (mobile hides the panel inside the FAB sheet,
  // so the countdown needs its own on-screen element).
  function getCountdownBadge() {
    let b = document.getElementById("tm-autofly-countdown-badge");
    if (!b) {
      b = document.createElement("div");
      b.id = "tm-autofly-countdown-badge";
      b.style.cssText = [
        "position:fixed",
        "bottom:84px",
        "right:16px",
        "max-width:220px",
        "padding:8px 12px",
        "background:#1a1a1a",
        "border:2px solid #f0a500",
        "border-radius:10px",
        "color:#f0a500",
        "font-weight:bold",
        "font-family:Arial,sans-serif",
        "font-size:13px",
        "line-height:1.3",
        "z-index:999999",
        "box-shadow:0 3px 10px rgba(0,0,0,0.6)",
        "display:none",
        "text-align:center",
        "pointer-events:none",
      ].join(";");
      document.body.appendChild(b);
    }
    return b;
  }

  function setReviveCountdown(secs) {
    if (reviveCountdownTimer) {
      clearInterval(reviveCountdownTimer);
      reviveCountdownTimer = null;
    }
    let remaining = Math.max(0, Math.floor(secs));
    const render = () => {
      // Re-acquire (re-create) the badge every tick — the SPA can wipe
      // body-appended nodes on re-render, which would otherwise leave us
      // updating a detached element that's no longer on screen.
      const badge = getCountdownBadge();
      const panelEl = document.getElementById("tm-autofly-status");
      const text =
        remaining <= 0
          ? "Out of hospital — resuming…"
          : `In hospital — reviving in ${Math.floor(remaining / 60)}m ${remaining % 60}s`;
      if (panelEl) {
        panelEl.textContent = text;
        panelEl.style.display = "";
      }
      badge.textContent = text;
      badge.style.display = "";
      if (remaining <= 0) {
        clearInterval(reviveCountdownTimer);
        reviveCountdownTimer = null;
        // Leave the "resuming" note briefly, then hide the badge.
        setTimeout(() => {
          const b = document.getElementById("tm-autofly-countdown-badge");
          if (b) b.style.display = "none";
        }, 4000);
        return;
      }
      remaining--;
    };
    render();
    reviveCountdownTimer = setInterval(render, 1000);
  }

  // Independent hospital check that runs on load regardless of fly settings, so
  // the revive countdown always appears when hospitalised on a page we run on.
  // Only schedules the auto-reload when abroad (to retry the shop + fly-home).
  function setPanelStatus(text) {
    const el = document.getElementById("tm-autofly-status");
    if (el) {
      el.textContent = text;
      el.style.display = "";
    }
  }

  async function initHospitalWatch() {
    let status;
    try {
      status = await getHospitalStatus();
    } catch (e) {
      console.warn("[AutoFly] initHospitalWatch API failed", e);
      setPanelStatus("Hospital check: API error (check API key access)");
      return;
    }
    if (status.secondsRemaining <= 0) {
      // Not in hospital — show current state so the panel gives feedback.
      setPanelStatus(`Not in hospital — state: ${status.state || "Okay"}`);
      return;
    }
    console.log(
      `[AutoFly] Hospitalized — revive in ${status.secondsRemaining}s (until ${status.until})`,
    );
    setReviveCountdown(status.secondsRemaining);
    const abroad =
      (document.body && document.body.dataset.abroad === "true") ||
      isAbroadOrTraveling();
    if (abroad && !reviveTimer) {
      reviveTimer = setTimeout(
        () => location.reload(),
        status.secondsRemaining * 1000 + 3000,
      );
    }
  }

  // Travel arrival watch — uses the API for exact time_left, with a 5s DOM
  // poller as a fallback for when the page hangs and doesn't auto-refresh.
  function setTravelCountdown(secs, dest) {
    if (travelCountdownTimer) {
      clearInterval(travelCountdownTimer);
      travelCountdownTimer = null;
    }
    let remaining = Math.max(0, Math.floor(secs));
    const render = () => {
      const badge = getCountdownBadge();
      badge.style.borderColor = "#4db8ff";
      badge.style.color = "#4db8ff";
      const text =
        remaining <= 0
          ? `Arrived at ${dest} — reloading…`
          : `Flying to ${dest} — ${Math.floor(remaining / 60)}m ${remaining % 60}s`;
      const panelEl = document.getElementById("tm-autofly-status");
      if (panelEl) {
        panelEl.textContent = text;
        panelEl.style.display = "";
      }
      badge.textContent = text;
      badge.style.display = "";
      if (remaining <= 0) {
        clearInterval(travelCountdownTimer);
        travelCountdownTimer = null;
        return;
      }
      remaining--;
    };
    render();
    travelCountdownTimer = setInterval(render, 1000);
  }

  function startTravelDomPoller() {
    if (travelDomPollerId) return;
    travelDomPollerId = setInterval(() => {
      const b = document.body;
      if (!b || b.dataset.traveling !== "true") {
        clearInterval(travelDomPollerId);
        travelDomPollerId = null;
        if (travelReloadTimer) { clearTimeout(travelReloadTimer); travelReloadTimer = null; }
        if (travelCountdownTimer) { clearInterval(travelCountdownTimer); travelCountdownTimer = null; }
        console.log("[AutoFly] Travel state cleared (DOM poller) — reloading");
        location.reload();
      }
    }, 5000);
  }

  async function initTravelWatch() {
    const b = document.body;
    if (!b || b.dataset.traveling !== "true") return; // not in-flight

    let travelInfo;
    try {
      const data = await apiRequest("user", "basic,travel");
      travelInfo = data.travel;
    } catch (e) {
      console.warn("[AutoFly] initTravelWatch API failed — falling back to DOM poller", e);
      startTravelDomPoller();
      return;
    }

    const secs = Number((travelInfo && travelInfo.time_left) || 0);
    const dest = (travelInfo && travelInfo.destination) || "destination";

    if (secs <= 0) {
      console.log("[AutoFly] Travel already complete (API) — reloading");
      location.reload();
      return;
    }

    console.log(`[AutoFly] Traveling to ${dest} — reloading in ${secs}s`);
    setTravelCountdown(secs, dest);

    if (!travelReloadTimer) {
      travelReloadTimer = setTimeout(() => {
        console.log("[AutoFly] Arrival time reached — reloading");
        location.reload();
      }, secs * 1000 + 3000);
    }

    // DOM poller runs in parallel as a belt-and-suspenders failsafe
    startTravelDomPoller();
  }

  // When abroad and hospitalised, look up the exact revive time via the API and
  // schedule a single page reload for that moment (so the abroad shop + fly-home
  // routine retries once we're out). Returns true if a wait was scheduled (i.e.
  // we are hospitalised), false if free to proceed now.
  async function scheduleReviveReloadIfHospitalized() {
    let status;
    try {
      status = await getHospitalStatus();
    } catch (e) {
      console.warn("[AutoFly] hospital status API failed, retrying in 30s", e);
      if (!reviveTimer) {
        reviveTimer = setTimeout(() => location.reload(), 30_000);
      }
      return true; // don't shop until we know we're clear
    }

    if (!status.secondsRemaining) return false; // not in hospital — proceed

    const secs = status.secondsRemaining;
    console.log(
      `[AutoFly] Hospitalized abroad — revive in ${secs}s (until ${status.until})`,
    );
    setReviveCountdown(secs);

    if (!reviveTimer) {
      // +3s buffer so the server-side release has definitely applied.
      reviveTimer = setTimeout(
        () => location.reload(),
        secs * 1000 + 3000,
      );
    }
    return true;
  }

  function isHospital() {
    return !!document.querySelector('li[class*="icon15"]');
  }
  function isAbroadOrTraveling() {
    const b = document.body;
    return (
      b &&
      b.dataset &&
      (b.dataset.abroad === "true" || b.dataset.traveling === "true")
    );
  }

  function findFlyControl(desiredCountry) {
    const btn = [
      ...document.querySelectorAll("button.torn-btn.btn-dark-bg"),
    ].find((el) => el.textContent.trim() === "Travel");
    return btn;
  }

  function findFlyContinueControl(desiredCountry) {
    const btn = [
      ...document.querySelectorAll("button.torn-btn.btn-dark-bg"),
    ].find((el) => el.textContent.trim() === "Continue");
    return btn;
  }

  function clickFlyControl() {
    const btn = findFlyControl(settings && settings.desiredCountry);
    if (!btn) return false;
    try {
      console.log(
        "[AutoFly] clickFlyControl attempting click on",
        btn,
        (btn.textContent || "").trim(),
        btn.href || "",
      );
      // Try native click first (works for buttons and anchors in most SPA setups)
      btn.click();
      return true;
    } catch (e) {
      // As a fallback, dispatch mouse events
      try {
        const evs = ["mousedown", "mouseup", "click"].map(
          (t) =>
            new MouseEvent(t, {
              bubbles: true,
              cancelable: true,
              view: window,
            }),
        );
        for (const ev of evs) btn.dispatchEvent(ev);
        return true;
      } catch (err) {
        // Last resort: only follow anchor hrefs that look like the travel page
        try {
          if (btn.tagName && btn.tagName.toLowerCase() === "a" && btn.href) {
            const href = (btn.href || "").toLowerCase();
            if (
              href.includes("sid=travel") ||
              href.includes("travel") ||
              href.includes("abroad")
            ) {
              location.href = btn.href;
              return true;
            } else {
              console.warn(
                "[AutoFly] anchor href not travel-related, not following:",
                btn.href,
              );
            }
          }
        } catch (nerr) {}
        console.warn("[AutoFly] clickFlyControl failed", err);
        return false;
      }
    }
  }

  function clickFlyContinueControl() {
    const btn = findFlyContinueControl(settings && settings.desiredCountry);
    if (!btn) return false;
    try {
      console.log(
        "[AutoFly] clickFlyContinueControl attempting click on",
        btn,
        (btn.textContent || "").trim(),
      );
      btn.click();
      return true;
    } catch (e) {
      try {
        const evs = ["mousedown", "mouseup", "click"].map(
          (t) =>
            new MouseEvent(t, {
              bubbles: true,
              cancelable: true,
              view: window,
            }),
        );
        for (const ev of evs) btn.dispatchEvent(ev);
        return true;
      } catch (err) {
        console.warn("[AutoFly] clickFlyContinueControl failed", err);
        return false;
      }
    }
  }

  // After clicking Travel a warning panel with a "Continue" button may appear
  // (e.g. active OC, booster cooldown). Wait for it and click it. Resolves true
  // if Continue was clicked, false if none appeared before the timeout.
  function waitForContinueAndClick(timeout = 5000) {
    return new Promise((resolve) => {
      if (clickFlyContinueControl()) return resolve(true);
      const obs = new MutationObserver(() => {
        if (clickFlyContinueControl()) {
          obs.disconnect();
          resolve(true);
        }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => {
        obs.disconnect();
        resolve(false);
      }, timeout);
    });
  }

  async function tryAutoFly() {
    // Give the page time to fully load on initial execution
    await wait(500);

    settings = loadSettings();
    if (!settings.flyOutEnabled && !settings.flyBackEnabled) return;
    // If already abroad, attempt shopping/fly-back routine
    try {
      const body = document.body || {};
      if (body.dataset && body.dataset.abroad === "true") {
        if (settings.flyBackEnabled) {
          // If hospitalised abroad, wait for revive (API) then retry on reload.
          const waiting = await scheduleReviveReloadIfHospitalized();
          if (!waiting) {
            await processAbroadShopping();
          }
        } else {
          console.log("[AutoFly] Abroad but fly-back is disabled, skipping");
        }
        return;
      }
    } catch (e) {}
    if (isHospital()) {
      console.log("[AutoFly] Paused: in hospital");
      return;
    }
    if (isAbroadOrTraveling()) {
      console.log("[AutoFly] Already abroad or traveling");
      return;
    }
    if (!settings.flyOutEnabled) {
      console.log("[AutoFly] Fly-out disabled, skipping travel initiation");
      return;
    }
    // cooldown guard (avoid repeating clicks)
    const last = Number(sessionStorage.getItem(COOLDOWN_KEY) || 0);
    if (Date.now() - last < 10_000) {
      console.log(
        "[AutoFly] cooldown active",
        formatMs(10_000 - (Date.now() - last)),
      );
      return;
    }

    if (
      !location.pathname.includes("page.php") ||
      !location.search.includes("sid=travel")
    ) {
      console.log("[AutoFly] Navigating to travel page to attempt fly");
      location.href = "/page.php?sid=travel";
      return;
    }

    // If desired country is set, attempt to set it first
    if (settings.desiredCountry) {
      if (isTravelPage()) {
        // On the travel page use clickTravelDestination exclusively — calling
        // setCountryOnTravelPage first would double-click the expand button,
        // toggling it closed before the Travel button appears.
        await clickTravelDestination(settings.desiredCountry);
        // give UI time to update after destination selection
        await wait(1500);
      } else {
        const setOk = setCountryOnTravelPage(settings.desiredCountry);
        if (setOk) {
          // give UI a moment to update after selection
          await wait(10000);
        }
      }
    }

    // A warning panel with a Continue button may already be showing — handle
    // it first before (re)clicking Travel.
    if (settings.skipWarnings && clickFlyContinueControl()) {
      sessionStorage.setItem(COOLDOWN_KEY, String(Date.now()));
      console.log("[AutoFly] Continue control clicked (skip warnings)");
      await wait(500);
      location.reload();
      return;
    }

    // Click the Travel button. On mobile this often reveals a warning panel
    // with a "Continue" button instead of travelling immediately. Reloading
    // right after the Travel click would discard that warning, so if skipping
    // warnings we must wait for Continue and click it BEFORE reloading.
    if (clickFlyControl()) {
      sessionStorage.setItem(COOLDOWN_KEY, String(Date.now()));
      console.log("[AutoFly] Fly control clicked");
      if (settings.skipWarnings) {
        const continued = await waitForContinueAndClick(5000);
        console.log(
          continued
            ? "[AutoFly] Continue clicked after warning"
            : "[AutoFly] No warning appeared after Travel",
        );
        await wait(500);
      }
      location.reload();
      return;
    }

    // If no control present yet, observe and click when it appears.
    const mo = new MutationObserver(async (m, o) => {
      // Prefer the warning's Continue button when skipping warnings.
      if (settings.skipWarnings && clickFlyContinueControl()) {
        o.disconnect();
        sessionStorage.setItem(COOLDOWN_KEY, String(Date.now()));
        console.log("[AutoFly] Continue appeared and was clicked (observer)");
        await wait(500);
        location.reload();
        return;
      }
      if (clickFlyControl()) {
        sessionStorage.setItem(COOLDOWN_KEY, String(Date.now()));
        console.log("[AutoFly] Travel appeared and was clicked (observer)");
        if (settings.skipWarnings) {
          // Keep observing so the follow-up Continue warning is caught above.
          return;
        }
        o.disconnect();
        location.reload();
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
    // stop observing after 15s
    setTimeout(() => mo.disconnect(), 15000);
    console.log("[AutoFly] Waiting for travel controls (observer started)");
  }

  function startTimer() {
    stopTimer();
    settings = loadSettings();
    if (!settings.flyOutEnabled && !settings.flyBackEnabled) return;
    tryAutoFly();
    intervalId = setInterval(
      () => {
        tryAutoFly();
        console.log("[AutoFly] Starting timer", getPurchaseInfo());
      },
      Math.max(1, settings.intervalMinutes || 5) * 60 * 1000,
    );
  }
  function stopTimer() {
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
  }

  function isTravelPage() {
    return !!(
      document.querySelector("#travel-root") ||
      (location.pathname.includes("page.php") && location.search.includes("sid=travel"))
    );
  }

  function isMobile() {
    return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || window.innerWidth < 768;
  }

  function injectUI() {
    if (document.getElementById("tm-autofly-panel")) return;

    // Build the shared panel element
    const panel = document.createElement("div");
    panel.id = "tm-autofly-panel";
    panel.style.cssText = "color:#eee;font-family:Arial,sans-serif;font-size:13px;box-sizing:border-box;width:100%;";
    panel.innerHTML = `
            <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center; box-sizing:border-box; width:100%;">
                <strong style="flex:1 1 100%;">Torn Auto Fly Abroad</strong>
                <label style="display:flex; align-items:center; gap:6px;">
                    <input id="tm-autofly-fly-out" type="checkbox"> Auto-fly from Torn
                </label>
                <label style="display:flex; align-items:center; gap:6px;">
                    <input id="tm-autofly-fly-back" type="checkbox"> Auto-fly back
                </label>
                <label style="display:flex; align-items:center; gap:6px;">
                    <input id="tm-autofly-skip-warnings" type="checkbox"> Skip warnings
                </label>
                <label style="display:flex; align-items:center; gap:6px;">
                    Interval (min):
                    <input id="tm-autofly-interval" type="number" min="1" value="${settings.intervalMinutes || 5}" style="width:60px; padding:4px 6px; border-radius:4px; border:1px solid #555; background:#111; color:#eee; box-sizing:border-box;">
                </label>
                <label style="display:flex; align-items:center; gap:6px; flex:1 1 auto; min-width:0;">
                    Destination:
                    <select id="tm-autofly-country-select" style="flex:1; min-width:0; padding:4px 6px; border-radius:4px; border:1px solid #555; background:#111; color:#eee; box-sizing:border-box;">
                        <option value="">Any</option>
                        ${VALID_DESTINATIONS.map((d) => `<option>${d}</option>`).join("")}
                    </select>
                </label>
                <span id="tm-autofly-status" style="flex:1 1 100%; color:#f0a500; font-weight:bold; white-space:normal; display:none;"></span>
                <details id="tm-autofly-items-toggle" style="flex:1 1 100%; margin-top:4px; border-top:1px solid #333; padding-top:6px;">
                    <summary id="tm-autofly-items-summary" style="cursor:pointer; color:#aaa; font-size:12px; user-select:none; list-style:none;">Shopping List (0 items) — top = first bought</summary>
                    <div id="tm-autofly-items-list" style="margin-top:6px; max-height:200px; overflow-y:auto;"></div>
                    <div style="display:flex; gap:6px; margin-top:6px;">
                        <input id="tm-autofly-item-input" type="text" placeholder="Item name to add..." style="flex:1; padding:4px 6px; border-radius:4px; border:1px solid #555; background:#111; color:#eee; box-sizing:border-box; font-size:12px;">
                        <button id="tm-autofly-item-add" style="padding:4px 8px; border-radius:4px; border:1px solid #555; background:#333; color:#eee; cursor:pointer; white-space:nowrap; font-size:12px;">+ Add</button>
                    </div>
                </details>
            </div>
        `;

    if (isMobile()) {
      // Floating action button — appended directly to body, outside any React container
      if (document.getElementById("tm-autofly-fab")) return;
      console.log("[AutoFly] mobile detected, injecting FAB");

      const fab = document.createElement("button");
      fab.id = "tm-autofly-fab";
      fab.innerHTML = "&#9992;"; // ✈
      fab.style.cssText = [
        "position:fixed", "bottom:24px", "right:16px",
        "width:52px", "height:52px", "border-radius:50%",
        "background:#1a1a1a", "border:2px solid #555",
        "color:#eee", "font-size:26px", "line-height:1",
        "z-index:999999", "cursor:pointer",
        "display:flex", "align-items:center", "justify-content:center",
        "box-shadow:0 3px 10px rgba(0,0,0,0.6)",
        "touch-action:manipulation",
      ].join(";");
      document.body.appendChild(fab);
      console.log("[AutoFly] FAB appended to body");

      // Backdrop + bottom sheet
      const backdrop = document.createElement("div");
      backdrop.id = "tm-autofly-modal";
      backdrop.style.cssText = [
        "position:fixed", "inset:0",
        "background:rgba(0,0,0,0.65)",
        "z-index:999998", "display:none",
        "align-items:flex-end",
      ].join(";");

      const sheet = document.createElement("div");
      sheet.style.cssText = [
        "background:#1a1a1a", "border:1px solid #444",
        "border-radius:16px 16px 0 0",
        "padding:16px", "width:100%",
        "box-sizing:border-box",
        "max-height:80vh", "overflow-y:auto",
      ].join(";");

      const handle = document.createElement("div");
      handle.style.cssText = "width:40px;height:4px;background:#555;border-radius:2px;margin:0 auto 14px;";
      sheet.appendChild(handle);
      sheet.appendChild(panel);
      backdrop.appendChild(sheet);
      document.body.appendChild(backdrop);

      const openModal = () => {
        backdrop.style.display = "flex";
        initHospitalWatch(); // refresh the status line on open
      };
      const closeModal = () => { backdrop.style.display = "none"; };
      fab.addEventListener("click", () => {
        backdrop.style.display === "flex" ? closeModal() : openModal();
      });
      backdrop.addEventListener("click", (e) => {
        if (e.target === backdrop) closeModal();
      });

    } else {
      // Desktop: inline insertion
      const onTravel = isTravelPage();
      const target = onTravel
        ? document.querySelector("#travel-root .wrapper") ||
          document.querySelector("#travel-root") ||
          document.querySelector(".content-title") ||
          document.querySelector("main") ||
          document.querySelector('[role="main"]') ||
          document.querySelector(".maincon") ||
          document.body
        : document.querySelector(".content-title") ||
          document.querySelector("main") ||
          document.querySelector('[role="main"]') ||
          document.querySelector(".maincon") ||
          document.body;

      panel.style.cssText += ";background:#1a1a1a;border:1px solid #444;border-radius:8px;padding:12px;margin:10px 0;max-width:100%;";

      if (onTravel && (target.classList.contains("wrapper") || target.id === "travel-root")) {
        target.insertBefore(panel, target.firstChild);
      } else if (target === document.body) {
        document.body.insertAdjacentElement("afterbegin", panel);
      } else {
        target.parentNode.insertBefore(panel, target.nextSibling);
      }
    }

    // Populate country selector from detected travel-page countries (if available)
    try {
      const sel = document.getElementById("tm-autofly-country-select");
      if (sel) {
        let available = [];
        if (isTravelPage()) {
          available = getAvailableCountries();
          if (available && available.length) {
            try {
              sessionStorage.setItem(
                "tmAvailableCountries",
                JSON.stringify(available),
              );
            } catch (e) {}
          }
        }
        if (!available.length) {
          try {
            available = JSON.parse(
              sessionStorage.getItem("tmAvailableCountries") || "[]",
            );
          } catch (e) {
            available = [];
          }
        }
        if (!available.length) {
          available = VALID_DESTINATIONS.slice();
        }
        if (available && available.length) {
          // rebuild options preserving 'Any'
          const html = ['<option value="">Any</option>']
            .concat(available.map((c) => `<option>${c}</option>`))
            .join("");
          sel.innerHTML = html;
        }
      }
    } catch (e) {}

    const $ = (id) => document.getElementById(id);
    const flyOutEl = $("tm-autofly-fly-out");
    const flyBackEl = $("tm-autofly-fly-back");
    const skipWarningsEl = $("tm-autofly-skip-warnings");
    const intervalEl = $("tm-autofly-interval");
    const selEl = $("tm-autofly-country-select");
    if (flyOutEl) {
      flyOutEl.checked = !!settings.flyOutEnabled;
      if (flyBackEl) flyBackEl.checked = !!settings.flyBackEnabled;
      if (skipWarningsEl) skipWarningsEl.checked = !!settings.skipWarnings;
      intervalEl.value = settings.intervalMinutes || 5;
      if (settings.desiredCountry) {
        const foundOpt = Array.from(selEl.options).find(
          (o) =>
            (o.text || "").toLowerCase() ===
            (settings.desiredCountry || "").toLowerCase(),
        );
        if (foundOpt) {
          selEl.value = foundOpt.text;
        } else {
          selEl.value = "";
        }
      } else {
        selEl.value = "";
      }

      // Auto-save on changes
      flyOutEl.addEventListener("change", () => {
        settings.flyOutEnabled = !!flyOutEl.checked;
        saveSettings(settings);
        if (settings.flyOutEnabled || settings.flyBackEnabled) startTimer();
        else stopTimer();
      });
      if (flyBackEl) {
        flyBackEl.addEventListener("change", () => {
          settings.flyBackEnabled = !!flyBackEl.checked;
          saveSettings(settings);
          if (settings.flyOutEnabled || settings.flyBackEnabled) startTimer();
          else stopTimer();
        });
      }
      intervalEl.addEventListener("change", () => {
        settings.intervalMinutes = Math.max(1, parseInt(intervalEl.value || 5));
        saveSettings(settings);
        startTimer();
      });
      if (skipWarningsEl) {
        skipWarningsEl.addEventListener("change", () => {
          settings.skipWarnings = !!skipWarningsEl.checked;
          saveSettings(settings);
        });
      }
      selEl.addEventListener("change", async () => {
        settings.desiredCountry = (selEl.value || "").trim();
        saveSettings(settings);
        // If on travel page, auto-click the destination
        if (
          settings.desiredCountry &&
          location.pathname.includes("page.php") &&
          location.search.includes("sid=travel")
        ) {
          await clickTravelDestination(settings.desiredCountry);
          // give UI time to update after destination selection
          await wait(1200);

          // If auto-fly is enabled, try to click the fly/travel control
          const enabledNow = !!(
            document.getElementById("tm-autofly-fly-out") &&
            document.getElementById("tm-autofly-fly-out").checked
          );
          if (enabledNow) {
            if (clickFlyControl()) {
              sessionStorage.setItem(COOLDOWN_KEY, String(Date.now()));
              console.log(
                "[AutoFly] Fly control clicked (from selector change)",
              );
            } else {
              // observe for fly control and click when it appears (fallback)
              const obs = new MutationObserver((m, o) => {
                if (
                  clickFlyControl() ||
                  (settings.skipWarnings && clickFlyContinueControl())
                ) {
                  sessionStorage.setItem(COOLDOWN_KEY, String(Date.now()));
                  console.log(
                    "[AutoFly] Fly/Continue control appeared and was clicked (observer from selector change)",
                  );
                  o.disconnect();
                }
              });
              obs.observe(document.body, { childList: true, subtree: true });
              setTimeout(() => obs.disconnect(), 15000);
            }
          }
        }
      });
    }

    // Shopping list UI wiring
    const itemsToggle = document.getElementById("tm-autofly-items-toggle");
    const itemsList = document.getElementById("tm-autofly-items-list");
    const itemInput = document.getElementById("tm-autofly-item-input");
    const itemAddBtn = document.getElementById("tm-autofly-item-add");

    if (itemsList) {
      renderShoppingList();

      // Up / Down / Remove via event delegation on the list container
      itemsList.addEventListener("click", (e) => {
        const btn = e.target.closest("button[data-action]");
        if (!btn) return;
        const action = btn.dataset.action;
        const idx = parseInt(btn.dataset.idx, 10);
        const list = loadShoppingList();
        if (action === "remove") {
          list.splice(idx, 1);
        } else if (action === "up" && idx > 0) {
          [list[idx - 1], list[idx]] = [list[idx], list[idx - 1]];
        } else if (action === "down" && idx < list.length - 1) {
          [list[idx], list[idx + 1]] = [list[idx + 1], list[idx]];
        }
        saveShoppingList(list);
        renderShoppingList();
      });
    }

    if (itemAddBtn && itemInput) {
      const doAdd = () => {
        const val = itemInput.value.trim();
        if (!val) return;
        const list = loadShoppingList();
        if (!list.some((x) => x.toLowerCase() === val.toLowerCase())) {
          list.push(val);
          saveShoppingList(list);
          renderShoppingList();
          // Auto-expand the section after adding
          if (itemsToggle && !itemsToggle.open) itemsToggle.open = true;
        }
        itemInput.value = "";
      };
      itemAddBtn.addEventListener("click", doAdd);
      itemInput.addEventListener("keydown", (e) => {
        if (e.key === "Enter") { e.preventDefault(); doAdd(); }
      });
    }
  }

  // Click the destination on the travel page — handles both desktop (radio buttons)
  // and mobile (expand buttons in a list).
  async function clickTravelDestination(countryName, retries = 3) {
    if (!countryName) return false;
    const low = countryName.toLowerCase();

    // Desktop layout: radio buttons with aria-label containing the country name
    const radioButtons = Array.from(
      document.querySelectorAll('input[type="radio"][name="destination"]'),
    );
    for (const radio of radioButtons) {
      const ariaLabel = (radio.getAttribute("aria-label") || "").toLowerCase();
      if (ariaLabel.includes(low)) {
        try {
          radio.click();
          console.log("[AutoFly] Clicked destination radio: " + countryName);
          return true;
        } catch (e) {
          console.warn("[AutoFly] Failed to click destination radio", e);
          return false;
        }
      }
    }

    // Mobile layout: expand buttons in a destination list.
    // Each button contains a <span class*="country"> with the country name.
    const expandButtons = Array.from(
      document.querySelectorAll('[class*="expandButton"]'),
    );
    for (const btn of expandButtons) {
      const countrySpan = btn.querySelector('[class*="country"]');
      if (
        countrySpan &&
        countrySpan.textContent.trim().toLowerCase().includes(low)
      ) {
        try {
          console.log("[AutoFly] Mobile: clicking expand button for " + countryName);
          safeClick(btn);
          // Wait for the Travel button to appear inside the expanded section
          await new Promise((resolve) => {
            const obs = new MutationObserver(() => {
              if (findFlyControl()) {
                obs.disconnect();
                resolve();
              }
            });
            obs.observe(document.body, { childList: true, subtree: true });
            setTimeout(() => { obs.disconnect(); resolve(); }, 5000);
          });
          return true;
        } catch (e) {
          console.warn("[AutoFly] Mobile: failed to click expand button", e);
          return false;
        }
      }
    }

    // Neither layout found — retry
    if (retries > 0) {
      console.log("[AutoFly] Destination not found, retrying... (" + retries + " retries left)");
      await wait(300);
      return clickTravelDestination(countryName, retries - 1);
    }

    return false;
  }

  // Attempt to set the desired country on the travel page.
  function setCountryOnTravelPage(desired) {
    if (!desired) return false;
    const low = desired.toLowerCase();

    // 1) Try select elements
    const selects = Array.from(document.querySelectorAll("select"));
    for (const sel of selects) {
      const opts = Array.from(sel.options || []);
      const match = opts.find(
        (o) =>
          (o.text || "").toLowerCase().includes(low) ||
          (o.value || "").toLowerCase().includes(low),
      );
      if (match) {
        sel.value = match.value || match.text;
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
    }

    // 2) Try clickable country links/buttons
    const candidates = Array.from(document.querySelectorAll("a,button"));
    for (const el of candidates) {
      const txt = (
        (el.textContent || "") +
        " " +
        (el.value || "")
      ).toLowerCase();
      if (txt.includes(low)) {
        try {
          el.click();
        } catch (e) {}
        return true;
      }
    }

    // 3) Try inputs with placeholder or label
    const inputs = Array.from(document.querySelectorAll("input"));
    for (const inp of inputs) {
      const ph = (inp.placeholder || "").toLowerCase();
      if (ph.includes("country") || ph.includes("destination")) {
        inp.value = desired;
        inp.dispatchEvent(new Event("input", { bubbles: true }));
        inp.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      }
    }

    return false;
  }

  // Heuristic: scan the travel page DOM for country names/options
  function getAvailableCountries() {
    try {
      // 1) Look for select elements with many options
      const selects = Array.from(document.querySelectorAll("select"));
      for (const sel of selects) {
        const opts = Array.from(sel.options || [])
          .map((o) => (o.text || o.value || "").trim())
          .filter(Boolean);
        if (opts.length > 3) return Array.from(new Set(opts));
      }

      // 2) Look for links/buttons that look like country choices (text length reasonable)
      const candidates = Array.from(document.querySelectorAll("a,button"))
        .map((el) => (el.textContent || el.value || "").trim())
        .filter((t) => t && t.length > 2 && t.length < 40);
      if (candidates.length > 3)
        return Array.from(new Set(candidates)).slice(0, 50);

      // 3) fallback: try to read from previously saved list
      const saved = sessionStorage.getItem("tmAvailableCountries");
      if (saved) return JSON.parse(saved);
    } catch (e) {}
    return [];
  }

  function wait(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  // Robust element click helper: tries multiple strategies
  function safeClick(el) {
    if (!el) return false;
    try {
      el.focus && el.focus();
      el.click();
      return true;
    } catch (e) {}
    try {
      const evs = [
        "pointerdown",
        "pointerup",
        "mousedown",
        "mouseup",
        "click",
      ].map(
        (t) =>
          new MouseEvent(t, { bubbles: true, cancelable: true, view: window }),
      );
      for (const ev of evs) el.dispatchEvent(ev);
      return true;
    } catch (e) {}
    try {
      if (typeof el.onclick === "function") {
        el.onclick();
        return true;
      }
    } catch (e) {}
    try {
      if (el.tagName && el.tagName.toLowerCase() === "a" && el.href) {
        location.href = el.href;
        return true;
      }
    } catch (e) {}
    return false;
  }

  // Robust quantity setter for a shop row: attempts many heuristics to set qty
  function safeSetQty(row, qty) {
    if (!row) return false;
    const num = Math.max(1, Math.floor(Number(qty) || 1));
    // common inputs
    const candidates = Array.from(
      row.querySelectorAll(
        'input[type=number], input.input-money, input[placeholder], input[name*="qty"], input[type=hidden]',
      ),
    );
    for (const inp of candidates) {
      try {
        // If hidden, set value attribute
        if (inp.type === "hidden") {
          inp.value = String(num);
          inp.setAttribute("value", String(num));
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

    // try selects
    const sel = row.querySelector("select");
    if (sel) {
      try {
        sel.value = String(num);
        sel.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      } catch (e) {}
    }

    // try clicking a per-row max button then adjusting if possible
    const maxBtn = row.querySelector(
      ".input-money-symbol button, .input-money-symbol input.wai-btn, button.max, .max-button",
    );
    if (maxBtn) {
      try {
        safeClick(maxBtn);
        return true;
      } catch (e) {}
    }

    // fallback: set data attributes sometimes used by apps
    const dataInp = row.querySelector("[data-money], [data-qty]");
    if (dataInp) {
      try {
        dataInp.setAttribute("data-money", String(num));
        dataInp.setAttribute("data-qty", String(num));
        return true;
      } catch (e) {}
    }

    return false;
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // Wait for stockTableWrapper to appear in the DOM, up to 15 seconds
  function waitForStockTable() {
    return new Promise((resolve) => {
      const existing = document.querySelector('[class*="stockTableWrapper"]');
      if (existing) return resolve(existing);
      console.log("[AutoFly] stockTableWrapper not found, waiting for SPA render...");
      const observer = new MutationObserver(() => {
        const el = document.querySelector('[class*="stockTableWrapper"]');
        if (el) {
          observer.disconnect();
          console.log("[AutoFly] stockTableWrapper appeared in DOM");
          resolve(el);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => {
        observer.disconnect();
        console.warn("[AutoFly] stockTableWrapper never appeared after 15s");
        resolve(null);
      }, 15000);
    });
  }


  // Parse the "X / Y items so far" counter from the abroad info message.
  // Returns { purchased, limit } or null if not found.
  function getPurchaseInfo() {
    const msgEl = document.querySelector('[class*="messageContent"]');
    if (!msgEl) return null;
    const text = msgEl.textContent || "";
    const match = text.match(/(\d+)\s*\/\s*(\d+)\s*items/i);
    if (!match) return null;
    return { purchased: parseInt(match[1], 10), limit: parseInt(match[2], 10) };
  }

  // Purchase items from SHOPPING_LIST when abroad, THEN travel home.
  async function processAbroadShopping() {
    try {
      console.log("[AutoFly] processing abroad shopping");

      const stockTableWrapper = await waitForStockTable();
      if (!stockTableWrapper) {
        console.warn("[AutoFly] stockTableWrapper missing — cannot shop");
        return;
      }

      // Check remaining purchase slots from the info message (e.g. "0 / 28 items so far").
      const purchaseInfo = getPurchaseInfo();
      let remainingSlots = purchaseInfo
        ? purchaseInfo.limit - purchaseInfo.purchased
        : Infinity;
      if (purchaseInfo) {
        console.log(
          `[AutoFly] Purchase slots: ${purchaseInfo.purchased} / ${purchaseInfo.limit} (${remainingSlots} remaining)`,
        );
      }

      let boughtAny = false;
      let itemsAvailable = false;

      if (remainingSlots <= 0) {
        console.log("[AutoFly] Purchase limit already reached — skipping purchases, flying home.");
      } else {
        // Each row is <li><div class="row___…"> with cells addressed by the
        // stable data-tt-content-type attribute (name/cost/stock/amount/buy).
        // The column header is a separate itemsHeader___ element (no row___), so
        // it is naturally excluded.
        const rows = Array.from(
          stockTableWrapper.querySelectorAll('li > [class^="row___"]'),
        );
        console.log(`[AutoFly] shop rows found: ${rows.length}`);

        // Build a map from lowercased shop name → row so we can look up by
        // shopping-list order rather than DOM order.
        const nameToRow = new Map();
        for (const r of rows) {
          const nc = r.querySelector('[data-tt-content-type="name"]');
          const bc = r.querySelector('[data-tt-content-type="buy"]');
          if (nc && bc) nameToRow.set(nc.textContent.trim().toLowerCase(), r);
        }

        // Iterate the user-ordered shopping list — first entry = highest priority.
        const activeList = loadShoppingList();
        for (const listItem of activeList) {
          if (remainingSlots <= 0) {
            console.log("[AutoFly] Purchase limit reached — stopping purchases.");
            break;
          }

          const lowerItem = listItem.toLowerCase();
          let matchKey = null;
          for (const shopName of nameToRow.keys()) {
            if (shopName.includes(lowerItem) || lowerItem.includes(shopName)) {
              matchKey = shopName;
              break;
            }
          }
          if (!matchKey) continue;

          const row = nameToRow.get(matchKey);
          nameToRow.delete(matchKey); // prevent buying the same row twice

          const nameCell = row.querySelector('[data-tt-content-type="name"]');
          const buyCell = row.querySelector('[data-tt-content-type="buy"]');
          const amountCell = row.querySelector('[data-tt-content-type="amount"]');
          const itemName = nameCell.textContent.trim();

          itemsAvailable = true;
          console.log(`[AutoFly] Buying ${itemName} (list entry: "${listItem}")`);

          // 1) Fill the maximum amount via the max (wai-btn) button.
          // On mobile the amount column is CSS-hidden; the max-fill element is a
          // <span class="wai-btn"> — not an input or button — so target it first.
          const maxBtn = (amountCell || row).querySelector(
            '[class*="wai-btn"], .input-money-symbol input.wai-btn, .input-money-symbol button, input.wai-btn',
          );
          if (maxBtn) {
            safeClick(maxBtn);
            await delay(500);
          }

          // 2) Click the cart/buy button — opens the confirmation panel.
          const buyBtn = buyCell.querySelector("button");
          if (!buyBtn) {
            console.warn("[AutoFly] no buy button for", itemName);
            continue;
          }
          const panelId = buyBtn.getAttribute("aria-controls"); // item-<id>-buyPanel
          safeClick(buyBtn);
          await delay(300);

          // 3) Two-step mobile flow:
          //    Step A — intermediate panel shows qty + "BUY" button; click it.
          //    Step B — Yes/No confirmation appears; click "Yes".
          //    Desktop skips step A (Yes/No appears directly after the cart click).
          let yesBtn = null;
          let clickedBuyBtn = false;
          const deadline = Date.now() + 6000;
          while (Date.now() < deadline) {
            const panel = panelId ? document.getElementById(panelId) : null;
            const panelBtns = panel ? [...panel.querySelectorAll("button")] : [];

            // Priority 1: Yes button (final step on both mobile and desktop)
            yesBtn = panelBtns.find((b) => /^yes$/i.test((b.textContent || "").trim()));
            if (!yesBtn) {
              for (const cp of document.querySelectorAll('[class*="confirmPanel"]')) {
                yesBtn = [...cp.querySelectorAll("button")].find((b) =>
                  /^yes$/i.test((b.textContent || "").trim()),
                );
                if (yesBtn) break;
              }
            }
            if (yesBtn) break;

            // Priority 2: BUY button (intermediate step on mobile)
            if (!clickedBuyBtn && panelBtns.length > 0) {
              const interimBuy = panelBtns.find((b) =>
                /^buy$/i.test((b.textContent || "").trim()),
              );
              if (interimBuy) {
                console.log(`[AutoFly] clicking intermediate BUY for ${itemName}`);
                try { interimBuy.click(); } catch (e) {}
                clickedBuyBtn = true;
                await delay(400);
                continue;
              }
            }

            await delay(100);
          }

          if (yesBtn) {
            try { yesBtn.click(); } catch (e) {}
            boughtAny = true;
            remainingSlots--;
            console.log(`[AutoFly] confirmed purchase of ${itemName}`);
            await delay(800);
          } else if (clickedBuyBtn) {
            // BUY was clicked but no Yes/No appeared — purchase may have gone
            // through directly (e.g. "Abroad Buy No Confirm" mode).
            boughtAny = true;
            remainingSlots--;
            console.log(`[AutoFly] BUY clicked for ${itemName} (no Yes/No panel)`);
            await delay(800);
          } else {
            console.warn(
              "[AutoFly] buy confirmation not found for",
              itemName,
              "(panel:",
              panelId,
              ")",
            );
          }
        }
      } // end else (slots available)

      if (!itemsAvailable) {
        console.log("[AutoFly] No SHOPPING_LIST items available at this destination — flying back.");
      } else if (!boughtAny) {
        console.log("[AutoFly] Items matched but none bought successfully.");
      }

      // Buying finished (or nothing to buy) — travel home.
      console.log("[AutoFly] Finished shopping. Travelling home...");
      const travelHomeBtn = document.querySelector(
        '[aria-controls="travel-home-panel"]',
      );
      safeClick(travelHomeBtn);
      await delay(500);
      const travelHomeConfirm = document.querySelector(
        '#travel-home-panel button, [class*="confirmCancel"] button',
      );
      safeClick(travelHomeConfirm);

      console.log("[AutoFly] shopping pass complete");
    } catch (e) {
      console.warn("[AutoFly] processAbroadShopping error", e);
    }
  }

  console.log("[AutoFly] script starting. mobile=" + isMobile() + " ua=" + navigator.userAgent.slice(0, 80));

  // Run on load
  try {
    injectUI();
  } catch (e) {
    console.error("[AutoFly] injectUI failed:", e);
  }

  // Belt-and-suspenders: re-inject FAB every second if it disappears (handles aggressive SPA re-renders on mobile)
  setInterval(() => {
    if (isMobile() && !document.getElementById("tm-autofly-fab")) {
      console.log("[AutoFly] FAB missing, re-injecting");
      try { injectUI(); } catch (e) { console.error("[AutoFly] re-inject failed:", e); }
    }
  }, 1000);

  // ensure UI injection on DOM changes (in case SPA renders after load)
  const uiObserver = new MutationObserver(() => {
    // On mobile re-inject if both FAB and panel are gone
    if (isMobile()) {
      if (!document.getElementById("tm-autofly-fab") && !document.getElementById("tm-autofly-panel")) {
        injectUI();
      }
    } else {
      injectUI();
    }
  });
  uiObserver.observe(document.documentElement, { childList: true, subtree: true });

  // Start timer
  startTimer();

  // Independent hospital check on load — shows the revive countdown whenever
  // hospitalised, regardless of the fly-out/fly-back toggles.
  initHospitalWatch();

  // Travel arrival watch — schedules a reload when in-flight, so the page
  // doesn't hang and miss the abroad shopping + fly-back trigger.
  initTravelWatch();

  // Expose helpers for console testing and manual extraction
  try {
    window.tmAutoFly = {
      settingsKey: KEY,
      loadSettings,
      saveSettings,
      tryAutoFly,
      startTimer,
      stopTimer,
      getAvailableCountries,
      getHospitalStatus,
      initHospitalWatch,
      testCountdown: (secs = 120) => setReviveCountdown(secs),
    };
    console.log("[AutoFly] helpers available at window.tmAutoFly");
  } catch (e) {}
})();
