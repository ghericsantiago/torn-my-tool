// ==UserScript==
// @name         Torn Recaptcha Alert
// @namespace    http://tampermonkey.net/
// @version      1.3
// @description  Plays a looping alarm sound and sends a phone push notification when Torn's recaptcha page appears
// @author       Gheric
// @match        https://www.torn.com/recaptcha.php*
// @match        https://www.torn.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @connect      ntfy.sh
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  var STORAGE_KEY = "recaptchaAlertInterval";
  var NTFY_GM_KEY = "recaptchaAlertNtfyTopic";
  var DEFAULT_INTERVAL = 1400; // ms

  var audioCtx = null;
  var loopTimeout = null;
  var muted = false;
  var loopInterval = parseInt(localStorage.getItem(STORAGE_KEY), 10) || DEFAULT_INTERVAL;
  var notificationSent = false;

  function getCtx() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    return audioCtx;
  }

  function beep(freq, duration, startTime) {
    var ac = getCtx();
    var osc = ac.createOscillator();
    var gain = ac.createGain();
    osc.connect(gain);
    gain.connect(ac.destination);
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.4, startTime);
    gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
    osc.start(startTime);
    osc.stop(startTime + duration);
  }

  function playPattern() {
    if (muted) return;
    var t = getCtx().currentTime;
    beep(880, 0.12, t);
    beep(880, 0.12, t + 0.18);
    beep(1100, 0.20, t + 0.40);
    loopTimeout = setTimeout(playPattern, loopInterval);
  }

  function stopPattern() {
    clearTimeout(loopTimeout);
    loopTimeout = null;
  }

  function tryStart() {
    if (muted || loopTimeout) return;
    var ac = getCtx();
    if (ac.state === "running") {
      playPattern();
    } else {
      ac.resume().then(function () {
        if (!muted && !loopTimeout) playPattern();
      });
    }
  }

  // ---- Push notification via ntfy.sh ----
  function gmFetch(url, options) {
    options = options || {};
    return new Promise(function (resolve, reject) {
      GM_xmlhttpRequest({
        method: options.method || "GET",
        url: url,
        headers: options.headers || {},
        data: options.body,
        timeout: 15000,
        onload: function (r) {
          resolve({ ok: r.status >= 200 && r.status < 300, status: r.status, text: r.responseText });
        },
        onerror: function () { reject(new Error("GM request failed")); },
        ontimeout: function () { reject(new Error("GM request timed out")); },
      });
    });
  }

  function sendPushNotification() {
    var topic = GM_getValue(NTFY_GM_KEY, "");
    if (!topic || notificationSent) return;
    notificationSent = true;
    gmFetch("https://ntfy.sh/" + encodeURIComponent(topic), {
      method: "POST",
      headers: {
        "Title": "Torn reCAPTCHA",
        "Priority": "urgent",
        "Tags": "rotating_light",
      },
      body: "A reCAPTCHA appeared on your Torn session. Solve it now.",
    }).then(function (r) {
      if (!r.ok) {
        console.warn("[RecaptchaAlert] ntfy push failed:", r.status);
        notificationSent = false; // allow one retry on transient error
      } else {
        console.log("[RecaptchaAlert] Push notification sent");
      }
    }).catch(function (e) {
      console.warn("[RecaptchaAlert] Push notification error:", e);
      notificationSent = false;
    });
  }

  function buildButton() {
    var wrap = document.createElement("div");
    wrap.style.cssText = [
      "position:fixed",
      "bottom:24px",
      "right:24px",
      "z-index:9999999",
      "display:flex",
      "flex-direction:column",
      "align-items:flex-end",
      "gap:6px",
    ].join(";");

    // ntfy topic row
    var ntfyRow = document.createElement("div");
    ntfyRow.style.cssText = [
      "display:flex",
      "align-items:center",
      "gap:6px",
      "background:rgba(0,0,0,0.7)",
      "padding:6px 10px",
      "border-radius:6px",
      "box-shadow:0 2px 8px rgba(0,0,0,0.5)",
    ].join(";");

    var ntfyLabel = document.createElement("label");
    ntfyLabel.textContent = "ntfy topic:";
    ntfyLabel.style.cssText = "color:#fff;font-size:12px;white-space:nowrap;";

    var ntfyInput = document.createElement("input");
    ntfyInput.type = "text";
    ntfyInput.placeholder = "e.g. torn-alert-abc123";
    ntfyInput.value = GM_getValue(NTFY_GM_KEY, "");
    ntfyInput.style.cssText = [
      "flex:1",
      "min-width:120px",
      "padding:3px 5px",
      "border:none",
      "border-radius:4px",
      "font-size:12px",
    ].join(";");

    ntfyInput.addEventListener("change", function () {
      GM_setValue(NTFY_GM_KEY, ntfyInput.value.trim());
    });

    ntfyRow.appendChild(ntfyLabel);
    ntfyRow.appendChild(ntfyInput);

    // Interval row
    var row = document.createElement("div");
    row.style.cssText = [
      "display:flex",
      "align-items:center",
      "gap:6px",
      "background:rgba(0,0,0,0.7)",
      "padding:6px 10px",
      "border-radius:6px",
      "box-shadow:0 2px 8px rgba(0,0,0,0.5)",
    ].join(";");

    var label = document.createElement("label");
    label.textContent = "Repeat every";
    label.style.cssText = "color:#fff;font-size:12px;white-space:nowrap;";

    var input = document.createElement("input");
    input.type = "number";
    input.min = "1";
    input.max = "60";
    input.step = "0.5";
    input.value = (loopInterval / 1000).toFixed(1);
    input.style.cssText = [
      "width:52px",
      "padding:3px 5px",
      "border:none",
      "border-radius:4px",
      "font-size:13px",
      "text-align:center",
    ].join(";");

    var unit = document.createElement("span");
    unit.textContent = "s";
    unit.style.cssText = "color:#fff;font-size:12px;";

    input.addEventListener("change", function () {
      var secs = parseFloat(input.value);
      if (isNaN(secs) || secs < 0.5) { secs = 0.5; input.value = "0.5"; }
      if (secs > 60) { secs = 60; input.value = "60.0"; }
      loopInterval = Math.round(secs * 1000);
      localStorage.setItem(STORAGE_KEY, loopInterval);
      // Restart loop with new interval if currently playing
      if (loopTimeout) {
        stopPattern();
        playPattern();
      }
    });

    row.appendChild(label);
    row.appendChild(input);
    row.appendChild(unit);

    // Mute button
    var btn = document.createElement("button");
    btn.id = "recaptcha-alert-btn";
    btn.textContent = "🔔 Mute Alert";
    btn.style.cssText = [
      "padding:10px 16px",
      "background:#c0392b",
      "color:#fff",
      "border:none",
      "border-radius:6px",
      "font-size:14px",
      "font-weight:bold",
      "cursor:pointer",
      "box-shadow:0 2px 8px rgba(0,0,0,0.5)",
      "width:100%",
    ].join(";");

    btn.addEventListener("click", function () {
      muted = !muted;
      if (muted) {
        stopPattern();
        btn.textContent = "🔕 Unmute Alert";
        btn.style.background = "#555";
      } else {
        btn.textContent = "🔔 Mute Alert";
        btn.style.background = "#c0392b";
        tryStart();
      }
    });

    wrap.appendChild(ntfyRow);
    wrap.appendChild(row);
    wrap.appendChild(btn);
    document.body.appendChild(wrap);
  }

  function unlockAudioContext() {
    // Play a completely silent 1-sample buffer — this satisfies the browser's
    // "audio context must be started from a user gesture" requirement in some
    // configurations and userscript environments.
    var ac = getCtx();
    var buf = ac.createBuffer(1, 1, 22050);
    var src = ac.createBufferSource();
    src.buffer = buf;
    src.connect(ac.destination);
    src.start(0);
    ac.resume();
  }

  function init() {
    buildButton();
    sendPushNotification(); // fires once per page load; URL match = captcha detected

    // Watch for AudioContext becoming unblocked (e.g. browser auto-allows it)
    getCtx().addEventListener("statechange", function () {
      if (getCtx().state === "running") tryStart();
    });

    // Attempt silent-buffer unlock immediately on load
    unlockAudioContext();

    // Try immediately — works if browser already unlocked audio for this origin
    tryStart();

    // Fallback: unlock on the very first user interaction of any kind.
    // This catches clicking the reCAPTCHA checkbox, keyboard input, touch, etc.
    var events = ["click", "keydown", "touchstart", "mousedown"];
    function onFirstInteraction() {
      events.forEach(function (e) {
        document.removeEventListener(e, onFirstInteraction, true);
      });
      tryStart();
    }
    events.forEach(function (e) {
      document.addEventListener(e, onFirstInteraction, { capture: true, once: false });
    });
  }

  if (/\/recaptcha\.php/i.test(location.pathname)) {
    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", init);
    } else {
      init();
    }
  }

  GM_registerMenuCommand("Set ntfy Topic", function () {
    var current = GM_getValue(NTFY_GM_KEY, "");
    var topic = prompt("Enter your ntfy.sh topic:", current);
    if (topic === null) return;
    GM_setValue(NTFY_GM_KEY, topic.trim());
  });
})();
