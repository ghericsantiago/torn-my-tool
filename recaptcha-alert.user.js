// ==UserScript==
// @name         Torn Recaptcha Alert
// @namespace    http://tampermonkey.net/
// @version      1.1
// @description  Plays a looping alarm sound when Torn's recaptcha page appears
// @author       Gheric
// @match        https://www.torn.com/recaptcha.php*
// @grant        none
// @run-at       document-idle
// ==/UserScript==

(function () {
  "use strict";

  var audioCtx = null;
  var loopTimeout = null;
  var muted = false;

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
    loopTimeout = setTimeout(playPattern, 1400);
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
    var btn = document.createElement("button");
    btn.id = "recaptcha-alert-btn";
    btn.textContent = "🔔 Mute Alert";
    btn.style.cssText = [
      "position:fixed",
      "bottom:24px",
      "right:24px",
      "z-index:9999999",
      "padding:10px 16px",
      "background:#c0392b",
      "color:#fff",
      "border:none",
      "border-radius:6px",
      "font-size:14px",
      "font-weight:bold",
      "cursor:pointer",
      "box-shadow:0 2px 8px rgba(0,0,0,0.5)",
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

    document.body.appendChild(btn);
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
