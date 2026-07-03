// ==UserScript==
// @name         Torn Property Vault Auto Withdraw/Deposit
// @namespace    http://tampermonkey.net/
// @version      1.2
// @description  Maintain a target cash-on-hand value by auto depositing or withdrawing from the property vault.
// @author       GitHub Copilot
// @match        https://www.torn.com/properties.php*
// @grant        none
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
  };

  const CONFIG = loadSettings({
    targetCashOnHand: "500000",
    autoMaintainEnabled: false,
    autoAttackDepositEnabled: true,
    attackRecoveryDelaySeconds: 10,
    insertionLabel: "Vault Auto Cash Manager",
  });

  const PANEL_ID = "tm-vault-panel";
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

          let countdown = travel.secondsRemaining;
          if (travelCountdownInterval) {
            clearInterval(travelCountdownInterval);
          }
          const updateTravelUI = (sec) => {
            const el = document.getElementById("tm-travel-countdown");
            if (!el) return;
            if (sec <= 0) {
              el.style.display = "none";
              el.textContent = "";
            } else {
              const m = Math.floor(sec / 60);
              const s = sec % 60;
              el.textContent = `Traveling: ${m}m ${s}s`;
              el.style.display = "inline";
            }
          };
          updateTravelUI(countdown);
          travelCountdownInterval = setInterval(() => {
            countdown--;
            if (countdown <= 0) {
              clearInterval(travelCountdownInterval);
              travelCountdownInterval = null;
              updateTravelUI(0);
              console.log(
                "[Vault Script] Travel time expired. Reloading page...",
              );
              location.reload();
              return;
            }
            updateTravelUI(countdown);
            console.log(
              `[Vault Script] Travel reload countdown: ${countdown} seconds remaining...`,
            );
          }, 1000);

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
    if (info) {
      info.textContent = `Current cash: $${formatNumber(cash)} | Vault: $${formatNumber(vault)} | Target: $${formatNumber(parseAmount(CONFIG.targetCashOnHand))}`;
    }
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
    const info = document.getElementById("tm-vault-maintain-info");
    if (info) {
      info.textContent = `Current cash: $${formatNumber(cash)} | Vault: $${formatNumber(vault)} | Target: $${formatNumber(target)}`;
    }

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

  const buildControlPanel = () => {
    const anchor = document.querySelector(".content-title");
    if (!anchor) return;

    const existing = document.getElementById(PANEL_ID);
    if (existing) {
      existing.remove();
    }

    const panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.style.background = "#1a1a1a";
    panel.style.border = "1px solid #444";
    panel.style.borderRadius = "8px";
    panel.style.color = "#eee";
    panel.style.padding = "12px";
    panel.style.margin = "10px 0";
    panel.style.fontFamily = "Arial, sans-serif";
    panel.style.fontSize = "13px";

    panel.innerHTML = `
            <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:center;">
                <strong style="flex:1 1 100%;">${CONFIG.insertionLabel}</strong>
                <label style="display:flex; align-items:center; gap:6px; white-space:nowrap;">
                    Target cash on hand:
                    <input id="tm-target-cash" type="text" value="${formatNumber(parseAmount(CONFIG.targetCashOnHand))}" style="width:110px; padding:4px 6px; border-radius:4px; border:1px solid #555; background:#111; color:#eee;">
                </label>
                <label style="display:flex; align-items:center; gap:6px; white-space:nowrap;">
                    <input id="tm-auto-maintain" type="checkbox"${CONFIG.autoMaintainEnabled ? " checked" : ""}>
                    Auto maintain
                </label>
                <label style="display:flex; align-items:center; gap:6px; white-space:nowrap;">
                    <input id="tm-auto-attack-deposit" type="checkbox"${CONFIG.autoAttackDepositEnabled ? " checked" : ""}>
                    Deposit on attack
                </label>
                <span id="tm-attack-countdown" style="display:none; color:#ff6b6b; font-weight:bold; white-space:nowrap;"></span>
                <span id="tm-travel-countdown" style="display:none; color:#f0a500; font-weight:bold; white-space:nowrap;"></span>
            </div>
        `;

    anchor.parentNode.insertBefore(panel, anchor.nextSibling);

    const targetInput = panel.querySelector("#tm-target-cash");
    const autoMaintainInput = panel.querySelector("#tm-auto-maintain");
    const autoAttackDepositInput = panel.querySelector(
      "#tm-auto-attack-deposit",
    );
    targetInput?.addEventListener("change", () => {
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
  };

  const ensureControlPanel = () => {
    const anchor = document.querySelector(".content-title");
    if (!anchor) return;
    if (!document.getElementById(PANEL_ID)) {
      buildControlPanel();
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
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
    });

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
    } else {
      waitForNode("body").then((node) => {
        if (node) init();
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
