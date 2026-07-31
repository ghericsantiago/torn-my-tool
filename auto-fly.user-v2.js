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
// @match        https://www.torn.com/hospitalview.php*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  // =================== CONSTANTS ===================
  const PLAN_KEY = "tmFlightPlanV2";
  const OPTS_KEY = "tmAutoFlyV2Options";
  const SHOPPING_LIST_KEY = "tmShoppingList"; // shared with v1
  const COOLDOWN_KEY = "tmAutoFlyLast";
  const API_KEY = () => GM_getValue('tornApiKey', '');

  // =================== CLOUD SYNC ===================
  const KV_URL = "https://kv-get-started.ghericsantiago.workers.dev/torn-settings";

  const VALID_DESTINATIONS = [
    "Mexico", "Cayman Islands", "Canada", "Hawaii",
    "United Kingdom", "Argentina", "Switzerland", "Japan",
    "China", "UAE", "South Africa",
  ];

  // Per-destination product lists sourced from yata.json
  const YATA_PRODUCTS = {
    "Mexico":         ["Axe","Samurai Sword","Desert Eagle","AK-47","M249 SAW","Outer Tactical Vest","Minigun","Springfield 1911","Trench Coat","9mm Uzi","Leather Bullwhip","Ninja Claws","Bolt Cutters","Taser","Cobra Derringer","Flak Jacket","Claymore Mine","Flare Gun","Heckler & Koch SL8","Jaguar Plushie","Dahlia","ArmaLite M-15A4","Yucca Plant","Bottle of Tequila","Crazy Straw","Kevlar Gloves","Card Skimmer","Mayan Statue","Zip Ties","Obsidian Point"],
    "Cayman Islands": ["Tavor TAR-21","Harpoon","Diamond Bladed Knife","Naval Cutlass","Trout","Banana Orchid","Stingray Plushie","Steel Drum","Nodding Turtle","Snorkel","Flippers","Speedo","Bikini","Wetsuit","Diving Gloves","Bearer Bond"],
    "Canada":         ["Cannabis","Ecstasy","PCP","Vicodin","Xanax","Ithaca 37","Lorcin 380","Wolverine Plushie","Hockey Stick","Crocus","PVC Cards","Ice Pick","Fire Hydrant","Mountie Hat","Safety Boots","Bear Gall","Aluminum Plate","Dog Treats","Insulin","Quartz Point"],
    "Hawaii":         ["Type 98 Anti Tank","Bushmaster Carbon 15","HEG","Taurus","Orchid","Pele Charm","Small Suitcase","Medium Suitcase","Large Suitcase","Coconut Bra","Basalt Point","Shark Fin","Turtle Shell"],
    "United Kingdom": ["Cannabis","Ecstasy","Ketamine","Xanax","Claymore Sword","Crossbow","PCP","Shrooms","Vicodin","Enfield SA-80","Grenade","Stick Grenade","Nessie Plushie","Heather","Red Fox Plushie","Flail","Sextant","Model Space Ship","Ship in a Bottle","Paper Weight","Tailor's Dummy","Dart Board","Cricket Bat","Frying Pan","WWII Helmet","Inkwell","Chert Point"],
    "Argentina":      ["Chalcedony Point","Meteorite Fragment","Liquid Body Armor","Macana","Compass","Lighter","Patagonian Fossil","Cannabis","Ketamine","LSD","Shrooms","Speed","Flamethrower","Tear Gas","Throwing Knife","Monkey Plushie","Soccer Ball","Ceibo Flower"],
    "Switzerland":    ["Cannabis","Ketamine","LSD","PCP","Shrooms","Speed","Flash Grenade","Jackhammer","Swiss Army Knife","Edelweiss","Chamois Plushie","Neumune Tablet","SIG 552","Dozen White Roses","Snowboard","Ephedrine Powder","Ergotamine Ampoule","Safrole Oil"],
    "Japan":          ["Ecstasy","Ketamine","Opium","Shrooms","Speed","Vicodin","Xanax","BT MP9","Chain Whip","Wooden Nunchaku","Kama","Kodachi","Sai","Ninja Star","Cherry Blossom","Kabuki Mask","Maneki Neko","Bottle of Sake","Flexible Body Armor","Metal Nunchaku","Sumo Doll","Chopsticks","Sensu","Yakitori Lantern","Glow Stick","Bonded Latex","Hydrochloric Acid","Counterfeit Manga","Whale Meat"],
    "China":          ["Ecstasy","LSD","Opium","PCP","Speed","Blowgun","Bo Staff","Fireworks","Katana","Qsz-92","SKS Carbine","Twin Tiger Hooks","Wushu Double Axes","Panda Plushie","Jade Buddha","Peony","Printing Paper","Stick of Dynamite","Guandao","Magnesium Shavings","Pangolin Scales","Tiger Bone Powder"],
    "UAE":            ["Gold Laptop","Gold Plated AK-47","Camel Plushie","Tribulus Omanense","Sports Sneakers","Handbag","Pink Mac-10","Sports Shades","Proda Sunglasses","Potassium Nitrate","Ambergris Lump","Natural Pearls"],
    "South Africa":   ["Knuckle Dusters","LSD","Opium","PCP","Shrooms","Xanax","Mag 7","Smoke Grenade","Spear","Vektor CR-21","Elephant Statue","Lion Plushie","African Violet","Combat Vest","Raw Ivory","Afro Comb","Combat Helmet","Combat Pants","Combat Boots","Combat Gloves","Quartzite Point","Uncut Diamonds"],
  };

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
    const DEFAULTS = { skipWarnings: false, flyBackEnabled: true, autoEnabled: false, repeatPlan: false, preflyDelay: 5, gymEnabled: false, gymStat: "strength", holdIfNerveFull: false, autoRehabEnabled: false, minAddictionLevel: 1, goItemMarket: false };
    try {
      const raw = JSON.parse(localStorage.getItem(OPTS_KEY) || "{}");
      const result = Object.assign({}, DEFAULTS);
      for (const k of Object.keys(DEFAULTS)) {
        if (k in raw) result[k] = raw[k];
      }
      return result;
    } catch (e) {
      return Object.assign({}, DEFAULTS);
    }
  }
  function saveOptions(o) {
    try { localStorage.setItem(OPTS_KEY, JSON.stringify(o)); } catch (e) {}
    scheduleCloudSave("autofly_opts", o);
  }

  // =================== FLIGHT PLAN ===================
  // Each entry: { id, destination, departureTime ("HH:MM" TCT/UTC), status: "pending"|"flying"|"done", loop: false }
  // loop:true — flight resets to "pending" immediately after completing and always fires regardless of departure time
  function loadFlightPlan() {
    try {
      const plan = JSON.parse(localStorage.getItem(PLAN_KEY) || "[]");
      if (Array.isArray(plan)) return plan.map(f => {
        if (f.destination === "United Arab Emirates") f.destination = "UAE";
        return Object.assign({ loop: false, skip: false }, f);
      });
    } catch (e) {}
    return [];
  }
  function saveFlightPlan(plan) {
    try { localStorage.setItem(PLAN_KEY, JSON.stringify(plan)); } catch (e) {}
    scheduleCloudSave("autofly_plan", plan);
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
    const next = plan.find(f => f.status === "pending" && !f.skip);
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
    scheduleCloudSave("autofly_shopping", list);
  }

  // =================== CLOUD HELPERS ===================
  const CLOUD_POLL_KEY = "tmCloudSyncPoll";
  const CLOUD_SAVE_PERSIST_KEY = "tmCloudSavePersist"; // survives page navigation
  const CONTROLLER_ONLY_KEY = "tmAutoFlyControllerOnly";
  function isControllerOnly() { return localStorage.getItem(CONTROLLER_ONLY_KEY) === "true"; }
  let _cloudSavePending = {};
  let _cloudSaveTimer = null;
  let _cloudSaveInProgress = false;
  let _cloudPollIntervalId = null;
  let _nextPollAt = 0;
  let _syncCountdownTimerId = null;

  // When the page navigates/reloads, any queued cloud save is killed by the
  // 1500ms debounce timer being cleared. Persist the pending data to localStorage
  // so the next page load can flush it before reading the Gist.
  window.addEventListener("beforeunload", () => {
    if (!Object.keys(_cloudSavePending).length) return;
    try {
      const existing = JSON.parse(localStorage.getItem(CLOUD_SAVE_PERSIST_KEY) || "{}");
      Object.assign(existing, _cloudSavePending);
      localStorage.setItem(CLOUD_SAVE_PERSIST_KEY, JSON.stringify(existing));
    } catch(e) {}
  });

  // GM_xmlhttpRequest wrapper — bypasses Torn's CSP that blocks api.github.com
  function gmFetch(url, { method = "GET", headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method, url, headers, data: body,
        timeout: 30000, // prevent stuck-on-saving if GitHub never responds
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
      if (!r.ok) { console.warn("[AutoFly2] Cloud load HTTP error:", r.status); return null; }
      return JSON.parse(r.text || "{}");
    } catch(e) { console.warn("[AutoFly2] Cloud load failed:", e); return null; }
  }

  let _cloudStatusClearTimer = null;
  function setCloudSaveStatus(state) {
    const el = document.getElementById("tm-af2-cloud-status");
    if (!el) return;
    if (_cloudStatusClearTimer) { clearTimeout(_cloudStatusClearTimer); _cloudStatusClearTimer = null; }
    if (state === "pending") {
      el.textContent = "⏳"; el.title = "Save queued…"; el.style.color = "#f0a500";
    } else if (state === "saving") {
      el.textContent = "↑"; el.title = "Saving to cloud…"; el.style.color = "#f0a500";
    } else if (state === "saved") {
      el.textContent = "✓"; el.title = "Saved to cloud"; el.style.color = "#44cc88";
      _cloudStatusClearTimer = setTimeout(() => {
        const e2 = document.getElementById("tm-af2-cloud-status");
        if (e2) { e2.textContent = ""; e2.title = ""; }
        _cloudStatusClearTimer = null;
      }, 3000);
    } else if (state === "error") {
      el.textContent = "✗"; el.title = "Save failed — check console"; el.style.color = "#f66";
    } else {
      el.textContent = ""; el.title = "";
    }
  }

  function updateSyncCountdown() {
    const el = document.getElementById("tm-af2-cloud-next");
    if (!el) return;
    if (_cloudSaveInProgress || Object.keys(_cloudSavePending).length > 0) { el.textContent = ""; return; }
    const secs = Math.max(0, Math.ceil((_nextPollAt - Date.now()) / 1000));
    el.textContent = secs <= 0 ? "↻ …" : `↻ ${secs}s`;
  }

  function scheduleCloudSave(section, data) {
    _cloudSavePending[section] = JSON.parse(JSON.stringify(data));
    if (_cloudSaveTimer) clearTimeout(_cloudSaveTimer);
    setCloudSaveStatus("pending");
    _cloudSaveTimer = setTimeout(async () => {
      const pending = Object.assign({}, _cloudSavePending);
      _cloudSavePending = {};
      _cloudSaveTimer = null;
      _cloudSaveInProgress = true;
      setCloudSaveStatus("saving");
      try {
        let all = {};
        try { all = JSON.parse(_lastCloudContent || "{}"); } catch(e) {}
        Object.assign(all, pending);
        const patchRes = await gmFetch(KV_URL, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(all, null, 2)
        });
        if (!patchRes.ok) {
          Object.assign(_cloudSavePending, pending);
          _cloudSaveInProgress = false;
          setCloudSaveStatus("error");
          console.error(`[AutoFly2] Cloud save failed — HTTP ${patchRes.status}. Sections: ${Object.keys(pending).join(", ")} (data preserved for retry)`);
          return;
        }
        _lastCloudContent = JSON.stringify(all);
        _cloudSaveInProgress = false;
        setCloudSaveStatus("saved");
        console.log("[AutoFly2] Cloud settings saved. Sections:", Object.keys(pending).join(", "));
      } catch(e) {
        Object.assign(_cloudSavePending, pending);
        _cloudSaveInProgress = false;
        setCloudSaveStatus("error");
        console.error("[AutoFly2] Cloud save exception — sections:", Object.keys(pending).join(", "), e);
      }
    }, 1500);
  }

  let _lastCloudContent = null;

  function applyCloudSettings(cloud) {
    if (!cloud || !Object.keys(cloud).length) return;
    if (cloud.autofly_opts && typeof cloud.autofly_opts === "object") {
      try { localStorage.setItem(OPTS_KEY, JSON.stringify(cloud.autofly_opts)); } catch(e) {}
      options = loadOptions();
      const setChk = (id, v) => { const el = document.getElementById(id); if (el) el.checked = !!v; };
      const setVal = (id, v) => { const el = document.getElementById(id); if (el) el.value = String(v); };
      setChk("tm-af2-auto-enabled", options.autoEnabled);
      setChk("tm-af2-fly-back", options.flyBackEnabled);
      setChk("tm-af2-skip-warnings", options.skipWarnings);
      setChk("tm-af2-repeat-plan", options.repeatPlan);
      setVal("tm-af2-prefly-delay", options.preflyDelay ?? 5);
      setChk("tm-af2-gym-enabled", options.gymEnabled);
      setVal("tm-af2-gym-stat", options.gymStat || "strength");
      setChk("tm-af2-hold-nerve", options.holdIfNerveFull);
      setChk("tm-af2-rehab-enabled", options.autoRehabEnabled);
      setVal("tm-af2-min-addiction", options.minAddictionLevel ?? 1);
      setChk("tm-af2-go-item-market", options.goItemMarket);
      if (options.goItemMarket && !isControllerOnly() && !isAbroadOrTraveling()) {
        options.goItemMarket = false;
        saveOptions(options);
        window.location.href = "https://www.torn.com/page.php?sid=ItemMarket";
      }
      if (options.autoEnabled) startAutoCheck(); else stopAutoCheck();
    }
    if (cloud.autofly_plan && Array.isArray(cloud.autofly_plan)) {
      // Merge with local plan: never downgrade a flight's status from cloud data.
      // "flying" and "done" set locally are the authoritative state — the Gist
      // often has a stale "pending" because the cloud-save timer is cancelled by
      // page reloads that happen right after departure.
      const statusRank = { pending: 0, flying: 1, done: 2 };
      const local = loadFlightPlan();
      const localById = new Map(local.map(f => [f.id, f]));
      const merged = cloud.autofly_plan.map(cf => {
        const lf = localById.get(cf.id);
        if (!lf) return cf;
        const localRank = statusRank[lf.status] ?? 0;
        const cloudRank = statusRank[cf.status] ?? 0;
        return localRank > cloudRank ? Object.assign({}, cf, { status: lf.status }) : cf;
      });
      try { localStorage.setItem(PLAN_KEY, JSON.stringify(merged)); } catch(e) {}
      renderFlightPlan();
    }
    if (cloud.autofly_shopping && Array.isArray(cloud.autofly_shopping)) {
      try { localStorage.setItem(SHOPPING_LIST_KEY, JSON.stringify(cloud.autofly_shopping)); } catch(e) {}
      renderShoppingList();
    }
  }

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
        console.log("[AutoFly2] Flushed persisted cloud save. Sections:", Object.keys(pending).join(", "));
      }
    } catch(e) {
      console.warn("[AutoFly2] Failed to flush persisted cloud save:", e);
    }
  }

  async function initCloudSync() {
    const cloud = await cloudLoad();
    if (cloud === null) { console.warn("[AutoFly2] initCloudSync skipped — load failed"); return; }
    _lastCloudContent = JSON.stringify(cloud);
    applyCloudSettings(cloud);

    // Backfill any sections missing from the Gist using local data.
    // This recovers from partial wipes without overwriting valid cloud data.
    if (!cloud.autofly_opts) {
      scheduleCloudSave("autofly_opts", loadOptions());
      console.log("[AutoFly2] Backfilling missing autofly_opts to Gist");
    }
    if (!cloud.autofly_plan) {
      const localPlan = loadFlightPlan();
      if (localPlan.length > 0) {
        scheduleCloudSave("autofly_plan", localPlan);
        console.log("[AutoFly2] Backfilling missing autofly_plan to Gist");
      }
    }
    if (!cloud.autofly_shopping) {
      scheduleCloudSave("autofly_shopping", loadShoppingList());
      console.log("[AutoFly2] Backfilling missing autofly_shopping to Gist");
    }

    _mergeCloudLog(cloud.autofly_log);
    console.log("[AutoFly2] Cloud settings synced");
  }

  async function pollCloudSync() {
    _nextPollAt = Date.now() + 15000;
    // Skip entirely — don't even hit the network — while a save is queued or in-flight
    if (_cloudSaveInProgress || Object.keys(_cloudSavePending).length > 0) return;
    const cloud = await cloudLoad();
    if (cloud === null) return;
    const content = JSON.stringify(cloud);
    if (content === _lastCloudContent) return;
    _lastCloudContent = content;
    applyCloudSettings(cloud);
    _mergeCloudLog(cloud.autofly_log);
    console.log("[AutoFly2] Cloud settings updated from remote");
  }

  function isCloudPollEnabled() {
    const v = localStorage.getItem(CLOUD_POLL_KEY);
    return v === null ? true : v === "true";
  }
  function startCloudPoll() {
    if (!isCloudPollEnabled()) { console.log("[AutoFly2] Cloud polling disabled"); return; }
    if (_cloudPollIntervalId) return;
    _nextPollAt = Date.now() + 15000;
    _cloudPollIntervalId = setInterval(pollCloudSync, 15000);
    if (_syncCountdownTimerId) clearInterval(_syncCountdownTimerId);
    _syncCountdownTimerId = setInterval(updateSyncCountdown, 1000);
  }
  function stopCloudPoll() {
    if (_cloudPollIntervalId) { clearInterval(_cloudPollIntervalId); _cloudPollIntervalId = null; }
    if (_syncCountdownTimerId) { clearInterval(_syncCountdownTimerId); _syncCountdownTimerId = null; }
    const el = document.getElementById("tm-af2-cloud-next");
    if (el) el.textContent = "";
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
  let nerveWatchIntervalId = null;

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
  function isHospitalPage() {
    return location.pathname.includes("hospitalview.php") ||
      (location.pathname.includes("page.php") && location.search.includes("sid=hospital")) ||
      !!document.querySelector("#hospitalroot");
  }

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
        "padding:8px 12px 8px 12px","background:#1a1a1a","border:2px solid #f0a500",
        "border-radius:10px","color:#f0a500","font-weight:bold",
        "font-family:Arial,sans-serif","font-size:13px","line-height:1.3",
        "z-index:2147483641","box-shadow:0 3px 10px rgba(0,0,0,0.6)",
        "display:none","text-align:center","pointer-events:auto","position:fixed",
      ].join(";");

      const textSpan = document.createElement("span");
      textSpan.id = "tm-af2-badge-text";
      b.appendChild(textSpan);

      const closeBtn = document.createElement("button");
      closeBtn.textContent = "×";
      closeBtn.title = "Hide";
      closeBtn.style.cssText = [
        "position:absolute","top:2px","right:5px",
        "background:none","border:none","color:#888",
        "cursor:pointer","font-size:15px","line-height:1","padding:0",
        "font-weight:bold",
      ].join(";");
      closeBtn.addEventListener("click", () => {
        b.dataset.userHidden = "1";
        b.style.display = "none";
      });
      b.appendChild(closeBtn);

      b.style.position = "fixed";
      document.body.appendChild(b);
    }
    return b;
  }

  // =================== API ===================
  async function apiRequest(section, selections) {
    const res = await fetch(`https://api.torn.com/${section}/?selections=${selections}&key=${API_KEY()}`);
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
    getCountdownBadge().dataset.userHidden = "";
    const render = () => {
      const remaining = Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
      const badge = getCountdownBadge();
      badge.style.borderColor = "#f0a500";
      badge.style.color = "#f0a500";
      const text = remaining <= 0
        ? "Out of hospital — resuming…"
        : `In hospital — ${Math.floor(remaining / 3600) > 0 ? Math.floor(remaining / 3600) + "h " : ""}${Math.floor((remaining % 3600) / 60)}m ${remaining % 60}s`;
      setPanelStatus(text);
      const textEl = document.getElementById("tm-af2-badge-text");
      if (textEl) textEl.textContent = text;
      if (!badge.dataset.userHidden) badge.style.display = "";
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
    getCountdownBadge().dataset.userHidden = "";
    const render = () => {
      const remaining = Math.max(0, Math.ceil((endAt - Date.now()) / 1000));
      const badge = getCountdownBadge();
      badge.style.borderColor = "#4db8ff";
      badge.style.color = "#4db8ff";
      const text = remaining <= 0
        ? `Arrived at ${dest} — reloading…`
        : `Flying to ${dest} — ${Math.floor(remaining / 3600) > 0 ? Math.floor(remaining / 3600) + "h " : ""}${Math.floor((remaining % 3600) / 60)}m ${remaining % 60}s`;
      setPanelStatus(text, "#4db8ff");
      const textEl = document.getElementById("tm-af2-badge-text");
      if (textEl) textEl.textContent = text;
      if (!badge.dataset.userHidden) badge.style.display = "";
      if (remaining <= 0) { clearInterval(travelCountdownTimer); travelCountdownTimer = null; return; }
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

  // =================== OVERSEAS ERROR WATCH ===================
  function watchForOverseasError() {
    const MSG = "You must be overseas to do this action.";
    const hiddenEls = new Set();

    function isVisible(el) {
      let curr = el;
      while (curr && curr !== document.documentElement) {
        const s = window.getComputedStyle(curr);
        if (s.display === "none" || s.visibility === "hidden" || parseFloat(s.opacity) === 0) return false;
        curr = curr.parentElement;
      }
      return true;
    }

    function findMsgEl(root) {
      if (!root || root.nodeType !== Node.ELEMENT_NODE) return null;
      if (!(root.textContent || "").includes(MSG)) return null;
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if ((node.nodeValue || "").includes(MSG)) return node.parentElement;
      }
      return null;
    }

    function checkAndAct(root) {
      const el = findMsgEl(root);
      if (!el) return false;
      if (isVisible(el)) {
        console.log("[AutoFly2] Overseas error visible — reloading");
        location.reload();
        return true;
      }
      hiddenEls.add(el);
      return false;
    }

    if (document.body) checkAndAct(document.body);

    const obs = new MutationObserver(mutations => {
      for (const m of mutations) {
        if (m.type === "childList") {
          for (const node of m.addedNodes) {
            if (node.nodeType === Node.ELEMENT_NODE && checkAndAct(node)) return;
          }
        }
        if (hiddenEls.size > 0) {
          for (const el of hiddenEls) {
            if (!document.body.contains(el)) { hiddenEls.delete(el); continue; }
            if (isVisible(el)) { hiddenEls.delete(el); console.log("[AutoFly2] Overseas error became visible — reloading"); location.reload(); return; }
          }
        }
      }
    });
    obs.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["style", "class"] });
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

  // =================== ABROAD LOG ===================
  const ABROAD_LOG_KEY = "tmAbroadLog";
  // Survives page reloads (sessionStorage) but clears when the tab is closed.
  let _abroadLog = (() => {
    try { return JSON.parse(sessionStorage.getItem(ABROAD_LOG_KEY) || "[]"); } catch(e) { return []; }
  })();

  function abroadLog(msg, type = "info") {
    const now = new Date();
    const ts = now.getTime();
    const t = `${String(now.getUTCHours()).padStart(2,"0")}:${String(now.getUTCMinutes()).padStart(2,"0")}:${String(now.getUTCSeconds()).padStart(2,"0")}`;
    _abroadLog.push({ ts, t, msg, type });
    if (_abroadLog.length > 300) _abroadLog.shift();
    try { sessionStorage.setItem(ABROAD_LOG_KEY, JSON.stringify(_abroadLog)); } catch(e) {}
    const list = document.getElementById("tm-af2-log-list");
    if (list) _renderAbroadLogList(list);
  }

  function _mergeCloudLog(cloudLog) {
    if (!Array.isArray(cloudLog) || !cloudLog.length) return;
    const seen = new Set(_abroadLog.map(e => e.ts || (e.t + "|" + e.msg)));
    let added = 0;
    for (const entry of cloudLog) {
      const key = entry.ts || (entry.t + "|" + entry.msg);
      if (!seen.has(key)) { _abroadLog.push(entry); seen.add(key); added++; }
    }
    if (added > 0) {
      _abroadLog.sort((a, b) => (a.ts || 0) - (b.ts || 0));
      if (_abroadLog.length > 300) _abroadLog.splice(0, _abroadLog.length - 300);
      try { sessionStorage.setItem(ABROAD_LOG_KEY, JSON.stringify(_abroadLog)); } catch(e) {}
      const list = document.getElementById("tm-af2-log-list");
      if (list) _renderAbroadLogList(list);
    }
  }

  function _renderAbroadLogList(container) {
    const colorMap = { info: "#ccc", success: "#44cc88", warn: "#f0a500", error: "#f66" };
    if (!_abroadLog.length) {
      container.innerHTML = '<div style="color:#555;font-size:12px;padding:8px 0;">No activity yet. Auto-fly will log abroad shopping here.</div>';
      return;
    }
    container.innerHTML = _abroadLog.slice().reverse().map(e =>
      `<div style="padding:3px 0;border-bottom:1px solid #1e1e1e;font-size:11px;display:flex;gap:8px;align-items:baseline;">` +
      `<span style="color:#444;white-space:nowrap;flex-shrink:0;font-variant-numeric:tabular-nums;">${escHtml(e.t)}</span>` +
      `<span style="color:${colorMap[e.type] || "#ccc"};">${escHtml(e.msg)}</span>` +
      `</div>`
    ).join("");
  }

  function openAbroadLogModal() {
    let modal = document.getElementById("tm-af2-log-modal");
    if (!modal) {
      modal = document.createElement("div");
      modal.id = "tm-af2-log-modal";
      modal.style.cssText = "position:fixed;inset:0;background:rgba(0,0,0,0.75);z-index:2147483647;display:flex;align-items:center;justify-content:center;";
      const box = document.createElement("div");
      box.style.cssText = [
        "background:#1a1a1a","border:1px solid #444","border-radius:10px",
        "padding:16px","width:500px","max-width:92vw",
        "max-height:80vh","display:flex","flex-direction:column","gap:8px",
        "box-shadow:0 8px 32px rgba(0,0,0,0.8)",
      ].join(";");
      box.innerHTML =
        `<div style="display:flex;justify-content:space-between;align-items:center;flex-shrink:0;">` +
          `<strong style="color:#eee;font-size:13px;">&#128203; Shopping Logs <span style="color:#555;font-weight:normal;font-size:11px;">(newest first · TCT)</span></strong>` +
          `<div style="display:flex;gap:6px;">` +
            `<button id="tm-af2-log-clear" style="padding:2px 8px;background:#220000;border:1px solid #622;color:#f66;border-radius:3px;cursor:pointer;font-size:11px;">Clear</button>` +
            `<button id="tm-af2-log-close" style="padding:2px 8px;background:#222;border:1px solid #444;color:#aaa;border-radius:3px;cursor:pointer;font-size:11px;">✕</button>` +
          `</div>` +
        `</div>` +
        `<div id="tm-af2-log-list" style="overflow-y:auto;flex:1;padding-right:4px;"></div>`;
      modal.appendChild(box);
      document.body.appendChild(modal);
      modal.addEventListener("click", e => { if (e.target === modal) closeAbroadLogModal(); });
      document.getElementById("tm-af2-log-close").addEventListener("click", closeAbroadLogModal);
      document.getElementById("tm-af2-log-clear").addEventListener("click", () => {
        _abroadLog.length = 0;
        try { sessionStorage.removeItem(ABROAD_LOG_KEY); } catch(e) {}
        scheduleCloudSave("autofly_log", []);
        _renderAbroadLogList(document.getElementById("tm-af2-log-list"));
      });
    }
    modal.style.display = "flex";
    _renderAbroadLogList(document.getElementById("tm-af2-log-list"));
  }

  function closeAbroadLogModal() {
    const modal = document.getElementById("tm-af2-log-modal");
    if (modal) modal.style.display = "none";
  }

  // =================== ABROAD SHOPPING ===================
  function waitForStockTable(timeout = 15000) {
    return new Promise(resolve => {
      const existing = document.querySelector('[class*="stockTableWrapper"]');
      if (existing) return resolve(existing);
      console.log("[AutoFly2] Waiting for stockTableWrapper…");
      const observer = new MutationObserver(() => {
        const el = document.querySelector('[class*="stockTableWrapper"]');
        if (el) { observer.disconnect(); resolve(el); }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { observer.disconnect(); resolve(null); }, timeout);
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
    // Hard budget: total abroad time (shopping + fly-home clicks) must be ≤ 15s
    const abroadDeadline = Date.now() + 15_000;
    const msLeft = (reserve = 2000) => Math.max(0, abroadDeadline - reserve - Date.now());
    const overBudget = (reserve = 2000) => Date.now() + reserve >= abroadDeadline;

    try {
      const _dest = (() => {
        const fromFlight = getActiveFlight()?.destination;
        if (fromFlight && YATA_PRODUCTS[fromFlight]) return fromFlight;
        // Flight not found or destination unknown — scan DOM for a known country name
        const pageText = document.body?.innerText || "";
        for (const dest of Object.keys(YATA_PRODUCTS)) {
          if (pageText.includes(dest)) return dest;
        }
        return fromFlight || "abroad";
      })();
      console.log("[AutoFly2] Processing abroad shopping");
      abroadLog(`Arrived at ${_dest} — processing shopping`, "info");
      const stockTableWrapper = await waitForStockTable(Math.min(8000, msLeft(3000)));
      if (!stockTableWrapper) { console.warn("[AutoFly2] No stock table — flying home anyway"); abroadLog("No stock table found — flying home", "warn"); }

      if (stockTableWrapper && !overBudget()) {
        let purchaseInfo = getPurchaseInfo();
        let remainingSlots = purchaseInfo ? purchaseInfo.limit - purchaseInfo.purchased : Infinity;

        if (remainingSlots > 0) {
          const rows = Array.from(stockTableWrapper.querySelectorAll('li > [class^="row___"]'));
          const nameToRow = new Map();
          for (const r of rows) {
            const nc = r.querySelector('[data-tt-content-type="name"]');
            const bc = r.querySelector('[data-tt-content-type="buy"]');
            if (nc && bc) nameToRow.set(nc.textContent.trim().toLowerCase(), r);
          }

          const rawShoppingList = loadShoppingList();
          const currentFlight = getActiveFlight();
          const effectiveShoppingList = (() => {
            if (!currentFlight || !currentFlight.priorityProduct) return rawShoppingList;
            const p = currentFlight.priorityProduct;
            const idx = rawShoppingList.findIndex(x => x.toLowerCase() === p.toLowerCase());
            if (idx === 0) return rawShoppingList;
            const rest = rawShoppingList.filter((_, i) => i !== idx);
            return [idx === -1 ? p : rawShoppingList[idx], ...rest];
          })();
          const _destProducts = YATA_PRODUCTS[_dest];
          const filteredShoppingList = _destProducts
            ? effectiveShoppingList.filter(item => _destProducts.some(p => p.toLowerCase() === item.toLowerCase()))
            : effectiveShoppingList;
          for (const listItem of filteredShoppingList) {
            if (remainingSlots <= 0 || overBudget()) break;
            const lowerItem = listItem.toLowerCase();
            let matchKey = null;
            for (const shopName of nameToRow.keys()) {
              if (shopName.includes(lowerItem) || lowerItem.includes(shopName)) { matchKey = shopName; break; }
            }
            if (!matchKey) { abroadLog(`${listItem}: not in stock here`, "warn"); continue; }

            const row = nameToRow.get(matchKey);
            nameToRow.delete(matchKey);
            const nameCell = row.querySelector('[data-tt-content-type="name"]');
            const buyCell = row.querySelector('[data-tt-content-type="buy"]');
            const amountCell = row.querySelector('[data-tt-content-type="amount"]');
            const itemName = nameCell.textContent.trim();
            console.log(`[AutoFly2] Buying ${itemName}`);
            abroadLog(`Buying ${itemName}…`, "info");

            const maxBtn = (amountCell || row).querySelector(
              '[class*="wai-btn"], .input-money-symbol input.wai-btn, .input-money-symbol button, input.wai-btn'
            );
            if (maxBtn) { safeClick(maxBtn); await delay(300); }

            const buyBtn = buyCell.querySelector("button");
            if (!buyBtn) continue;
            const panelId = buyBtn.getAttribute("aria-controls");
            safeClick(buyBtn);
            await delay(200);

            let yesBtn = null;
            let clickedBuyBtn = false;
            // Per-item confirm deadline: up to 3s, but never past the overall budget
            const confirmDeadline = Math.min(Date.now() + 3000, abroadDeadline - 2000);
            while (Date.now() < confirmDeadline) {
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
                if (interimBuy) { safeClick(interimBuy); clickedBuyBtn = true; await delay(200); continue; }
              }
              await delay(100);
            }

            if (yesBtn || clickedBuyBtn) {
              if (yesBtn) { try { yesBtn.click(); } catch (e) {} }
              // Poll up to 2s for slot counter to update
              let newInfo = null;
              const verifyDeadline = Math.min(Date.now() + 2000, abroadDeadline - 1000);
              while (Date.now() < verifyDeadline) {
                await delay(200);
                newInfo = getPurchaseInfo();
                if (!purchaseInfo || !newInfo || newInfo.purchased > purchaseInfo.purchased) break;
              }
              if (purchaseInfo && newInfo) {
                if (newInfo.purchased > purchaseInfo.purchased) {
                  purchaseInfo = newInfo;
                  remainingSlots = newInfo.limit - newInfo.purchased;
                  console.log(`[AutoFly2] Confirmed purchase: ${itemName} (${newInfo.purchased}/${newInfo.limit})`);
                  abroadLog(`✓ Bought ${itemName} (${newInfo.purchased}/${newInfo.limit})`, "success");
                } else {
                  abroadLog(`✗ ${itemName}: slot counter unchanged after buy`, "error");
                }
              } else {
                // Counter not visible — trust the click; sync if counter just became available
                if (newInfo) {
                  purchaseInfo = newInfo;
                  remainingSlots = newInfo.limit - newInfo.purchased;
                } else {
                  remainingSlots = isFinite(remainingSlots) ? remainingSlots - 1 : remainingSlots;
                }
                console.log(`[AutoFly2] Confirmed purchase: ${itemName}`);
                abroadLog(`✓ Bought ${itemName}`, "success");
              }
            } else {
              abroadLog(`✗ ${itemName}: no confirm panel appeared`, "error");
            }
          }
        }
      }

      // Fly home
      console.log("[AutoFly2] Shopping done. Flying home...");
      abroadLog("Shopping done — flying home", "info");
      scheduleCloudSave("autofly_log", _abroadLog.slice());
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

  async function getNerveStatus() {
    const data = await apiRequest("user", "bars");
    const n = data.nerve || {};
    return { current: Number(n.current || 0), maximum: Number(n.maximum || 0), isFull: Number(n.current) >= Number(n.maximum) && Number(n.maximum) > 0 };
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

  // =================== REHAB ===================
  function isRehabPage() {
    return document.body.dataset.page === "rehab" || !!document.querySelector(".travel-rehab .rehab");
  }

  function getAddictionLevelFromDOM() {
    if (!document.querySelector(".cont-gray.rehab.addicted")) return 0;
    const slider = document.querySelector(".range-slider-data[data-percentages]");
    if (!slider) return 1;
    const val = parseInt(slider.getAttribute("value") || "0", 10);
    try {
      const percs = JSON.parse(slider.getAttribute("data-percentages") || "{}");
      const sorted = Object.entries(percs).map(([l, p]) => [parseInt(l, 10), Number(p)]).sort((a, b) => a[1] - b[1]);
      for (const [level, pct] of sorted) {
        if (val <= pct) return level;
      }
    } catch (e) {}
    return 1;
  }

  async function getAddictionLevelFromAPI() {
    try {
      const data = await apiRequest("user", "profile");
      if (data.drugs && typeof data.drugs.addiction_level === "number") return data.drugs.addiction_level;
      if (typeof data.addiction_level === "number") return data.addiction_level;
    } catch (e) { console.warn("[AutoFly2] Addiction API failed", e); }
    return -1;
  }

  async function processRehab() {
    options = loadOptions();

    await new Promise(resolve => {
      if (document.querySelector(".rehab-btn-area")) return resolve();
      const obs = new MutationObserver(() => {
        if (document.querySelector(".rehab-btn-area")) { obs.disconnect(); resolve(); }
      });
      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { obs.disconnect(); resolve(); }, 8000);
    });
    await wait(500);

    const addictionLevel = getAddictionLevelFromDOM();
    if (addictionLevel === 0) {
      console.log("[AutoFly2] Not addicted — skipping rehab");
      return false;
    }
    if (addictionLevel <= options.minAddictionLevel) {
      console.log(`[AutoFly2] Addiction ${addictionLevel} <= threshold ${options.minAddictionLevel} — skipping rehab`);
      return false;
    }

    const rehabBtn = document.querySelector(".rehab-btn-area.addicted button.torn-btn");
    if (!rehabBtn) { console.warn("[AutoFly2] Rehab button not found"); return false; }

    setPanelStatus(`Auto-Rehab: level ${addictionLevel} — rehabilitating…`, "#f0a500");
    console.log(`[AutoFly2] Rehab: clicking REHABILITATE (level ${addictionLevel})`);
    safeClick(rehabBtn);

    await new Promise(resolve => {
      const isDone = () => {
        const s = document.querySelector(".success-rehab");
        if (s && s.innerHTML.trim()) return true;
        if (!document.querySelector(".rehab-btn-area.addicted")) return true;
        return false;
      };
      if (isDone()) return resolve();
      const obs = new MutationObserver(() => { if (isDone()) { obs.disconnect(); resolve(); } });
      obs.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { obs.disconnect(); resolve(); }, 10000);
    });

    await wait(1000);
    const newLevel = getAddictionLevelFromDOM();
    if (newLevel > options.minAddictionLevel) {
      console.log(`[AutoFly2] Still at level ${newLevel} — rehabbing again`);
      return processRehab();
    }

    setPanelStatus("Auto-Rehab: done — shopping…", "#44cc88");
    console.log("[AutoFly2] Rehab complete");
    return true;
  }

  async function checkAndGoToRehab() {
    options = loadOptions();
    if (!options.autoRehabEnabled) return false;
    if (getActiveFlight()) return false;

    const addictionLevel = await getAddictionLevelFromAPI();
    if (addictionLevel < 0 || addictionLevel <= options.minAddictionLevel) return false;

    const plan = loadFlightPlan();
    if (plan.some(f => f.destination === "Switzerland" && f.status !== "done")) return false;

    console.log(`[AutoFly2] Addiction ${addictionLevel} > threshold ${options.minAddictionLevel} — going to Switzerland for rehab`);
    setPanelStatus(`Addiction level ${addictionLevel} — going to Switzerland for rehab…`, "#f0a500");

    if (!isTravelPage()) {
      await wait(500);
      location.href = "/page.php?sid=travel";
      return true;
    }

    await clickTravelDestination("Switzerland");
    await wait(1500);

    const preflyDelay = Math.max(0, options.preflyDelay ?? 5);
    for (let i = preflyDelay; i > 0; i--) {
      setPanelStatus(`Rehab flight to Switzerland in ${i}s…`, "#f0a500");
      await wait(1000);
    }

    if (options.skipWarnings && clickFlyContinueControl()) {
      sessionStorage.setItem(COOLDOWN_KEY, String(Date.now()));
      await wait(500); location.reload(); return true;
    }
    if (clickFlyControl()) {
      sessionStorage.setItem(COOLDOWN_KEY, String(Date.now()));
      console.log("[AutoFly2] Rehab flight: Travel clicked for Switzerland");
      if (options.skipWarnings) { await waitForContinueAndClick(5000); await wait(500); }
      location.reload(); return true;
    }
    return false;
  }

  // =================== AUTO-FLY CHECK ===================
  // Runs every 60s when autoEnabled. Compares current TCT to flight plan.
  let _autoFlyCheckRunning = false;
  async function autoFlyCheck() {
    if (isControllerOnly()) return;
    if (_autoFlyCheckRunning) return;
    _autoFlyCheckRunning = true;
    try {
    options = loadOptions();
    await wait(500);

    // In-flight — Torn sets both traveling=true AND abroad=true simultaneously, so
    // this must come first to prevent processAbroadShopping from firing mid-flight.
    if (isTraveling()) {
      console.log("[AutoFly2] In transit — waiting for arrival");
      return;
    }

    // Abroad (and not still traveling): rehab + shop and fly home
    if (isAbroad()) {
      if (options.flyBackEnabled) {
        const waiting = await scheduleReviveReloadIfHospitalized();
        if (!waiting) {
          if (options.autoRehabEnabled && isRehabPage()) await processRehab();
          await processAbroadShopping();
        }
      } else {
        console.log("[AutoFly2] Abroad, fly-back disabled");
      }
      return;
    }

    // Everything below requires autoEnabled
    if (!options.autoEnabled) return;

    // On gym page — run training
    if (isGymPage()) {
      await processGymTraining();
      return;
    }

    // On hospital page but no longer hospitalized — head to travel
    if (isHospitalPage() && !isHospital()) {
      localStorage.removeItem("tmWasHospitalized");
      console.log("[AutoFly2] Released from hospital — navigating to travel page");
      setPanelStatus("Released from hospital — going to travel…", "#44cc88");
      await wait(1000);
      location.href = "/page.php?sid=travel";
      return;
    }

    // Was hospitalized on a previous check and now released (any page) — head to travel
    if (!isHospital() && localStorage.getItem("tmWasHospitalized") === "1" && !isTravelPage()) {
      localStorage.removeItem("tmWasHospitalized");
      console.log("[AutoFly2] Hospital cleared — navigating to travel page");
      setPanelStatus("Released from hospital — going to travel…", "#44cc88");
      await wait(1000);
      location.href = "/page.php?sid=travel";
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
      localStorage.setItem("tmWasHospitalized", "1");
      setPanelStatus("In hospital — paused");
      return;
    }

    // Gym takes priority over flights — go train if energy is full
    const wentToGym = await checkAndGoToGym();
    if (wentToGym) return;

    // Rehab check — go to Switzerland if addiction is above threshold
    const wentToRehab = await checkAndGoToRehab();
    if (wentToRehab) return;

    // Hold if nerve is full
    if (options.holdIfNerveFull) {
      let nerve;
      try { nerve = await getNerveStatus(); }
      catch (e) { console.warn("[AutoFly2] Nerve check failed", e); }
      if (nerve && nerve.isFull) {
        setPanelStatus(`Nerve full (${nerve.current}/${nerve.maximum}) — holding flight`, "#ff6b6b");
        console.log(`[AutoFly2] Nerve full (${nerve.current}/${nerve.maximum}) — holding flight`);
        startNerveWatch();
        return;
      }
    }
    stopNerveWatch();

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
  } finally {
    _autoFlyCheckRunning = false;
  }
  }

  function stopNerveWatch() {
    if (nerveWatchIntervalId) { clearInterval(nerveWatchIntervalId); nerveWatchIntervalId = null; }
  }
  function startNerveWatch() {
    if (nerveWatchIntervalId) return;
    nerveWatchIntervalId = setInterval(async () => {
      let nerve;
      try { nerve = await getNerveStatus(); }
      catch (e) { return; }
      if (!nerve.isFull) {
        stopNerveWatch();
        autoFlyCheck();
      }
    }, 30_000);
  }

  function startAutoCheck() {
    stopAutoCheck();
    options = loadOptions();
    autoFlyCheck(); // always run once — abroad handling doesn't need autoEnabled
    if (!options.autoEnabled) return;
    autoCheckIntervalId = setInterval(autoFlyCheck, 60_000);
  }
  function stopAutoCheck() {
    if (autoCheckIntervalId) { clearInterval(autoCheckIntervalId); autoCheckIntervalId = null; }
    stopNerveWatch();
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
      const skipS = flight.skip
        ? "padding:1px 5px;background:#3a1a00;border:1px solid #8a4a00;color:#f90;border-radius:3px;cursor:pointer;font-size:11px;"
        : "padding:1px 5px;background:#222;border:1px solid #444;color:#555;border-radius:3px;cursor:pointer;font-size:11px;";
      const timeLabel = flight.loop
        ? `<span style="color:#4f4;font-size:10px;min-width:40px;font-weight:bold;" title="Loop — ignores schedule time">∞</span>`
        : flight.departureTime
          ? `<span style="color:#aaa;font-size:11px;min-width:40px;font-weight:bold;">${escHtml(flight.departureTime)}</span>`
          : `<span style="color:#44cc88;font-size:10px;min-width:40px;font-weight:bold;" title="No scheduled time — flies when ready">ASAP</span>`;
      const destLabel = flight.priorityProduct
        ? `${escHtml(flight.destination)}<span style="color:#f0a500;font-size:10px;margin-left:3px;" title="Priority: ${escHtml(flight.priorityProduct)}">★ ${escHtml(flight.priorityProduct)}</span>`
        : escHtml(flight.destination);
      const destColor = flight.skip ? "#555" : statusColor;
      const destDecoration = flight.skip ? "line-through" : "none";
      row.innerHTML = [
        `<span style="color:${statusColor};font-size:13px;min-width:18px;text-align:center;">${statusIcon}</span>`,
        timeLabel,
        `<span style="flex:1;font-size:12px;color:${destColor};text-decoration:${destDecoration};overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${destLabel}</span>`,
        `<button data-action="toggle-skip" data-idx="${i}" style="${skipS}" title="${flight.skip ? "Skipped — click to re-enable" : "Skip this flight"}">&#x2298;</button>`,
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
          <div style="display:flex;align-items:center;gap:8px;">
            <button id="tm-af2-log-btn" style="padding:2px 8px;background:#222;border:1px solid #444;color:#aaa;border-radius:3px;cursor:pointer;font-size:11px;" title="View abroad shopping logs">&#128203; Logs</button>
            <span id="tm-af2-tct-clock" style="font-size:11px;color:#f0a500;font-weight:bold;font-variant-numeric:tabular-nums;"></span>
          </div>
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
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;" title="Poll the Gist cloud every second to sync settings across devices. Disable to reduce GitHub API usage.">
            <input id="tm-af2-cloud-poll" type="checkbox"> Cloud sync
          </label>
          <span id="tm-af2-cloud-status" style="font-size:11px;font-weight:bold;min-width:14px;text-align:center;"></span>
          <span id="tm-af2-cloud-next" style="font-size:10px;color:#555;font-variant-numeric:tabular-nums;"></span>
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;margin-left:auto;color:#f0a500;" title="View and control settings from this device without running automation. Safe for phone use.">
            <input id="tm-af2-controller-only" type="checkbox"> Controller only
          </label>
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;color:#44cc88;" title="Remote command: when checked on controller phone, the automation device navigates to the Item Market (only fires when at Torn home, not abroad)">
            <input id="tm-af2-go-item-market" type="checkbox"> Go Item Market
          </label>
        </div>
        <div id="tm-af2-controller-banner" style="display:none;flex:1 1 100%;background:#2a1f00;border:1px solid #f0a500;border-radius:4px;padding:5px 10px;font-size:11px;color:#f0a500;text-align:center;">
          Controller Only Mode — automation is paused on this device
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
            <input id="tm-af2-new-product" type="text" placeholder="Priority product…" list="tm-af2-new-product-list"
              title="Optionally prioritise one product from this destination — it will be bought first."
              style="flex:2;min-width:140px;padding:4px 6px;border-radius:4px;border:1px solid #555;background:#111;color:#eee;font-size:12px;box-sizing:border-box;">
            <datalist id="tm-af2-new-product-list"></datalist>
            <button id="tm-af2-add-flight" style="padding:4px 10px;border-radius:4px;border:1px solid #555;background:#333;color:#eee;cursor:pointer;font-size:12px;white-space:nowrap;">+ Add Flight</button>
          </div>
          <div style="color:#555;font-size:10px;margin-top:4px;">Time is optional (TCT/UTC). ASAP = no time set, flies when ready. ● = ready. ✈ = flying. ✓ = done. &#x21bb; = loop. ★ = priority product.</div>
        </details>

        <!-- Automation -->
        <details id="tm-af2-gym-toggle" style="flex:1 1 100%;border-top:1px solid #333;padding-top:6px;">
          <summary style="cursor:pointer;color:#aaa;font-size:12px;user-select:none;list-style:none;font-weight:bold;">Automation &#x2699;&#xFE0F;</summary>
          <div style="margin-top:8px;display:flex;gap:12px;flex-wrap:wrap;align-items:flex-start;">
            <div style="display:flex;flex-direction:column;gap:6px;">
              <span style="color:#666;font-size:10px;text-transform:uppercase;letter-spacing:0.05em;">Gym</span>
              <label style="display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;" title="Automatically go to gym and train when energy is full, before flying">
                <input id="tm-af2-gym-enabled" type="checkbox"> Auto-Gym &#x1F3CB; (trains before flying when energy is full)
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
            <div style="display:flex;flex-direction:column;gap:6px;border-left:1px solid #333;padding-left:12px;">
              <span style="color:#666;font-size:10px;text-transform:uppercase;letter-spacing:0.05em;">Nerve</span>
              <label style="display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;" title="Hold the next flight if your nerve bar is full — waits until nerve is spent before departing">
                <input id="tm-af2-hold-nerve" type="checkbox"> Hold flight if nerve full &#x26A1;
              </label>
            </div>
            <div style="display:flex;flex-direction:column;gap:6px;border-left:1px solid #333;padding-left:12px;">
              <span style="color:#666;font-size:10px;text-transform:uppercase;letter-spacing:0.05em;">Rehab</span>
              <label style="display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;" title="Auto-travel to Switzerland and rehab before shopping when addiction exceeds the threshold. Also rehabbing in Switzerland before shopping when already there.">
                <input id="tm-af2-rehab-enabled" type="checkbox"> Auto-Rehab &#x1F489; (Switzerland)
              </label>
              <label style="display:flex;align-items:center;gap:6px;user-select:none;" title="Rehab triggers only when addiction level is strictly above this value (1–4)">
                Min addiction:
                <input id="tm-af2-min-addiction" type="number" min="1" max="4" step="1"
                  style="width:40px;padding:2px 4px;border-radius:3px;border:1px solid #555;background:#111;color:#eee;font-size:12px;text-align:center;">
                <span style="color:#666;font-size:10px;">(rehabs when &gt; this)</span>
              </label>
            </div>
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
    const logBtn = document.getElementById("tm-af2-log-btn");
    if (logBtn) logBtn.addEventListener("click", openAbroadLogModal);

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
      const cloudPollEl = document.getElementById("tm-af2-cloud-poll");
      if (cloudPollEl) {
        cloudPollEl.checked = isCloudPollEnabled();
        cloudPollEl.addEventListener("change", () => {
          localStorage.setItem(CLOUD_POLL_KEY, String(cloudPollEl.checked));
          cloudPollEl.checked ? startCloudPoll() : stopCloudPoll();
        });
      }

      const controllerOnlyEl = document.getElementById("tm-af2-controller-only");
      const controllerBanner = document.getElementById("tm-af2-controller-banner");
      const applyControllerOnly = (on) => {
        if (controllerBanner) controllerBanner.style.display = on ? "block" : "none";
        if (on) stopAutoCheck(); else if (options.autoEnabled) startAutoCheck();
      };
      if (controllerOnlyEl) {
        controllerOnlyEl.checked = isControllerOnly();
        applyControllerOnly(controllerOnlyEl.checked);
        controllerOnlyEl.addEventListener("change", () => {
          localStorage.setItem(CONTROLLER_ONLY_KEY, String(controllerOnlyEl.checked));
          applyControllerOnly(controllerOnlyEl.checked);
        });
      }

      const goItemMarketEl = document.getElementById("tm-af2-go-item-market");
      if (goItemMarketEl) {
        goItemMarketEl.checked = !!options.goItemMarket;
        goItemMarketEl.addEventListener("change", () => {
          options.goItemMarket = !!goItemMarketEl.checked;
          saveOptions(options);
        });
      }
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
    const holdNerveEl = document.getElementById("tm-af2-hold-nerve");
    if (holdNerveEl) {
      holdNerveEl.checked = !!options.holdIfNerveFull;
      holdNerveEl.addEventListener("change", () => {
        options.holdIfNerveFull = !!holdNerveEl.checked; saveOptions(options);
      });
    }
    const rehabEnabledEl = document.getElementById("tm-af2-rehab-enabled");
    if (rehabEnabledEl) {
      rehabEnabledEl.checked = !!options.autoRehabEnabled;
      rehabEnabledEl.addEventListener("change", () => {
        options.autoRehabEnabled = !!rehabEnabledEl.checked; saveOptions(options);
      });
    }
    const minAddictionEl = document.getElementById("tm-af2-min-addiction");
    if (minAddictionEl) {
      minAddictionEl.value = String(options.minAddictionLevel ?? 1);
      minAddictionEl.addEventListener("change", () => {
        const v = Math.max(1, Math.min(4, parseInt(minAddictionEl.value, 10) || 1));
        minAddictionEl.value = String(v);
        options.minAddictionLevel = v;
        saveOptions(options);
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
          const productInpS = "padding:2px 4px;border-radius:3px;border:1px solid #555;background:#111;color:#eee;font-size:11px;box-sizing:border-box;width:130px;min-width:0;";
          const saveS = "padding:1px 5px;background:#1a3a1a;border:1px solid #2a6a2a;color:#6f6;border-radius:3px;cursor:pointer;font-size:11px;";
          const cancelS = "padding:1px 5px;background:#220000;border:1px solid #622;color:#f66;border-radius:3px;cursor:pointer;font-size:11px;";
          const editDlId = `tm-af2-edit-pdl-${idx}`;
          const initProducts = (YATA_PRODUCTS[flight.destination] || []).map(p => `<option value="${escHtml(p)}"></option>`).join("");
          row.innerHTML = [
            `<input type="text" placeholder="HH:MM" maxlength="5" data-edit-time="${idx}" value="${escHtml(flight.departureTime)}" style="${timeInpS}">`,
            `<select data-edit-dest="${idx}" style="${destSelS}">`,
            VALID_DESTINATIONS.map(d => `<option${d === flight.destination ? " selected" : ""}>${escHtml(d)}</option>`).join(""),
            `</select>`,
            `<input type="text" placeholder="Priority product" data-edit-product="${idx}" value="${escHtml(flight.priorityProduct || "")}" list="${editDlId}" style="${productInpS}">`,
            `<datalist id="${editDlId}">${initProducts}</datalist>`,
            `<button data-action="save-flight" data-idx="${idx}" style="${saveS}">✓</button>`,
            `<button data-action="cancel-flight" data-idx="${idx}" style="${cancelS}">✗</button>`,
          ].join("");
          const timeInp = row.querySelector("input[data-edit-time]");
          timeInp && timeInp.focus();
          timeInp && timeInp.addEventListener("keydown", ev => {
            if (ev.key === "Enter") { ev.preventDefault(); row.querySelector('[data-action="save-flight"]').click(); }
            if (ev.key === "Escape") { ev.preventDefault(); renderFlightPlan(); }
          });
          const editDestSel = row.querySelector("select[data-edit-dest]");
          const editDl = document.getElementById(editDlId);
          if (editDestSel && editDl) {
            editDestSel.addEventListener("change", () => {
              editDl.innerHTML = (YATA_PRODUCTS[editDestSel.value] || []).map(p => `<option value="${escHtml(p)}"></option>`).join("");
              const prodInp = row.querySelector("input[data-edit-product]");
              if (prodInp) prodInp.value = "";
            });
          }

        } else if (action === "save-flight") {
          const row = btn.closest("div");
          const newTime = (row.querySelector("input[data-edit-time]") || {}).value || "";
          const newDest = (row.querySelector("select[data-edit-dest]") || {}).value || "";
          const newProduct = ((row.querySelector("input[data-edit-product]") || {}).value || "").trim();
          if (newDest && plan[idx]) {
            plan[idx].departureTime = newTime;
            plan[idx].destination = newDest;
            plan[idx].priorityProduct = newProduct;
            if (plan[idx].status === "done") plan[idx].status = "pending";
            saveFlightPlan(plan);
          }
          renderFlightPlan();
          autoFlyCheck();

        } else if (action === "cancel-flight") {
          renderFlightPlan();

        } else if (action === "toggle-skip") {
          if (plan[idx]) {
            plan[idx].skip = !plan[idx].skip;
            saveFlightPlan(plan);
            renderFlightPlan();
          }
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

    // Populate add-flight product datalist and refresh it when destination changes
    const newDestEl = document.getElementById("tm-af2-new-dest");
    const newProductDL = document.getElementById("tm-af2-new-product-list");
    function refreshAddProductList(dest) {
      if (!newProductDL) return;
      newProductDL.innerHTML = (YATA_PRODUCTS[dest] || []).map(p => `<option value="${escHtml(p)}"></option>`).join("");
    }
    if (newDestEl) {
      refreshAddProductList(newDestEl.value);
      newDestEl.addEventListener("change", () => {
        refreshAddProductList(newDestEl.value);
        const productEl = document.getElementById("tm-af2-new-product");
        if (productEl) productEl.value = "";
      });
    }

    // Add flight button
    const addFlightBtn = document.getElementById("tm-af2-add-flight");
    if (addFlightBtn) {
      addFlightBtn.addEventListener("click", () => {
        const destEl = document.getElementById("tm-af2-new-dest");
        const timeEl = document.getElementById("tm-af2-new-time");
        const productEl = document.getElementById("tm-af2-new-product");
        const dest = (destEl && destEl.value) || "";
        const time = (timeEl && timeEl.value) || "";
        const product = ((productEl && productEl.value) || "").trim();
        if (!dest) return;
        const plan = loadFlightPlan();
        plan.push({ id: genId(), destination: dest, departureTime: time, status: "pending", loop: false, priorityProduct: product });
        saveFlightPlan(plan);
        renderFlightPlan();
        if (productEl) productEl.value = "";
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
        "z-index:2147483641","cursor:pointer",
        "display:flex","align-items:center","justify-content:center",
        "box-shadow:0 3px 10px rgba(0,0,0,0.6)","touch-action:manipulation",
      ].join(";");
      document.body.appendChild(fab);

      const backdrop = document.createElement("div");
      backdrop.id = "tm-af2-modal";
      backdrop.style.cssText = [
        "position:fixed","inset:0","background:rgba(0,0,0,0.65)",
        "z-index:2147483640","display:none","align-items:flex-end",
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

  GM_registerMenuCommand('Set API Key', () => {
    const current = GM_getValue('tornApiKey', '');
    const key = prompt('Enter your Torn API key:', current);
    if (key === null) return;
    GM_setValue('tornApiKey', key.trim());
  });

  startAutoCheck();
  initHospitalWatch();
  initTravelWatch();
  watchForOverseasError();
  flushPersistedCloudSave()
    .then(() => initCloudSync())
    .catch(e => console.warn("[AutoFly2] cloud init error:", e));
  startCloudPoll();
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") pollCloudSync();
  }, { passive: true });
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
