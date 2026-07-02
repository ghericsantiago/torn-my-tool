// ==UserScript==
// @name         Torn Auto Fly Abroad
// @namespace    http://tampermonkey.net/
// @version      1.0
// @description  Auto-fly to abroad on Torn with an injected UI (settings saved to localStorage)
// @author       GitHub Copilot
// @match        https://www.torn.com/
// @match        https://www.torn.com/index.php
// @match        https://www.torn.com/page.php?sid=travel*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function(){
    'use strict';

    const KEY = 'tmAutoFlySettings';
    const COOLDOWN_KEY = 'tmAutoFlyLast';
    const VALID_DESTINATIONS = [
        'Mexico',
        'Cayman Islands',
        'Canada',
        'Hawaii',
        'United Kingdom',
        'Argentina',
        'Switzerland',
        'Japan',
        'China',
        'United Arab Emirates',
        'South Africa'
    ];

    function loadSettings(){
        try{ return Object.assign({ enabled:false, intervalMinutes:5, skipWarnings:false }, JSON.parse(localStorage.getItem(KEY)||'{}')); }
        catch(e){ return { enabled:false, intervalMinutes:5, skipWarnings:false }; }
    }
    function saveSettings(s){ try{ localStorage.setItem(KEY, JSON.stringify(s)); } catch(e){} }

    let settings = loadSettings();
    let intervalId = null;

    function formatMs(ms){ return Math.round(ms/1000)+'s'; }

    function isHospital(){ return !!document.querySelector('li[class*="icon15"]'); }
    function isAbroadOrTraveling(){
        const b = document.body;
        return (b && (b.dataset && (b.dataset.abroad==='true' || b.dataset.traveling==='true')));
    }

    function findFlyControl(desiredCountry){
        const btn = [...document.querySelectorAll('button.torn-btn.btn-dark-bg')].find(el => el.textContent.trim() === 'Travel');
        return btn;
    }

    function findFlyContinueControl(desiredCountry){
        const btn = [...document.querySelectorAll('button.torn-btn.btn-dark-bg')].find(el => el.textContent.trim() === 'Continue');
        return btn;
    }

    function clickFlyControl(){
        const btn = findFlyControl(settings && settings.desiredCountry);
        if(!btn) return false;
        try{
            console.log('[AutoFly] clickFlyControl attempting click on', btn, (btn.textContent||'').trim(), btn.href||'');
            // Try native click first (works for buttons and anchors in most SPA setups)
            btn.click();
            return true;
        } catch(e){
            // As a fallback, dispatch mouse events
            try{
                const evs = ['mousedown','mouseup','click'].map(t => new MouseEvent(t, { bubbles:true, cancelable:true, view:window }));
                for(const ev of evs) btn.dispatchEvent(ev);
                return true;
            } catch(err){
                // Last resort: only follow anchor hrefs that look like the travel page
                try {
                    if(btn.tagName && btn.tagName.toLowerCase() === 'a' && btn.href){
                        const href = (btn.href||'').toLowerCase();
                        if(href.includes('sid=travel') || href.includes('travel') || href.includes('abroad')){
                            location.href = btn.href;
                            return true;
                        } else {
                            console.warn('[AutoFly] anchor href not travel-related, not following:', btn.href);
                        }
                    }
                } catch(nerr){}
                console.warn('[AutoFly] clickFlyControl failed', err);
                return false;
            }
        }
    }

    function clickFlyContinueControl(){
        const btn = findFlyContinueControl(settings && settings.desiredCountry);
        if(!btn) return false;
        try{
            console.log('[AutoFly] clickFlyContinueControl attempting click on', btn, (btn.textContent||'').trim());
            btn.click();
            return true;
        } catch(e){
            try{
                const evs = ['mousedown','mouseup','click'].map(t => new MouseEvent(t, { bubbles:true, cancelable:true, view:window }));
                for(const ev of evs) btn.dispatchEvent(ev);
                return true;
            } catch(err){
                console.warn('[AutoFly] clickFlyContinueControl failed', err);
                return false;
            }
        }
    }

    async function tryAutoFly(){
        // Give the page time to fully load on initial execution
        await wait(500);
        
        settings = loadSettings();
        if(!settings.enabled) return;
        if(isHospital()){ console.log('[AutoFly] Paused: in hospital'); return; }
        if(isAbroadOrTraveling()){ console.log('[AutoFly] Already abroad or traveling'); return; }
        // cooldown guard (avoid repeating clicks)
        const last = Number(sessionStorage.getItem(COOLDOWN_KEY)||0);
        if(Date.now() - last < 10_000){ console.log('[AutoFly] cooldown active', formatMs(10_000 - (Date.now()-last))); return; }

        if(!location.pathname.includes('page.php') || !location.search.includes('sid=travel')){
            console.log('[AutoFly] Navigating to travel page to attempt fly');
            location.href = '/page.php?sid=travel';
            return;
        }

        // If desired country is set, attempt to set it first
        if(settings.desiredCountry){
            const setOk = setCountryOnTravelPage(settings.desiredCountry);
            // Also click the destination radio button on travel page
            if(location.pathname.includes('page.php') && location.search.includes('sid=travel')){
                await clickTravelDestination(settings.desiredCountry);
                // give UI time to update after destination selection
                await wait(1500);
            } else if(setOk){
                // give UI a moment to update after selection
                await wait(700);
            }
        }

        // on travel page: try to click fly control or wait for it
        if(clickFlyControl()){
            sessionStorage.setItem(COOLDOWN_KEY, String(Date.now()));
            console.log('[AutoFly] Fly control clicked');
            return;
        }

        // If not clicked and user opted to skip warnings, try clicking the Continue button
        if(settings.skipWarnings && clickFlyContinueControl()){
            sessionStorage.setItem(COOLDOWN_KEY, String(Date.now()));
            console.log('[AutoFly] Continue control clicked (skip warnings)');
            return;
        }

        // If control not present yet, observe and click when it appears
        const mo = new MutationObserver((m, o) => {
            if(clickFlyControl() || (settings.skipWarnings && clickFlyContinueControl())){
                sessionStorage.setItem(COOLDOWN_KEY, String(Date.now()));
                console.log('[AutoFly] Fly/Continue control appeared and was clicked (observer)');
                o.disconnect();
            }
        });
        mo.observe(document.body, { childList:true, subtree:true });
        // stop observing after 15s
        setTimeout(()=> mo.disconnect(), 15000);
        console.log('[AutoFly] Waiting for travel controls (observer started)');
    }

    function startTimer(){
        stopTimer();
        settings = loadSettings();
        if(!settings.enabled) return;
        tryAutoFly();
        intervalId = setInterval(() => { tryAutoFly(); }, Math.max(1, settings.intervalMinutes||5) * 60 * 1000);
    }
    function stopTimer(){ if(intervalId) { clearInterval(intervalId); intervalId = null; } }

    function injectUI(){
        // only inject once
        if(document.getElementById('tm-autofly-panel')) return;

        // Try multiple selectors for different page layouts
        // Prioritize travel page container if we're on the travel page
        const target = (location.pathname.includes('page.php') && location.search.includes('sid=travel'))
            ? (document.querySelector('#travel-root .wrapper') || document.querySelector('#travel-root') || document.querySelector('.content-title') || document.querySelector('main') || document.querySelector('[role="main"]') || document.querySelector('.maincon') || document.body)
            : (document.querySelector('.content-title') || document.querySelector('main') || document.querySelector('[role="main"]') || document.querySelector('.maincon') || document.body);
        if(!target) return;

        const panel = document.createElement('div');
        panel.id = 'tm-autofly-panel';
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
                <strong style="flex:1 1 100%;">Torn Auto Fly Abroad</strong>
                <label style="display:flex; align-items:center; gap:6px; white-space:nowrap;">
                    <input id="tm-autofly-enabled" type="checkbox"> Enable auto-fly
                </label>
                <label style="display:flex; align-items:center; gap:6px; white-space:nowrap;">
                    <input id="tm-autofly-skip-warnings" type="checkbox"> Skip warnings
                </label>
                <label style="display:flex; align-items:center; gap:6px; white-space:nowrap;">
                    Interval (min):
                    <input id="tm-autofly-interval" type="number" min="1" value="${settings.intervalMinutes||5}" style="width:70px; padding:4px 6px; border-radius:4px; border:1px solid #555; background:#111; color:#eee;">
                </label>
                <label style="display:flex; align-items:center; gap:6px; white-space:nowrap;">
                    Destination:
                    <select id="tm-autofly-country-select" style="width:180px; padding:4px 6px; border-radius:4px; border:1px solid #555; background:#111; color:#eee;">
                        <option value="">Any</option>
                        ${VALID_DESTINATIONS.map(d => `<option>${d}</option>`).join('')}
                    </select>
                </label>
            </div>
        `;

        // Insert panel at the top of the target (especially important for travel page)
        if((location.pathname.includes('page.php') && location.search.includes('sid=travel')) || target.id === 'travel-root'){
            target.insertBefore(panel, target.firstChild);
        } else {
            target.appendChild(panel);
        }

        // Populate country selector from detected travel-page countries (if available)
        try{
            const sel = document.getElementById('tm-autofly-country-select');
            if(sel){
                let available = [];
                if(location.pathname.includes('page.php') && location.search.includes('sid=travel')){
                    available = getAvailableCountries();
                    if(available && available.length){
                        try{ sessionStorage.setItem('tmAvailableCountries', JSON.stringify(available)); }catch(e){}
                    }
                }
                if(!available.length){
                    try{ available = JSON.parse(sessionStorage.getItem('tmAvailableCountries')||'[]'); }catch(e){ available = []; }
                }
                if(!available.length){
                    available = VALID_DESTINATIONS.slice();
                }
                if(available && available.length){
                    // rebuild options preserving 'Any'
                    const html = ['<option value="">Any</option>'].concat(available.map(c => `<option>${c}</option>`)).join('');
                    sel.innerHTML = html;
                }
            }
        }catch(e){}

        const $ = id => document.getElementById(id);
        const enabledEl = $('tm-autofly-enabled');
        const skipWarningsEl = $('tm-autofly-skip-warnings');
        const intervalEl = $('tm-autofly-interval');
        const selEl = $('tm-autofly-country-select');
        if(enabledEl){
            enabledEl.checked = !!settings.enabled;
            if(skipWarningsEl) skipWarningsEl.checked = !!settings.skipWarnings;
            intervalEl.value = settings.intervalMinutes || 5;
            if(settings.desiredCountry){
                const foundOpt = Array.from(selEl.options).find(o => (o.text||'').toLowerCase() === (settings.desiredCountry||'').toLowerCase());
                if(foundOpt){ selEl.value = foundOpt.text; }
                else { selEl.value = ''; }
            } else {
                selEl.value = '';
            }

            // Auto-save on changes
            enabledEl.addEventListener('change', ()=>{
                settings.enabled = !!enabledEl.checked;
                saveSettings(settings);
                if(settings.enabled) startTimer(); else stopTimer();
            });
            intervalEl.addEventListener('change', ()=>{
                settings.intervalMinutes = Math.max(1, parseInt(intervalEl.value||5));
                saveSettings(settings);
                startTimer();
            });
            if(skipWarningsEl){
                skipWarningsEl.addEventListener('change', ()=>{
                    settings.skipWarnings = !!skipWarningsEl.checked;
                    saveSettings(settings);
                });
            }
            selEl.addEventListener('change', async ()=>{
                settings.desiredCountry = (selEl.value||'').trim();
                saveSettings(settings);
                // If on travel page, auto-click the destination
                if(settings.desiredCountry && location.pathname.includes('page.php') && location.search.includes('sid=travel')){
                    await clickTravelDestination(settings.desiredCountry);
                    // give UI time to update after destination selection
                    await wait(1200);

                    // If auto-fly is enabled, try to click the fly/travel control
                    const enabledNow = !!(document.getElementById('tm-autofly-enabled') && document.getElementById('tm-autofly-enabled').checked);
                    if(enabledNow){
                        if(clickFlyControl()){
                            sessionStorage.setItem(COOLDOWN_KEY, String(Date.now()));
                            console.log('[AutoFly] Fly control clicked (from selector change)');
                        } else {
                            // observe for fly control and click when it appears (fallback)
                            const obs = new MutationObserver((m, o) => {
                                if(clickFlyControl() || (settings.skipWarnings && clickFlyContinueControl())){
                                    sessionStorage.setItem(COOLDOWN_KEY, String(Date.now()));
                                    console.log('[AutoFly] Fly/Continue control appeared and was clicked (observer from selector change)');
                                    o.disconnect();
                                }
                            });
                            obs.observe(document.body, { childList:true, subtree:true });
                            setTimeout(()=> obs.disconnect(), 15000);
                        }
                    }
                }
            });
        }
    }

    // Click the destination radio button on the travel page (with retry)
    async function clickTravelDestination(countryName, retries = 3){
        if(!countryName) return false;
        const low = countryName.toLowerCase();
        
        // Find the radio button with matching country in aria-label
        const radioButtons = Array.from(document.querySelectorAll('input[type="radio"][name="destination"]'));
        for(const radio of radioButtons){
            const ariaLabel = (radio.getAttribute('aria-label')||'').toLowerCase();
            if(ariaLabel.includes(low)){
                try{
                    radio.click();
                    console.log('[AutoFly] Clicked destination radio: ' + countryName);
                    return true;
                } catch(e){
                    console.warn('[AutoFly] Failed to click destination radio', e);
                    return false;
                }
            }
        }
        
        // Radio buttons not found - retry if we have retries left
        if(retries > 0){
            console.log('[AutoFly] Radio buttons not found, retrying... (' + retries + ' retries left)');
            await wait(300);
            return clickTravelDestination(countryName, retries - 1);
        }
        
        return false;
    }

    // Attempt to set the desired country on the travel page.
    function setCountryOnTravelPage(desired){
        if(!desired) return false;
        const low = desired.toLowerCase();

        // 1) Try select elements
        const selects = Array.from(document.querySelectorAll('select'));
        for(const sel of selects){
            const opts = Array.from(sel.options || []);
            const match = opts.find(o => (o.text||'').toLowerCase().includes(low) || (o.value||'').toLowerCase().includes(low));
            if(match){
                sel.value = match.value || match.text;
                sel.dispatchEvent(new Event('change',{bubbles:true}));
                return true;
            }
        }

        // 2) Try clickable country links/buttons
        const candidates = Array.from(document.querySelectorAll('a,button'));
        for(const el of candidates){
            const txt = ((el.textContent||'') + ' ' + (el.value||'')).toLowerCase();
            if(txt.includes(low)){
                try{ el.click(); } catch(e){}
                return true;
            }
        }

        // 3) Try inputs with placeholder or label
        const inputs = Array.from(document.querySelectorAll('input'));
        for(const inp of inputs){
            const ph = (inp.placeholder||'').toLowerCase();
            if(ph.includes('country') || ph.includes('destination')){
                inp.value = desired;
                inp.dispatchEvent(new Event('input',{bubbles:true}));
                inp.dispatchEvent(new Event('change',{bubbles:true}));
                return true;
            }
        }

        return false;
    }

    // Heuristic: scan the travel page DOM for country names/options
    function getAvailableCountries(){
        try{
            // 1) Look for select elements with many options
            const selects = Array.from(document.querySelectorAll('select'));
            for(const sel of selects){
                const opts = Array.from(sel.options || []).map(o => (o.text||o.value||'').trim()).filter(Boolean);
                if(opts.length > 3) return Array.from(new Set(opts));
            }

            // 2) Look for links/buttons that look like country choices (text length reasonable)
            const candidates = Array.from(document.querySelectorAll('a,button'))
                .map(el => (el.textContent||el.value||'').trim())
                .filter(t => t && t.length>2 && t.length<40);
            if(candidates.length > 3) return Array.from(new Set(candidates)).slice(0,50);

            // 3) fallback: try to read from previously saved list
            const saved = sessionStorage.getItem('tmAvailableCountries');
            if(saved) return JSON.parse(saved);
        }catch(e){}
        return [];
    }

    function wait(ms){ return new Promise(r=>setTimeout(r, ms)); }

    // Run on load
    try{ injectUI(); } catch(e){}
    // ensure UI injection on DOM changes (in case SPA renders after load)
    const uiObserver = new MutationObserver(()=> injectUI());
    uiObserver.observe(document.body, { childList:true, subtree:true });

    // Start timer
    startTimer();

    // Expose helpers for console testing and manual extraction
    try{ window.tmAutoFly = { settingsKey: KEY, loadSettings, saveSettings, tryAutoFly, startTimer, stopTimer, getAvailableCountries }; console.log('[AutoFly] helpers available at window.tmAutoFly'); } catch(e){}

})();
