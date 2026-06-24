// ==UserScript==
// @name         Torn Property Vault Auto Withdraw/Deposit
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  Maintain a target cash-on-hand value by auto depositing or withdrawing from the property vault.
// @author       GitHub Copilot
// @match        https://www.torn.com/properties.php*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function() {
    'use strict';

    const STORAGE_KEY = 'tornVaultAutoSettings';

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
            console.warn('Vault script failed to save settings', error);
        }
    };

    const CONFIG = loadSettings({
        targetCashOnHand: '500000',
        autoMaintainEnabled: false,
        autoAttackDepositEnabled: true,
        attackRecoveryDelaySeconds: 10,
        insertionLabel: 'Vault Auto Cash Manager'
    });

    const PANEL_ID = 'tm-vault-panel';
    let autoMaintain = CONFIG.autoMaintainEnabled;
    let lastVaultState = { cash: null, vault: null };
    let maintainSchedule = null;
    let attackRecoveryTimer = null;
    let lastAttackDepositTime = 0;
    let lastAttackState = false;
    const ATTACK_DEPOSIT_COOLDOWN = 60000;
    const ATTACK_XPATH = '/html/body/div[2]/div[3]/div';

    const getNodeByXPath = (xpath) => {
        const result = document.evaluate(xpath, document, null, XPathResult.FIRST_ORDERED_NODE_TYPE, null);
        return result.singleNodeValue;
    };

    const getAttackStateFromXPath = () => {
        const node = getNodeByXPath(ATTACK_XPATH);
        if (!node) return false;
        const cls = node.getAttribute('class');
        return typeof cls === 'string' && cls.trim().length > 0;
    };

    const scheduleMaintainAfterRecovery = () => {
        if (attackRecoveryTimer) {
            clearTimeout(attackRecoveryTimer);
        }
        attackRecoveryTimer = setTimeout(() => {
            attackRecoveryTimer = null;
            if (!getAttackStateFromXPath() && autoMaintain) {
                maintainCashOnHand();
            }
        }, CONFIG.attackRecoveryDelaySeconds * 1000);
    };

    const checkAttackState = () => {
        const currentState = getAttackStateFromXPath();
        if (currentState && !lastAttackState) {
            depositAllCashOnAttack();
            if (attackRecoveryTimer) {
                clearTimeout(attackRecoveryTimer);
                attackRecoveryTimer = null;
            }
        }
        if (!currentState && lastAttackState && autoMaintain) {
            scheduleMaintainAfterRecovery();
        }
        lastAttackState = currentState;
    };

    const formatNumber = (value) => {
        return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    };

    const randomizeAmount = (amount, variance = 0.02) => {
        if (amount <= 1) return amount;
        const delta = (Math.random() * 2 - 1) * variance;
        const randomized = Math.round(amount * (1 + delta));
        return Math.max(1, randomized);
    };

    const parseAmount = (value) => {
        if (value == null) return 0;
        if (typeof value !== 'string') {
            value = String(value);
        }
        value = value.replace(/[^\d\.kmmb%\-]/gi, '').trim().toLowerCase();
        if (!value) return 0;
        const percentMatch = value.match(/^(\d+(?:\.\d+)?)%$/);
        if (percentMatch) {
            return Math.round(Number(percentMatch[1]) / 100 * 1000000000);
        }
        const suffixMatch = value.match(/^(\-?\d+(?:\.\d+)?)(k|m|b)?$/);
        if (!suffixMatch) return 0;
        let num = Number(suffixMatch[1]);
        const suffix = suffixMatch[2];
        if (!Number.isFinite(num)) return 0;
        if (suffix === 'k') num *= 1_000;
        if (suffix === 'm') num *= 1_000_000;
        if (suffix === 'b') num *= 1_000_000_000;
        return Math.round(num);
    };

    const getVaultForm = (type) => {
        if (type === 'withdraw') {
            return document.querySelector('form.vault-cont.left');
        }
        return document.querySelector('form.vault-cont.right.deposit-box');
    };

    const getVaultValues = () => {
        const cashEl = document.getElementById('vault-dvalue');
        const vaultEl = document.getElementById('vault-wvalue');
        const cash = parseAmount(cashEl?.textContent || '0');
        const vault = parseAmount(vaultEl?.textContent || '0');
        return { cash, vault };
    };

    const updateMaintainInfo = ({ cash, vault }) => {
        const info = document.getElementById('tm-vault-maintain-info');
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
                if (autoMaintain) {
                    maintainCashOnHand();
                }
            }
        }, 200);
    };

    const depositAllCashOnAttack = () => {
        if (!CONFIG.autoAttackDepositEnabled) return;
        const now = Date.now();
        if (now - lastAttackDepositTime < ATTACK_DEPOSIT_COOLDOWN) {
            return;
        }
        lastAttackDepositTime = now;
        const { cash } = getVaultValues();
        if (cash > 0) {
            const depositAmount = randomizeAmount(cash, 0.03);
            submitVaultForm('deposit', depositAmount);
        }
    };

    const fillVaultForm = (type, amount) => {
        const form = getVaultForm(type);
        if (!form) return false;

        const textInput = form.querySelector('input.input-money[type="text"]');
        const hiddenInput = form.querySelector(`input[type="hidden"][name="${type}"]`);
        const submitBtn = form.querySelector('input[type="submit"]');
        if (!textInput || !hiddenInput || !submitBtn) return false;

        const normalized = parseAmount(amount);
        if (normalized <= 0) return false;

        textInput.value = formatNumber(normalized);
        hiddenInput.value = normalized;
        hiddenInput.dataset.money = normalized;

        submitBtn.disabled = false;
        submitBtn.classList.remove('disabled');
        submitBtn.classList.add('torn-btn');

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
        const target = parseAmount(CONFIG.targetCashOnHand);
        if (target <= 0) return;

        const { cash, vault } = getVaultValues();
        const delta = cash - target;
        const info = document.getElementById('tm-vault-maintain-info');
        if (info) {
            info.textContent = `Current cash: $${formatNumber(cash)} | Vault: $${formatNumber(vault)} | Target: $${formatNumber(target)}`;
        }

        if (delta === 0) {
            return;
        }

        if (delta > 0) {
            const depositAmount = randomizeAmount(delta, 0.02);
            submitVaultForm('deposit', depositAmount);
            return;
        }

        const baseWithdraw = Math.min(Math.abs(delta), vault);
        const withdrawAmount = Math.min(vault, randomizeAmount(baseWithdraw, 0.02));
        if (withdrawAmount <= 0) return;
        submitVaultForm('withdraw', withdrawAmount);
    };

    const buildControlPanel = () => {
        const wrap = document.querySelector('.vault-wrap');
        if (!wrap) return;

        const existing = document.getElementById(PANEL_ID);
        if (existing) {
            existing.remove();
        }

        const panel = document.createElement('div');
        panel.id = PANEL_ID;
        panel.style.background = '#1a1a1a';
        panel.style.border = '1px solid #444';
        panel.style.borderRadius = '8px';
        panel.style.color = '#eee';
        panel.style.padding = '12px';
        panel.style.margin = '10px 0';
        panel.style.fontFamily = 'Arial, sans-serif';
        panel.style.fontSize = '13px';

        panel.innerHTML = `
            <div style="display:flex; gap:10px; flex-wrap:wrap; align-items:center;">
                <strong style="flex:1 1 100%;">${CONFIG.insertionLabel}</strong>
                <label style="display:flex; align-items:center; gap:6px; white-space:nowrap;">
                    Target cash on hand:
                    <input id="tm-target-cash" type="text" value="${formatNumber(parseAmount(CONFIG.targetCashOnHand))}" style="width:110px; padding:4px 6px; border-radius:4px; border:1px solid #555; background:#111; color:#eee;">
                </label>
                <label style="display:flex; align-items:center; gap:6px; white-space:nowrap;">
                    <input id="tm-auto-maintain" type="checkbox"${CONFIG.autoMaintainEnabled ? ' checked' : ''}>
                    Auto maintain
                </label>
                <label style="display:flex; align-items:center; gap:6px; white-space:nowrap;">
                    <input id="tm-auto-attack-deposit" type="checkbox"${CONFIG.autoAttackDepositEnabled ? ' checked' : ''}>
                    Deposit on attack
                </label>
            </div>
        `;

        wrap.parentNode.insertBefore(panel, wrap);

        const targetInput = panel.querySelector('#tm-target-cash');
        const autoMaintainInput = panel.querySelector('#tm-auto-maintain');
        const autoAttackDepositInput = panel.querySelector('#tm-auto-attack-deposit');
        targetInput?.addEventListener('change', () => {
            CONFIG.targetCashOnHand = targetInput.value;
            saveSettings();
            if (autoMaintain) {
                maintainCashOnHand();
            }
        });
        autoMaintainInput?.addEventListener('change', () => {
            autoMaintain = autoMaintainInput.checked;
            CONFIG.autoMaintainEnabled = autoMaintain;
            saveSettings();
            if (autoMaintain) {
                CONFIG.targetCashOnHand = targetInput.value;
                maintainCashOnHand();
            }
        });
        autoAttackDepositInput?.addEventListener('change', () => {
            CONFIG.autoAttackDepositEnabled = autoAttackDepositInput.checked;
            saveSettings();
        });
    };

    const ensureControlPanel = () => {
        const wrap = document.querySelector('.vault-wrap');
        if (!wrap) return;
        if (!document.getElementById(PANEL_ID)) {
            buildControlPanel();
        }
    };

    const init = () => {
        ensureControlPanel();
        const observer = new MutationObserver(() => {
            ensureControlPanel();
            scheduleMaybeMaintain();
            checkAttackState();
        });
        observer.observe(document.body, { childList: true, subtree: true, characterData: true });

        const currentValues = getVaultValues();
        lastVaultState = currentValues;
        updateMaintainInfo(currentValues);
        checkAttackState();

        if (CONFIG.autoMaintainEnabled) {
            autoMaintain = true;
            maintainCashOnHand();
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

    waitForNode('.vault-wrap').then((node) => {
        if (node) init();
    });
})();
