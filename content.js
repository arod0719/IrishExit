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

  function resetPeakToCurrent() {
    state.peakParticipants = state.currentParticipants;
    state.triggerStartTime = null;
    evaluateCallState();
    return state.peakParticipants;
  }

  function updateHudPosition(container) {
    if (!container) return;

    let targetTop = 10;
    let targetRight = 120;

    // Collect all candidate elements in the top header band
    // (buttons, chips, status pills, participant badge, presenter pill, etc.)
    const candidateSelector = [
      'button',
      '[role="button"]',
      '[role="status"]',
      '[role="region"]',
      '[data-panel-id]',
      '[data-participant-id]',
      '[data-tooltip]',
      '.uGOf1d',
      'img',
      'div[aria-label]',
      'span[aria-label]'
    ].join(', ');

    const rawCandidates = document.querySelectorAll(candidateSelector);
    const validHeaderRects = [];

    for (const el of rawCandidates) {
      if (el === container || container.contains(el)) continue;
      const rect = el.getBoundingClientRect();
      // Must be within top header zone, visible, and not full-screen/backdrop
      if (
        rect.top >= 0 &&
        rect.top < 65 &&
        rect.bottom > 8 &&
        rect.bottom <= 80 &&
        rect.height >= 16 &&
        rect.height <= 64 &&
        rect.width >= 16 &&
        rect.width < window.innerWidth * 0.85 &&
        rect.right > 40
      ) {
        validHeaderRects.push(rect);
      }
    }

    // Also specifically scan for any presenter indicators in the header
    // Google Meet displays: "[Avatar] <Name> (Presenting)" or "You are presenting"
    const textNodes = document.querySelectorAll('div, span');
    for (const el of textNodes) {
      if (el === container || container.contains(el)) continue;
      if (el.children.length === 0 && el.textContent) {
        const txt = el.textContent.trim().toLowerCase();
        if (
          txt.includes('(present') ||
          txt === 'presentation' ||
          txt.includes('presenting') ||
          txt.includes('is presenting')
        ) {
          const rect = el.getBoundingClientRect();
          if (rect.top >= 0 && rect.top < 65 && rect.width > 0 && rect.height > 0) {
            // Find outer pill/chip container
            let pill = el;
            while (pill.parentElement && pill.parentElement !== document.body) {
              const pr = pill.parentElement.getBoundingClientRect();
              if (pr.height <= 64 && pr.top >= 0 && pr.top < 65 && pr.width < window.innerWidth * 0.85) {
                pill = pill.parentElement;
              } else {
                break;
              }
            }
            const pillRect = pill.getBoundingClientRect();
            if (pillRect.width >= 20 && pillRect.height >= 16) {
              validHeaderRects.push(pillRect);
            }
          }
        }
      }
    }

    // Also check for the parent flex cluster of top-right controls
    const knownTopAnchors = [
      document.querySelector('[data-panel-id="1"]'),
      document.querySelector('.uGOf1d'),
      document.querySelector('button[aria-label*="People" i]'),
      document.querySelector('button[aria-label*="everyone" i]'),
      document.querySelector('button[aria-label*="Gemini" i]')
    ].filter(Boolean);

    for (const anchor of knownTopAnchors) {
      let curr = anchor.parentElement;
      while (curr && curr !== document.body && curr !== document.documentElement) {
        const r = curr.getBoundingClientRect();
        if (
          r.top >= 0 &&
          r.top < 65 &&
          r.height >= 24 &&
          r.height <= 70 &&
          r.width > 50 &&
          r.width < window.innerWidth * 0.9 &&
          r.right > window.innerWidth - 200
        ) {
          validHeaderRects.push(r);
          for (const child of curr.children) {
            if (child === container || container.contains(child)) continue;
            const cr = child.getBoundingClientRect();
            if (cr.width > 10 && cr.height > 10 && cr.top < 65) {
              validHeaderRects.push(cr);
            }
          }
          break;
        }
        curr = curr.parentElement;
      }
    }

    if (validHeaderRects.length > 0) {
      // Sort rects from right to left (descending order of right coordinate)
      validHeaderRects.sort((a, b) => b.right - a.right);

      // Start the cluster from the rightmost element near the right window edge
      let clusterMinLeft = validHeaderRects[0].left;
      let matchingTop = validHeaderRects[0].top;
      let matchingHeight = validHeaderRects[0].height;

      for (let i = 0; i < validHeaderRects.length; i++) {
        const r = validHeaderRects[i];
        // If element is overlapping or adjacent (gap <= 48px), it's part of the top-right cluster
        const gap = clusterMinLeft - r.right;
        if (gap <= 48) {
          if (r.left < clusterMinLeft) {
            clusterMinLeft = r.left;
          }
          matchingTop = Math.min(matchingTop, r.top);
          matchingHeight = Math.max(matchingHeight, r.height);
        }
      }

      if (clusterMinLeft < window.innerWidth && clusterMinLeft > 40) {
        targetRight = window.innerWidth - clusterMinLeft + 8;
        targetTop = Math.max(6, Math.round(matchingTop + (matchingHeight - 32) / 2));
      }
    }

    // Safety guard: ensure the pill doesn't clip off the left side of the screen on narrow displays
    const hudEstimatedWidth = 145;
    const maxTargetRight = window.innerWidth - hudEstimatedWidth - 12;
    if (targetRight > maxTargetRight) {
      targetRight = Math.max(12, maxTargetRight);
    }

    container.style.top = `${targetTop}px`;
    container.style.right = `${targetRight}px`;
  }

  function createHudElements() {
    if (hudElements) {
      return hudElements;
    }

    const container = document.createElement('div');
    container.id = 'irishexit-hud';
    container.style.position = 'fixed';
    container.style.top = '10px';
    container.style.right = '120px';
    container.style.zIndex = '2147483646';
    container.style.height = '32px';
    container.style.boxSizing = 'border-box';
    container.style.padding = '0 12px 0 10px';
    container.style.borderRadius = '9999px';
    container.style.backgroundColor = 'rgba(32, 33, 36, 0.9)';
    container.style.backdropFilter = 'blur(8px)';
    container.style.webkitBackdropFilter = 'blur(8px)';
    container.style.border = '1px solid rgba(255, 255, 255, 0.16)';
    container.style.color = '#e8eaed';
    container.style.fontFamily = 'Google Sans, Roboto, -apple-system, BlinkMacSystemFont, sans-serif';
    container.style.fontSize = '12px';
    container.style.fontWeight = '500';
    container.style.lineHeight = '30px';
    container.style.cursor = 'pointer';
    container.style.userSelect = 'none';
    container.style.display = 'none';
    container.style.alignItems = 'center';
    container.style.gap = '6px';
    container.style.boxShadow = '0 2px 6px rgba(0, 0, 0, 0.35)';
    container.style.transition =
      'background-color 0.15s ease, border-color 0.15s ease, color 0.15s ease, transform 0.1s ease, right 0.25s cubic-bezier(0.2, 0, 0, 1), top 0.2s ease';

    const iconSpan = document.createElement('span');
    iconSpan.style.display = 'inline-flex';
    iconSpan.style.alignItems = 'center';
    iconSpan.style.fontSize = '13px';
    iconSpan.style.lineHeight = '1';
    iconSpan.textContent = '🍀';

    const statusDot = document.createElement('span');
    statusDot.style.width = '7px';
    statusDot.style.height = '7px';
    statusDot.style.borderRadius = '50%';
    statusDot.style.backgroundColor = '#9aa0a6';
    statusDot.style.display = 'inline-block';
    statusDot.style.flexShrink = '0';
    statusDot.style.transition = 'background-color 0.15s ease, box-shadow 0.15s ease';

    const titleText = document.createElement('span');
    titleText.style.fontWeight = '500';
    titleText.style.letterSpacing = '0.01em';
    titleText.style.whiteSpace = 'nowrap';
    titleText.textContent = 'IrishExit · Off';

    container.appendChild(iconSpan);
    container.appendChild(statusDot);
    container.appendChild(titleText);

    // Floating Tooltip Dropdown
    const tooltip = document.createElement('div');
    tooltip.id = 'irishexit-hud-tooltip';
    tooltip.style.position = 'absolute';
    tooltip.style.top = '38px';
    tooltip.style.right = '0';
    tooltip.style.minWidth = '220px';
    tooltip.style.padding = '10px 12px';
    tooltip.style.borderRadius = '12px';
    tooltip.style.backgroundColor = 'rgba(24, 26, 29, 0.96)';
    tooltip.style.backdropFilter = 'blur(12px)';
    tooltip.style.webkitBackdropFilter = 'blur(12px)';
    tooltip.style.border = '1px solid rgba(255, 255, 255, 0.16)';
    tooltip.style.boxShadow = '0 8px 24px rgba(0, 0, 0, 0.55)';
    tooltip.style.color = '#e8eaed';
    tooltip.style.fontSize = '11px';
    tooltip.style.lineHeight = '1.45';
    tooltip.style.display = 'none';
    tooltip.style.pointerEvents = 'auto';
    tooltip.style.cursor = 'default';
    tooltip.style.zIndex = '2147483647';
    tooltip.style.textAlign = 'left';

    const tooltipHeader = document.createElement('div');
    tooltipHeader.style.fontWeight = '600';
    tooltipHeader.style.marginBottom = '4px';
    tooltipHeader.style.color = '#f8fafc';
    tooltipHeader.textContent = 'IrishExit';

    const tooltipStats = document.createElement('div');
    tooltipStats.style.color = '#cbd5e1';
    tooltipStats.style.marginBottom = '8px';

    const tooltipActions = document.createElement('div');
    tooltipActions.style.display = 'flex';
    tooltipActions.style.justifyContent = 'space-between';
    tooltipActions.style.alignItems = 'center';
    tooltipActions.style.borderTop = '1px solid rgba(255, 255, 255, 0.1)';
    tooltipActions.style.paddingTop = '6px';
    tooltipActions.style.marginTop = '4px';

    const leftLinks = document.createElement('div');
    leftLinks.style.display = 'flex';
    leftLinks.style.alignItems = 'center';
    leftLinks.style.gap = '8px';

    const resetPeakBtn = document.createElement('button');
    resetPeakBtn.type = 'button';
    resetPeakBtn.style.background = 'none';
    resetPeakBtn.style.border = 'none';
    resetPeakBtn.style.color = '#38bdf8';
    resetPeakBtn.style.cursor = 'pointer';
    resetPeakBtn.style.padding = '0';
    resetPeakBtn.style.fontSize = '11px';
    resetPeakBtn.style.textDecoration = 'underline';
    resetPeakBtn.textContent = 'Reset Peak';
    resetPeakBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      resetPeakToCurrent();
      renderHud();
    });

    const guideLink = document.createElement('a');
    guideLink.href = 'https://github.com/arod0719/IrishExit/blob/main/HOW_IT_WORKS.md';
    guideLink.target = '_blank';
    guideLink.rel = 'noopener noreferrer';
    guideLink.style.color = '#94a3b8';
    guideLink.style.fontSize = '10px';
    guideLink.style.textDecoration = 'none';
    guideLink.textContent = '📖 Guide';
    guideLink.addEventListener('mouseenter', () => {
      guideLink.style.color = '#38bdf8';
    });
    guideLink.addEventListener('mouseleave', () => {
      guideLink.style.color = '#94a3b8';
    });
    guideLink.addEventListener('click', (e) => {
      e.stopPropagation();
    });

    leftLinks.appendChild(resetPeakBtn);
    leftLinks.appendChild(guideLink);

    const hintText = document.createElement('span');
    hintText.style.color = '#94a3b8';
    hintText.style.fontSize = '10px';
    hintText.textContent = 'Click pill to toggle';

    tooltipActions.appendChild(leftLinks);
    tooltipActions.appendChild(hintText);

    tooltip.appendChild(tooltipHeader);
    tooltip.appendChild(tooltipStats);
    tooltip.appendChild(tooltipActions);
    container.appendChild(tooltip);

    // Hover interactions
    let hoverTimeout = null;
    container.addEventListener('mouseenter', () => {
      clearTimeout(hoverTimeout);
      tooltip.style.display = 'block';
      if (!state.meetingEnabled) {
        container.style.backgroundColor = 'rgba(60, 64, 67, 0.95)';
        container.style.color = '#f8fafc';
      }
    });
    container.addEventListener('mouseleave', () => {
      hoverTimeout = setTimeout(() => {
        tooltip.style.display = 'none';
      }, 150);
      if (!state.meetingEnabled) {
        container.style.backgroundColor = 'rgba(32, 33, 36, 0.9)';
        container.style.color = '#9aa0a6';
      }
    });

    // 1-Click Toggle
    container.addEventListener('click', (e) => {
      if (tooltip.contains(e.target) && e.target !== tooltip) {
        return;
      }
      container.style.transform = 'scale(0.96)';
      setTimeout(() => {
        container.style.transform = 'none';
      }, 120);
      setMeetingEnabledState(!state.meetingEnabled);
    });

    window.addEventListener('resize', () => {
      if (hudElements && hudElements.container) {
        updateHudPosition(hudElements.container);
      }
    });

    document.body.appendChild(container);
    hudElements = {
      container,
      statusDot,
      titleText,
      tooltip,
      tooltipHeader,
      tooltipStats,
      resetPeakBtn
    };
    return hudElements;
  }

  function renderHud() {
    if (!document.body || (!hudElements && !isCallUrl())) {
      return;
    }
    const hud = createHudElements();
    if (!isCallUrl() || !state.inCall || !settings.showHud) {
      hud.container.style.display = 'none';
      return;
    }

    hud.container.style.display = 'inline-flex';
    updateHudPosition(hud.container);

    if (state.hasLeft) {
      hud.statusDot.style.backgroundColor = '#ea4335';
      hud.statusDot.style.boxShadow = '0 0 6px rgba(234, 67, 53, 0.7)';
      hud.container.style.backgroundColor = 'rgba(56, 18, 18, 0.95)';
      hud.container.style.borderColor = 'rgba(234, 67, 53, 0.6)';
      hud.container.style.color = '#f28b82';
      hud.titleText.textContent = 'Leaving Call...';
      hud.tooltipHeader.textContent = 'IrishExit · Disconnecting';
      hud.tooltipStats.textContent = state.lastReason;
      return;
    }

    if (!state.meetingEnabled) {
      hud.statusDot.style.backgroundColor = '#9aa0a6';
      hud.statusDot.style.boxShadow = 'none';
      hud.container.style.backgroundColor = 'rgba(32, 33, 36, 0.9)';
      hud.container.style.borderColor = 'rgba(255, 255, 255, 0.16)';
      hud.container.style.color = '#9aa0a6';
      hud.titleText.textContent = 'IrishExit · Off';
      hud.tooltipHeader.textContent = 'IrishExit · Turned Off';
      hud.tooltipStats.textContent = `Current attendees: ${state.currentParticipants}. Click this pill to activate auto-leave for this call.`;
      return;
    }

    if (!state.armed) {
      hud.statusDot.style.backgroundColor = '#fbbc04';
      hud.statusDot.style.boxShadow = '0 0 6px rgba(251, 188, 4, 0.5)';
      hud.container.style.backgroundColor = 'rgba(40, 35, 20, 0.92)';
      hud.container.style.borderColor = 'rgba(251, 188, 4, 0.45)';
      hud.container.style.color = '#fde293';
      hud.titleText.textContent = `Waiting (need ≥${settings.minPeakToArm})`;
      hud.tooltipHeader.textContent = 'IrishExit · Waiting for Room to Fill';
      hud.tooltipStats.textContent = `Peak: ${state.peakParticipants} · Current: ${state.currentParticipants}. Waiting for room to reach ≥${settings.minPeakToArm} people before activating.`;
      return;
    }

    if (state.triggerStartTime !== null) {
      hud.statusDot.style.backgroundColor = '#ea4335';
      hud.statusDot.style.boxShadow = '0 0 8px rgba(234, 67, 53, 0.8)';
      hud.container.style.backgroundColor = 'rgba(56, 18, 18, 0.95)';
      hud.container.style.borderColor = 'rgba(234, 67, 53, 0.7)';
      hud.container.style.color = '#f28b82';
      hud.titleText.textContent = 'Drop Detected — Leaving!';
      hud.tooltipHeader.textContent = 'IrishExit · Threshold Reached';
      hud.tooltipStats.textContent = `Attendance dropped to ${state.currentParticipants} (threshold was ≤${state.leaveAtOrBelow}). Disconnecting...`;
    } else {
      hud.statusDot.style.backgroundColor = '#34a853';
      hud.statusDot.style.boxShadow = '0 0 6px rgba(52, 168, 83, 0.6)';
      hud.container.style.backgroundColor = 'rgba(18, 42, 28, 0.92)';
      hud.container.style.borderColor = 'rgba(52, 168, 83, 0.45)';
      hud.container.style.color = '#a8dab5';
      hud.titleText.textContent = `Active · Leaves at ≤ ${state.leaveAtOrBelow}`;
      hud.tooltipHeader.textContent = 'IrishExit · Active & Watching';
      hud.tooltipStats.textContent = `Peak: ${state.peakParticipants} · Current: ${state.currentParticipants} · Auto-leaves when room drops to ≤ ${state.leaveAtOrBelow}.`;
    }
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
            const newPeak = resetPeakToCurrent();
            sendResponse({ ok: true, peakParticipants: newPeak });
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
