// ==UserScript==
// @name         Torn Item Market Auto Buy
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  Auto-buy an item on the Torn item market, sizing quantity to your cash on hand, with an on-page settings panel.
// @author       GitHub Copilot
// @match        https://www.torn.com/page.php*
// @match        https://www.torn.com/imarket.php*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  const LOG = "[ItemMarketBuy]";
  const KEY = "tmItemMarketBuySettings";
  const PANEL_ID = "tm-imbuy-panel";
  const FAB_ID = "tm-imbuy-fab";
  const MODAL_ID = "tm-imbuy-modal";

  // Minimum gap between scans while the seller list is mutating rapidly, so a
  // stream of realtime updates can't starve or spam the buy logic.
  const SCAN_MIN_GAP_MS = 500;

  const DEFAULTS = {
    itemName: "",
    maxUnitPrice: "",
    enabled: false,
  };

  // -------------------------------------------------------------------------
  // Settings (localStorage JSON blob merged over defaults)
  // -------------------------------------------------------------------------
  function loadSettings() {
    try {
      return Object.assign(
        {},
        DEFAULTS,
        JSON.parse(localStorage.getItem(KEY) || "{}"),
      );
    } catch (e) {
      return Object.assign({}, DEFAULTS);
    }
  }
  function saveSettings(s) {
    try {
      localStorage.setItem(KEY, JSON.stringify(s));
    } catch (e) {}
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
    const header = document.querySelector('[class^="itemsHeader___"]');
    if (!header) return "";
    const title = header.querySelector('[class^="title___"]');
    return title ? title.textContent.trim() : "";
  }

  function getSearchInput() {
    return document.querySelector('input[class^="searchInput___"]');
  }

  function getSellerRows() {
    const list = document.querySelector('ul[class^="sellerList___"]');
    if (!list) return [];
    return Array.from(list.querySelectorAll('li[class^="rowWrapper___"]'));
  }

  // Parse a data row into { unitPrice, available, row, sellerRow }, or null
  // for the header row / unparseable rows.
  function parseRow(li) {
    const sellerRow = li.querySelector('[class^="sellerRow___"]');
    if (!sellerRow) return null;
    // Header row has a priceHead cell, not a real price cell.
    if (sellerRow.querySelector('[class^="priceHead___"]')) return null;
    const priceEl = sellerRow.querySelector('[class^="price___"]');
    const availEl = sellerRow.querySelector('[class^="available___"]');
    if (!priceEl || !availEl) return null;
    const unitPrice = parseAmount(priceEl.textContent || "0");
    // Desktop shows "54 available"; mobile shows "54". Parse plain digits only —
    // parseAmount would treat the "b" in "available" as a billions suffix.
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
        ? document.querySelector('ul[class^="sellerList___"]')
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
    //  - Mobile: a "Show buy controls" button expands a [class^="buyDialog___"].
    //  - Desktop: buy controls are inline in the row ([class^="buyControlsInRow___"]),
    //    no expand step, and the BUY button starts disabled until a qty is set.
    // Resolve a single `container` that holds the input.input-money + buy button.
    let container = null;
    const showBtn = row.querySelector(
      'button[class^="showBuyControlsButton___"]',
    );
    if (showBtn) {
      let dialog = row.querySelector('[class^="buyDialog___"]');
      const visible = dialog && dialog.offsetParent !== null;
      if (!visible) {
        safeClick(showBtn);
        dialog = await waitForNode(
          () => row.querySelector('[class^="buyDialog___"]'),
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
        row.querySelector('[class^="buyControlsInRow___"]') ||
        row.querySelector('[class^="buyControls___"]') ||
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
      container.querySelector('button[class^="buyButton___"]') ||
      container.querySelector('button[aria-label^="Buy "]') ||
      row.querySelector('button[class^="buyButton___"]');
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
    return true;
  }

  async function scanAndBuy() {
    if (!settings.enabled) return;
    if (!isItemMarketPage()) return;
    if (busy) return;
    busy = true;
    try {
      const selected = await ensureItemSelected(settings.itemName);
      if (!selected) {
        setStatus("Waiting for item: " + (settings.itemName || "(none set)"));
        return;
      }

      const cap = parseAmount(settings.maxUnitPrice);
      if (cap <= 0) {
        setStatus("Set a max unit price to enable buying.");
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
          `No listings <= $${formatNumber(cap)} for ${getSelectedItemTitle()}. Cash $${formatNumber(money)}.`,
        );
        return;
      }

      let boughtUnits = 0;
      let spent = 0;
      for (const entry of entries) {
        money = getMoneyOnHand(); // refresh after each purchase
        const affordable = Math.floor(money / entry.unitPrice);
        const qty = Math.min(entry.available, affordable);
        if (qty < 1) break; // can't afford even one at this (cheapest remaining) price
        const ok = await buyFromRow(entry, qty);
        if (ok) {
          boughtUnits += qty;
          spent += qty * entry.unitPrice;
          setStatus(
            `Bought ${formatNumber(boughtUnits)} @ up to $${formatNumber(cap)} (spent ~$${formatNumber(spent)}). Cash $${formatNumber(getMoneyOnHand())}.`,
          );
          await wait(700); // let React + money update settle
        } else {
          // Stop the sweep on failure to avoid hammering a broken row.
          break;
        }
      }

      if (boughtUnits === 0) {
        setStatus(
          `Scanned ${entries.length} listing(s) <= $${formatNumber(cap)}, none affordable. Cash $${formatNumber(getMoneyOnHand())}.`,
        );
      }
    } catch (e) {
      console.warn(LOG, "scanAndBuy error", e);
    } finally {
      busy = false;
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
    // Observe the (stable) market wrapper so we catch both realtime row
    // updates within the seller list and full list swaps on item change.
    const target =
      document.querySelector('[class^="marketWrapper___"]') || document.body;
    monitorObserver = new MutationObserver(scheduleScan);
    monitorObserver.observe(target, { childList: true, subtree: true });
    console.log(LOG, "monitoring seller list via MutationObserver");
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
  }

  // -------------------------------------------------------------------------
  // UI
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

  function buildPanelElement() {
    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.style.cssText =
      "color:#eee;font-family:Arial,sans-serif;font-size:13px;box-sizing:border-box;width:100%;";
    panel.innerHTML = `
      <div style="display:flex; gap:8px; flex-wrap:wrap; align-items:center; box-sizing:border-box; width:100%;">
        <strong style="flex:1 1 100%;">Torn Item Market Auto Buy</strong>
        <label style="display:flex; align-items:center; gap:6px; flex:1 1 auto; min-width:0;">
          Item:
          <input id="tm-imbuy-item" type="text" placeholder="e.g. Xanax" style="flex:1; min-width:0; padding:4px 6px; border-radius:4px; border:1px solid #555; background:#111; color:#eee; box-sizing:border-box;">
        </label>
        <label style="display:flex; align-items:center; gap:6px;">
          Max unit price:
          <input id="tm-imbuy-maxprice" type="text" placeholder="e.g. 800k" style="width:110px; padding:4px 6px; border-radius:4px; border:1px solid #555; background:#111; color:#eee; box-sizing:border-box;">
        </label>
        <label style="display:flex; align-items:center; gap:6px;">
          <input id="tm-imbuy-enabled" type="checkbox"> Auto-buy
        </label>
        <span id="tm-imbuy-status" style="flex:1 1 100%; color:#8bd; white-space:normal;"></span>
      </div>
    `;
    return panel;
  }

  function wirePanel() {
    const $ = (id) => document.getElementById(id);
    const itemEl = $("tm-imbuy-item");
    const priceEl = $("tm-imbuy-maxprice");
    const enabledEl = $("tm-imbuy-enabled");
    if (!itemEl) return;

    itemEl.value = settings.itemName || "";
    priceEl.value = settings.maxUnitPrice || "";
    enabledEl.checked = !!settings.enabled;

    itemEl.addEventListener("change", () => {
      settings.itemName = itemEl.value.trim();
      lastSearchedItem = null;
      saveSettings(settings);
    });
    priceEl.addEventListener("change", () => {
      settings.maxUnitPrice = priceEl.value.trim();
      saveSettings(settings);
    });
    enabledEl.addEventListener("change", () => {
      settings.enabled = !!enabledEl.checked;
      saveSettings(settings);
      if (settings.enabled) startMonitor();
      else {
        stopMonitor();
        setStatus("Auto-buy off.");
      }
    });

    setStatus(
      settings.enabled
        ? "Auto-buy on."
        : `Cash on hand: $${formatNumber(getMoneyOnHand())}. Set item + price, then enable.`,
    );
  }

  function injectUI() {
    if (!isItemMarketPage()) return;
    if (document.getElementById(PANEL_ID)) {
      // Panel already present (desktop) — nothing to do.
      if (!isMobile()) return;
    }

    const panel = buildPanelElement();

    if (isMobile()) {
      if (document.getElementById(FAB_ID)) return;

      const fab = document.createElement("button");
      fab.id = FAB_ID;
      fab.innerHTML = "&#128722;"; // 🛒
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
      ].join(";");

      const sheet = document.createElement("div");
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
    } else {
      const target =
        document.querySelector('[class^="marketWrapper___"]') ||
        document.querySelector(".content-title") ||
        document.querySelector("main") ||
        document.querySelector('[role="main"]') ||
        document.querySelector(".maincon") ||
        document.body;

      panel.style.cssText +=
        ";background:#1a1a1a;border:1px solid #444;border-radius:8px;padding:12px;margin:10px 0;max-width:100%;";

      if (target === document.body) {
        document.body.insertAdjacentElement("afterbegin", panel);
      } else if (target.matches('[class^="marketWrapper___"]')) {
        target.insertBefore(panel, target.firstChild);
      } else {
        target.parentNode.insertBefore(panel, target.nextSibling);
      }
    }

    wirePanel();
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
    if (isMobile()) {
      if (
        !document.getElementById(FAB_ID) &&
        !document.getElementById(PANEL_ID)
      ) {
        injectUI();
      }
    } else if (!document.getElementById(PANEL_ID)) {
      injectUI();
    }
  });
  uiObserver.observe(document.documentElement, {
    childList: true,
    subtree: true,
  });

  if (isMobile()) {
    setInterval(() => {
      // Remove the FAB/modal if we've navigated away from the item market
      // (the SPA can change sid without a full reload).
      if (!isItemMarketPage()) {
        document.getElementById(FAB_ID)?.remove();
        document.getElementById(MODAL_ID)?.remove();
        return;
      }
      if (!document.getElementById(FAB_ID)) {
        try {
          injectUI();
        } catch (e) {}
      }
    }, 1000);
  }

  startMonitor();

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
      startMonitor,
      stopMonitor,
    };
    console.log(LOG, "helpers available at window.tmItemMarketBuy");
  } catch (e) {}
})();
