// ==UserScript==
// @name         Torn Property Vault Auto Withdraw/Deposit
// @namespace    http://tampermonkey.net/
// @version      1.4
// @description  Maintain a target cash-on-hand value by auto depositing or withdrawing from the property vault. Mobile floating panel supported.
// @author       GitHub Copilot
// @match        https://www.torn.com/properties.php*
// @grant        GM_xmlhttpRequest
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  class TornAPI {
    constructor(apiKey) {
      this.apiKey = apiKey;
      this.baseUrl = "https://api.torn.com";
    }

    async request(section, selections) {
      const url = `${this.baseUrl}/${section}/?selections=${selections}&key=${this.apiKey}`;

      const response = await fetch(url);

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();

      if (data.error) {
        throw new Error(`[${data.error.code}] ${data.error.error}`);
      }

      return data;
    }

    async getTravelStatus() {
      const data = await this.request("user", "basic,travel");

      // If there is no travel object, you're in Torn
      if (!data.travel) {
        return {
          traveling: false,
          destination: "Torn",
          minutesRemaining: 0,
          secondsRemaining: 0,
          status: data.status?.state,
        };
      }

      const seconds = Number(data.travel.time_left || 0);

      return {
        traveling: seconds > 0,
        destination: data.travel.destination,
        method: data.travel.method,
        departed: data.travel.departed,
        arrivalTimestamp: data.travel.timestamp,
        minutesRemaining: Math.ceil(seconds / 60),
        secondsRemaining: seconds,
        status: data.status?.state,
      };
    }
  }

  const STORAGE_KEY = "tornVaultAutoSettings";
  const api = new TornAPI("v6Yo75UQIYvWYrhT");

  // =================== CLOUD SYNC ===================
  const GIST_TOKEN = "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";
  const GIST_ID    = "bd5625e0bb394474941befb868d9af6d";
  const GIST_FILE  = "torn-my-tool-settings.json";

  const loadSettings = (defaults) => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (!stored) return defaults;
      const parsed = JSON.parse(stored);
      return Object.assign({}, defaults, parsed);
    } catch (error) {
      return defaults;
    }
  };

  const saveSettings = () => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(CONFIG));
    } catch (error) {
      console.warn("Vault script failed to save settings", error);
    }
    scheduleCloudSave("vault", CONFIG);
  };

  // =================== CLOUD HELPERS ===================
  const CLOUD_POLL_KEY = "tmCloudSyncPoll";
  let _cloudSavePending = {};
  let _cloudSaveTimer = null;
  let _cloudSaveInProgress = false;
  let _cloudPollIntervalId = null;

  function gmFetch(url, { method = "GET", headers = {}, body } = {}) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method, url, headers, data: body,
        onload: (r) => resolve({
          ok: r.status >= 200 && r.status < 300,
          status: r.status,
          json: () => Promise.resolve(JSON.parse(r.responseText)),
        }),
        onerror: () => reject(new Error("GM request failed")),
        ontimeout: () => reject(new Error("GM request timed out")),
      });
    });
  }

  async function cloudLoad() {
    if (!GIST_TOKEN || GIST_TOKEN === "YOUR_GITHUB_TOKEN_HERE") return {};
    try {
      const r = await gmFetch(`https://api.github.com/gists/${GIST_ID}?_=${Date.now()}`, {
        headers: { Authorization: `token ${GIST_TOKEN}`, Accept: "application/vnd.github.v3+json", "Cache-Control": "no-cache" }
      });
      if (!r.ok) return {};
      const d = await r.json();
      return JSON.parse(d.files?.[GIST_FILE]?.content || "{}");
    } catch(e) { console.warn("[Vault] Cloud load failed:", e); return {}; }
  }

  let _cloudStatusClearTimer = null;
  function setCloudSaveStatus(state) {
    const el = document.getElementById("tm-vault-cloud-status");
    if (!el) return;
    if (_cloudStatusClearTimer) { clearTimeout(_cloudStatusClearTimer); _cloudStatusClearTimer = null; }
    if (state === "pending") {
      el.textContent = "⏳"; el.title = "Save queued…"; el.style.color = "#f0a500";
    } else if (state === "saving") {
      el.textContent = "↑"; el.title = "Saving to cloud…"; el.style.color = "#f0a500";
    } else if (state === "saved") {
      el.textContent = "✓"; el.title = "Saved to cloud"; el.style.color = "#44cc88";
      _cloudStatusClearTimer = setTimeout(() => {
        const e2 = document.getElementById("tm-vault-cloud-status");
        if (e2) { e2.textContent = ""; e2.title = ""; }
        _cloudStatusClearTimer = null;
      }, 3000);
    } else if (state === "error") {
      el.textContent = "✗"; el.title = "Save failed — check console"; el.style.color = "#f66";
    } else {
      el.textContent = ""; el.title = "";
    }
  }

  function scheduleCloudSave(section, data) {
    _cloudSavePending[section] = JSON.parse(JSON.stringify(data));
    if (_cloudSaveTimer) clearTimeout(_cloudSaveTimer);
    setCloudSaveStatus("pending");
    _cloudSaveTimer = setTimeout(async () => {
      if (!GIST_TOKEN || GIST_TOKEN === "YOUR_GITHUB_TOKEN_HERE") return;
      const pending = Object.assign({}, _cloudSavePending);
      _cloudSavePending = {};
      _cloudSaveTimer = null;
      _cloudSaveInProgress = true;
      setCloudSaveStatus("saving");
      try {
        const all = await cloudLoad();
        Object.assign(all, pending);
        await gmFetch(`https://api.github.com/gists/${GIST_ID}`, {
          method: "PATCH",
          headers: {
            Authorization: `token ${GIST_TOKEN}`,
            Accept: "application/vnd.github.v3+json",
            "Content-Type": "application/json"
          },
          body: JSON.stringify({ files: { [GIST_FILE]: { content: JSON.stringify(all, null, 2) } } })
        });
        _lastCloudContent = JSON.stringify(all);
        _cloudSaveInProgress = false;
        setCloudSaveStatus("saved");
        console.log("[Vault] Cloud settings saved");
      } catch(e) {
        Object.assign(_cloudSavePending, pending);
        _cloudSaveInProgress = false;
        setCloudSaveStatus("error");
        console.warn("[Vault] Cloud save failed:", e);
      }
    }, 1500);
  }

  let _lastCloudContent = null;

  function applyCloudSettings(cloud) {
    if (!cloud.vault) return;
    Object.assign(CONFIG, cloud.vault);
    autoMaintain = CONFIG.autoMaintainEnabled;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(CONFIG)); } catch(e) {}
    const targetInput     = document.getElementById("tm-target-cash");
    const autoMaintainInp = document.getElementById("tm-auto-maintain");
    const autoAttackInp   = document.getElementById("tm-auto-attack-deposit");
    if (targetInput)     targetInput.value        = formatNumber(parseAmount(CONFIG.targetCashOnHand));
    if (autoMaintainInp) autoMaintainInp.checked  = !!CONFIG.autoMaintainEnabled;
    if (autoAttackInp)   autoAttackInp.checked    = !!CONFIG.autoAttackDepositEnabled;
    try { updateMaintainInfo(getVaultValues()); } catch(e) {}
  }

  async function initCloudSync() {
    const cloud = await cloudLoad();
    _lastCloudContent = JSON.stringify(cloud);
    applyCloudSettings(cloud);
    console.log("[Vault] Cloud settings synced");
  }

  async function pollCloudSync() {
    if (_cloudSaveInProgress || Object.keys(_cloudSavePending).length > 0) return;
    const cloud = await cloudLoad();
    const content = JSON.stringify(cloud);
    if (content === _lastCloudContent) return;
    _lastCloudContent = content;
    applyCloudSettings(cloud);
    console.log("[Vault] Cloud settings updated from remote");
  }

  function isCloudPollEnabled() {
    const v = localStorage.getItem(CLOUD_POLL_KEY);
    return v === null ? true : v === "true";
  }
  function startCloudPoll() {
    if (!isCloudPollEnabled()) { console.log("[Vault] Cloud polling disabled"); return; }
    if (_cloudPollIntervalId) return;
    _cloudPollIntervalId = setInterval(pollCloudSync, 1000);
  }
  function stopCloudPoll() {
    if (_cloudPollIntervalId) { clearInterval(_cloudPollIntervalId); _cloudPollIntervalId = null; }
  }

  const CONFIG = loadSettings({
    targetCashOnHand: "500000",
    autoMaintainEnabled: false,
    autoAttackDepositEnabled: true,
    attackRecoveryDelaySeconds: 10,
    insertionLabel: "Vault Auto Cash Manager",
  });

  const PANEL_ID = "tm-vault-panel";
  const FAB_ID = "tm-vault-fab";
  const MODAL_ID = "tm-vault-modal";
  let autoMaintain = CONFIG.autoMaintainEnabled;
  let lastVaultState = { cash: null, vault: null };
  let maintainSchedule = null;
  let attackRecoveryTimer = null;
  let lastAttackDepositTime = 0;
  let lastAttackState = false;
  let postAttackRecoveryUntil = 0;
  let postAttackCountdownInterval = null;
  const ATTACK_DEPOSIT_COOLDOWN = 30000;
  const ATTACK_SELECTOR = '[class^="effectRoot"] > div';
  const HOSPITAL_MESSAGE = "This area is unavailable while you're in hospital.";
  const HOSPITAL_CHECK_INTERVAL_SECONDS = 10;
  const HOSPITAL_CHECK_INTERVAL_MS = HOSPITAL_CHECK_INTERVAL_SECONDS * 1000;
  let hospitalCheckInterval = null;
  let lastHospitalState = false;
  const TRAVEL_CHECK_INTERVAL_MS = 5000; // Check every 5 seconds for travel status
  let travelingCheckInterval = null;
  let travelCountdownInterval = null; // For the countdown logging

  const getNodeByXPath = (xpath) => {
    const result = document.evaluate(
      xpath,
      document,
      null,
      XPathResult.FIRST_ORDERED_NODE_TYPE,
      null,
    );
    return result.singleNodeValue;
  };

  const getAttackStateFromXPath = () => {
    const node = document.querySelector(ATTACK_SELECTOR);
    if (!node) return false;
    const cls = node.getAttribute("class");
    return typeof cls === "string" && cls.trim().length > 0;
  };

  const startPostAttackCountdown = () => {
    if (postAttackCountdownInterval) {
      clearInterval(postAttackCountdownInterval);
    }
    postAttackCountdownInterval = setInterval(() => {
      const remainingMs = postAttackRecoveryUntil - Date.now();
      if (remainingMs <= 0) {
        clearInterval(postAttackCountdownInterval);
        postAttackCountdownInterval = null;
        console.log(
          "[Vault Script] Post-attack recovery period complete (0 seconds remaining)",
        );
        const countdownEl = document.getElementById("tm-attack-countdown");
        if (countdownEl) {
          countdownEl.textContent = "";
          countdownEl.style.display = "none";
        }
        return;
      }
      const remainingSec = Math.ceil(remainingMs / 1000);
      console.log(
        `[Vault Script] Post-attack recovery countdown: ${remainingSec} seconds remaining`,
      );
      const countdownEl = document.getElementById("tm-attack-countdown");
      if (countdownEl) {
        countdownEl.textContent = `Recovery: ${remainingSec}s`;
        countdownEl.style.display = "inline";
      }
    }, 1000); // Update every 1 second for UI, log every update
  };

  const scheduleMaintainAfterRecovery = () => {
    if (attackRecoveryTimer) {
      clearTimeout(attackRecoveryTimer);
    }
    const delayMs = ATTACK_DEPOSIT_COOLDOWN;
    console.log(
      "[Vault Script] Attack ended, will resume maintenance after",
      delayMs / 1000,
      "second cooldown",
    );
    attackRecoveryTimer = setTimeout(() => {
      attackRecoveryTimer = null;
      if (postAttackCountdownInterval) {
        clearInterval(postAttackCountdownInterval);
        postAttackCountdownInterval = null;
      }
      // Clear the recovery flag
      postAttackRecoveryUntil = 0;
      lastAttackState = false;
      console.log(
        "[Vault Script] Post-attack recovery period complete, flag reset",
      );

      if (autoMaintain) {
        console.log("[Vault Script] Resuming maintenance after recovery");
        maintainCashOnHand();
      } else {
        console.log(
          "[Vault Script] Auto maintain is disabled, not resuming maintenance",
        );
      }
    }, delayMs);
  };

  const checkAttackState = () => {
    const currentState = getAttackStateFromXPath();
    if (currentState && !lastAttackState) {
      console.log("[Vault Script] Attack detected");

      // Immediately clear the class to reset detection state
      const node = document.querySelector(ATTACK_SELECTOR);
      if (node) {
        node.className = "";
        console.log(
          "[Vault Script] Cleared effectRoot class on attack detection",
        );
      }

      // Set recovery period to block maintenance
      postAttackRecoveryUntil = Date.now() + ATTACK_DEPOSIT_COOLDOWN;
      console.log(
        "[Vault Script] Post-attack recovery enabled for",
        ATTACK_DEPOSIT_COOLDOWN / 1000,
        "seconds",
      );
      startPostAttackCountdown();
      depositAllCashOnAttack();
      if (attackRecoveryTimer) {
        clearTimeout(attackRecoveryTimer);
        attackRecoveryTimer = null;
      }
    }
    if (!currentState && lastAttackState && autoMaintain) {
      console.log("[Vault Script] Attack cleared");
      scheduleMaintainAfterRecovery();
    }
    lastAttackState = currentState;
  };

  const isHospitalStatus = () => {
    return document.querySelector('li[class*="icon15"]') !== null;
  };

  const startHospitalMonitor = async () => {
    const hospitalActive = isHospitalStatus();
    const travelingMsg = document.querySelector(".info-msg.border-round");
    const isTraveling =
      travelingMsg &&
      travelingMsg.textContent.includes("while you're traveling.");

    if (hospitalActive || isTraveling) {
      lastHospitalState = true;
      if (!hospitalCheckInterval) {
        if (isTraveling && !travelingCheckInterval) {
          const travel = await api.getTravelStatus();

          if (travel.secondsRemaining <= 0) {
            console.log(
              "[Vault Script] Travel already complete. Reloading now...",
            );
            location.reload();
            return;
          }

          console.log(
            `[Vault Script] Traveling detected. Destination: ${travel.destination}. Will reload in ${travel.secondsRemaining} seconds (${travel.minutesRemaining} minutes)`,
          );

          if (travelCountdownInterval) {
            clearInterval(travelCountdownInterval);
          }
          const travelEndAt = Date.now() + Math.max(0, Math.floor(travel.secondsRemaining)) * 1000;
          const updateTravelUI = (sec) => {
            const el = document.getElementById("tm-travel-countdown");
            if (!el) return;
            if (sec <= 0) {
              el.style.display = "none";
              el.textContent = "";
            } else {
              const h = Math.floor(sec / 3600);
              const m = Math.floor((sec % 3600) / 60);
              const s = sec % 60;
              el.textContent = `Traveling: ${h > 0 ? h + "h " : ""}${m}m ${s}s`;
              el.style.display = "inline";
            }
          };
          const renderTravel = () => {
            const countdown = Math.max(0, Math.ceil((travelEndAt - Date.now()) / 1000));
            updateTravelUI(countdown);
            if (countdown <= 0) {
              clearInterval(travelCountdownInterval);
              travelCountdownInterval = null;
              console.log(
                "[Vault Script] Travel time expired. Reloading page...",
              );
              location.reload();
              return;
            }
            console.log(
              `[Vault Script] Travel reload countdown: ${countdown} seconds remaining...`,
            );
          };
          renderTravel();
          travelCountdownInterval = setInterval(renderTravel, 1000);
          document.addEventListener("visibilitychange", function onTravelVisible() {
            if (!document.hidden) { renderTravel(); }
            if (!travelCountdownInterval) document.removeEventListener("visibilitychange", onTravelVisible);
          });

          travelingCheckInterval = setInterval(() => {
            if (
              !document
                .querySelector(".info-msg.border-round")
                ?.textContent.includes("while you're traveling.")
            ) {
              clearInterval(travelingCheckInterval);
              travelingCheckInterval = null;
              if (travelCountdownInterval) {
                clearInterval(travelCountdownInterval);
                travelCountdownInterval = null;
              }
              console.log(
                "[Vault Script] No longer traveling. Reloading page...",
              );
              location.reload();
            }
          }, TRAVEL_CHECK_INTERVAL_MS);

          return;
        }

        console.log(
          "[Vault Script] Hospital status detected. Pausing automation and waiting to retry every",
          HOSPITAL_CHECK_INTERVAL_MS / 1000,
          "seconds.",
        );
        hospitalCheckInterval = setInterval(() => {
          if (isHospitalStatus()) {
            console.log(
              "[Vault Script] Still in hospital. Waiting to retry...",
            );
            return;
          }
          console.log(
            "[Vault Script] Hospital status cleared. Reloading page to resume automation.",
          );
          clearInterval(hospitalCheckInterval);
          hospitalCheckInterval = null;
          location.reload();
        }, HOSPITAL_CHECK_INTERVAL_MS);
      }
      return true;
    }

    if (lastHospitalState) {
      lastHospitalState = false;
      if (hospitalCheckInterval) {
        clearInterval(hospitalCheckInterval);
        hospitalCheckInterval = null;
      }
      if (travelCountdownInterval) {
        clearInterval(travelCountdownInterval);
        travelCountdownInterval = null;
      }
      console.log(
        "[Vault Script] Hospital/travel status just cleared. Reloading page to resume automation.",
      );
      location.reload();
      return true;
    }

    return false;
  };

  const formatNumber = (value) => {
    return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  };

  const parseAmount = (value) => {
    if (value == null) return 0;
    if (typeof value !== "string") {
      value = String(value);
    }
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

  const getVaultForm = (type) => {
    if (type === "withdraw") {
      return document.querySelector("form.vault-cont.left");
    }
    return document.querySelector("form.vault-cont.right.deposit-box");
  };

  const getVaultValues = () => {
    const cashEl = document.getElementById("vault-dvalue");
    const vaultEl = document.getElementById("vault-wvalue");
    const cash = parseAmount(cashEl?.textContent || "0");
    const vault = parseAmount(vaultEl?.textContent || "0");
    return { cash, vault };
  };

  const updateMaintainInfo = ({ cash, vault }) => {
    const info = document.getElementById("tm-vault-maintain-info");
    if (!info) return;
    const target = parseAmount(CONFIG.targetCashOnHand);
    const delta = cash - target;
    const deltaColor = delta > 0 ? "#ff9966" : delta < 0 ? "#66aaff" : "#44cc88";
    const deltaStr = delta === 0 ? "on target" : (delta > 0 ? "+" : "") + "$" + formatNumber(Math.abs(delta)) + (delta > 0 ? " to deposit" : " to withdraw");
    info.innerHTML = [
      `<span style="color:#aaa;">Cash:</span> <span style="color:#44cc88;font-weight:bold;">$${formatNumber(cash)}</span>`,
      `<span style="color:#555;margin:0 4px;">|</span>`,
      `<span style="color:#aaa;">Vault:</span> <span style="color:#4db8ff;font-weight:bold;">$${formatNumber(vault)}</span>`,
      `<span style="color:#555;margin:0 4px;">|</span>`,
      `<span style="color:#aaa;">Target:</span> <span style="color:#f0a500;font-weight:bold;">$${formatNumber(target)}</span>`,
      `<span style="color:#555;margin:0 4px;">|</span>`,
      `<span style="color:${deltaColor};font-size:11px;">${deltaStr}</span>`,
    ].join("");
  };

  const valuesChanged = ({ cash, vault }) => {
    return cash !== lastVaultState.cash || vault !== lastVaultState.vault;
  };

  const scheduleMaybeMaintain = () => {
    if (maintainSchedule) return;
    maintainSchedule = setTimeout(() => {
      maintainSchedule = null;
      const values = getVaultValues();
      if (valuesChanged(values)) {
        lastVaultState = values;
        updateMaintainInfo(values);
        const inPostAttackRecovery = Date.now() < postAttackRecoveryUntil;
        if (inPostAttackRecovery) {
          console.log(
            "[Vault Script] In post-attack recovery period, skipping maintenance",
          );
          return;
        }
        if (autoMaintain && !getAttackStateFromXPath()) {
          maintainCashOnHand();
        }
      }
    }, 200);
  };

  const depositAllCashOnAttack = () => {
    if (isHospitalStatus()) return;
    if (!CONFIG.autoAttackDepositEnabled) return;
    const now = Date.now();
    if (now - lastAttackDepositTime < ATTACK_DEPOSIT_COOLDOWN) {
      console.log("[Vault Script] Attack deposit skipped due to cooldown");
      return;
    }
    lastAttackDepositTime = now;
    const { cash } = getVaultValues();
    if (cash > 0) {
      console.log("[Vault Script] Depositing all cash on attack:", cash);
      submitVaultForm("deposit", cash);
    } else {
      console.log("[Vault Script] No cash to deposit on attack");
    }
  };

  const fillVaultForm = (type, amount) => {
    const form = getVaultForm(type);
    if (!form) return false;

    const textInput = form.querySelector('input.input-money[type="text"]');
    const hiddenInput = form.querySelector(
      `input[type="hidden"][name="${type}"]`,
    );
    const submitBtn = form.querySelector('input[type="submit"]');
    if (!textInput || !hiddenInput || !submitBtn) return false;

    const normalized = parseAmount(amount);
    if (normalized <= 0) return false;

    textInput.value = formatNumber(normalized);
    hiddenInput.value = normalized;
    hiddenInput.dataset.money = normalized;

    submitBtn.disabled = false;
    submitBtn.classList.remove("disabled");
    submitBtn.classList.add("torn-btn");

    return true;
  };

  const submitVaultForm = (type, amount) => {
    const filled = fillVaultForm(type, amount);
    if (!filled) return false;

    const form = getVaultForm(type);
    if (!form) return false;

    const submitBtn = form.querySelector('input[type="submit"]');
    if (submitBtn) {
      submitBtn.click();
      return true;
    }
    form.submit();
    return true;
  };

  const maintainCashOnHand = () => {
    if (isHospitalStatus()) return;
    const inPostAttackRecovery = Date.now() < postAttackRecoveryUntil;
    if (inPostAttackRecovery) {
      console.log(
        "[Vault Script] In post-attack recovery period, skipping maintenance",
      );
      return;
    }
    const target = parseAmount(CONFIG.targetCashOnHand);
    if (target < 0) return;

    const { cash, vault } = getVaultValues();
    const delta = cash - target;
    console.log(
      "[Vault Script] Maintaining cash on hand. Current cash:",
      cash,
      "Vault:",
      vault,
      "Target:",
      target,
      "Delta:",
      delta,
    );
    updateMaintainInfo({ cash, vault });

    if (delta === 0) {
      console.log("[Vault Script] Cash on hand already at target");
      return;
    }

    const required = Math.abs(delta);
    if (delta > 0) {
      submitVaultForm("deposit", required);
      return;
    }

    const withdrawAmount = Math.min(vault, required);
    if (withdrawAmount <= 0) return;
    submitVaultForm("withdraw", withdrawAmount);
  };

  const isMobile = () =>
    /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) ||
    window.innerWidth < 768;

  // Build the shared panel element (controls only). Box/positioning styling is
  // applied by the desktop (inline) or mobile (bottom-sheet) branch.
  const buildPanelElement = () => {
    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.style.cssText =
      "color:#eee;font-family:Arial,sans-serif;font-size:13px;box-sizing:border-box;width:100%;";
    panel.innerHTML = `
      <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center;box-sizing:border-box;width:100%;">

        <!-- Header -->
        <div style="display:flex;justify-content:space-between;align-items:center;flex:1 1 100%;">
          <strong>&#127974; Vault Cash Manager</strong>
        </div>

        <!-- Vault state info -->
        <div id="tm-vault-maintain-info" style="flex:1 1 100%;font-size:12px;color:#aaa;background:#111;border:1px solid #2a2a2a;border-radius:6px;padding:6px 10px;font-variant-numeric:tabular-nums;min-height:1em;"></div>

        <!-- Alert badges (shown conditionally) -->
        <div style="flex:1 1 100%;display:flex;gap:8px;flex-wrap:wrap;min-height:0;">
          <span id="tm-attack-countdown" style="display:none;color:#ff6b6b;font-weight:bold;font-size:12px;background:#1a0000;border:1px solid #622;border-radius:4px;padding:3px 8px;white-space:nowrap;"></span>
          <span id="tm-travel-countdown" style="display:none;color:#f0a500;font-weight:bold;font-size:12px;background:#1a1000;border:1px solid #664400;border-radius:4px;padding:3px 8px;white-space:nowrap;"></span>
        </div>

        <!-- Options -->
        <div style="flex:1 1 100%;display:flex;gap:12px;flex-wrap:wrap;align-items:center;border-top:1px solid #333;padding-top:8px;">
          <label style="display:flex;align-items:center;gap:6px;user-select:none;" title="Keep this much cash on hand — excess deposits, shortfall withdraws">
            Target:
            <input id="tm-target-cash" type="text" value="${formatNumber(parseAmount(CONFIG.targetCashOnHand))}"
              style="width:100px;padding:3px 6px;border-radius:4px;border:1px solid #555;background:#111;color:#eee;font-size:12px;box-sizing:border-box;">
          </label>
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;" title="Automatically deposit or withdraw to maintain the target amount">
            <input id="tm-auto-maintain" type="checkbox"${CONFIG.autoMaintainEnabled ? " checked" : ""}> Auto-maintain
          </label>
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;" title="Immediately deposit all cash to vault when an attack is detected">
            <input id="tm-auto-attack-deposit" type="checkbox"${CONFIG.autoAttackDepositEnabled ? " checked" : ""}> Deposit on attack
          </label>
          <label style="display:flex;align-items:center;gap:6px;cursor:pointer;user-select:none;" title="Poll Gist cloud every second to sync settings across devices. Disable to reduce GitHub API usage.">
            <input id="tm-vault-cloud-poll" type="checkbox"> Cloud sync
          </label>
          <span id="tm-vault-cloud-status" style="font-size:11px;font-weight:bold;min-width:14px;text-align:center;"></span>
        </div>

      </div>
    `;
    return panel;
  };

  const wireControlPanel = () => {
    const targetInput = document.getElementById("tm-target-cash");
    const autoMaintainInput = document.getElementById("tm-auto-maintain");
    const autoAttackDepositInput = document.getElementById(
      "tm-auto-attack-deposit",
    );
    if (!targetInput) return;
    targetInput.addEventListener("change", () => {
      CONFIG.targetCashOnHand = targetInput.value;
      saveSettings();
      console.log(
        "[Vault Script] Target cash on hand set to",
        CONFIG.targetCashOnHand,
      );
      if (autoMaintain) {
        maintainCashOnHand();
      }
    });
    autoMaintainInput?.addEventListener("change", () => {
      autoMaintain = autoMaintainInput.checked;
      CONFIG.autoMaintainEnabled = autoMaintain;
      saveSettings();
      console.log(
        "[Vault Script] Auto maintain",
        autoMaintain ? "enabled" : "disabled",
      );
      if (autoMaintain) {
        CONFIG.targetCashOnHand = targetInput.value;
        maintainCashOnHand();
      }
    });
    autoAttackDepositInput?.addEventListener("change", () => {
      CONFIG.autoAttackDepositEnabled = autoAttackDepositInput.checked;
      saveSettings();
    });
    const cloudPollEl = document.getElementById("tm-vault-cloud-poll");
    if (cloudPollEl) {
      cloudPollEl.checked = isCloudPollEnabled();
      cloudPollEl.addEventListener("change", () => {
        localStorage.setItem(CLOUD_POLL_KEY, String(cloudPollEl.checked));
        cloudPollEl.checked ? startCloudPoll() : stopCloudPoll();
      });
    }
  };

  const buildControlPanel = () => {
    if (isMobile()) {
      // Floating action button + backdrop + bottom sheet, appended to body.
      if (document.getElementById(FAB_ID)) return;

      const panel = buildPanelElement();

      const fab = document.createElement("button");
      fab.id = FAB_ID;
      fab.innerHTML = "&#127974;"; // 🏦
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
      // Desktop: inline insertion after the content title.
      const anchor = document.querySelector(".content-title");
      if (!anchor) return;
      document.getElementById(PANEL_ID)?.remove();

      const panel = buildPanelElement();
      panel.style.cssText +=
        ";background:#1a1a1a;border:1px solid #444;border-radius:8px;padding:12px;margin:10px 0;max-width:100%;";
      anchor.parentNode.insertBefore(panel, anchor.nextSibling);
    }

    wireControlPanel();
  };

  const ensureControlPanel = () => {
    if (isMobile()) {
      if (
        !document.getElementById(FAB_ID) &&
        !document.getElementById(PANEL_ID)
      ) {
        buildControlPanel();
      }
    } else {
      const anchor = document.querySelector(".content-title");
      if (!anchor) return;
      if (!document.getElementById(PANEL_ID)) {
        buildControlPanel();
      }
    }
  };

  const init = () => {
    startHospitalMonitor();
    ensureControlPanel();

    const observer = new MutationObserver(() => {
      ensureControlPanel();
      if (isHospitalStatus()) return;
      scheduleMaybeMaintain();
      checkAttackState();
    });
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });

    // Belt-and-suspenders: re-inject the mobile FAB if a re-render removes it.
    if (isMobile()) {
      setInterval(() => {
        if (!document.getElementById(FAB_ID)) {
          ensureControlPanel();
        }
      }, 1000);
    }

    if (!isHospitalStatus()) {
      const currentValues = getVaultValues();
      lastVaultState = currentValues;
      updateMaintainInfo(currentValues);
      checkAttackState();

      if (CONFIG.autoMaintainEnabled) {
        autoMaintain = true;
        maintainCashOnHand();
      }
    }
  };

  const waitForNode = (selector, timeout = 5000) => {
    return new Promise((resolve) => {
      const existing = document.querySelector(selector);
      if (existing) return resolve(existing);

      const observer = new MutationObserver(() => {
        const found = document.querySelector(selector);
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
  };

  const initWhenReady = () => {
    if (document.body) {
      init();
      initCloudSync().catch(e => console.warn("[Vault] initCloudSync error:", e));
      startCloudPoll();
    } else {
      waitForNode("body").then((node) => {
        if (node) {
          init();
          initCloudSync().catch(e => console.warn("[Vault] initCloudSync error:", e));
          startCloudPoll();
        }
      });
    }
  };

  initWhenReady();
  // expose simple debug helpers to the console for troubleshooting
  try {
    window.tmVaultDebug = {
      getAttackState: getAttackStateFromXPath,
      getVaultValues: getVaultValues,
      maintainNow: maintainCashOnHand,
      config: CONFIG,
    };
    console.log(
      "[Vault Script] Debug helpers available at window.tmVaultDebug",
    );
  } catch (e) {
    // ignore in restricted environments
  }
})();
