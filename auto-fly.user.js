// ==UserScript==
// @name         Torn Auto Fly Abroad
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Auto-fly to abroad on Torn with an injected UI (settings saved to localStorage)
// @author       GitHub Copilot
// @match        https://www.torn.com/*
// @match        https://www.torn.com/
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

  // Items to purchase when abroad (loaded from shopping-list.txt)
  const SHOPPING_LIST = [
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
  ].map((s) => s.toLowerCase());

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

  let settings = loadSettings();
  let intervalId = null;

  function formatMs(ms) {
    return Math.round(ms / 1000) + "s";
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
          await processAbroadShopping();
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
      const setOk = setCountryOnTravelPage(settings.desiredCountry);
      // Also click the destination on the travel page
      if (isTravelPage()) {
        await clickTravelDestination(settings.desiredCountry);
        // give UI time to update after destination selection
        await wait(1500);
      } else if (setOk) {
        // give UI a moment to update after selection
        await wait(10000);
      }
    }

    // on travel page: try to click fly control or wait for it
    if (clickFlyControl()) {
      sessionStorage.setItem(COOLDOWN_KEY, String(Date.now()));
      console.log("[AutoFly] Fly control clicked");
      location.reload();
      return;
    }

    // If not clicked and user opted to skip warnings, try clicking the Continue button
    if (settings.skipWarnings && clickFlyContinueControl()) {
      sessionStorage.setItem(COOLDOWN_KEY, String(Date.now()));
      console.log("[AutoFly] Continue control clicked (skip warnings)");
      location.reload();
      return;
    }

    // If control not present yet, observe and click when it appears
    const mo = new MutationObserver((m, o) => {
      if (
        clickFlyControl() ||
        (settings.skipWarnings && clickFlyContinueControl())
      ) {
        sessionStorage.setItem(COOLDOWN_KEY, String(Date.now()));
        console.log(
          "[AutoFly] Fly/Continue control appeared and was clicked (observer)",
        );
        o.disconnect();
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
            </div>
        `;

    if (isMobile()) {
      // Floating action button — appended directly to body, outside any React container
      if (document.getElementById("tm-autofly-fab")) return;

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

      const openModal = () => { backdrop.style.display = "flex"; };
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

  // Purchase items from SHOPPING_LIST when abroad
  async function processAbroadShopping() {
    try {
      console.log("[AutoFly] processing abroad shopping");

      const stockTableWrapper = await waitForStockTable();
      if (!stockTableWrapper) {
        console.group("[AutoFly DIAG] stockTableWrapper missing — copy this block");
        console.log("body.dataset.abroad:", document.body.dataset.abroad);
        console.log("body.dataset.traveling:", document.body.dataset.traveling);
        console.log("body.className:", document.body.className);
        console.log("SHOPPING_LIST:", JSON.stringify(SHOPPING_LIST));
        console.log("All [class*=stockTable] elements:", [...document.querySelectorAll('[class*="stockTable"]')].map(e => e.className));
        console.log("All [class*=wrapper] elements:", [...document.querySelectorAll('[class*="wrapper"]')].map(e => e.className).slice(0, 20));
        console.groupEnd();
        return;
      }

      const rows = stockTableWrapper.querySelectorAll('[class*="row"]');
      console.log(`[AutoFly DIAG] stockTableWrapper found. Row count: ${rows.length}. SHOPPING_LIST: ${JSON.stringify(SHOPPING_LIST)}`);

      for (const row of rows) {
        const cells = row.querySelectorAll('[class*="cell"]');
        if (cells.length < 7) {
          console.log(`[AutoFly DIAG] row skipped — only ${cells.length} cells (need 7)`);
          continue;
        }

        const nameCell = cells[1];
        const qtyCell = cells[5];
        const buyCell = cells[6];

        const itemName = nameCell.textContent.trim();
        const maxQtyBtn = qtyCell.querySelector("span");
        const buyBtn = buyCell.querySelector("button");

        console.log(`[AutoFly DIAG] row | item="${itemName}" | maxQtyBtn=${!!maxQtyBtn} | buyBtn=${!!buyBtn}`);

        for (const want of SHOPPING_LIST) {
          if (itemName.toLowerCase().includes(want.toLowerCase())) {
            console.log(`[AutoFly] Buying ${itemName} (matched "${want}")`);
            console.log(`[AutoFly DIAG] maxQtyBtn el:`, maxQtyBtn, `| buyBtn el:`, buyBtn);

            safeClick(maxQtyBtn);
            await delay(500);

            safeClick(buyBtn);
            await delay(500);

            const yesBtn = document.querySelector('[class*="yes"]');
            console.log(`[AutoFly DIAG] yesBtn el:`, yesBtn);
            safeClick(yesBtn);
            await delay(500);
          }
        }

        console.log("[AutoFly] checked:", itemName);
      }

      console.log("[AutoFly] Finished shopping. Travelling home...");

      const travelHomeBtn = document.querySelector(
        '[aria-controls="travel-home-panel"]',
      );
      safeClick(travelHomeBtn);

      await delay(500);

      const travelHomeConfirm = document.querySelector(
        '[class*="confirmCancel"] button',
      );
      safeClick(travelHomeConfirm);

      console.log("[AutoFly] shopping pass complete");
    } catch (e) {
      console.warn("[AutoFly] processAbroadShopping error", e);
    }
  }

  // Run on load
  try {
    injectUI();
  } catch (e) {
    console.error("[AutoFly] injectUI failed:", e);
  }
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
    };
    console.log("[AutoFly] helpers available at window.tmAutoFly");
  } catch (e) {}
})();
