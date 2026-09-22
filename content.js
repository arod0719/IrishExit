'use strict';

(() => {
  if (window.top !== window) {
    // Never run inside embedded iframes (e.g. Gmail / Google Chat / Calendar embeds)
    return;
  }
  if (window.location.hostname !== 'meet.google.com') {
    return;
  }
  if (window.__irishExitLoaded) {
    return;
  }
  window.__irishExitLoaded = true;

  let isDestroyed = false;
  let pollIntervalId = null;
  let mutationObserver = null;
  let hudElements = null;

  function isCallUrl() {
    return /\/[a-z]{3}-[a-z]{4}-[a-z]{3}/i.test(window.location.pathname);
  }

  function isContextValid() {
    if (isDestroyed) {
      return false;
    }
    try {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.id) {
        selfDestruct();
        return false;
      }
      return true;
    } catch (_e) {
      selfDestruct();
      return false;
    }
  }

  function selfDestruct() {
    if (isDestroyed) {
      return;
    }
    isDestroyed = true;
    if (pollIntervalId) {
      clearInterval(pollIntervalId);
      pollIntervalId = null;
    }
    if (mutationObserver) {
      try {
        mutationObserver.disconnect();
      } catch (_e) {}
      mutationObserver = null;
    }
    if (hudElements && hudElements.container) {
      try {
        hudElements.container.remove();
      } catch (_e) {}
      hudElements = null;
    }
  }

  window.addEventListener('error', (event) => {
    if (event && event.message && event.message.includes('Extension context invalidated')) {
      selfDestruct();
    }
  });

  function safeSendMessage(message, callback) {
    if (!isContextValid()) {
      selfDestruct();
      return;
    }
    try {
      if (typeof callback === 'function') {
        chrome.runtime.sendMessage(message, (response) => {
          try {
            const err = chrome.runtime.lastError;
            if (err && String(err.message).includes('context invalidated')) {
              selfDestruct();
              return;
            }
            callback(response);
          } catch (e) {
            if (String(e).includes('context invalidated')) {
              selfDestruct();
            }
          }
        });
      } else {
        const p = chrome.runtime.sendMessage(message);
        if (p && typeof p.catch === 'function') {
          p.catch((err) => {
            if (String(err).includes('context invalidated')) {
              selfDestruct();
            }
          });
        }
      }
    } catch (err) {
      if (String(err).includes('context invalidated')) {
        selfDestruct();
      }
    }
  }

  const DEFAULT_SETTINGS = Object.freeze({
    autoArmNewMeetings: false,
    useDropPercent: true,
    dropPercent: 30,
    useMinFloor: true,
    minFloor: 2,
    minPeakToArm: 3,
    sustainedSeconds: 2,
    hardDisconnectFailsafe: true,
    closeTabOnLeave: false,
    showHud: true
  });

  let settings = Object.assign({}, DEFAULT_SETTINGS);
  let state = {
    inCall: false,
    meetingEnabled: false,
    currentParticipants: 0,
    peakParticipants: 0,
    armed: false,
    leaveAtOrBelow: 0,
    triggerStartTime: null,
    hasLeft: false,
    lastReason: '',
    currentMeetingCode: ''
  };

  function clampInt(value, min, max, fallback) {
    const parsed = Number.parseInt(value, 10);
    if (Number.isNaN(parsed)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, parsed));
  }

  function sanitizeSettings(raw) {
    const input = raw && typeof raw === 'object' ? raw : {};
    return {
      autoArmNewMeetings:
        typeof input.autoArmNewMeetings === 'boolean'
          ? input.autoArmNewMeetings
          : DEFAULT_SETTINGS.autoArmNewMeetings,
      useDropPercent:
        typeof input.useDropPercent === 'boolean' ? input.useDropPercent : DEFAULT_SETTINGS.useDropPercent,
      dropPercent: clampInt(input.dropPercent, 10, 90, DEFAULT_SETTINGS.dropPercent),
      useMinFloor: typeof input.useMinFloor === 'boolean' ? input.useMinFloor : DEFAULT_SETTINGS.useMinFloor,
      minFloor: clampInt(input.minFloor, 1, 50, DEFAULT_SETTINGS.minFloor),
      minPeakToArm: clampInt(input.minPeakToArm, 2, 100, DEFAULT_SETTINGS.minPeakToArm),
      sustainedSeconds: clampInt(input.sustainedSeconds, 0, 30, DEFAULT_SETTINGS.sustainedSeconds),
      hardDisconnectFailsafe:
        typeof input.hardDisconnectFailsafe === 'boolean'
          ? input.hardDisconnectFailsafe
          : DEFAULT_SETTINGS.hardDisconnectFailsafe,
      closeTabOnLeave:
        typeof input.closeTabOnLeave === 'boolean' ? input.closeTabOnLeave : DEFAULT_SETTINGS.closeTabOnLeave,
      showHud: typeof input.showHud === 'boolean' ? input.showHud : DEFAULT_SETTINGS.showHud
    };
  }

  function getMeetingCodeFromUrl() {
    const match = window.location.pathname.match(/\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i);
    return match ? match[1].toLowerCase() : window.location.pathname;
  }

  function findHangupButton() {
    const selectors = [
      'button[aria-label*="Leave call" i]',
      'button[aria-label*="End call" i]',
      'button[data-tooltip*="Leave call" i]',
      'button[jsname="CQylAd"]',
      '[role="button"][aria-label*="Leave call" i]'
    ];
    for (const sel of selectors) {
      const btn = document.querySelector(sel);
      if (btn && btn.offsetParent !== null) {
        return btn;
      }
    }

    const icons = document.querySelectorAll('i, span.google-symbols, span.material-icons-extended');
    for (const icon of icons) {
      const text = (icon.textContent || '').trim();
      if (text === 'call_end') {
        const parentBtn = icon.closest('button, [role="button"]');
        if (parentBtn) {
          return parentBtn;
        }
        return icon;
      }
    }
    return null;
  }

  function parseBadgeNumber(rawText) {
    if (typeof rawText !== 'string') {
      return null;
    }
    const cleaned = rawText.trim();
    const match = cleaned.match(/^(\d{1,4})$/);
    if (!match) {
      return null;
    }
    const num = Number.parseInt(match[1], 10);
    return num > 0 ? num : null;
  }

  function detectParticipantCount() {
    const hangupBtn = findHangupButton();
    if (!hangupBtn) {
      return null;
    }

    const badgeNodes = document.querySelectorAll('.uGOf1d');
    for (const node of badgeNodes) {
      const parsed = parseBadgeNumber(node.textContent || '');
      if (parsed !== null) {
        return parsed;
      }
    }

    const peopleButtons = document.querySelectorAll(
      'button[aria-label*="People" i], button[aria-label*="everyone" i], button[aria-label*="participant" i], [data-panel-id="1"]'
    );
    for (const btn of peopleButtons) {
      const aria = btn.getAttribute('aria-label') || '';
      const ariaMatch = aria.match(/(\d+)\s+participant/i);
      if (ariaMatch) {
        const num = Number.parseInt(ariaMatch[1], 10);
        if (num > 0) {
          return num;
        }
      }
      const container = btn.parentElement || btn;
      const textNodes = container.querySelectorAll('div, span');
      for (const child of textNodes) {
        const parsed = parseBadgeNumber(child.textContent || '');
        if (parsed !== null) {
          return parsed;
        }
      }
    }

    const participantTiles = document.querySelectorAll('[data-participant-id]');
    if (participantTiles.length > 0) {
      const uniqueIds = new Set();
      for (const tile of participantTiles) {
        const pid = tile.getAttribute('data-participant-id');
        if (pid) {
          uniqueIds.add(pid);
        }
      }
      if (uniqueIds.size > 0) {
        return uniqueIds.size;
      }
    }

    return 1;
  }

  function computeThresholdDetails(peak, cfg) {
    if (peak < cfg.minPeakToArm) {
      return {
        qualifiesToArm: false,
        leaveAtOrBelow: 0,
        reasons: []
      };
    }

    const candidates = [];
    if (cfg.useDropPercent) {
      const droppedRequired = Math.max(2, Math.round((peak * cfg.dropPercent) / 100));
      const target = Math.max(1, peak - droppedRequired);
      if (target < peak) {
        candidates.push({
          target,
          label: `Drop ≥${cfg.dropPercent}% from peak (${peak} → ≤${target})`
        });
      }
    }

    if (cfg.useMinFloor) {
      const target = Math.min(peak - 1, cfg.minFloor);
      if (target >= 1) {
        candidates.push({
          target,
          label: `Minimum room floor ≤${target} participants`
        });
      }
    }

    if (candidates.length === 0) {
      return {
        qualifiesToArm: false,
        leaveAtOrBelow: 0,
        reasons: []
      };
    }

    let highestTrigger = 0;
    for (const item of candidates) {
      if (item.target > highestTrigger) {
        highestTrigger = item.target;
      }
    }

    const matchingReasons = candidates.filter((c) => c.target === highestTrigger).map((c) => c.label);
    return {
      qualifiesToArm: true,
      leaveAtOrBelow: highestTrigger,
      reasons: matchingReasons
    };
  }

  function triggerJsActionClick(element) {
    if (!element) {
      return;
    }
    if (typeof element.focus === 'function') {
      element.focus();
    }
    const eventInit = { bubbles: true, cancelable: true, composed: true, view: window };
    element.dispatchEvent(new PointerEvent('pointerdown', eventInit));
    element.dispatchEvent(new MouseEvent('mousedown', eventInit));
    element.dispatchEvent(new PointerEvent('pointerup', eventInit));
    element.dispatchEvent(new MouseEvent('mouseup', eventInit));
    element.click();
  }

  function clickHostConfirmLeaveIfPresent() {
    const buttons = document.querySelectorAll(
      '[role="dialog"] button, [aria-modal="true"] button, button[aria-label*="Just leave" i], button'
    );
    for (const btn of buttons) {
      const text = ((btn.textContent || '') + ' ' + (btn.getAttribute('aria-label') || '')).toLowerCase();
      if (
        (text.includes('just leave the call') || text.includes('just leave')) &&
        !text.includes('everyone')
      ) {
        triggerJsActionClick(btn);
        return true;
      }
    }
    return false;
  }

  function executeLeave(reason) {
    if (state.hasLeft) {
      return;
    }
    state.hasLeft = true;
    state.lastReason = reason;
    renderHud();

    const hangupBtn = findHangupButton();
    if (hangupBtn) {
      triggerJsActionClick(hangupBtn);
    }

    let attempts = 0;
    const confirmInterval = setInterval(() => {
      attempts += 1;
      clickHostConfirmLeaveIfPresent();
      if (!isContextValid() || attempts >= 10) {
        clearInterval(confirmInterval);
      }
    }, 100);

    safeSendMessage({
      type: 'ALM_TRIGGER_FAILSAFE',
      reason,
      peak: state.peakParticipants,
      current: state.currentParticipants
    });

    if (settings.hardDisconnectFailsafe) {
      setTimeout(() => {
        if (window.location.pathname.length > 1) {
          window.location.replace('https://meet.google.com/?autoleft=1');
        }
      }, 900);
    }
  }

  function evaluateCallState() {
    if (!isContextValid()) {
      selfDestruct();
      return;
    }

    try {
      if (!isCallUrl()) {
        state.inCall = false;
        renderHud();
        return;
      }

      const meetingCode = getMeetingCodeFromUrl();
      if (meetingCode !== state.currentMeetingCode) {
        state.currentMeetingCode = meetingCode;
        state.currentParticipants = 0;
        state.peakParticipants = 0;
        state.armed = false;
        state.leaveAtOrBelow = 0;
        state.triggerStartTime = null;
        state.hasLeft = false;

        const storageKey = `alm_meet_${meetingCode}`;
        try {
          chrome.storage.local.get([storageKey], (res) => {
            if (!isContextValid()) {
              return;
            }
            try {
              if (res && typeof res[storageKey] === 'boolean') {
                state.meetingEnabled = res[storageKey];
              } else {
                state.meetingEnabled = Boolean(settings.autoArmNewMeetings);
              }
              renderHud();
            } catch (_e) {
              selfDestruct();
            }
          });
        } catch (_e) {
          selfDestruct();
          return;
        }
      }

      const count = detectParticipantCount();
      if (count === null) {
        state.inCall = false;
        state.triggerStartTime = null;
        safeSendMessage({
          type: 'ALM_UPDATE_BADGE',
          text: '',
          color: '#64748b',
          enabled: Boolean(state.meetingEnabled)
        });
        renderHud();
        return;
      }

      state.inCall = true;
      state.currentParticipants = count;
      if (count > state.peakParticipants) {
        state.peakParticipants = count;
      }

      const details = computeThresholdDetails(state.peakParticipants, settings);
      state.armed = state.meetingEnabled && details.qualifiesToArm;
      state.leaveAtOrBelow = details.leaveAtOrBelow;

      const badgeColor = !state.meetingEnabled ? '#64748b' : state.armed ? '#10b981' : '#f59e0b';
      safeSendMessage({
        type: 'ALM_UPDATE_BADGE',
        text: state.meetingEnabled ? String(count) : 'OFF',
        color: badgeColor,
        enabled: Boolean(state.meetingEnabled)
      });

      if (state.armed && !state.hasLeft && state.currentParticipants <= state.leaveAtOrBelow) {
        const now = Date.now();
        if (state.triggerStartTime === null) {
          state.triggerStartTime = now;
        }
        const elapsedSec = (now - state.triggerStartTime) / 1000;
        if (elapsedSec >= settings.sustainedSeconds) {
          const reasonStr =
            details.reasons.join(' | ') ||
            `Participants dropped from ${state.peakParticipants} to ${state.currentParticipants}`;
          executeLeave(reasonStr);
          return;
        }
      } else {
        state.triggerStartTime = null;
      }

      renderHud();
    } catch (err) {
      if (String(err).includes('context invalidated')) {
        selfDestruct();
        return;
      }
      console.warn('[IrishExit] Error during state evaluation:', err);
    }
  }

  function setMeetingEnabledState(enabled) {
    state.meetingEnabled = Boolean(enabled);
    if (state.meetingEnabled) {
      state.peakParticipants = Math.max(state.currentParticipants, 1);
      state.triggerStartTime = null;
    }
    const meetingCode = getMeetingCodeFromUrl();
    if (meetingCode && isContextValid()) {
      const storageKey = `alm_meet_${meetingCode}`;
      try {
        chrome.storage.local.set({ [storageKey]: state.meetingEnabled });
      } catch (_e) {
        selfDestruct();
      }
    }
    evaluateCallState();
  }

  function createHudElements() {
    if (hudElements) {
      return hudElements;
    }

    const container = document.createElement('div');
    container.id = 'irishexit-hud';
    container.style.position = 'fixed';
    container.style.bottom = '84px';
    container.style.left = '16px';
    container.style.zIndex = '2147483646';
    container.style.backgroundColor = 'rgba(15, 23, 42, 0.94)';
    container.style.color = '#f8fafc';
    container.style.border = '1px solid rgba(148, 163, 184, 0.3)';
    container.style.borderRadius = '12px';
    container.style.padding = '8px 12px';
    container.style.fontFamily = 'Google Sans, Roboto, -apple-system, BlinkMacSystemFont, sans-serif';
    container.style.fontSize = '12px';
    container.style.lineHeight = '1.4';
    container.style.boxShadow = '0 8px 24px rgba(0, 0, 0, 0.45)';
    container.style.backdropFilter = 'blur(8px)';
    container.style.display = 'none';
    container.style.userSelect = 'none';

    const topRow = document.createElement('div');
    topRow.style.display = 'flex';
    topRow.style.alignItems = 'center';
    topRow.style.gap = '8px';

    const statusDot = document.createElement('span');
    statusDot.style.width = '8px';
    statusDot.style.height = '8px';
    statusDot.style.borderRadius = '50%';
    statusDot.style.backgroundColor = '#64748b';
    statusDot.style.display = 'inline-block';
    statusDot.style.flexShrink = '0';

    const titleText = document.createElement('span');
    titleText.style.fontWeight = '600';
    titleText.style.letterSpacing = '0.01em';
    titleText.textContent = 'IrishExit: OFF';

    const statsText = document.createElement('span');
    statsText.style.color = '#cbd5e1';
    statsText.style.marginLeft = '2px';

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.style.marginLeft = '6px';
    toggleBtn.style.padding = '3px 10px';
    toggleBtn.style.borderRadius = '6px';
    toggleBtn.style.border = '1px solid rgba(16, 185, 129, 0.5)';
    toggleBtn.style.backgroundColor = 'rgba(16, 185, 129, 0.2)';
    toggleBtn.style.color = '#34d399';
    toggleBtn.style.fontSize = '11px';
    toggleBtn.style.fontWeight = '600';
    toggleBtn.style.cursor = 'pointer';
    toggleBtn.textContent = 'Turn ON for This Meet';
    toggleBtn.addEventListener('click', () => {
      setMeetingEnabledState(!state.meetingEnabled);
    });

    topRow.appendChild(statusDot);
    topRow.appendChild(titleText);
    topRow.appendChild(statsText);
    topRow.appendChild(toggleBtn);
    container.appendChild(topRow);

    document.body.appendChild(container);
    hudElements = { container, statusDot, titleText, statsText, toggleBtn };
    return hudElements;
  }

  function renderHud() {
    if (!document.body || !hudElements && !isCallUrl()) {
      return;
    }
    const hud = createHudElements();
    if (!isCallUrl() || !state.inCall || !settings.showHud) {
      hud.container.style.display = 'none';
      return;
    }

    hud.container.style.display = 'block';
    if (state.hasLeft) {
      hud.statusDot.style.backgroundColor = '#ef4444';
      hud.titleText.textContent = 'Leaving Call Now...';
      hud.statsText.textContent = state.lastReason;
      hud.toggleBtn.style.display = 'none';
      return;
    }

    hud.toggleBtn.style.display = 'inline-block';
    if (!state.meetingEnabled) {
      hud.statusDot.style.backgroundColor = '#64748b';
      hud.titleText.textContent = 'IrishExit: OFF';
      hud.statsText.textContent = `Now: ${state.currentParticipants}`;
      hud.toggleBtn.textContent = 'Turn ON for This Meet';
      hud.toggleBtn.style.backgroundColor = 'rgba(16, 185, 129, 0.2)';
      hud.toggleBtn.style.borderColor = 'rgba(16, 185, 129, 0.5)';
      hud.toggleBtn.style.color = '#34d399';
      return;
    }

    hud.toggleBtn.textContent = 'Turn OFF';
    hud.toggleBtn.style.backgroundColor = 'rgba(255, 255, 255, 0.1)';
    hud.toggleBtn.style.borderColor = 'rgba(255, 255, 255, 0.2)';
    hud.toggleBtn.style.color = '#f8fafc';

    if (!state.armed) {
      hud.statusDot.style.backgroundColor = '#f59e0b';
      hud.titleText.textContent = `ON (Waiting for ≥${settings.minPeakToArm})`;
      hud.statsText.textContent = `Peak: ${state.peakParticipants} · Now: ${state.currentParticipants}`;
      return;
    }

    if (state.triggerStartTime !== null) {
      hud.statusDot.style.backgroundColor = '#ef4444';
      hud.titleText.textContent = 'Drop Detected — Leaving!';
    } else {
      hud.statusDot.style.backgroundColor = '#10b981';
      hud.titleText.textContent = 'IrishExit: ON';
    }
    hud.statsText.textContent = `Peak: ${state.peakParticipants} · Now: ${state.currentParticipants} · Leaves ≤${state.leaveAtOrBelow}`;
  }

  function renderAutoLeftBannerIfApplicable() {
    if (!window.location.search.includes('autoleft=1') || !document.body) {
      return;
    }
    if (document.getElementById('irishexit-autoleft-summary')) {
      return;
    }

    try {
      chrome.storage.local.get(['almLastLeaveEvent'], (res) => {
        if (!isContextValid()) {
          return;
        }
        const evt = res && res.almLastLeaveEvent;
        const banner = document.createElement('div');
        banner.id = 'irishexit-autoleft-summary';
        banner.style.position = 'fixed';
        banner.style.top = '18px';
        banner.style.left = '50%';
        banner.style.transform = 'translateX(-50%)';
        banner.style.zIndex = '2147483647';
        banner.style.backgroundColor = '#065f46';
        banner.style.color = '#ecfdf5';
        banner.style.border = '1px solid #10b981';
        banner.style.borderRadius = '12px';
        banner.style.padding = '12px 18px';
        banner.style.fontFamily = 'Google Sans, Roboto, sans-serif';
        banner.style.fontSize = '14px';
        banner.style.boxShadow = '0 10px 28px rgba(0,0,0,0.35)';
        banner.style.display = 'flex';
        banner.style.alignItems = 'center';
        banner.style.gap = '12px';

        const msg = document.createElement('span');
        if (evt && evt.timestamp) {
          const timeStr = new Date(evt.timestamp).toLocaleTimeString();
          msg.textContent = `IrishExit safely disconnected your call at ${timeStr} (Peak: ${evt.peak} → Left at: ${evt.current} · ${evt.reason})`;
        } else {
          msg.textContent = 'IrishExit safely disconnected your call when participants dropped.';
        }

        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.textContent = 'Dismiss';
        closeBtn.style.backgroundColor = 'rgba(255,255,255,0.15)';
        closeBtn.style.color = '#ffffff';
        closeBtn.style.border = 'none';
        closeBtn.style.borderRadius = '6px';
        closeBtn.style.padding = '4px 10px';
        closeBtn.style.cursor = 'pointer';
        closeBtn.addEventListener('click', () => {
          banner.remove();
        });

        banner.appendChild(msg);
        banner.appendChild(closeBtn);
        document.body.appendChild(banner);
      });
    } catch (_e) {
      selfDestruct();
    }
  }

  function startObservers() {
    if (!isCallUrl()) {
      return;
    }
    if (mutationObserver) {
      mutationObserver.disconnect();
    }
    let scheduled = false;
    mutationObserver = new MutationObserver(() => {
      if (scheduled || !isContextValid()) {
        return;
      }
      scheduled = true;
      setTimeout(() => {
        scheduled = false;
        evaluateCallState();
      }, 150);
    });

    if (document.body) {
      mutationObserver.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true
      });
    }

    pollIntervalId = setInterval(evaluateCallState, 1000);
  }

  if (isContextValid()) {
    try {
      chrome.storage.local.get(['almSettings'], (res) => {
        if (!isContextValid()) {
          return;
        }
        settings = sanitizeSettings(res && res.almSettings);
        renderAutoLeftBannerIfApplicable();
        if (isCallUrl()) {
          evaluateCallState();
          startObservers();
        } else {
          const checkNav = () => {
            if (isCallUrl() && !pollIntervalId) {
              evaluateCallState();
              startObservers();
            }
          };
          window.addEventListener('popstate', checkNav);
        }
      });

      chrome.storage.onChanged.addListener((changes, areaName) => {
        if (!isContextValid()) {
          selfDestruct();
          return;
        }
        try {
          if (areaName === 'local') {
            if (changes.almSettings) {
              settings = sanitizeSettings(changes.almSettings.newValue);
              evaluateCallState();
            }
            const meetingCode = getMeetingCodeFromUrl();
            if (meetingCode) {
              const key = `alm_meet_${meetingCode}`;
              if (changes[key] && typeof changes[key].newValue === 'boolean') {
                state.meetingEnabled = changes[key].newValue;
                evaluateCallState();
              }
            }
          }
        } catch (_e) {
          selfDestruct();
        }
      });

      chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
        if (!isContextValid()) {
          selfDestruct();
          return false;
        }

        try {
          if (!message || typeof message !== 'object') {
            sendResponse({ ok: false });
            return false;
          }

          if (message.type === 'ALM_PING') {
            evaluateCallState();
            sendResponse({
              ok: true,
              inCall: state.inCall,
              meetingEnabled: state.meetingEnabled,
              currentParticipants: state.currentParticipants
            });
            return false;
          }

          if (message.type === 'ALM_HEARTBEAT') {
            evaluateCallState();
            sendResponse({ ok: true });
            return false;
          }

          if (message.type === 'ALM_GET_STATUS') {
            evaluateCallState();
            sendResponse({
              ok: true,
              state: {
                inCall: state.inCall,
                meetingEnabled: state.meetingEnabled,
                currentParticipants: state.currentParticipants,
                peakParticipants: state.peakParticipants,
                armed: state.armed,
                leaveAtOrBelow: state.leaveAtOrBelow,
                hasLeft: state.hasLeft
              }
            });
            return false;
          }

          if (message.type === 'ALM_SET_MEETING_ENABLED') {
            setMeetingEnabledState(Boolean(message.enabled));
            sendResponse({ ok: true, meetingEnabled: state.meetingEnabled });
            return false;
          }

          if (message.type === 'ALM_RESET_PEAK') {
            state.peakParticipants = state.currentParticipants;
            state.triggerStartTime = null;
            evaluateCallState();
            sendResponse({ ok: true, peakParticipants: state.peakParticipants });
            return false;
          }

          if (message.type === 'ALM_TEST_LEAVE') {
            executeLeave('Manual test leave triggered from popup');
            sendResponse({ ok: true });
            return false;
          }

          sendResponse({ ok: false });
          return false;
        } catch (err) {
          if (String(err).includes('context invalidated')) {
            selfDestruct();
          }
          return false;
        }
      });
    } catch (_e) {
      selfDestruct();
    }
  }
})();
