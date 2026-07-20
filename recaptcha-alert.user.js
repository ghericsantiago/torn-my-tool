// ==UserScript==
// @name         Torn Recaptcha Alert
// @namespace    http://tampermonkey.net/
// @version      1.2
// @description  Plays a looping alarm sound when Torn's recaptcha page appears
// @author       Gheric
// @match        https://www.torn.com/recaptcha.php*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  var STORAGE_KEY = "recaptchaAlertInterval";
  var DEFAULT_INTERVAL = 1400; // ms

  var audioCtx = null;
  var loopTimeout = null;
  var muted = false;
  var loopInterval = parseInt(localStorage.getItem(STORAGE_KEY), 10) || DEFAULT_INTERVAL;

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

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
