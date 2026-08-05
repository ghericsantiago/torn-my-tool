// ==UserScript==
// @name         Torn Item Market Auto Buy
// @namespace    http://tampermonkey.net/
// @version      2.0
// @description  Auto-buy a watchlist of items on the Torn item market, sizing quantity to your cash on hand, cycling items on a no-buy timeout, with an on-page settings panel.
// @author       GitHub Copilot
// @match        https://www.torn.com/page.php*
// @match        https://www.torn.com/imarket.php*
// @match        https://www.torn.com/bazaar.php*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const LOG = "[ItemMarketBuy]";
  const KEY = "tmItemMarketBuySettings";

  // =================== CLOUD SYNC ===================
  const KV_URL = "https://kv-get-started.ghericsantiago.workers.dev/torn-settings";
  const PANEL_ID = "tm-imbuy-panel";
  const FAB_ID = "tm-imbuy-fab";
  const MODAL_ID = "tm-imbuy-modal";

  // Minimum gap between scans while the seller list is mutating rapidly, so a
  // stream of realtime updates can't starve or spam the buy logic.
  const SCAN_MIN_GAP_MS = 500;
  const ITEMS_CACHE_KEY = "tmItemMarketBuyItemsCache";
  const ITEMS_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
  const AUTOBUYSTARTTS_KEY = "tmAutoBuyStartTs";

  const DEFAULTS = {
    items: [], // watchlist: [{ name, maxPrice }]
    noBuySeconds: 20, // advance to next item after this long with no purchase
    enabled: false,
    bazaarSniperEnabled: false, // scan weav3r API and navigate to bazaar when price is right
    bazaarPollSeconds: 5,       // how often to scan (seconds)
    bazaarMaxStaleMins: 15,     // reject listings older than this (minutes)
    autoBuyDurationHours: 0,   // 0 = run indefinitely; >0 = stop after N hours
    goHome: false,              // remote command: navigate to home page on the automation device
  };

  // Parse the multi-line items textarea into [{ name, maxPrice }].
  // Each line: "Item Name = max price" (also accepts | or : as separator).
  function parseItemsText(text) {
    return (text || "")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const m = line.match(/^(.*?)\s*[=|:]\s*(.+)$/);
        return m
          ? { name: m[1].trim(), maxPrice: m[2].trim() }
          : { name: line, maxPrice: "" };
      })
      .filter((i) => i.name);
  }

  function serializeItems(items) {
    return (items || [])
      .map((i) => (i.maxPrice ? `${i.name} = ${i.maxPrice}` : i.name))
      .join("\n");
  }

  // -------------------------------------------------------------------------
  // Settings (localStorage JSON blob merged over defaults)
  // -------------------------------------------------------------------------
  function loadSettings() {
    try {
      const parsed = JSON.parse(localStorage.getItem(KEY) || "{}");
      const merged = Object.assign({}, DEFAULTS, parsed);
      // Migrate the old single-item settings to the watchlist.
      if (
        !Array.isArray(parsed.items) &&
        (parsed.itemName || parsed.maxUnitPrice)
      ) {
        merged.items = [
          { name: parsed.itemName || "", maxPrice: parsed.maxUnitPrice || "" },
        ].filter((i) => i.name);
      }
      if (!Array.isArray(merged.items)) merged.items = [];
      delete merged.apiKey;
      delete merged.itemName;
      delete merged.maxUnitPrice;
      return merged;
    } catch (e) {
      return Object.assign({}, DEFAULTS);
    }
  }
  function saveSettings(s) {
    try {
      localStorage.setItem(KEY, JSON.stringify(s));
    } catch (e) {}
    scheduleCloudSave("itemmarket", s);
  }

  // =================== CLOUD HELPERS ===================
  const CLOUD_POLL_KEY = "tmCloudSyncPoll";
  const CLOUD_SAVE_PERSIST_KEY = "tmCloudSavePersist";
  const CONTROLLER_ONLY_KEY = "tmAutoFlyControllerOnly";
  function isControllerOnly() { return localStorage.getItem(CONTROLLER_ONLY_KEY) === "true"; }
  let _cloudSavePending = {};
  let _cloudSaveTimer = null;
  let _cloudSaveInProgress = false;
  let _cloudPollIntervalId = null;
  let _nextPollAt = 0;
  let _syncCountdownTimerId = null;

  window.addEventListener("beforeunload", () => {
    if (!Object.keys(_cloudSavePending).length) return;
    try {
      const existing = JSON.parse(localStorage.getItem(CLOUD_SAVE_PERSIST_KEY) || "{}");
      Object.assign(existing, _cloudSavePending);
      localStorage.setItem(CLOUD_SAVE_PERSIST_KEY, JSON.stringify(existing));
    } catch(e) {}
  });

  function gmFetch(url, { method = "GET", headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method, url, headers, data: body,
        timeout: 30000,
        onload: (r) => resolve({
          ok: r.status >= 200 && r.status < 300,
          status: r.status,
          text: r.responseText,
          json: () => Promise.resolve(JSON.parse(r.responseText)),
        }),
        onerror: () => reject(new Error("GM request failed")),
        ontimeout: () => reject(new Error("GM request timed out after 30s")),
      });
    });
  }

  async function cloudLoad() {
    try {
      const r = await gmFetch(`${KV_URL}?_=${Date.now()}`);
      if (r.status === 404) return {};
      if (!r.ok) { console.warn(LOG, "Cloud load HTTP error:", r.status); return null; }
      return JSON.parse(r.text || "{}");
    } catch(e) { console.warn(LOG, "Cloud load failed:", e); return null; }
  }

  function updateSyncCountdown() {
    const el = document.getElementById("tm-imbuy-cloud-next");
    if (!el) return;
    if (_cloudSaveInProgress || Object.keys(_cloudSavePending).length > 0) { el.textContent = ""; return; }
    const secs = Math.max(0, Math.ceil((_nextPollAt - Date.now()) / 1000));
    el.textContent = secs <= 0 ? "↻ …" : `↻ ${secs}s`;
  }

  function scheduleCloudSave(section, data) {
    _cloudSavePending[section] = JSON.parse(JSON.stringify(data));
    if (_cloudSaveTimer) clearTimeout(_cloudSaveTimer);
    _cloudSaveTimer = setTimeout(async () => {
      const pending = Object.assign({}, _cloudSavePending);
      _cloudSavePending = {};
      _cloudSaveTimer = null;
      _cloudSaveInProgress = true;
      try {
        let all = {};
        try { all = JSON.parse(_lastCloudContent || "{}"); } catch(e) {}
        Object.assign(all, pending);
        const res = await gmFetch(KV_URL, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(all, null, 2)
        });
        if (!res.ok) {
          Object.assign(_cloudSavePending, pending);
          _cloudSaveInProgress = false;
          console.error(LOG, `Cloud save failed — HTTP ${res.status} (data preserved for retry)`);
          return;
        }
        _lastCloudContent = JSON.stringify(all);
        _cloudSaveInProgress = false;
        console.log(LOG, "Cloud settings saved");
      } catch(e) {
        Object.assign(_cloudSavePending, pending);
        _cloudSaveInProgress = false;
        console.warn(LOG, "Cloud save failed:", e);
      }
    }, 1500);
  }

  let _lastCloudContent = null;

  async function flushPersistedCloudSave() {
    let raw;
    try { raw = localStorage.getItem(CLOUD_SAVE_PERSIST_KEY); } catch(e) { return; }
    if (!raw) return;
    let pending;
    try { pending = JSON.parse(raw); } catch(e) { localStorage.removeItem(CLOUD_SAVE_PERSIST_KEY); return; }
    if (!Object.keys(pending).length) { localStorage.removeItem(CLOUD_SAVE_PERSIST_KEY); return; }
    localStorage.removeItem(CLOUD_SAVE_PERSIST_KEY);
    try {
      let all = {};
      try { all = JSON.parse(_lastCloudContent || "{}"); } catch(e) {}
      Object.assign(all, pending);
      const res = await gmFetch(KV_URL, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(all, null, 2)
      });
      if (res.ok) {
        _lastCloudContent = JSON.stringify(all);
        console.log(LOG, "Flushed persisted cloud save. Sections:", Object.keys(pending).join(", "));
      }
    } catch(e) {
      console.warn(LOG, "Failed to flush persisted cloud save:", e);
    }
  }

  function applyCloudSettings(cloud) {
    if (!cloud.itemmarket) return;
    const merged = Object.assign({}, DEFAULTS, cloud.itemmarket);
    delete merged.apiKey;
    try { localStorage.setItem(KEY, JSON.stringify(merged)); } catch(e) {}
    settings = merged;
    const panel = document.getElementById(PANEL_ID);
    if (panel) {
      const timeoutEl  = panel.querySelector("#tm-imbuy-timeout");
      const enabledEl  = panel.querySelector("#tm-imbuy-enabled");
      const goHomeEl   = panel.querySelector("#tm-imbuy-go-home");
      const durationEl = panel.querySelector("#tm-imbuy-duration-hours");
      if (timeoutEl)  timeoutEl.value  = String(settings.noBuySeconds ?? 20);
      if (enabledEl)  enabledEl.checked  = !!settings.enabled;
      if (goHomeEl)   goHomeEl.checked   = !!settings.goHome;
      if (durationEl) durationEl.value  = String(settings.autoBuyDurationHours || 0);
      renderItemList();
    }
    // Remote "Go Home" command: automation device navigates home and resets the flag.
    if (settings.goHome && !isControllerOnly()) {
      console.log(LOG, "Go Home command received — navigating to home page");
      settings.goHome = false;
      saveSettings(settings);
      window.location.href = "https://www.torn.com/index.php";
    }
  }

  async function initCloudSync() {
    const cloud = await cloudLoad();
    if (cloud === null) { console.warn(LOG, "initCloudSync skipped — load failed"); return; }
    _lastCloudContent = JSON.stringify(cloud);
    applyCloudSettings(cloud);
    console.log(LOG, "Cloud settings synced");
  }

  async function pollCloudSync() {
    _nextPollAt = Date.now() + 15000;
    if (_cloudSaveInProgress || Object.keys(_cloudSavePending).length > 0) return;
    const cloud = await cloudLoad();
    if (cloud === null) return;
    const content = JSON.stringify(cloud);
    if (content === _lastCloudContent) return;
    _lastCloudContent = content;
    applyCloudSettings(cloud);
    console.log(LOG, "Cloud settings updated from remote");
  }

  function isCloudPollEnabled() {
    const v = localStorage.getItem(CLOUD_POLL_KEY);
    return v === null ? true : v === "true";
  }
  function startCloudPoll() {
    if (!isCloudPollEnabled()) { console.log("[IMBuy] Cloud polling disabled"); return; }
    if (_cloudPollIntervalId) return;
    _nextPollAt = Date.now() + 15000;
    _cloudPollIntervalId = setInterval(pollCloudSync, 15000);
    if (_syncCountdownTimerId) clearInterval(_syncCountdownTimerId);
    _syncCountdownTimerId = setInterval(updateSyncCountdown, 1000);
  }
  function stopCloudPoll() {
    if (_cloudPollIntervalId) { clearInterval(_cloudPollIntervalId); _cloudPollIntervalId = null; }
    if (_syncCountdownTimerId) { clearInterval(_syncCountdownTimerId); _syncCountdownTimerId = null; }
    const el = document.getElementById("tm-imbuy-cloud-next");
    if (el) el.textContent = "";
  }

  // The item market is a hash-routed SPA at page.php?sid=ItemMarket
  // (e.g. .../page.php?sid=ItemMarket#/market/view=search&itemID=437).
  // @match is broad (page.php*), so gate all behaviour on this check.
  const isItemMarketPage = () => /[?&]sid=ItemMarket/i.test(location.href);

  let settings = loadSettings();
  let busy = false;
  let lastSearchedItem = null;
  let monitorObserver = null;
  let scanTimer = null;
  let lastScanTs = 0;
  let currentIndex = 0; // which watchlist item is active
  let itemStartTs = 0; // when we started dwelling on the current item (reset on buy)
  let advanceTimer = null; // interval that advances items after the no-buy timeout
  let tornItems = null; // cache of Torn API items: { id: { name, market_value, ... } }

  // -------------------------------------------------------------------------
  // Number helpers (reused from property-vault.user.js)
  // -------------------------------------------------------------------------
  const formatNumber = (value) =>
    value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");

  const parseAmount = (value) => {
    if (value == null) return 0;
    if (typeof value !== "string") value = String(value);
    value = value
      .replace(/[^\d\.kmmb%\-]/gi, "")
      .trim()
      .toLowerCase();
    if (!value) return 0;
    const percentMatch = value.match(/^(\d+(?:\.\d+)?)%$/);
    if (percentMatch) {
      return Math.round((Number(percentMatch[1]) / 100) * 1000000000);
    }
    const suffixMatch = value.match(/^(\-?\d+(?:\.\d+)?)(k|m|b)?$/);
    if (!suffixMatch) return 0;
    let num = Number(suffixMatch[1]);
    const suffix = suffixMatch[2];
    if (!Number.isFinite(num)) return 0;
    if (suffix === "k") num *= 1_000;
    if (suffix === "m") num *= 1_000_000;
    if (suffix === "b") num *= 1_000_000_000;
    return Math.round(num);
  };

  // -------------------------------------------------------------------------
  // Timing / DOM helpers (reused from auto-fly.user.js)
  // -------------------------------------------------------------------------
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  function waitForNode(selectorOrFn, timeout = 5000, root = document) {
    const find = () =>
      typeof selectorOrFn === "function"
        ? selectorOrFn()
        : root.querySelector(selectorOrFn);
    return new Promise((resolve) => {
      const existing = find();
      if (existing) return resolve(existing);
      const observer = new MutationObserver(() => {
        const found = find();
        if (found) {
          observer.disconnect();
          resolve(found);
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => {
        observer.disconnect();
        resolve(null);
      }, timeout);
    });
  }

  // Robust React-friendly click: tries native click, then a full pointer/mouse
  // event sequence, then onclick, then anchor navigation.
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

  // Dispatch a brief, human-like mouse-move sequence ending over `el`, so any
  // hover/pointer-gated handlers fire before we click, and the interaction
  // looks less like an instantaneous synthetic click.
  async function simulateMouseMove(el, steps = 6) {
    if (!el || typeof el.getBoundingClientRect !== "function") return;
    const rect = el.getBoundingClientRect();
    const targetX = rect.left + rect.width / 2;
    const targetY = rect.top + rect.height / 2;
    let startX = targetX - 60;
    let startY = targetY - 40;

    const fire = (type, px, py, mx, my) => {
      const opts = {
        bubbles: true,
        cancelable: true,
        view: window,
        clientX: Math.round(px),
        clientY: Math.round(py),
        movementX: Math.round(mx || 0),
        movementY: Math.round(my || 0),
      };
      try {
        el.dispatchEvent(new MouseEvent(type, opts));
        if (type === "mousemove" && typeof PointerEvent === "function") {
          el.dispatchEvent(
            new PointerEvent("pointermove", { ...opts, pointerType: "mouse" }),
          );
        }
      } catch (e) {}
    };

    fire("mouseover", startX, startY);
    fire("mouseenter", startX, startY);
    let prevX = startX;
    let prevY = startY;
    for (let i = 1; i <= steps; i++) {
      const nx = startX + ((targetX - startX) * i) / steps;
      const ny = startY + ((targetY - startY) * i) / steps;
      fire("mousemove", nx, ny, nx - prevX, ny - prevY);
      prevX = nx;
      prevY = ny;
      await wait(15 + (i % 3) * 10); // slight, varying pace between moves
    }
  }

  // Set a value on a React-controlled input so React registers the change.
  function setReactInputValue(input, value) {
    if (!input) return false;
    const proto =
      input.tagName === "TEXTAREA"
        ? window.HTMLTextAreaElement.prototype
        : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    try {
      if (setter) {
        setter.call(input, String(value));
      } else {
        input.value = String(value);
      }
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    } catch (e) {
      try {
        input.value = String(value);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      } catch (err) {
        return false;
      }
    }
  }

  // Set the buy quantity in an expanded buy dialog. Writes the visible
  // input.input-money, the hidden mirror, and data-money, dispatching events.
  function setBuyQty(dialog, qty) {
    if (!dialog) return false;
    const num = Math.max(1, Math.floor(Number(qty) || 1));
    const inputs = Array.from(dialog.querySelectorAll("input.input-money"));
    if (!inputs.length) return false;
    for (const inp of inputs) {
      try {
        if (inp.type === "hidden") {
          inp.value = String(num);
          inp.setAttribute("value", String(num));
        } else {
          setReactInputValue(inp, num);
        }
        inp.setAttribute("data-money", String(num));
        inp.dataset && (inp.dataset.money = String(num));
      } catch (e) {}
    }
    return true;
  }

  // -------------------------------------------------------------------------
  // Market DOM readers (hashed React classnames -> prefix selectors)
  // -------------------------------------------------------------------------
  function getMoneyOnHand() {
    const el = document.getElementById("user-money");
    if (!el) return 0;
    const dm = el.getAttribute("data-money");
    if (dm != null && dm !== "") {
      const n = Number(dm);
      if (Number.isFinite(n)) return Math.floor(n);
    }
    return parseAmount(el.textContent || "0");
  }

  function getSelectedItemTitle() {
    const header = document.querySelector('[class*="itemsHeader___"]');
    if (!header) return "";
    const title = header.querySelector('[class*="title___"]');
    return title ? title.textContent.trim() : "";
  }

  // DOM-based item ID cache — populated as the user browses the item market.
  // Lets the Bazaar Sniper work without a Torn API key.
  const DOM_ITEM_IDS_KEY = "tmDomItemIds";
  let _domItemIds = (() => {
    try { return JSON.parse(localStorage.getItem(DOM_ITEM_IDS_KEY) || "{}"); }
    catch (e) { return {}; }
  })();
  function _saveDomItemIds() {
    try { localStorage.setItem(DOM_ITEM_IDS_KEY, JSON.stringify(_domItemIds)); } catch (e) {}
  }
  function readCurrentItemIdFromDom() {
    // Torn encodes the item ID in aria-controls="wai-itemInfo-{id}" or "wai-itemInfo-{n}-{id}"
    const btns = document.querySelectorAll('button[aria-controls^="wai-itemInfo-"]');
    for (const btn of btns) {
      const parts = (btn.getAttribute("aria-controls") || "").split("-");
      // Walk from the end; the item ID is the last numeric segment > 0
      for (let i = parts.length - 1; i >= 0; i--) {
        const n = parseInt(parts[i], 10);
        if (n > 0) return String(n);
      }
    }
    return null;
  }
  function _cacheCurrentDomItem() {
    const name = getSelectedItemTitle();
    const id   = readCurrentItemIdFromDom();
    if (!name || !id) return;
    const key = name.toLowerCase();
    if (_domItemIds[key] !== id) {
      _domItemIds[key] = id;
      _saveDomItemIds();
    }
  }

  function getSearchInput() {
    return document.querySelector('[data-testid="autocomplete-input"]') ||
           document.querySelector('input[class*="searchInput___"]');
  }

  function getSellerRows() {
    const list = document.querySelector('ul[class*="sellerList___"]');
    if (!list) return [];
    return Array.from(list.querySelectorAll('li[class*="rowWrapper___"]'));
  }

  // Parse a data row into { unitPrice, available, row, sellerRow }, or null
  // for the header row / unparseable rows.
  function parseRow(li) {
    const sellerRow = li.querySelector('[class*="sellerRow___"]');
    if (!sellerRow) return null;
    // Header row has a priceHead cell, not a real price cell.
    if (sellerRow.querySelector('[class*="priceHead___"]')) return null;
    const priceEl = sellerRow.querySelector('[class*="price___"]');
    const availEl = sellerRow.querySelector('[class*="available___"]');
    if (!priceEl || !availEl) return null;
    const unitPrice = parseAmount(priceEl.textContent || "0");
    // Desktop shows “54 available”; mobile shows “54”. Parse plain digits only —
    // parseAmount would treat the “b” in “available” as a billions suffix.
    const availDigits = (availEl.textContent || "").replace(/[^\d]/g, "");
    const available = availDigits ? parseInt(availDigits, 10) : 0;
    if (unitPrice <= 0 || available <= 0) return null;
    return { unitPrice, available, row: li, sellerRow };
  }

  // -------------------------------------------------------------------------
  // Item search / selection
  // -------------------------------------------------------------------------
  async function ensureItemSelected(name) {
    const target = (name || "").trim();
    if (!target) return false;

    const current = getSelectedItemTitle();
    if (current && current.toLowerCase() === target.toLowerCase()) {
      return true;
    }

    const input = getSearchInput();
    if (!input) {
      console.warn(LOG, "search input not found");
      return false;
    }

    // Avoid retyping repeatedly while the previous search resolves.
    if (
      lastSearchedItem &&
      lastSearchedItem.toLowerCase() === target.toLowerCase() &&
      (input.value || "").toLowerCase() === target.toLowerCase()
    ) {
      // already typed; wait for the dropdown/title to catch up
    } else {
      console.log(LOG, "searching for item:", target);
      setReactInputValue(input, target);
      lastSearchedItem = target;
    }

    // Wait for autocomplete options to appear and click the matching one.
    const option = await waitForNode(() => {
      const opts = Array.from(document.querySelectorAll(
        // Torn's actual autocomplete: button.item inside [data-testid="dropdown-content"]
        '[data-testid="dropdown-content"] button,' +
        '[data-testid="dropdown-content"] .item,' +
        '.dropdown-content button,' +
        '.dropdown-content .item,' +
        // torn-react-autocomplete library — non-hashed stable classes
        '.suggestions li,' +
        'li.suggestion,' +
        '.autocomplete-wrapper li,' +
        '.torn-react-autocomplete li,' +
        // hashed / role-based fallbacks
        '[class*="autocomplete"] [role="option"],' +
        '[role="listbox"] [role="option"],' +
        '[role="listbox"] li,' +
        '[class*="autocomplete"] li'
      )).filter(o => o.offsetParent !== null); // visible only

      const lower = target.toLowerCase();
      // 1. aria-label exact match — most reliable (contains clean name without item count)
      const byLabel = opts.find(o =>
        (o.getAttribute("aria-label") || "").toLowerCase() === lower
      );
      if (byLabel) return byLabel;
      // 2. Exact text content match
      const exact = opts.find(o => (o.textContent || "").trim().toLowerCase() === lower);
      if (exact) return exact;
      // 3. Text match after stripping trailing "(number)" — e.g. "Glow Stick (3135)"
      const nameOnly = opts.find(o =>
        (o.textContent || "").trim().replace(/\s*\(\d+\)\s*$/, "").toLowerCase() === lower
      );
      if (nameOnly) return nameOnly;
      // 4. Partial includes fallback
      return opts.find(o => (o.textContent || "").trim().toLowerCase().includes(lower)) || null;
    }, 4000);

    if (option) {
      safeClick(option);
      await wait(300);
    } else {
      console.warn(
        LOG,
        "autocomplete option not found for",
        target,
        "- will retry on next update",
      );
    }

    // Wait for the seller list of the selected item to render.
    await waitForNode(() => {
      const t = getSelectedItemTitle();
      return t && t.toLowerCase() === target.toLowerCase()
        ? document.querySelector('ul[class*="sellerList___"]')
        : null;
    }, 4000);

    const now = getSelectedItemTitle();
    return !!now && now.toLowerCase() === target.toLowerCase();
  }

  // -------------------------------------------------------------------------
  // Buy logic
  // -------------------------------------------------------------------------
  async function buyFromRow(entry, qty) {
    const { row } = entry;

    // Two layouts share the same class prefixes:
    //  - Mobile: a "Show buy controls" button expands a [class*="buyDialog___"].
    //  - Desktop: buy controls are inline in the row ([class*="buyControlsInRow___"]),
    //    no expand step, and the BUY button starts disabled until a qty is set.
    // Resolve a single `container` that holds the input.input-money + buy button.
    let container = null;
    const showBtn = row.querySelector(
      'button[class*="showBuyControlsButton___"]',
    );
    if (showBtn) {
      let dialog = row.querySelector('[class*="buyDialog___"]');
      const visible = dialog && dialog.offsetParent !== null;
      if (!visible) {
        safeClick(showBtn);
        dialog = await waitForNode(
          () => row.querySelector('[class*="buyDialog___"]'),
          3000,
        );
      }
      if (!dialog) {
        console.warn(LOG, "buy dialog did not open");
        return false;
      }
      container = dialog;
    } else {
      // Desktop inline controls (or fall back to the row itself).
      container =
        row.querySelector('[class*="buyControlsInRow___"]') ||
        row.querySelector('[class*="buyControls___"]') ||
        row;
    }
    await wait(150);

    if (!setBuyQty(container, qty)) {
      console.warn(LOG, "failed to set quantity");
      return false;
    }
    await wait(200);

    // The amount input defaults to the listing's FULL stock (data-money=available).
    // Verify it now reflects our cash-capped quantity before clicking BUY, so we
    // never accidentally submit the full stock when cash can't cover it.
    const shownQty = () => {
      const visible = container.querySelector(
        'input.input-money:not([type="hidden"])',
      );
      if (!visible) return 0;
      return parseAmount(
        visible.value || visible.getAttribute("value") || "0",
      );
    };
    if (shownQty() !== qty) {
      setBuyQty(container, qty); // one retry
      await wait(200);
    }
    if (shownQty() !== qty) {
      console.warn(
        LOG,
        `quantity did not stick (wanted ${qty}, input shows ${shownQty()}); aborting buy to avoid overspend`,
      );
      return false;
    }

    const buyBtn =
      container.querySelector('button[class*="buyButton___"]') ||
      container.querySelector('button[aria-label^="Buy "]') ||
      row.querySelector('button[class*="buyButton___"]');
    if (!buyBtn) {
      console.warn(LOG, "buy button not found");
      return false;
    }
    // Desktop BUY button is disabled until qty is entered; force-enable as a
    // fallback in case React hasn't re-enabled it yet.
    if (buyBtn.disabled) {
      buyBtn.disabled = false;
      buyBtn.removeAttribute("disabled");
    }
    // Move the mouse over the buy button before clicking.
    if (!settings.enabled) return false; // aborted by user
    await simulateMouseMove(buyBtn);
    console.log(LOG, `clicking BUY for qty ${qty}`);
    safeClick(buyBtn);
    await wait(400);

    // Handle a possible confirmation popup.
    const confirm = document.querySelector(
      '[class*="confirm"] button, [class*="Confirm"] button, button[class*="yes" i], [class*="popup"] button[class*="buyButton" i]',
    );
    if (confirm && confirm.offsetParent !== null) {
      console.log(LOG, "clicking confirmation");
      safeClick(confirm);
      await wait(400);
    }

    // After a successful buy a success panel appears, e.g.
    //   <div class="buyDialog___"><div class="confirmMessage___">
    //     <div class="successText___">You bought 100x Bottle of Beer ...</div>
    //   </div><div class="closeButtonWrapper___">
    //     <button aria-label="Close panel" class="closeButton___">…</button>
    // Read it for logging, then close it so the row is buyable again.
    const success = await waitForNode(
      () =>
        container.querySelector('[class*="successText___"]') ||
        document.querySelector('[class*="successText___"]'),
      2500,
    );
    if (success) {
      console.log(LOG, "buy confirmed:", success.textContent.trim());
      const dialog =
        success.closest('[class*="buyDialog___"]') ||
        success.closest('[class*="confirmMessage___"]')?.parentElement ||
        container;
      const closeBtn =
        dialog.querySelector('button[aria-label="Close panel"]') ||
        dialog.querySelector('[class*="closeButtonWrapper___"] button');
      if (closeBtn) {
        console.log(LOG, "closing success message");
        safeClick(closeBtn);
        await wait(200);
      }
    }
    return true;
  }

  function isItemDone(item) {
    return (item.targetQty || 0) > 0 && (item.boughtQty || 0) >= item.targetQty;
  }

  async function scanAndBuy() {
    if (isControllerOnly()) return;
    if (!settings.enabled) return;
    if (!isItemMarketPage()) return;
    if (busy) return;
    if (_bazaarSnipeBusy) return; // sniper is navigating to a bazaar
    if (isAutoBuyExpired()) {
      settings.enabled = false;
      saveSettings(settings);
      stopMonitor();
      const el = document.getElementById("tm-imbuy-enabled");
      if (el) el.checked = false;
      setStatus(`Auto-buy stopped — ${settings.autoBuyDurationHours}h run duration elapsed.`);
      updateTimerDisplay();
      return;
    }
    busy = true;
    try {
      const list = settings.items || [];
      if (!list.length) {
        setStatus("Add items (one per line: Name = max price).");
        return;
      }
      if (currentIndex >= list.length) currentIndex = 0;
      // Advance past any skipped items
      const _skipStart = currentIndex;
      while (list[currentIndex]?.skipped || isItemDone(list[currentIndex])) {
        currentIndex = (currentIndex + 1) % list.length;
        if (currentIndex === _skipStart) { setStatus("All items are skipped or done."); return; }
      }
      const cur = list[currentIndex];
      const tag = `[${currentIndex + 1}/${list.length}] ${cur.name}`;

      const selected = await ensureItemSelected(cur.name);
      if (!selected) {
        setStatus(`Waiting for ${tag}…`);
        return;
      }

      const cap = parseAmount(cur.maxPrice);
      if (cap <= 0) {
        setStatus(`${tag}: no valid max price set — skipping.`);
        return;
      }

      let money = getMoneyOnHand();
      if (money <= 0) {
        setStatus("No cash on hand.");
        return;
      }

      const entries = getSellerRows()
        .map(parseRow)
        .filter(Boolean)
        .filter((e) => e.unitPrice <= cap)
        .sort((a, b) => a.unitPrice - b.unitPrice);

      if (!entries.length) {
        setStatus(
          `${tag}: no listings <= $${formatNumber(cap)}. Cash $${formatNumber(money)}.`,
        );
        return;
      }

      let boughtUnits = 0;
      let spent = 0;
      for (const entry of entries) {
        if (!settings.enabled) break; // user disabled mid-loop
        money = getMoneyOnHand(); // refresh after each purchase
        const affordable = Math.floor(money / entry.unitPrice);
        const remaining = (cur.targetQty || 0) > 0 ? Math.max(0, cur.targetQty - (cur.boughtQty || 0)) : Infinity;
        if (remaining === 0) break; // target already met
        const qty = Math.min(entry.available, affordable, isFinite(remaining) ? remaining : entry.available);
        if (qty < 1) break; // can't afford even one at this (cheapest remaining) price
        const ok = await buyFromRow(entry, qty);
        if (ok) {
          boughtUnits += qty;
          spent += qty * entry.unitPrice;
          cur.boughtQty = (cur.boughtQty || 0) + qty;
          itemStartTs = Date.now(); // reset dwell timer — keep sniping this item
          setStatus(
            `${tag}: bought ${formatNumber(boughtUnits)}${cur.targetQty > 0 ? ` (${cur.boughtQty}/${cur.targetQty} total)` : ""} @ up to $${formatNumber(cap)} (spent ~$${formatNumber(spent)}). Cash $${formatNumber(getMoneyOnHand())}.`,
          );
          await wait(700); // let React + money update settle
          if (isItemDone(cur)) break; // target reached — stop buying this item
        } else {
          // Stop the sweep on failure to avoid hammering a broken row.
          break;
        }
      }
      if (boughtUnits > 0) {
        saveSettings(settings);
        renderItemList();
        if (isItemDone(cur)) {
          console.log(LOG, `${tag}: target of ${cur.targetQty} reached — advancing to next item`);
          advanceItem("target reached");
        }
      }

      if (boughtUnits === 0) {
        setStatus(
          `${tag}: ${entries.length} listing(s) <= $${formatNumber(cap)}, none affordable. Cash $${formatNumber(getMoneyOnHand())}.`,
        );
      }
    } catch (e) {
      console.warn(LOG, "scanAndBuy error", e);
    } finally {
      busy = false;
    }
  }

  // Move to the next watchlist item. Called by the no-buy-timeout checker.
  function advanceItem(reason) {
    const list = settings.items || [];
    if (list.length <= 1) return; // nothing to cycle to
    const startIdx = currentIndex;
    do {
      currentIndex = (currentIndex + 1) % list.length;
    } while ((list[currentIndex]?.skipped || isItemDone(list[currentIndex])) && currentIndex !== startIdx);
    if (list[currentIndex]?.skipped || isItemDone(list[currentIndex])) return; // all items skipped/done
    itemStartTs = Date.now();
    lastSearchedItem = null; // force a fresh search for the new item
    const cur = list[currentIndex];
    console.log(
      LOG,
      `advancing to [${currentIndex + 1}/${list.length}] ${cur.name} (${reason})`,
    );
    scheduleScan();
  }

  // Refresh the panel countdown showing time until the next item.
  function updateCountdown(list, remainingMs) {
    const el = document.getElementById("tm-imbuy-countdown");
    if (!el) return;
    if (!settings.enabled || !list.length) {
      el.innerHTML = '<span style=”color:#555;”>&mdash;</span>';
      return;
    }
    const cur = list[currentIndex] || {};
    const nameHtml = `<span style="color:#fff;font-weight:bold;">${cur.name || ""}</span>`;
    const posHtml = `<span style="color:#555;font-size:11px;">[${currentIndex + 1}/${list.length}]</span> ${nameHtml}`;
    if (list.length <= 1) {
      el.innerHTML = `&#128722; Sniping ${nameHtml} <span style=”color:#555;font-size:11px;”>(single item &mdash; no cycling)</span>`;
    } else if (busy) {
      el.innerHTML = `&#128722; Buying ${posHtml}<span style="color:#f0a500;">&hellip;</span>`;
    } else {
      const secs = Math.ceil(remainingMs / 1000);
      el.innerHTML = `&#128722; ${posHtml} <span style=”color:#555;font-size:11px;”>&mdash; next in <span style=”color:#f0a500;”>${secs}s</span></span>`;
    }
  }

  // Advance to the next item if the current one hasn't yielded a buy within
  // the configured no-buy timeout. Runs on a 1s timer (time-based by nature),
  // and also refreshes the on-panel countdown each tick.
  function checkDwell() {
    if (isControllerOnly()) return;
    if (!settings.enabled) return;
    const list = settings.items || [];
    const timeoutMs = Math.max(1, Number(settings.noBuySeconds) || 20) * 1000;
    const remainingMs = Math.max(0, timeoutMs - (Date.now() - itemStartTs));
    updateCountdown(list, remainingMs);
    updateTimerDisplay();
    if (busy || list.length <= 1) return;
    if (remainingMs <= 0) {
      advanceItem(`no buy within ${Math.round(timeoutMs / 1000)}s`);
    }
  }

  // -------------------------------------------------------------------------
  // Monitor: react to realtime seller-list changes via MutationObserver.
  // A throttle (SCAN_MIN_GAP_MS) coalesces bursts of updates and guarantees a
  // scan still runs under continuous mutation instead of a debounce starving.
  // -------------------------------------------------------------------------
  function scheduleScan() {
    if (!settings.enabled) return;
    const since = Date.now() - lastScanTs;
    if (since >= SCAN_MIN_GAP_MS) {
      lastScanTs = Date.now();
      scanAndBuy();
    } else if (!scanTimer) {
      scanTimer = setTimeout(() => {
        scanTimer = null;
        lastScanTs = Date.now();
        scanAndBuy();
      }, SCAN_MIN_GAP_MS - since);
    }
  }

  function startMonitor() {
    stopMonitor();
    if (!settings.enabled) return;
    if (!getAutoBuyStartTs()) setAutoBuyStartTs(Date.now());
    currentIndex = 0;
    itemStartTs = Date.now();
    // Observe the (stable) market wrapper so we catch both realtime row
    // updates within the seller list and full list swaps on item change.
    const target =
      document.querySelector('[class*="marketWrapper___"]') || document.body;
    monitorObserver = new MutationObserver(scheduleScan);
    monitorObserver.observe(target, { childList: true, subtree: true });
    // Time-based check that cycles to the next item after the no-buy timeout.
    advanceTimer = setInterval(checkDwell, 1000);
    console.log(LOG, "monitoring seller list via MutationObserver");
    checkDwell(); // show the countdown immediately
    scheduleScan(); // initial pass
  }

  function stopMonitor() {
    if (monitorObserver) {
      monitorObserver.disconnect();
      monitorObserver = null;
    }
    if (scanTimer) {
      clearTimeout(scanTimer);
      scanTimer = null;
    }
    if (advanceTimer) {
      clearInterval(advanceTimer);
      advanceTimer = null;
    }
  }

  // -------------------------------------------------------------------------
  // Auto-buy run-duration timer
  // -------------------------------------------------------------------------
  function getAutoBuyStartTs() {
    return parseInt(localStorage.getItem(AUTOBUYSTARTTS_KEY) || "0", 10);
  }
  function setAutoBuyStartTs(ts) {
    if (ts) localStorage.setItem(AUTOBUYSTARTTS_KEY, String(ts));
    else localStorage.removeItem(AUTOBUYSTARTTS_KEY);
  }
  function isAutoBuyExpired() {
    const hours = settings.autoBuyDurationHours || 0;
    if (hours <= 0) return false;
    const startTs = getAutoBuyStartTs();
    if (!startTs) return false;
    return Date.now() - startTs >= hours * 3600000;
  }
  function updateTimerDisplay() {
    const el = document.getElementById("tm-imbuy-timer-remaining");
    if (!el) return;
    const hours = settings.autoBuyDurationHours || 0;
    if (hours <= 0) { el.textContent = ""; return; }
    const startTs = getAutoBuyStartTs();
    if (!startTs) { el.textContent = "not started"; el.style.color = "#666"; return; }
    const remainingMs = Math.max(0, hours * 3600000 - (Date.now() - startTs));
    if (remainingMs <= 0) { el.textContent = "expired"; el.style.color = "#f66"; return; }
    el.style.color = "#666";
    const remMins = Math.ceil(remainingMs / 60000);
    el.textContent = remMins >= 60
      ? `${Math.floor(remMins / 60)}h ${remMins % 60}m left`
      : `${remMins}m left`;
  }

  // =========================================================================
  // BAZAAR SNIPER — polls weav3r API on the item market page, navigates to
  // a seller's bazaar when a watched item is at or below the target price,
  // then auto-buys the maximum affordable quantity on the bazaar page.
  // =========================================================================

  const BAZAAR_CTX_KEY   = "tmBazaarAutoBuyCtx";
  const SNIPE_RETURN_KEY = "tmSnipeReturn"; // item name to re-select after returning from bazaar
  const BAZAAR_QUEUE_KEY = "tmBazaarQueue"; // sessionStorage queue of pending bazaar visits
  const WEAV3R_API       = "https://weav3r.dev/api/";

  // ---- Bazaar visit queue — all listings collected in one weav3r poll,
  //      drained one bazaar at a time before the next poll fires. ----
  function loadBazaarQueue() {
    try { return JSON.parse(sessionStorage.getItem(BAZAAR_QUEUE_KEY) || "[]"); }
    catch (e) { return []; }
  }
  function saveBazaarQueue(q) {
    try { sessionStorage.setItem(BAZAAR_QUEUE_KEY, JSON.stringify(q)); }
    catch (e) {}
  }
  function clearBazaarQueue() {
    try { sessionStorage.removeItem(BAZAAR_QUEUE_KEY); }
    catch (e) {}
  }

  function isBazaarPage() {
    return /bazaar\.php/i.test(location.pathname);
  }

  // ---- Visited-bazaar cache — prevents revisiting a listing with the same
  //      last_checked timestamp (only revisit when the seller restocks/updates).
  const BAZAAR_VISITED_KEY = "tmBazaarVisited";
  const BAZAAR_VISITED_TTL = 24 * 60 * 60; // prune entries older than 24 h

  function _loadBazaarVisited() {
    try { return JSON.parse(localStorage.getItem(BAZAAR_VISITED_KEY) || "{}"); }
    catch (e) { return {}; }
  }

  function isBazaarVisited(playerId, itemId, lastChecked) {
    const entry = _loadBazaarVisited()[`${playerId}_${itemId}`];
    if (!entry) return false;
    // Same timestamp → definitely same listing, skip.
    if (entry.lastChecked === lastChecked) return true;
    // Different timestamp (weav3r re-polled) but visited very recently → still skip.
    // Prevents rapid re-visiting when weav3r updates last_checked without the seller restocking.
    const now = Math.floor(Date.now() / 1000);
    return (now - (entry.visitedAt || 0)) < 300; // 5-minute cooldown
  }

  function markBazaarVisited(playerId, itemId, lastChecked) {
    const now = Math.floor(Date.now() / 1000);
    const cache = _loadBazaarVisited();
    // Prune stale entries while we have the cache open.
    for (const [k, v] of Object.entries(cache)) {
      if (now - (v.visitedAt || 0) > BAZAAR_VISITED_TTL) delete cache[k];
    }
    cache[`${playerId}_${itemId}`] = { lastChecked, visitedAt: now };
    try { localStorage.setItem(BAZAAR_VISITED_KEY, JSON.stringify(cache)); } catch (e) {}
  }

  function clearBazaarVisited() {
    try { localStorage.removeItem(BAZAAR_VISITED_KEY); } catch (e) {}
  }
  // ---- end visited-bazaar cache ----

  // Fetch cheapest bazaar listings for itemId priced <= maxPrice from weav3r.
  async function fetchWeav3rMarketplace(itemId, maxPrice) {
    try {
      const url = `${WEAV3R_API}marketplace/${itemId}?maxPrice=${maxPrice}&limit=10`;
      const r = await gmFetch(url);
      if (!r.ok) return null;
      return JSON.parse(r.text);
    } catch (e) {
      console.warn(LOG, "[Bazaar] fetchWeav3rMarketplace failed", e);
      return null;
    }
  }

  // Look up the numeric Torn item ID by name.
  // Primary: tornItems cache (requires Torn API key).
  // Fallback: DOM-observed item ID cache populated while browsing the item market.
  function getItemIdByName(name) {
    const lower = name.toLowerCase();
    if (tornItems) {
      const entry = Object.entries(tornItems).find(([, v]) => v.name.toLowerCase() === lower);
      if (entry) return entry[0];
    }
    return _domItemIds[lower] || null;
  }

  // Parse the unit price from a bazaar item card [data-testid="price"].
  // The element contains a text node with "$NNN,NNN" plus child divs for
  // rate/delta info — read only the first TEXT_NODE to avoid including those.
  function parseBazaarItemPrice(card) {
    const el = card.querySelector('[data-testid="price"]');
    if (!el) return 0;
    for (const node of el.childNodes) {
      if (node.nodeType !== Node.TEXT_NODE) continue;
      const m = node.textContent?.replace(/,/g, "").match(/(\d+)/);
      if (m) return Number(m[1]);
    }
    const m = el.textContent?.match(/\$([\d,]+)/);
    return m ? Number(m[1].replace(/,/g, "")) : 0;
  }

  // ---- Status toast shown on the bazaar page ----
  let _bazaarToastEl = null;
  function showBazaarToast(msg, type) {
    if (!_bazaarToastEl) {
      _bazaarToastEl = document.createElement("div");
      _bazaarToastEl.id = "tm-bazaar-toast";
      _bazaarToastEl.style.cssText = [
        "position:fixed", "top:16px", "left:50%",
        "transform:translateX(-50%)", "z-index:999999",
        "padding:10px 18px", "border-radius:6px",
        "font-family:Arial,sans-serif", "font-size:13px", "color:#fff",
        "box-shadow:0 4px 16px rgba(0,0,0,.55)", "pointer-events:none",
        "transition:opacity .3s", "max-width:min(90vw,500px)",
        "text-align:center", "line-height:1.4",
      ].join(";");
      document.body.appendChild(_bazaarToastEl);
    }
    const colors = { info: "#1d4ed8", success: "#15803d", warn: "#b45309", error: "#b91c1c" };
    _bazaarToastEl.style.background = colors[type] || colors.info;
    _bazaarToastEl.style.opacity = "1";
    _bazaarToastEl.textContent = msg;
    console.log(LOG, "[Bazaar]", msg);
  }

  // ---- Main bazaar auto-buy routine — runs once on bazaar.php ----
  async function runBazaarAutoBuy() {
    if (!isBazaarPage()) return;
    if (isControllerOnly()) return;

    const params = new URLSearchParams(window.location.search);
    if (params.get("tm-autobuy") !== "1") return;

    // Strip our param from the URL immediately so a reload doesn't re-trigger.
    params.delete("tm-autobuy");
    const qs = params.toString();
    history.replaceState({}, "", `${location.pathname}${qs ? "?" + qs : ""}${location.hash}`);

    // Recover context stored before navigation.
    let ctx;
    try { ctx = JSON.parse(sessionStorage.getItem(BAZAAR_CTX_KEY) || "null"); } catch {}
    if (!ctx) { showBazaarToast("Auto-buy: no context found — aborted", "error"); return; }
    sessionStorage.removeItem(BAZAAR_CTX_KEY);

    const { itemId, itemName, maxPrice, lastChecked, returnUrl } = ctx;
    const goBack = () => {
      window.location.href = returnUrl || "https://www.torn.com/page.php?sid=ItemMarket";
    };

    if (!settings.enabled) {
      showBazaarToast("Auto-buy is disabled — going back…", "warn");
      await wait(1500);
      goBack();
      return;
    }

    showBazaarToast(`Auto-buy: locating "${itemName}" in this bazaar…`, "info");

    // Reject stale listings — they may already have been purchased.
    const now = Math.floor(Date.now() / 1000);
    const maxStaleSecs = Math.max(5, settings.bazaarMaxStaleMins || 15) * 60;
    if (lastChecked > 0 && (now - lastChecked) > maxStaleSecs) {
      const ageMins = Math.round((now - lastChecked) / 60);
      showBazaarToast(
        `Aborted: listing is ${ageMins}m old (max ${settings.bazaarMaxStaleMins || 15}m). May already be sold.`,
        "warn"
      );
      return;
    }

    // Wait for the React bazaar grid to render.
    const grid = await waitForNode('[data-testid="bazaar-items"]', 18000);
    if (!grid) { showBazaarToast("Bazaar grid did not load in time — going back", "error"); await wait(1200); history.back(); return; }

    // Filter the bazaar to the target item using the search input.
    const searchInput = document.querySelector('[data-testid="autocomplete-input"]');
    if (searchInput) {
      setReactInputValue(searchInput, itemName);
      await wait(900);
    }

    // Find the item card whose image src contains the itemId.
    const findCard = () => {
      for (const card of document.querySelectorAll('[data-testid="item"]')) {
        if (card.querySelector(`img[src*="/images/items/${itemId}/"]`)) return card;
      }
      return null;
    };

    let card = await waitForNode(findCard, 10000);
    if (!card && searchInput) {
      // Filter might have hidden it if the name doesn't match; try without filter.
      setReactInputValue(searchInput, "");
      await wait(700);
      card = await waitForNode(findCard, 8000);
    }

    if (!card) {
      showBazaarToast(
        `"${itemName}" not found in this bazaar — may already be sold. Going back…`,
        "warn"
      );
      await wait(2500);
      goBack();
      return;
    }

    // Verify price is still within budget.
    const actualPrice = parseBazaarItemPrice(card);
    if (actualPrice <= 0) { showBazaarToast("Could not read item price", "error"); return; }
    if (actualPrice > maxPrice) {
      showBazaarToast(
        `Price $${formatNumber(actualPrice)} > target $${formatNumber(maxPrice)} — going back…`,
        "warn"
      );
      await wait(2500);
      goBack();
      return;
    }

    // Determine how many we can afford, capped by remaining target quantity.
    const stockEl  = card.querySelector('[data-testid="amount-value"]');
    const stockTxt = stockEl?.textContent?.trim();
    // Use parsed stock if the element exists; fall back to 9999 only when it's absent (not when it shows "0").
    const stock    = stockTxt != null ? Math.max(0, parseInt(stockTxt, 10) || 0) : 9999;
    const money   = getMoneyOnHand();
    const watchItemForQty = settings.items.find(i => i.name.toLowerCase() === itemName.toLowerCase());
    const _remaining = watchItemForQty && (watchItemForQty.targetQty || 0) > 0
      ? Math.max(0, watchItemForQty.targetQty - (watchItemForQty.boughtQty || 0))
      : Infinity;
    const qty     = Math.min(stock, Math.floor(money / actualPrice), isFinite(_remaining) ? _remaining : stock);

    if (qty < 1) {
      showBazaarToast(
        `Not enough cash: need $${formatNumber(actualPrice)}, have $${formatNumber(money)}`,
        "error"
      );
      return;
    }

    showBazaarToast(
      `Buying ${formatNumber(qty)}x ${itemName} @ $${formatNumber(actualPrice)} (cash $${formatNumber(money)})…`,
      "info"
    );

    card.scrollIntoView({ behavior: "smooth", block: "center" });
    await wait(600);

    // Click the activate-buy-button on the card.
    // On mobile bazaar the buy form is already inline — no activate button exists.
    const buyActivateBtn = card.querySelector('[data-testid="activate-buy-button"]');
    const buyFormAlreadyInline = !!(
      card.querySelector('[data-testid="buy-button"]') ||
      card.querySelector('[data-testid="buy-form"]')
    );
    if (!buyActivateBtn && !buyFormAlreadyInline) {
      showBazaarToast("Buy button not found on item card", "error");
      return;
    }
    if (buyActivateBtn) {
      await simulateMouseMove(buyActivateBtn);
      safeClick(buyActivateBtn);
      await wait(700);
    }

    // The bazaar reveals buy controls INLINE inside the item card — there is no
    // separate dialog.  After clicking activate-buy-button a quantity input and
    // a "Buy / fill max" button appear within the card (or its row container).
    const rowContainer = card.closest('[data-testid="bazaar-items-row"]') || card.parentElement || card;

    const findQtyInput = () =>
      card.querySelector('[data-testid="number-input"]')                       ||
      card.querySelector('input[type="number"]')                               ||
      card.querySelector('input[type="text"][class*="numberInput"]')           ||
      card.querySelector('input[type="text"][class*="buyAmountInput"]')        ||
      card.querySelector('input.input-money:not([type="hidden"])')             ||
      rowContainer.querySelector('[data-testid="number-input"]')               ||
      rowContainer.querySelector('input[type="number"]')                       ||
      rowContainer.querySelector('input[type="text"][class*="numberInput"]')   ||
      rowContainer.querySelector('input.input-money:not([type="hidden"])');

    // Buy button — must NOT match "fill max" (that only fills the qty input).
    const findBuyBtn = () =>
      card.querySelector('button[class*="buyButton___"]')                ||
      card.querySelector('button[aria-label*="Buy"]')                    ||
      rowContainer.querySelector('button[class*="buyButton___"]')        ||
      rowContainer.querySelector('button[aria-label*="Buy"]')            ||
      [...rowContainer.querySelectorAll("button")].find(b => {
        const text = (b.textContent || "").trim();
        return /^buy/i.test(text) && !/fill/i.test(text) && b.offsetParent !== null;
      });

    // "Fill max" link/button — clicks it to auto-fill max affordable quantity.
    const findFillMaxEl = () =>
      [...rowContainer.querySelectorAll("button, a, span")].find(b =>
        /fill\s*max/i.test(b.textContent || "") && b.offsetParent !== null
      );

    // Wait for either the quantity input or the buy button to appear inside the card.
    const inlineReady = await waitForNode(
      () => findQtyInput() || findBuyBtn(),
      5000
    );

    if (!inlineReady) {
      // As a fallback, check for an overlay dialog (some bazaar versions use one).
      const fallbackDialog = (
        document.querySelector('[class*="buyDialog___"]') ||
        document.querySelector('[role="dialog"]')
      );
      if (!fallbackDialog) {
        const earlySuccess = document.querySelector('[class*="successText___"]');
        if (earlySuccess) {
          showBazaarToast(`Bought ${formatNumber(qty)}x ${itemName} @ $${formatNumber(actualPrice)}`, "success");
          return;
        }
        showBazaarToast("Buy controls did not appear — please buy manually", "warn");
        return;
      }
      // Handle the fallback dialog path the same way (controls inside the dialog).
      const dQty = fallbackDialog.querySelector('input[type="number"]') ||
                   fallbackDialog.querySelector('input.input-money:not([type="hidden"])');
      const dBtn = fallbackDialog.querySelector('button[class*="buyButton___"]') ||
                   fallbackDialog.querySelector('button[aria-label*="Buy"]');
      if (dQty) { setReactInputValue(dQty, qty); await wait(300); }
      if (dBtn) { if (dBtn.disabled) { dBtn.disabled = false; dBtn.removeAttribute("disabled"); } await simulateMouseMove(dBtn); safeClick(dBtn); }
      await wait(500);
    } else {
      // ---- Inline controls path (normal bazaar) ----

      // Step 1: Click "fill max" if available — Torn auto-fills min(stock, cash/price).
      const fillMaxEl = findFillMaxEl();
      if (fillMaxEl) {
        await simulateMouseMove(fillMaxEl);
        safeClick(fillMaxEl);
        await wait(400);
      }

      // Step 2: Always verify and enforce our computed max qty.
      // "fill max" may have used stock-only (ignoring cash), or may not exist.
      const qtyInput = findQtyInput();
      if (qtyInput) {
        if (qtyInput.disabled) { qtyInput.disabled = false; qtyInput.removeAttribute("disabled"); }
        const current = Number(qtyInput.value) || 0;
        if (current !== qty) {
          setReactInputValue(qtyInput, qty);
          await wait(350);
          if (Number(qtyInput.value) !== qty) {
            setReactInputValue(qtyInput, qty);
            await wait(250);
          }
        }
      }

      await wait(200);

      // Step 3: Click the actual buy button (distinct from fill max).
      const confirmBtn = findBuyBtn();
      if (!confirmBtn) { showBazaarToast("Buy button not found in inline controls", "error"); return; }
      if (confirmBtn.disabled) { confirmBtn.disabled = false; confirmBtn.removeAttribute("disabled"); }
      await simulateMouseMove(confirmBtn);
      safeClick(confirmBtn);
      await wait(500);
    }

    // Wait for the "Buy N x Item for $Price? → Yes / No" confirmation popup.
    const confirmYesBtn = await waitForNode(
      () => [...document.querySelectorAll("button")].find(
        b => /^yes$/i.test((b.textContent || "").trim()) && b.offsetParent !== null
      ),
      3000
    );
    if (confirmYesBtn) {
      await simulateMouseMove(confirmYesBtn);
      safeClick(confirmYesBtn);
      await wait(500);
    }

    const success = await waitForNode(
      () => document.querySelector('[class*="successText___"]'),
      3000
    );
    // Credit the purchase toward the watchlist item's target quantity.
    // Done here (before the success check) because the bazaar page doesn't always
    // show the successText element — the buy was submitted regardless.
    const watchItem = settings.items.find(i => i.name.toLowerCase() === itemName.toLowerCase());
    if (watchItem) {
      watchItem.boughtQty = (watchItem.boughtQty || 0) + qty;
      saveSettings(settings);
      if (isItemDone(watchItem)) {
        console.log(LOG, `[Bazaar] "${itemName}" reached target of ${watchItem.targetQty} — will be skipped on return`);
      }
    }

    if (success) {
      showBazaarToast(`Bought ${formatNumber(qty)}x ${itemName} @ $${formatNumber(actualPrice)} — going back…`, "success");
      const closeBtn = document.querySelector(
        'button[aria-label="Close panel"], button[class*="closeButton___"]'
      );
      if (closeBtn) { safeClick(closeBtn); await wait(200); }
      await wait(2000);
      goBack();
    } else {
      showBazaarToast(`Buy submitted for ${itemName} — check inventory to confirm`, "info");
      await wait(2500);
      goBack();
    }
  }

  // ---- Bazaar snipe scan — runs on the item market page ----
  let _bazaarSnipeTimer  = null;
  let _bazaarSnipeBusy   = false;

  async function runBazaarSnipeScan() {
    if (isControllerOnly())                 return;
    if (_bazaarSnipeBusy)                   return;
    if (!settings.bazaarSniperEnabled)      return;
    if (!settings.enabled)                  return; // master auto-buy toggle
    if (!isItemMarketPage())                return;
    if (busy)                               return; // item-market buy in progress

    _bazaarSnipeBusy = true;
    try {
      _cacheCurrentDomItem();
      if (!tornItems) await fetchTornItems();

      const list = settings.items || [];
      let queue = loadBazaarQueue();

      // Only poll weav3r when the queue is empty — collect ALL qualifying listings
      // in one shot so every bazaar within budget is visited before the next poll.
      if (!queue.length) {
        const currentName      = getSelectedItemTitle();
        const currentWatchItem = currentName
          ? list.find(i => !i.skipped && !isItemDone(i) && i.name.toLowerCase() === currentName.toLowerCase())
          : null;
        const itemsToScan = currentWatchItem ? [currentWatchItem] : list;

        const now         = Math.floor(Date.now() / 1000);
        const maxStaleSec = Math.max(5, settings.bazaarMaxStaleMins || 15) * 60;

        for (const item of itemsToScan) {
          if (item.skipped || isItemDone(item)) continue;
          const cap = parseAmount(item.maxPrice);
          if (cap <= 0) continue;

          const itemId = getItemIdByName(item.name);
          if (!itemId) {
            console.log(LOG, `[Bazaar] No item ID for "${item.name}" — navigate to it in the item market to auto-detect its ID, or set a Torn API key`);
            continue;
          }

          setStatus(`[Bazaar] Checking ${item.name} via weav3r API…`);
          const data = await fetchWeav3rMarketplace(itemId, cap);
          if (!data?.listings?.length) continue;

          const valid = data.listings
            .filter(l => l.price <= cap && (now - (l.last_checked || 0)) < maxStaleSec)
            .filter(l => !isBazaarVisited(l.player_id, itemId, l.last_checked || 0))
            .sort((a, b) => a.price - b.price);

          for (const listing of valid) {
            queue.push({
              itemId:      String(itemId),
              itemName:    item.name,
              maxPrice:    cap,
              lastChecked: listing.last_checked || 0,
              listing,
            });
            // Mark visited now so a concurrent re-poll can't re-add this listing.
            markBazaarVisited(listing.player_id, itemId, listing.last_checked || 0);
          }
        }

        if (!queue.length) {
          setStatus("[Bazaar] Scan done — no qualifying listings right now.");
          return;
        }

        console.log(LOG, `[Bazaar] Queue built: ${queue.length} listing(s) to visit.`);
      }

      // Drain entries from the front that are no longer valid to visit.
      const now         = Math.floor(Date.now() / 1000);
      const maxStaleSec = Math.max(5, settings.bazaarMaxStaleMins || 15) * 60;
      while (queue.length) {
        const peek      = queue[0];
        const watchItem = list.find(i => i.name.toLowerCase() === peek.itemName.toLowerCase());
        const isStale   = peek.lastChecked > 0 && (now - peek.lastChecked) > maxStaleSec;
        if (!watchItem || watchItem.skipped || isItemDone(watchItem) || isStale || getMoneyOnHand() < peek.listing.price) {
          queue.shift();
          continue;
        }
        break;
      }

      if (!queue.length) {
        clearBazaarQueue();
        setStatus("[Bazaar] Queue exhausted — all listings visited or skipped.");
        return;
      }

      const next  = queue.shift();
      saveBazaarQueue(queue); // persist remaining entries for after we return

      const money = getMoneyOnHand();
      const ageSecs = now - next.lastChecked;
      console.log(
        LOG,
        `[Bazaar] Visiting "${next.itemName}" @ $${formatNumber(next.listing.price)} from player ${next.listing.player_id}`,
        `(updated ${Math.round(ageSecs / 60)}m ago, ${queue.length} more in queue)`
      );

      sessionStorage.setItem(SNIPE_RETURN_KEY, next.itemName);
      sessionStorage.setItem(BAZAAR_CTX_KEY, JSON.stringify({
        itemId:      next.itemId,
        itemName:    next.itemName,
        maxPrice:    next.maxPrice,
        lastChecked: next.lastChecked,
        money,
        listing:     next.listing,
        returnUrl:   location.href,
      }));

      const bazaarUrl =
        `https://www.torn.com/bazaar.php` +
        `?userId=${next.listing.player_id}` +
        `&itemId=${next.itemId}` +
        `&v=${next.lastChecked}` +
        `&tm-autobuy=1#/`;

      setStatus(`[Bazaar] Navigating → ${next.itemName} @ $${formatNumber(next.listing.price)} (${queue.length} more queued)…`);
      await wait(400);
      window.location.href = bazaarUrl;
    } catch (e) {
      console.warn(LOG, "runBazaarSnipeScan error", e);
    } finally {
      _bazaarSnipeBusy = false;
    }
  }

  function startBazaarSnipe() {
    stopBazaarSnipe();
    if (!settings.bazaarSniperEnabled || !isItemMarketPage()) return;
    runBazaarSnipeScan(); // run immediately
    const ms = Math.max(5, settings.bazaarPollSeconds || 5) * 1000;
    _bazaarSnipeTimer = setInterval(runBazaarSnipeScan, ms);
    console.log(LOG, `[Bazaar] Sniper started — polling every ${Math.round(ms / 1000)}s`);
  }

  function stopBazaarSnipe() {
    if (_bazaarSnipeTimer) { clearInterval(_bazaarSnipeTimer); _bazaarSnipeTimer = null; }
  }

  // =========================================================================
  // END BAZAAR SNIPER
  // =========================================================================

  // -------------------------------------------------------------------------
  // UI
  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // Torn API — item list + market prices
  // -------------------------------------------------------------------------
  async function fetchTornItems() {
    const apiKey = GM_getValue('tornApiKey', '');
    if (!apiKey) return;
    try {
      const cached = JSON.parse(localStorage.getItem(ITEMS_CACHE_KEY) || "{}");
      if (cached.ts && Date.now() - cached.ts < ITEMS_CACHE_TTL_MS && cached.data) {
        tornItems = cached.data;
        return;
      }
    } catch (e) {}
    try {
      const res = await fetch(
        `https://api.torn.com/torn/?selections=items&key=${apiKey}&comment=tmItemMarketBuy`,
      );
      const json = await res.json();
      if (json.error) {
        console.warn(LOG, "Torn API error:", json.error.error);
        return;
      }
      tornItems = json.items;
      localStorage.setItem(ITEMS_CACHE_KEY, JSON.stringify({ ts: Date.now(), data: tornItems }));
    } catch (e) {
      console.warn(LOG, "fetchTornItems failed", e);
    }
  }

  function getItemsMatching(prefix, limit = 12) {
    if (!tornItems || !prefix) return [];
    const lower = prefix.toLowerCase();
    return Object.values(tornItems)
      .filter(i => i.name.toLowerCase().includes(lower))
      .sort((a, b) => {
        const as = a.name.toLowerCase().startsWith(lower);
        const bs = b.name.toLowerCase().startsWith(lower);
        return as === bs ? a.name.localeCompare(b.name) : as ? -1 : 1;
      })
      .slice(0, limit);
  }

  function getMarketValue(name) {
    if (!tornItems) return 0;
    const lower = name.toLowerCase();
    const item = Object.values(tornItems).find(i => i.name.toLowerCase() === lower);
    return item?.market_value || 0;
  }

  function setupAutocomplete(input, onSelect) {
    const wrap = input.parentElement;
    const dd = document.createElement("div");
    dd.style.cssText = "display:none;position:absolute;top:calc(100% + 2px);left:0;right:0;z-index:100000;background:#1a1a1a;border:1px solid #444;border-radius:4px;max-height:180px;overflow-y:auto;box-shadow:0 4px 12px rgba(0,0,0,0.6);";
    wrap.appendChild(dd);

    let activeIdx = -1;
    const rows = () => Array.from(dd.children);

    const highlight = (i) => {
      rows().forEach((r, j) => { r.style.background = j === i ? "#2a2a3a" : ""; });
      activeIdx = i;
    };

    const render = (matches) => {
      dd.innerHTML = "";
      activeIdx = -1;
      if (!matches.length) { dd.style.display = "none"; return; }
      dd.style.display = "block";
      matches.forEach((item, i) => {
        const opt = document.createElement("div");
        opt.style.cssText = "padding:5px 8px;cursor:pointer;font-size:12px;display:flex;justify-content:space-between;align-items:center;gap:8px;";
        opt.innerHTML = `<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(item.name)}</span><span style="color:#f0a500;font-size:11px;white-space:nowrap;flex-shrink:0;">${item.market_value ? "$" + formatNumber(item.market_value) : ""}</span>`;
        opt.addEventListener("mouseover", () => highlight(i));
        opt.addEventListener("mousedown", e => { e.preventDefault(); onSelect(item); dd.style.display = "none"; });
        dd.appendChild(opt);
      });
    };

    input.addEventListener("input", () => {
      const v = input.value.trim();
      if (!v || !tornItems) { dd.style.display = "none"; return; }
      render(getItemsMatching(v));
    });

    input.addEventListener("keydown", e => {
      const list = rows();
      if (!list.length || dd.style.display === "none") return;
      if (e.key === "ArrowDown") { e.preventDefault(); highlight(Math.min(activeIdx + 1, list.length - 1)); }
      else if (e.key === "ArrowUp") { e.preventDefault(); highlight(Math.max(activeIdx - 1, 0)); }
      else if (e.key === "Enter" && activeIdx >= 0) { e.preventDefault(); list[activeIdx].dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); }
      else if (e.key === "Escape") { dd.style.display = "none"; }
    });

    document.addEventListener("click", e => {
      if (!wrap.contains(e.target)) dd.style.display = "none";
    }, { passive: true });

    return { close: () => { dd.style.display = "none"; } };
  }

  // -------------------------------------------------------------------------
  // Mobile detection
  // -------------------------------------------------------------------------
  function isMobile() {
    return (
      /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ||
      window.innerWidth < 768
    );
  }

  function setStatus(text) {
    const el = document.getElementById("tm-imbuy-status");
    if (el) el.textContent = text;
    console.log(LOG, text);
  }

  function escHtml(s) {
    return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }

  function renderItemList() {
    const container = document.getElementById("tm-imbuy-items-list");
    const summary = document.getElementById("tm-imbuy-items-summary");
    if (!container) return;
    const list = settings.items || [];
    if (summary) summary.textContent = `(${list.length} item${list.length !== 1 ? "s" : ""}) — top = first bought`;
    if (!list.length) {
      container.innerHTML = '<div style="color:#555;font-size:12px;padding:6px 0;">No items. Add one below.</div>';
      return;
    }
    const btnS = "padding:1px 5px;background:#222;border:1px solid #444;color:#ccc;border-radius:3px;cursor:pointer;font-size:11px;";
    const editS = "padding:1px 5px;background:#1a2a3a;border:1px solid #2a4a6a;color:#6af;border-radius:3px;cursor:pointer;font-size:11px;";
    const delS = "padding:1px 5px;background:#220000;border:1px solid #622;color:#f66;border-radius:3px;cursor:pointer;font-size:11px;";
    const skipS = "padding:1px 5px;background:#1a1a0a;border:1px solid #554400;color:#aa8;border-radius:3px;cursor:pointer;font-size:11px;";
    const unskipS = "padding:1px 5px;background:#0a1a0a;border:1px solid #2a6a2a;color:#6f6;border-radius:3px;cursor:pointer;font-size:11px;";
    const resetS = "padding:1px 4px;background:#0a1a2a;border:1px solid #2a4a6a;color:#6af;border-radius:3px;cursor:pointer;font-size:10px;";
    container.innerHTML = "";
    list.forEach((item, i) => {
      const done = isItemDone(item);
      const row = document.createElement("div");
      row.style.cssText = `display:flex;align-items:center;gap:4px;padding:4px 0;border-bottom:1px solid #2a2a2a;${(item.skipped || done) ? "opacity:0.45;" : ""}`;
      const priceHtml = item.maxPrice
        ? `<span style="color:#f0a500;font-size:11px;white-space:nowrap;">&#8804; $${formatNumber(parseAmount(item.maxPrice))}</span>`
        : `<span style="color:#555;font-size:11px;">no max</span>`;
      const targetQty = item.targetQty || 0;
      const boughtQty = item.boughtQty || 0;
      const progressHtml = targetQty > 0
        ? `<span style="font-size:10px;color:${done ? "#44cc88" : "#888"};white-space:nowrap;" title="${boughtQty} bought of ${targetQty} target">${boughtQty}/${targetQty}</span>`
        : "";
      const resetBtnHtml = targetQty > 0
        ? `<button data-action="reset" data-idx="${i}" style="${resetS}" title="Reset bought counter (${boughtQty} → 0)">&#8635;</button>`
        : "";
      row.innerHTML = [
        `<span style="color:#555;font-size:10px;min-width:16px;text-align:right;">${i + 1}.</span>`,
        `<span style="flex:1;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;${(item.skipped || done) ? "text-decoration:line-through;color:#555;" : ""}">${escHtml(item.name)}</span>`,
        priceHtml,
        progressHtml,
        resetBtnHtml,
        `<button data-action="skip" data-idx="${i}" style="${item.skipped ? unskipS : skipS}" title="${item.skipped ? "Enable item" : "Skip item"}">${item.skipped ? "&#9654;" : "&#9646;&#9646;"}</button>`,
        `<button data-action="edit" data-idx="${i}" style="${editS}">&#9998;</button>`,
        `<button data-action="up" data-idx="${i}" style="${btnS}"${i === 0 ? " disabled" : ""}>&#8593;</button>`,
        `<button data-action="down" data-idx="${i}" style="${btnS}"${i === list.length - 1 ? " disabled" : ""}>&#8595;</button>`,
        `<button data-action="remove" data-idx="${i}" style="${delS}">&#215;</button>`,
      ].join("");
      container.appendChild(row);
    });
  }

  function buildPanelElement() {
    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.style.cssText =
      "color:#eee;font-family:Arial,sans-serif;font-size:13px;box-sizing:border-box;width:100%;";
    panel.innerHTML = `
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;box-sizing:border-box;width:100%;">

        <!-- Header -->
        <div style="display:flex;justify-content:space-between;align-items:center;flex:1 1 100%;">
          <strong>&#128722; Item Market Auto Buy</strong>
        </div>

        <!-- Active item / countdown badge -->
        <div id="tm-imbuy-countdown" style="flex:1 1 100%;color:#f0a500;font-weight:bold;font-size:12px;background:#111;border:1px solid #2a2a2a;border-radius:6px;padding:6px 10px;min-height:1.5em;font-variant-numeric:tabular-nums;"></div>

        <!-- Status line -->
        <span id="tm-imbuy-status" style="flex:1 1 100%;color:#8bd;font-size:12px;min-height:1em;"></span>

        <!-- Watchlist -->
        <details id="tm-imbuy-items-toggle" open style="flex:1 1 100%;border-top:1px solid #333;padding-top:6px;">
          <summary style="cursor:pointer;color:#aaa;font-size:12px;user-select:none;list-style:none;display:flex;justify-content:space-between;align-items:center;">
            <span style="font-weight:bold;">Watchlist <span id="tm-imbuy-items-summary" style="font-weight:normal;color:#666;font-size:11px;"></span></span>
          </summary>
          <div id="tm-imbuy-items-list" style="margin-top:6px;max-height:200px;overflow-y:auto;"></div>
          <div style="display:flex;gap:6px;margin-top:8px;flex-wrap:wrap;align-items:center;">
            <div id="tm-imbuy-name-wrap" style="flex:2;min-width:120px;position:relative;">
              <input id="tm-imbuy-new-name" type="text" placeholder="Item name..."
                style="width:100%;padding:4px 6px;border-radius:4px;border:1px solid #555;background:#111;color:#eee;font-size:12px;box-sizing:border-box;">
            </div>
            <input id="tm-imbuy-new-price" type="text" placeholder="Max price (auto-fills from market)"
              style="flex:1;min-width:90px;padding:4px 6px;border-radius:4px;border:1px solid #555;background:#111;color:#eee;font-size:12px;box-sizing:border-box;">
            <input id="tm-imbuy-new-targetqty" type="number" min="0" placeholder="Target qty"
              title="Stop buying this item after this many are purchased (0 = unlimited)"
              style="width:72px;padding:4px 6px;border-radius:4px;border:1px solid #555;background:#111;color:#eee;font-size:12px;box-sizing:border-box;">
            <button id="tm-imbuy-add-item" style="padding:4px 10px;border-radius:4px;border:1px solid #555;background:#333;color:#eee;cursor:pointer;font-size:12px;white-space:nowrap;">+ Add</button>
          </div>
          <div style="color:#555;font-size:10px;margin-top:4px;">Top item is bought first. &#8804; = max price cap. Blank price uses market value. Target qty = 0 means unlimited.</div>
        </details>

        <!-- Options grid (3 cols desktop / 2 cols mobile) -->
        <div style="flex:1 1 100%;display:grid;grid-template-columns:${isMobile() ? '1fr 1fr' : '1fr 1fr 1fr'};gap:8px 16px;border-top:1px solid #333;padding-top:8px;">
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;">
            <input id="tm-imbuy-enabled" type="checkbox"> Auto-buy
          </label>
          <label style="display:flex;align-items:center;gap:6px;user-select:none;" title="Move to the next watchlist item after this many seconds without a purchase">
            Next item after:
            <input id="tm-imbuy-timeout" type="number" min="1"
              style="width:52px;padding:3px 6px;border-radius:4px;border:1px solid #555;background:#111;color:#eee;font-size:12px;box-sizing:border-box;text-align:center;">
            s
          </label>
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;" title="Poll cloud every 15s to sync settings across devices.">
            <input id="tm-imbuy-cloud-poll" type="checkbox"> Cloud sync
            <span id="tm-imbuy-cloud-next" style="font-size:10px;color:#555;font-variant-numeric:tabular-nums;"></span>
          </label>
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;" title="When checked, the automation device navigates to the Torn home page. Syncs via cloud — check this from your phone to send it home.">
            <input id="tm-imbuy-go-home" type="checkbox"> Go Home
          </label>
          <label style="display:flex;align-items:center;gap:6px;user-select:none;" title="Auto-buy stops automatically after this many hours. Set 0 to run indefinitely.">
            Run for
            <input id="tm-imbuy-duration-hours" type="number" min="0" step="0.5"
              style="width:52px;padding:3px 6px;border-radius:4px;border:1px solid #555;background:#111;color:#eee;font-size:12px;box-sizing:border-box;text-align:center;">
            h <span style="color:#555;font-size:11px;">(0 = ∞)</span>
          </label>
          <div style="display:flex;align-items:center;gap:8px;">
            <button id="tm-imbuy-reset-timer" style="padding:3px 8px;border-radius:4px;border:1px solid #2a4a6a;background:#0a1a2a;color:#6af;cursor:pointer;font-size:12px;" title="Reset the run timer — restarts the duration countdown from now, and re-enables auto-buy if it was stopped by an expired timer">&#8635; Reset timer</button>
            <span id="tm-imbuy-timer-remaining" style="font-size:11px;color:#666;font-variant-numeric:tabular-nums;"></span>
          </div>
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;color:#f0a500;" title="View and control settings from this device without running automation. Safe for phone use.">
            <input id="tm-imbuy-controller-only" type="checkbox"> Controller only
          </label>
        </div>
        <div id="tm-imbuy-controller-banner" style="display:none;background:#2a1f00;border:1px solid #f0a500;border-radius:4px;padding:5px 10px;font-size:11px;color:#f0a500;text-align:center;margin-top:4px;">
          Controller Only Mode — automation is paused on this device
        </div>

        <!-- Bazaar Sniper -->
        <details id="tm-imbuy-bazaar-toggle" style="flex:1 1 100%;border-top:1px solid #333;padding-top:8px;">
          <summary style="cursor:pointer;color:#aaa;font-size:12px;user-select:none;list-style:none;display:flex;justify-content:space-between;align-items:center;">
            <span style="font-weight:bold;">&#128270; Bazaar Sniper <span style="font-weight:normal;color:#666;font-size:11px;">(weav3r API)</span></span>
          </summary>
          <div style="margin-top:8px;display:flex;flex-direction:column;gap:8px;">
            <div style="color:#666;font-size:11px;line-height:1.4;">
              Polls weav3r.dev for bazaar listings. When a watched item hits your max price, navigates to that seller's bazaar and buys the maximum quantity you can afford.
            </div>
            <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;">
              <label style="display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;">
                <input id="tm-imbuy-bazaar-enabled" type="checkbox"> Enable Bazaar Sniper
              </label>
            </div>
            <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;">
              <label style="display:flex;align-items:center;gap:6px;user-select:none;" title="How often to poll the weav3r API for each item">
                Poll every
                <input id="tm-imbuy-bazaar-poll" type="number" min="5" max="600"
                  style="width:52px;padding:3px 6px;border-radius:4px;border:1px solid #555;background:#111;color:#eee;font-size:12px;box-sizing:border-box;text-align:center;">
                s
              </label>
              <label style="display:flex;align-items:center;gap:6px;user-select:none;" title="Listings older than this are skipped — they may already be sold">
                Max listing age
                <input id="tm-imbuy-bazaar-stale" type="number" min="1" max="60"
                  style="width:42px;padding:3px 6px;border-radius:4px;border:1px solid #555;background:#111;color:#eee;font-size:12px;box-sizing:border-box;text-align:center;">
                min
              </label>
            </div>
            <div style="color:#555;font-size:10px;">
              Requires a Torn API key (set via Tampermonkey menu) to resolve item names to IDs.
            </div>
            <div id="tm-imbuy-bazaar-status-line" style="color:#8bd;font-size:11px;min-height:1em;"></div>
          </div>
        </details>

      </div>
    `;
    return panel;
  }

  function wirePanel(panelEl) {
    if (!panelEl || panelEl.dataset.wired) return;
    panelEl.dataset.wired = "1";
    const $ = (id) => panelEl.querySelector(`#${id}`);
    const timeoutEl = $("tm-imbuy-timeout");
    const enabledEl = $("tm-imbuy-enabled");
    if (!timeoutEl || !enabledEl) return;

    timeoutEl.value = settings.noBuySeconds || 20;
    enabledEl.checked = !!settings.enabled;

    // Watchlist row interactions (edit / save / cancel / up / down / remove)
    const itemsList = $("tm-imbuy-items-list");
    if (itemsList) {
      renderItemList();
      itemsList.addEventListener("click", e => {
        const btn = e.target.closest("button[data-action]");
        if (!btn) return;
        const action = btn.dataset.action;
        const idx = parseInt(btn.dataset.idx, 10);
        const inpS = "padding:2px 5px;border-radius:3px;border:1px solid #555;background:#111;color:#eee;font-size:12px;box-sizing:border-box;min-width:0;";
        const saveS = "padding:1px 5px;background:#1a3a1a;border:1px solid #2a6a2a;color:#6f6;border-radius:3px;cursor:pointer;font-size:11px;";
        const cancelS = "padding:1px 5px;background:#220000;border:1px solid #622;color:#f66;border-radius:3px;cursor:pointer;font-size:11px;";

        if (action === "reset") {
          if (settings.items[idx]) {
            settings.items[idx].boughtQty = 0;
            saveSettings(settings);
            renderItemList();
          }
          return;
        } else if (action === "edit") {
          const item = settings.items[idx];
          if (!item) return;
          const row = btn.closest("div");
          row.innerHTML = [
            `<span style="color:#555;font-size:10px;min-width:16px;text-align:right;">${idx + 1}.</span>`,
            `<input type="text" data-edit-name="${idx}" value="${escHtml(item.name)}" style="flex:2;${inpS}">`,
            `<input type="text" data-edit-price="${idx}" value="${escHtml(item.maxPrice || "")}" placeholder="Max price" style="flex:1;${inpS}">`,
            `<input type="number" data-edit-targetqty="${idx}" value="${item.targetQty || 0}" min="0" placeholder="Target qty" title="Target quantity (0 = unlimited)" style="width:60px;${inpS}">`,
            `<button data-action="save" data-idx="${idx}" style="${saveS}">&#10003;</button>`,
            `<button data-action="cancel" data-idx="${idx}" style="${cancelS}">&#10007;</button>`,
          ].join("");
          const nameInp = row.querySelector("input[data-edit-name]");
          nameInp && nameInp.focus();
          nameInp && nameInp.addEventListener("keydown", ev => {
            if (ev.key === "Enter") { ev.preventDefault(); row.querySelector('[data-action="save"]').click(); }
            if (ev.key === "Escape") { ev.preventDefault(); renderItemList(); }
          });
        } else if (action === "save") {
          const row = btn.closest("div");
          const name = (row.querySelector("input[data-edit-name]")?.value || "").trim();
          const price = (row.querySelector("input[data-edit-price]")?.value || "").trim();
          const targetQty = Math.max(0, parseInt(row.querySelector("input[data-edit-targetqty]")?.value || "0", 10) || 0);
          if (name && settings.items[idx]) {
            settings.items[idx].name = name;
            settings.items[idx].maxPrice = price;
            settings.items[idx].targetQty = targetQty;
            lastSearchedItem = null;
            saveSettings(settings);
          }
          renderItemList();
        } else if (action === "cancel") {
          renderItemList();
        } else if (action === "skip") {
          if (settings.items[idx]) {
            settings.items[idx].skipped = !settings.items[idx].skipped;
            saveSettings(settings);
            renderItemList();
          }
        } else {
          if (action === "remove") settings.items.splice(idx, 1);
          else if (action === "up" && idx > 0) [settings.items[idx - 1], settings.items[idx]] = [settings.items[idx], settings.items[idx - 1]];
          else if (action === "down" && idx < settings.items.length - 1) [settings.items[idx], settings.items[idx + 1]] = [settings.items[idx + 1], settings.items[idx]];
          lastSearchedItem = null;
          currentIndex = 0;
          itemStartTs = Date.now();
          saveSettings(settings);
          renderItemList();
        }
      });
    }

    // Add item button
    const addBtn = $("tm-imbuy-add-item");
    if (addBtn) {
      const doAdd = () => {
        const name = ($("tm-imbuy-new-name")?.value || "").trim();
        let price = ($("tm-imbuy-new-price")?.value || "").trim();
        if (!name) return;
        // Fall back to market value when no price was entered
        if (!price) {
          const mv = getMarketValue(name);
          if (mv > 0) price = String(mv);
        }
        const targetQty = Math.max(0, parseInt($("tm-imbuy-new-targetqty")?.value || "0", 10) || 0);
        if (!settings.items.some(i => i.name.toLowerCase() === name.toLowerCase())) {
          settings.items.push({ name, maxPrice: price, targetQty, boughtQty: 0 });
          saveSettings(settings);
          renderItemList();
          const toggle = $("tm-imbuy-items-toggle");
          if (toggle && !toggle.open) toggle.open = true;
        }
        const nameEl = $("tm-imbuy-new-name");
        const priceEl = $("tm-imbuy-new-price");
        const qtyEl = $("tm-imbuy-new-targetqty");
        if (nameEl) nameEl.value = "";
        if (priceEl) priceEl.value = "";
        if (qtyEl) qtyEl.value = "";
      };
      addBtn.addEventListener("click", doAdd);
      $("tm-imbuy-new-name")?.addEventListener("keydown", e => {
        if (e.key === "Enter") { e.preventDefault(); doAdd(); }
      });
    }

    // Autocomplete on name input
    const nameInput = $("tm-imbuy-new-name");
    if (nameInput) {
      setupAutocomplete(nameInput, item => {
        nameInput.value = item.name;
        const priceEl = $("tm-imbuy-new-price");
        if (priceEl && !priceEl.value && item.market_value) {
          priceEl.value = String(item.market_value);
        }
      });
    }

    // Load items from cache / API on panel init
    fetchTornItems();

    timeoutEl.addEventListener("change", () => {
      settings.noBuySeconds = Math.max(1, parseInt(timeoutEl.value || 20, 10));
      saveSettings(settings);
    });
    enabledEl.addEventListener("change", () => {
      settings.enabled = !!enabledEl.checked;
      saveSettings(settings);
      if (settings.enabled) startMonitor();
      else {
        stopMonitor();
        const cd = $("tm-imbuy-countdown");
        if (cd) cd.innerHTML = '<span style="color:#555;">—</span>';
        setStatus("Auto-buy off.");
      }
    });
    const cloudPollEl = $("tm-imbuy-cloud-poll");
    if (cloudPollEl) {
      cloudPollEl.checked = isCloudPollEnabled();
      cloudPollEl.addEventListener("change", () => {
        localStorage.setItem(CLOUD_POLL_KEY, String(cloudPollEl.checked));
        cloudPollEl.checked ? startCloudPoll() : stopCloudPoll();
      });
    }

    const controllerOnlyEl = $("tm-imbuy-controller-only");
    const controllerBanner = $("tm-imbuy-controller-banner");
    const applyControllerOnly = (on) => {
      if (controllerBanner) controllerBanner.style.display = on ? "block" : "none";
      if (on) stopMonitor();
      else if (settings.enabled) startMonitor();
    };
    if (controllerOnlyEl) {
      controllerOnlyEl.checked = isControllerOnly();
      applyControllerOnly(controllerOnlyEl.checked);
      controllerOnlyEl.addEventListener("change", () => {
        localStorage.setItem(CONTROLLER_ONLY_KEY, String(controllerOnlyEl.checked));
        applyControllerOnly(controllerOnlyEl.checked);
      });
    }

    const goHomeEl = $("tm-imbuy-go-home");
    if (goHomeEl) {
      goHomeEl.checked = !!settings.goHome;
      goHomeEl.addEventListener("change", () => {
        settings.goHome = !!goHomeEl.checked;
        saveSettings(settings);
        // On the automation device, execute immediately — don't wait for the
        // cloud poll cycle (which would skip because _lastCloudContent already
        // reflects the save we just did).
        if (settings.goHome && !isControllerOnly()) {
          settings.goHome = false;
          saveSettings(settings);
          window.location.href = "https://www.torn.com/index.php";
        }
      });
    }

    // ---- Bazaar Sniper controls ----
    const bazaarEnabledEl = $("tm-imbuy-bazaar-enabled");
    const bazaarPollEl    = $("tm-imbuy-bazaar-poll");
    const bazaarStaleEl   = $("tm-imbuy-bazaar-stale");
    const bazaarStatusEl  = $("tm-imbuy-bazaar-status-line");

    const updateBazaarStatus = (msg) => { if (bazaarStatusEl) bazaarStatusEl.textContent = msg; };

    if (bazaarPollEl)    bazaarPollEl.value  = String(settings.bazaarPollSeconds  || 5);
    if (bazaarStaleEl)   bazaarStaleEl.value = String(settings.bazaarMaxStaleMins || 15);
    if (bazaarEnabledEl) bazaarEnabledEl.checked = !!settings.bazaarSniperEnabled;

    if (bazaarEnabledEl) {
      bazaarEnabledEl.addEventListener("change", () => {
        settings.bazaarSniperEnabled = !!bazaarEnabledEl.checked;
        saveSettings(settings);
        if (settings.bazaarSniperEnabled) {
          startBazaarSnipe();
          updateBazaarStatus("Sniper active — scanning on next poll cycle.");
        } else {
          stopBazaarSnipe();
          updateBazaarStatus("Sniper disabled.");
        }
      });
    }
    if (bazaarPollEl) {
      bazaarPollEl.addEventListener("change", () => {
        settings.bazaarPollSeconds = Math.max(5, parseInt(bazaarPollEl.value || "5", 10));
        saveSettings(settings);
        if (settings.bazaarSniperEnabled) startBazaarSnipe(); // restart with new interval
      });
    }
    if (bazaarStaleEl) {
      bazaarStaleEl.addEventListener("change", () => {
        settings.bazaarMaxStaleMins = Math.max(1, parseInt(bazaarStaleEl.value || "15", 10));
        saveSettings(settings);
      });
    }

    const durationEl    = $("tm-imbuy-duration-hours");
    const resetTimerBtn = $("tm-imbuy-reset-timer");

    if (durationEl) {
      durationEl.value = String(settings.autoBuyDurationHours || 0);
      durationEl.addEventListener("change", () => {
        settings.autoBuyDurationHours = Math.max(0, parseFloat(durationEl.value || "0") || 0);
        saveSettings(settings);
        updateTimerDisplay();
      });
    }
    if (resetTimerBtn) {
      resetTimerBtn.addEventListener("click", () => {
        setAutoBuyStartTs(Date.now());
        if (!settings.enabled) {
          settings.enabled = true;
          saveSettings(settings);
          const enabledEl = $("tm-imbuy-enabled");
          if (enabledEl) enabledEl.checked = true;
          startMonitor();
        }
        updateTimerDisplay();
        setStatus("Timer reset. Auto-buy running…");
      });
    }
    updateTimerDisplay();

    setStatus(
      settings.enabled
        ? "Auto-buy on."
        : `Cash: $${formatNumber(getMoneyOnHand())}. ${settings.items.length} item(s). Add items then enable.`,
    );
  }

  function injectUI() {
    if (!isItemMarketPage() && !isBazaarPage()) return;
    if (document.getElementById(FAB_ID)) return;

    // Remove any old inline panel left over from a previous script version.
    document.getElementById(PANEL_ID)?.remove();

    const panel = buildPanelElement();

    const fab = document.createElement("button");
    fab.id = FAB_ID;
    fab.innerHTML = "&#128722;";
    fab.style.cssText = [
      "position:fixed",
      "bottom:24px",
      "right:16px",
      "width:52px",
      "height:52px",
      "border-radius:50%",
      "background:#1a1a1a",
      "border:2px solid #555",
      "color:#eee",
      "font-size:24px",
      "line-height:1",
      "z-index:999999",
      "cursor:pointer",
      "display:flex",
      "align-items:center",
      "justify-content:center",
      "box-shadow:0 3px 10px rgba(0,0,0,0.6)",
      "touch-action:manipulation",
    ].join(";");
    document.body.appendChild(fab);

    const backdrop = document.createElement("div");
    backdrop.id = MODAL_ID;
    backdrop.style.cssText = [
      "position:fixed",
      "inset:0",
      "background:rgba(0,0,0,0.65)",
      "z-index:999998",
      "display:none",
      "align-items:flex-end",
      "justify-content:center",
    ].join(";");

    const sheet = document.createElement("div");
    if (isMobile()) {
      sheet.style.cssText = [
        "background:#1a1a1a",
        "border:1px solid #444",
        "border-radius:16px 16px 0 0",
        "padding:16px",
        "width:100%",
        "box-sizing:border-box",
        "max-height:80vh",
        "overflow-y:auto",
      ].join(";");
    } else {
      sheet.style.cssText = [
        "background:#1a1a1a",
        "border:1px solid #444",
        "border-radius:16px",
        "padding:16px",
        "width:480px",
        "max-width:90vw",
        "box-sizing:border-box",
        "max-height:85vh",
        "overflow-y:auto",
        "margin-bottom:80px",
        "box-shadow:0 8px 32px rgba(0,0,0,0.7)",
      ].join(";");
    }

    const handle = document.createElement("div");
    handle.style.cssText =
      "width:40px;height:4px;background:#555;border-radius:2px;margin:0 auto 14px;";
    sheet.appendChild(handle);
    sheet.appendChild(panel);
    backdrop.appendChild(sheet);
    document.body.appendChild(backdrop);

    const open = () => (backdrop.style.display = "flex");
    const close = () => (backdrop.style.display = "none");
    fab.addEventListener("click", () =>
      backdrop.style.display === "flex" ? close() : open(),
    );
    backdrop.addEventListener("click", (e) => {
      if (e.target === backdrop) close();
    });

    wirePanel(panel);
  }

  // -------------------------------------------------------------------------
  // Startup
  // -------------------------------------------------------------------------
  console.log(LOG, "starting. mobile=" + isMobile(), "bazaarPage=" + isBazaarPage());

  if (isBazaarPage()) {
    // ---- Bazaar page: just run the auto-buy routine if we were redirected ----
    // Wait for the DOM to settle before interacting.
    const _bazaarBoot = async () => {
      try { injectUI(); } catch (e) {}
      // Start cloud sync on the bazaar page so the "Go Home" remote command
      // is detected and acted on immediately — even mid-buy.
      flushPersistedCloudSave()
        .then(() => initCloudSync())
        .catch(e => console.warn(LOG, "bazaar cloud init error:", e));
      startCloudPoll();
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") pollCloudSync();
      }, { passive: true });
      await wait(800);
      try {
        await runBazaarAutoBuy();
      } catch (e) {
        console.error(LOG, "runBazaarAutoBuy failed", e);
      }
    };
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", () => _bazaarBoot());
    } else {
      _bazaarBoot();
    }
  } else {
    // ---- Item Market / imarket page: full UI + monitors ----
    try {
      injectUI();
    } catch (e) {
      console.error(LOG, "injectUI failed", e);
    }

    // Re-inject on SPA re-renders (panel/FAB removed by React).
    const uiObserver = new MutationObserver(() => {
      if (!document.getElementById(FAB_ID)) injectUI();
    });
    uiObserver.observe(document.documentElement, {
      childList: true,
      subtree: true,
    });

    setInterval(() => {
      if (!isItemMarketPage()) {
        document.getElementById(FAB_ID)?.remove();
        document.getElementById(MODAL_ID)?.remove();
        document.getElementById(PANEL_ID)?.remove();
        return;
      }
      // Remove any stray inline panel (old script version remnant).
      const inlinePanel = document.getElementById(PANEL_ID);
      if (inlinePanel && !inlinePanel.closest(`#${MODAL_ID}`)) inlinePanel.remove();
      if (!document.getElementById(FAB_ID)) {
        try { injectUI(); } catch (e) {}
      }
    }, 1000);

    // Restore currentIndex to the sniped item after returning from bazaar.
    // Must be applied AFTER startMonitor() because startMonitor resets currentIndex to 0.
    const _returnItem = sessionStorage.getItem(SNIPE_RETURN_KEY);
    let _returnIdx = -1;
    if (_returnItem) {
      _returnIdx = (settings.items || []).findIndex(
        i => i.name.toLowerCase() === _returnItem.toLowerCase()
      );
    }

    startMonitor();

    if (_returnIdx >= 0) currentIndex = _returnIdx;
    flushPersistedCloudSave()
      .then(() => initCloudSync())
      .catch(e => console.warn(LOG, "cloud init error:", e));
    startCloudPoll();
    // Trigger an immediate cloud check whenever the tab gets focus so remote
    // commands (Go Home) are detected without waiting for the 15s poll interval.
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") pollCloudSync();
    }, { passive: true });

    // Start bazaar sniper if it was enabled in the last session.
    if (settings.bazaarSniperEnabled) startBazaarSnipe();

    // After returning from a bazaar sniper buy, re-select the same item so the
    // sniper continues buying it without the user having to navigate back manually.
    (async () => {
      const returnItem = sessionStorage.getItem(SNIPE_RETURN_KEY);
      if (!returnItem) return;
      sessionStorage.removeItem(SNIPE_RETURN_KEY);
      await waitForNode(() => getSearchInput(), 10000);
      await ensureItemSelected(returnItem);
    })();
  }

  // Debug helpers for console testing.
  try {
    window.tmItemMarketBuy = {
      settingsKey: KEY,
      get settings() {
        return settings;
      },
      loadSettings,
      saveSettings: () => saveSettings(settings),
      getMoneyOnHand,
      getSelectedItemTitle,
      getSellerRows,
      parseRow,
      scanNow: scanAndBuy,
      ensureItemSelected,
      parseItemsText,
      serializeItems,
      advanceItem,
      get currentIndex() {
        return currentIndex;
      },
      startMonitor,
      stopMonitor,
      startBazaarSnipe,
      stopBazaarSnipe,
      runBazaarSnipeScan,
      runBazaarAutoBuy,
      getItemIdByName,
      fetchWeav3rMarketplace,
      isBazaarVisited,
      markBazaarVisited,
      clearBazaarVisited,
    };
    console.log(LOG, "helpers available at window.tmItemMarketBuy");
  } catch (e) {}

  GM_registerMenuCommand('Set API Key', () => {
    const current = GM_getValue('tornApiKey', '');
    const key = prompt('Enter your Torn API key:', current);
    if (key === null) return;
    GM_setValue('tornApiKey', key.trim());
  });
})();

