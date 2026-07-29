// ==UserScript==
// @name         Torn Item Market Auto Buy
// @namespace    http://tampermonkey.net/
// @version      1.5
// @description  Auto-buy a watchlist of items on the Torn item market, sizing quantity to your cash on hand, cycling items on a no-buy timeout, with an on-page settings panel.
// @author       GitHub Copilot
// @match        https://www.torn.com/page.php*
// @match        https://www.torn.com/imarket.php*
// @grant        GM_xmlhttpRequest
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

  const DEFAULTS = {
    items: [], // watchlist: [{ name, maxPrice }]
    noBuySeconds: 20, // advance to next item after this long with no purchase
    enabled: false,
    apiKey: "v6Yo75UQIYvWYrhT",
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
      if (!merged.apiKey) merged.apiKey = DEFAULTS.apiKey;
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
    if (!merged.apiKey) merged.apiKey = DEFAULTS.apiKey;
    try { localStorage.setItem(KEY, JSON.stringify(merged)); } catch(e) {}
    settings = merged;
    const panel = document.getElementById(PANEL_ID);
    if (panel) {
      const timeoutEl = panel.querySelector("#tm-imbuy-timeout");
      const enabledEl = panel.querySelector("#tm-imbuy-enabled");
      if (timeoutEl) timeoutEl.value = String(settings.noBuySeconds ?? 20);
      if (enabledEl) enabledEl.checked = !!settings.enabled;
      renderItemList();
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

  function getSearchInput() {
    return document.querySelector('input[class*="searchInput___"]');
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
      const opts = Array.from(
        document.querySelectorAll(
          '[class*="autocomplete"] [role="option"], [class*="dropdown-content"] [role="option"], [class*="autocomplete"] li, [class*="dropdown-content"] li',
        ),
      );
      return (
        opts.find(
          (o) =>
            o.textContent &&
            o.textContent.trim().toLowerCase() === target.toLowerCase(),
        ) ||
        opts.find(
          (o) =>
            o.textContent &&
            o.textContent.trim().toLowerCase().includes(target.toLowerCase()),
        ) ||
        null
      );
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

  async function scanAndBuy() {
    if (isControllerOnly()) return;
    if (!settings.enabled) return;
    if (!isItemMarketPage()) return;
    if (busy) return;
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
      while (list[currentIndex]?.skipped) {
        currentIndex = (currentIndex + 1) % list.length;
        if (currentIndex === _skipStart) { setStatus("All items are skipped."); return; }
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
        const qty = Math.min(entry.available, affordable);
        if (qty < 1) break; // can't afford even one at this (cheapest remaining) price
        const ok = await buyFromRow(entry, qty);
        if (ok) {
          boughtUnits += qty;
          spent += qty * entry.unitPrice;
          itemStartTs = Date.now(); // reset dwell timer — keep sniping this item
          setStatus(
            `${tag}: bought ${formatNumber(boughtUnits)} @ up to $${formatNumber(cap)} (spent ~$${formatNumber(spent)}). Cash $${formatNumber(getMoneyOnHand())}.`,
          );
          await wait(700); // let React + money update settle
        } else {
          // Stop the sweep on failure to avoid hammering a broken row.
          break;
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
    } while (list[currentIndex]?.skipped && currentIndex !== startIdx);
    if (list[currentIndex]?.skipped) return; // all items skipped
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
  // UI
  // -------------------------------------------------------------------------
  // -------------------------------------------------------------------------
  // Torn API — item list + market prices
  // -------------------------------------------------------------------------
  async function fetchTornItems() {
    if (!settings.apiKey) return;
    try {
      const cached = JSON.parse(localStorage.getItem(ITEMS_CACHE_KEY) || "{}");
      if (cached.ts && Date.now() - cached.ts < ITEMS_CACHE_TTL_MS && cached.data) {
        tornItems = cached.data;
        return;
      }
    } catch (e) {}
    try {
      const res = await fetch(
        `https://api.torn.com/torn/?selections=items&key=${settings.apiKey}&comment=tmItemMarketBuy`,
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
    container.innerHTML = "";
    list.forEach((item, i) => {
      const row = document.createElement("div");
      row.style.cssText = `display:flex;align-items:center;gap:4px;padding:4px 0;border-bottom:1px solid #2a2a2a;${item.skipped ? "opacity:0.45;" : ""}`;
      const priceHtml = item.maxPrice
        ? `<span style="color:#f0a500;font-size:11px;white-space:nowrap;">&#8804; $${formatNumber(parseAmount(item.maxPrice))}</span>`
        : `<span style="color:#555;font-size:11px;">no max</span>`;
      row.innerHTML = [
        `<span style="color:#555;font-size:10px;min-width:16px;text-align:right;">${i + 1}.</span>`,
        `<span style="flex:1;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;${item.skipped ? "text-decoration:line-through;color:#555;" : ""}">${escHtml(item.name)}</span>`,
        priceHtml,
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
            <button id="tm-imbuy-add-item" style="padding:4px 10px;border-radius:4px;border:1px solid #555;background:#333;color:#eee;cursor:pointer;font-size:12px;white-space:nowrap;">+ Add</button>
          </div>
          <div style="color:#555;font-size:10px;margin-top:4px;">Top item is bought first. &#8804; = max price cap. Blank price uses market value.</div>
        </details>

        <!-- Options row -->
        <div style="flex:1 1 100%;display:flex;gap:12px;flex-wrap:wrap;align-items:center;border-top:1px solid #333;padding-top:8px;">
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
          </label>
          <span id="tm-imbuy-cloud-next" style="font-size:10px;color:#555;font-variant-numeric:tabular-nums;"></span>
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;margin-left:auto;color:#f0a500;" title="View and control settings from this device without running automation. Safe for phone use.">
            <input id="tm-imbuy-controller-only" type="checkbox"> Controller only
          </label>
        </div>
        <div id="tm-imbuy-controller-banner" style="display:none;background:#2a1f00;border:1px solid #f0a500;border-radius:4px;padding:5px 10px;font-size:11px;color:#f0a500;text-align:center;margin-top:4px;">
          Controller Only Mode — automation is paused on this device
        </div>

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

        if (action === "edit") {
          const item = settings.items[idx];
          if (!item) return;
          const row = btn.closest("div");
          row.innerHTML = [
            `<span style="color:#555;font-size:10px;min-width:16px;text-align:right;">${idx + 1}.</span>`,
            `<input type="text" data-edit-name="${idx}" value="${escHtml(item.name)}" style="flex:2;${inpS}">`,
            `<input type="text" data-edit-price="${idx}" value="${escHtml(item.maxPrice || "")}" placeholder="Max price" style="flex:1;${inpS}">`,
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
          if (name && settings.items[idx]) {
            settings.items[idx].name = name;
            settings.items[idx].maxPrice = price;
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
        if (!settings.items.some(i => i.name.toLowerCase() === name.toLowerCase())) {
          settings.items.push({ name, maxPrice: price });
          saveSettings(settings);
          renderItemList();
          const toggle = $("tm-imbuy-items-toggle");
          if (toggle && !toggle.open) toggle.open = true;
        }
        const nameEl = $("tm-imbuy-new-name");
        const priceEl = $("tm-imbuy-new-price");
        if (nameEl) nameEl.value = "";
        if (priceEl) priceEl.value = "";
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

    setStatus(
      settings.enabled
        ? "Auto-buy on."
        : `Cash: $${formatNumber(getMoneyOnHand())}. ${settings.items.length} item(s). Add items then enable.`,
    );
  }

  function injectUI() {
    if (!isItemMarketPage()) return;
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
  console.log(LOG, "starting. mobile=" + isMobile());

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

  startMonitor();
  flushPersistedCloudSave()
    .then(() => initCloudSync())
    .catch(e => console.warn(LOG, "cloud init error:", e));
  startCloudPoll();

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
    };
    console.log(LOG, "helpers available at window.tmItemMarketBuy");
  } catch (e) {}
})();

