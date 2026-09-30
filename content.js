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
    dropPercent: 40,
    useMinFloor: true,
    minFloor: 2,
    minPeakToArm: 3,
    sustainedSeconds: 3,
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
    activePresentations: 0,
    armed: false,
    floorTriggered: false,
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

  function extractCountFromAria(aria) {
    if (typeof aria !== 'string') {
      return null;
    }
    const cleaned = aria.replace(/[\u200B-\u200D\uFEFF\u00A0]/g, ' ').trim();
    if (!cleaned) {
      return null;
    }

    // Pattern 1: Explicit joined / participant / people keywords
    // e.g. "People - 25 joined", "25 joined", "25 participants", "25 people", "25 in call"
    const joinedMatch = cleaned.match(/(\d{1,4})\s*(?:joined|participants?|people|in\s+call|members?|attendees?)/i);
    if (joinedMatch) {
      const n = Number.parseInt(joinedMatch[1], 10);
      if (n > 0) return n;
    }

    // Pattern 2: Parenthesized count e.g. "Show everyone (25)", "People (25)"
    const parenMatch = cleaned.match(/\((\d{1,4})\)/);
    if (parenMatch) {
      const n = Number.parseInt(parenMatch[1], 10);
      if (n > 0) return n;
    }

    // Pattern 3: Prefix format e.g. "People - 25", "Participants: 25", "Everyone: 25"
    const prefixMatch = cleaned.match(/(?:people|participants?|everyone|contributors?|attendees?)\s*[-:]?\s*(\d{1,4})/i);
    if (prefixMatch) {
      const n = Number.parseInt(prefixMatch[1], 10);
      if (n > 0) return n;
    }

    return null;
  }

  function extractCountFromText(rawText) {
    if (typeof rawText !== 'string') {
      return null;
    }
    const cleaned = rawText.replace(/[\u200B-\u200D\uFEFF\u00A0]/g, ' ').trim();
    if (!cleaned) {
      return null;
    }
    const match = cleaned.match(/^(\d{1,4})$/);
    if (match) {
      const n = Number.parseInt(match[1], 10);
      return n > 0 ? n : null;
    }
    return null;
  }

  function detectOverflowCount() {
    // Look for layout overflow bubble: e.g. "+15" or "and 15 other people in the call"
    const candidates = document.querySelectorAll(
      '[jslog*="OverflowBubble" i], button[aria-label*="other people in the call" i], button[aria-label*="other person in the call" i], button[aria-label*="more in this call" i]'
    );
    for (const el of candidates) {
      const aria = el.getAttribute('aria-label') || '';
      const matchAria = aria.match(/and\s+(\d{1,4})\s+other\s+(?:people|person)/i) || aria.match(/(\d{1,4})\s+more/i);
      if (matchAria) {
        const n = Number.parseInt(matchAria[1], 10);
        if (n > 0) return n;
      }
      const text = (el.textContent || '').trim();
      const matchText = text.match(/^\+\s*(\d{1,4})$/);
      if (matchText) {
        const n = Number.parseInt(matchText[1], 10);
        if (n > 0) return n;
      }
    }

    // Also check near-leaf elements whose text content is literally "+<N>"
    const plusBadges = document.querySelectorAll('button, span, div');
    for (const el of plusBadges) {
      if (el.children.length > 2) continue;
      const txt = (el.textContent || '').trim();
      const m = txt.match(/^\+\s*(\d{1,4})$/);
      if (m) {
        const n = Number.parseInt(m[1], 10);
        if (n > 0) return n;
      }
    }
    return 0;
  }

  function isTilePresentation(tile) {
    if (!tile) return false;

    // 1. Check if participant ID explicitly includes presentation
    const pid = (tile.getAttribute('data-participant-id') || '').toLowerCase();
    const reqPid = (tile.getAttribute('data-requested-participant-id') || '').toLowerCase();
    if (pid.includes('presentation') || reqPid.includes('presentation')) {
      return true;
    }

    // 2. Tile pin/unpin button: Google Meet uses "Pin <Name>'s presentation to your main screen" or "Pin your presentation..."
    const pinBtn = tile.querySelector(
      'button[aria-label*="presentation to your main screen" i], button[aria-label*="presentation from your main screen" i]'
    );
    if (pinBtn) {
      return true;
    }

    // 3. Tile presentation hover controls (present only on screen share tiles)
    const presControls = tile.querySelector(
      'button[aria-label*="Full screen" i], button[aria-label*="Fullscreen" i], button[aria-label*="zoom" i], button[aria-label*="pop out" i], button[aria-label*="Stop presenting" i], button[aria-label*="Stop sharing" i], button[aria-label*="minimize" i], button[aria-label*="expand" i]'
    );
    if (presControls) {
      return true;
    }

    // 4. Tile attribution text: contains "(Presentation)" or "(Your Presentation)" or "(You, presenting)"
    const text = tile.textContent || '';
    if (/\((?:Your\s+)?Presentation\)/i.test(text) || /\b(?:You,\s+presenting|is\s+presenting)\b/i.test(text)) {
      return true;
    }

    // 5. Data attributes or ARIA
    const aria = (tile.getAttribute('aria-label') || '').toLowerCase();
    if (aria.includes('presentation') || aria.includes('screen share')) {
      return true;
    }

    if (tile.matches('[data-is-presentation="true"], [data-presentation-id]')) {
      return true;
    }

    return false;
  }

  function countActivePresentations() {
    const presentationKeys = new Set();

    // 1. Scan participant tiles for presentations
    const allTiles = document.querySelectorAll('[data-participant-id]');
    for (const tile of allTiles) {
      if (isTilePresentation(tile)) {
        const pid = tile.getAttribute('data-participant-id') || `pres-tile-${presentationKeys.size + 1}`;
        presentationKeys.add(pid);
      }
    }

    // 2. Scan open People Panel for presentation items
    const peopleListItems = document.querySelectorAll(
      '[role="region"][aria-label*="People" i] [role="listitem"], [role="region"][aria-label*="Participants" i] [role="listitem"], [role="listitem"][data-participant-id]'
    );
    let peoplePresCount = 0;
    for (const item of peopleListItems) {
      const text = item.textContent || '';
      const aria = item.getAttribute('aria-label') || '';
      if (/\b(?:Your\s+)?presentation\b/i.test(text) || /\b(?:Your\s+)?presentation\b/i.test(aria)) {
        const id = item.getAttribute('data-participant-id') || `people-pres-${peoplePresCount++}`;
        presentationKeys.add(id);
      }
    }

    // 3. Local presentation (current user presenting screen)
    const localStopBtn = document.querySelector(
      'button[aria-label*="Stop presenting" i], button[aria-label*="Stop sharing" i], button[aria-label*="Stop screen sharing" i], button[aria-label*="Cancel presentation" i]'
    );
    const localBanner = document.querySelector(
      '[aria-label*="You are presenting" i], [aria-label*="You\'re presenting" i], [aria-label*="Your screen is still visible" i]'
    );
    const isLocalPresenting = Boolean(
      (localStopBtn && localStopBtn.offsetParent !== null) ||
      (localBanner && localBanner.offsetParent !== null)
    );

    if (isLocalPresenting && presentationKeys.size === 0) {
      presentationKeys.add('local-screen-share');
    }

    // 4. Remote presentation indicator in Peninsula / Top Bar when tiles are not yet mounted or are hidden
    if (presentationKeys.size === 0) {
      const remotePresenterBadges = document.querySelectorAll(
        '[data-tooltip*="present" i], [aria-label*="presenting" i], [aria-label*="is presenting" i]'
      );
      for (const badge of remotePresenterBadges) {
        // Exclude bottom-bar "Present now" / "Share screen" button
        if (
          badge.closest('button[aria-label*="Present now" i], button[aria-label*="Share screen" i]') ||
          badge.matches('button[aria-label*="Present now" i], button[aria-label*="Share screen" i]')
        ) {
          continue;
        }
        const text = (
          (badge.textContent || '') +
          ' ' +
          (badge.getAttribute('aria-label') || '') +
          ' ' +
          (badge.getAttribute('data-tooltip') || '')
        ).toLowerCase();
        if (
          (text.includes('presenting') || text.includes('presentation') || text.includes('is presenting')) &&
          !text.includes('present now') &&
          !text.includes('share screen') &&
          !text.includes('start presenting')
        ) {
          presentationKeys.add('remote-peninsula-presentation');
          break;
        }
      }
    }

    return presentationKeys.size;
  }

  function isPresentationActive() {
    return countActivePresentations() > 0;
  }

  function adjustForActivePresentations(rawCount) {
    if (typeof rawCount !== 'number' || Number.isNaN(rawCount) || rawCount <= 0) {
      return rawCount;
    }
    const presCount = countActivePresentations();
    if (presCount <= 0) {
      return rawCount;
    }
    // Google Meet adds a participant record for every active presentation.
    // Subtract active presentations so we only count actual human attendees.
    return Math.max(1, rawCount - presCount);
  }

  function countUniqueParticipantTiles() {
    const tiles = document.querySelectorAll('[data-participant-id]');
    if (tiles.length === 0) {
      return { humanCount: 0, presCount: 0, totalCount: 0 };
    }
    const humanIds = new Set();
    const presentationIds = new Set();
    for (const tile of tiles) {
      const pid = tile.getAttribute('data-participant-id');
      if (!pid || pid === 'undefined' || pid === 'null') {
        continue;
      }
      if (isTilePresentation(tile)) {
        presentationIds.add(pid);
      } else {
        humanIds.add(pid);
      }
    }
    return {
      humanCount: humanIds.size,
      presCount: presentationIds.size,
      totalCount: humanIds.size + presentationIds.size
    };
  }

  function detectParticipantCount() {
    // 1. Canonical People panel button (SidePanelId.PEOPLE = 1) in bottom bar or peninsula
    const canonicalPeopleBtns = document.querySelectorAll(
      'button[data-panel-id="1"], [role="button"][data-panel-id="1"], [data-panel-id="1"]'
    );
    for (const el of canonicalPeopleBtns) {
      const btn = el.closest('button, [role="button"]') || el;
      const aria = (btn.getAttribute('aria-label') || '') + ' ' + (btn.getAttribute('data-tooltip') || '');
      const fromAria = extractCountFromAria(aria);
      if (fromAria !== null) {
        return adjustForActivePresentations(fromAria);
      }
      const anyDigit = aria.match(/\b(\d{1,4})\b/);
      if (anyDigit) {
        const n = Number.parseInt(anyDigit[1], 10);
        if (n > 0) return adjustForActivePresentations(n);
      }
      const textNodes = btn.querySelectorAll('div, span');
      for (const child of textNodes) {
        const n = extractCountFromText(child.textContent || '');
        if (n !== null) {
          return adjustForActivePresentations(n);
        }
      }
    }

    // 2. Peninsula / Header People badge (top-right pill in Meet)
    const peninsulaTargets = document.querySelectorAll(
      '[aria-labelledby*="peopleBadge" i], [data-badge-id], [jscontroller*="peopleBadge" i], [jslog*="PeopleBadgeButton" i]'
    );
    for (const target of peninsulaTargets) {
      const container = target.closest('button, [role="button"]') || target.parentElement || target;
      const aria = (container.getAttribute('aria-label') || '') + ' ' + (container.getAttribute('data-tooltip') || '');
      const fromAria = extractCountFromAria(aria);
      if (fromAria !== null) {
        return adjustForActivePresentations(fromAria);
      }
      const anyDigit = aria.match(/\b(\d{1,4})\b/);
      if (anyDigit) {
        const n = Number.parseInt(anyDigit[1], 10);
        if (n > 0) return adjustForActivePresentations(n);
      }
      const textNodes = container.querySelectorAll('div, span');
      for (const child of textNodes) {
        const n = extractCountFromText(child.textContent || '');
        if (n !== null) {
          return adjustForActivePresentations(n);
        }
      }
    }

    // Direct scan of Peninsula region buttons (e.g. top-right pill with avatars + participant count)
    const peninsulaRegion = document.querySelector(
      '[role="region"][aria-label*="Call feature" i], [role="region"][aria-label*="Header" i], [role="region"][aria-label*="Top bar" i]'
    );
    if (peninsulaRegion) {
      const penBtns = peninsulaRegion.querySelectorAll('button, [role="button"]');
      for (const btn of penBtns) {
        // Exclude presentation toggle, microphone, camera, and settings buttons
        const btnAria = (btn.getAttribute('aria-label') || '') + ' ' + (btn.getAttribute('data-tooltip') || '');
        if (
          btnAria.includes('present') ||
          btnAria.includes('microphone') ||
          btnAria.includes('camera') ||
          btnAria.includes('settings')
        ) {
          continue;
        }
        const fromAria = extractCountFromAria(btnAria);
        if (fromAria !== null) {
          return adjustForActivePresentations(fromAria);
        }
        const textNodes = btn.querySelectorAll('div, span');
        for (const child of textNodes) {
          const n = extractCountFromText(child.textContent || '');
          if (n !== null) {
            return adjustForActivePresentations(n);
          }
        }
      }
    }

    // 3. General people/participant buttons by aria-label or tooltip
    const peopleButtons = document.querySelectorAll(
      'button[aria-label*="People" i], button[aria-label*="everyone" i], button[aria-label*="participant" i], button[aria-label*="joined" i], [role="button"][aria-label*="People" i], [role="button"][aria-label*="everyone" i], [role="button"][aria-label*="participant" i], [data-tooltip*="everyone" i], [data-tooltip*="People" i], [data-tooltip*="participant" i]'
    );
    for (const el of peopleButtons) {
      const btn = el.closest('button, [role="button"]') || el;
      const aria = (btn.getAttribute('aria-label') || '') + ' ' + (btn.getAttribute('data-tooltip') || '');
      const fromAria = extractCountFromAria(aria);
      if (fromAria !== null) {
        return adjustForActivePresentations(fromAria);
      }
      const anyDigit = aria.match(/\b(\d{1,4})\b/);
      if (anyDigit) {
        const n = Number.parseInt(anyDigit[1], 10);
        if (n > 0) return adjustForActivePresentations(n);
      }
      const textNodes = btn.querySelectorAll('div, span');
      for (const child of textNodes) {
        const n = extractCountFromText(child.textContent || '');
        if (n !== null) {
          return adjustForActivePresentations(n);
        }
      }
    }

    // 4. Classic .uGOf1d class
    const badgeNodes = document.querySelectorAll('.uGOf1d');
    for (const node of badgeNodes) {
      const parsed = extractCountFromText(node.textContent || '');
      if (parsed !== null) {
        return adjustForActivePresentations(parsed);
      }
    }

    // 5. Layout Grid + Overflow Bubble (Fix for >10 people grid cap)
    const tileStats = countUniqueParticipantTiles();
    const activePres = countActivePresentations();
    // How many presentations in the DOM weren't explicitly tagged as presentation tiles?
    const unaccountedPres = Math.max(0, activePres - tileStats.presCount);
    // True human visible tiles on screen
    const humanVisibleTiles = Math.max(0, tileStats.humanCount - unaccountedPres);

    const overflowCount = detectOverflowCount();
    if (overflowCount > 0) {
      const rawCombined = humanVisibleTiles > 0 ? (humanVisibleTiles + overflowCount) : (overflowCount + 1);
      return Math.max(1, rawCombined);
    }

    // 6. Check open People side panel headers or badges
    const panelHeaders = document.querySelectorAll(
      '[role="region"][aria-label*="People" i] [aria-label*="joined" i], [role="region"][aria-label*="People" i] [aria-label*="participant" i], [role="region"][aria-label*="Participants" i], [role="region"][aria-label*="People" i] h2, [role="region"][aria-label*="People" i] h3'
    );
    for (const h of panelHeaders) {
      const fromAria = extractCountFromAria(h.getAttribute('aria-label') || '');
      if (fromAria !== null) return adjustForActivePresentations(fromAria);
      const parsed = extractCountFromText(h.textContent || '');
      if (parsed !== null) return adjustForActivePresentations(parsed);
    }

    // 7. If humanVisibleTiles > 1 and NO overflow bubble, we have at least humanVisibleTiles
    if (humanVisibleTiles > 1) {
      return humanVisibleTiles;
    }

    // 8. If humanVisibleTiles <= 1 (including 0 when self-view is minimized or hidden) and NO overflow bubble:
    if (activePres === 0) {
      // With no presentation and no overflow bubble, <= 1 tile unambiguously indicates the user is alone in the call.
      return 1;
    }

    // Presentation is active: participant tiles might be collapsed or hidden into a filmstrip.
    const isExplicitlyAlone = document.querySelector(
      '[aria-label*="Just you" i], [aria-label*="You are the only person" i], [aria-label*="People - 1 joined" i]'
    );
    if (isExplicitlyAlone || state.peakParticipants <= 1) {
      return 1;
    }

    if (humanVisibleTiles === 1) {
      return 1;
    }

    // Indeterminate - telemetry temporarily unavailable during active presentation
    return null;
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
        state.floorTriggered = false;
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

      const hangupBtn = findHangupButton();
      if (!hangupBtn) {
        state.inCall = false;
        state.floorTriggered = false;
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

      state.activePresentations = countActivePresentations();
      const detectedCount = detectParticipantCount();
      if (detectedCount === null) {
        // Telemetry temporarily unavailable (e.g. layout transition, participant departure animation).
        // Crucial safety guard: If leave countdown or floor trigger is already locked in, DO NOT abort!
        if (state.armed && !state.hasLeft && (state.floorTriggered || state.triggerStartTime !== null)) {
          // Continue countdown execution below with previous known state
        } else {
          renderHud();
          return;
        }
      } else {
        state.currentParticipants = detectedCount;
        if (detectedCount > state.peakParticipants) {
          state.peakParticipants = detectedCount;
        }
      }

      const details = computeThresholdDetails(state.peakParticipants, settings);
      state.armed = state.meetingEnabled && details.qualifiesToArm;
      state.leaveAtOrBelow = details.leaveAtOrBelow;

      // Check if attendance is at or below the leave threshold or safety floor
      const isAtSafetyFloor =
        state.armed &&
        settings.useMinFloor &&
        state.currentParticipants <= settings.minFloor;

      const isBelowThreshold =
        state.armed &&
        state.currentParticipants <= state.leaveAtOrBelow;

      // Latch floor/threshold trigger: once triggered, lock it in so departures never get stuck
      if (isAtSafetyFloor || isBelowThreshold) {
        state.floorTriggered = true;
      }

      // Check if attendance recovered above leave threshold and above safety floor
      if (
        detectedCount !== null &&
        detectedCount > state.leaveAtOrBelow &&
        (!settings.useMinFloor || detectedCount > settings.minFloor)
      ) {
        state.floorTriggered = false;
        state.triggerStartTime = null;
      }

      let badgeColor = '#64748b';
      let badgeText = 'OFF';
      if (state.meetingEnabled) {
        if (state.hasLeft) {
          badgeColor = '#ea4335';
          badgeText = 'LEFT';
        } else if (state.floorTriggered || state.triggerStartTime !== null) {
          badgeColor = '#ea4335';
          badgeText = 'EXIT';
        } else if (state.armed) {
          badgeColor = '#10b981';
          badgeText = String(state.currentParticipants);
        } else {
          badgeColor = '#f59e0b';
          badgeText = String(state.currentParticipants);
        }
      }

      safeSendMessage({
        type: 'ALM_UPDATE_BADGE',
        text: badgeText,
        color: badgeColor,
        enabled: Boolean(state.meetingEnabled)
      });

      const shouldTriggerLeave =
        state.armed &&
        !state.hasLeft &&
        (state.floorTriggered || state.currentParticipants <= state.leaveAtOrBelow);

      if (shouldTriggerLeave) {
        const now = Date.now();
        if (state.triggerStartTime === null) {
          state.triggerStartTime = now;
        }
        const elapsedSec = (now - state.triggerStartTime) / 1000;

        // Anti-glitch guard: If peak was >= 4 and detected count plunges to <= 2, require at least 3s sustained
        const requiredSustainedSec =
          state.peakParticipants >= 4 && state.currentParticipants <= 2
            ? Math.max(settings.sustainedSeconds, 3)
            : settings.sustainedSeconds;

        if (elapsedSec >= requiredSustainedSec) {
          // Double-check one final time right before executing leave
          const finalCheck = detectParticipantCount();
          if (
            finalCheck !== null &&
            finalCheck > state.leaveAtOrBelow &&
            (!settings.useMinFloor || finalCheck > settings.minFloor)
          ) {
            state.floorTriggered = false;
            state.triggerStartTime = null;
            state.currentParticipants = finalCheck;
            renderHud();
            return;
          }

          const reasonStr =
            state.floorTriggered && settings.useMinFloor && state.currentParticipants <= settings.minFloor
              ? `Room reached safety floor (${state.currentParticipants} ≤ ${settings.minFloor}) from peak of ${state.peakParticipants}`
              : (details.reasons.join(' | ') || `Participants dropped from ${state.peakParticipants} to ${state.currentParticipants}`);
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
      state.floorTriggered = false;
    } else {
      state.floorTriggered = false;
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
    state.floorTriggered = false;
    state.triggerStartTime = null;
    evaluateCallState();
    return state.peakParticipants;
  }

  function updateHudPosition(container) {
    if (!container) return;

    // Minimum X coordinate for top-right cluster (strictly ignores any top-left meeting info/time)
    const minClusterX = Math.max(window.innerWidth * 0.45, window.innerWidth - 850);
    let leftmostX = window.innerWidth;
    let matchingTop = 10;
    let matchingHeight = 36;

    // 1. Google Meet's Peninsula (top-right feature container holding REC, Gemini, People, etc.)
    const peninsula = document.querySelector('[role="region"][aria-label*="Call feature" i]');
    if (peninsula) {
      const rect = peninsula.getBoundingClientRect();
      if (
        rect.top >= 0 &&
        rect.top < 65 &&
        rect.left >= minClusterX &&
        rect.left < window.innerWidth &&
        rect.width > 20 &&
        rect.width < 500
      ) {
        leftmostX = Math.min(leftmostX, rect.left);
        matchingTop = rect.top;
        matchingHeight = rect.height;
      }
    }

    // 2. Buttons, chips, and controls in the top-right header area
    const rightControls = document.querySelectorAll(
      'button, [role="button"], [data-panel-id], [data-badge-id], [role="status"]'
    );
    for (const el of rightControls) {
      if (el === container || container.contains(el)) continue;
      const rect = el.getBoundingClientRect();
      if (
        rect.top >= 0 &&
        rect.top < 65 &&
        rect.left >= minClusterX &&
        rect.right <= window.innerWidth + 10 &&
        rect.width >= 16 &&
        rect.width < 450 &&
        rect.height >= 16 &&
        rect.height <= 65
      ) {
        if (rect.left < leftmostX) {
          leftmostX = rect.left;
          matchingTop = rect.top;
          matchingHeight = rect.height;
        }
      }
    }

    // 3. Presenter badge and presentation status indicators (e.g. "[Avatar] Name (Presenting, annotating)")
    const presenterCandidates = document.querySelectorAll(
      '[data-tooltip*="present" i], [aria-label*="present" i], [data-tooltip*="annotat" i], [aria-label*="annotat" i]'
    );
    for (const el of presenterCandidates) {
      if (el === container || container.contains(el)) continue;
      const rect = el.getBoundingClientRect();
      if (
        rect.top >= 0 &&
        rect.top < 65 &&
        rect.left >= minClusterX &&
        rect.left < window.innerWidth &&
        rect.width >= 20 &&
        rect.width < 450 &&
        rect.height >= 16
      ) {
        if (rect.left < leftmostX) {
          leftmostX = rect.left;
          matchingTop = rect.top;
          matchingHeight = rect.height;
        }
      }
    }

    // 4. Text-based detection for Presenter badge content in the top-right
    const textNodes = document.querySelectorAll('div, span');
    for (const el of textNodes) {
      if (el === container || container.contains(el)) continue;
      if (el.children.length === 0 && el.textContent) {
        const txt = el.textContent.trim().toLowerCase();
        if (
          txt.includes('(present') ||
          txt.includes('presenting') ||
          txt.includes('annotating')
        ) {
          const rect = el.getBoundingClientRect();
          if (rect.top >= 0 && rect.top < 65 && rect.left >= minClusterX && rect.left < window.innerWidth) {
            // Find outer pill container which includes avatar to the left
            let chip = el;
            while (chip.parentElement && chip.parentElement !== document.body) {
              const pr = chip.parentElement.getBoundingClientRect();
              if (
                pr.height <= 65 &&
                pr.top >= 0 &&
                pr.top < 65 &&
                pr.left >= minClusterX &&
                pr.width < 450
              ) {
                chip = chip.parentElement;
              } else {
                break;
              }
            }
            const chipRect = chip.getBoundingClientRect();
            if (chipRect.left >= minClusterX && chipRect.left < leftmostX) {
              leftmostX = chipRect.left;
              matchingTop = chipRect.top;
              matchingHeight = chipRect.height;
            }
          }
        }
      }
    }

    let targetTop = 10;
    let targetRight = 120;

    if (leftmostX < window.innerWidth && leftmostX >= minClusterX) {
      targetRight = window.innerWidth - leftmostX + 16;
      targetTop = Math.max(6, Math.round(matchingTop + (matchingHeight - 32) / 2));
    }

    // Safety guard: ensure the pill stays strictly in the right region and never crosses center
    const maxAllowedRight = window.innerWidth - minClusterX + 120;
    targetRight = Math.min(targetRight, maxAllowedRight);

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

    const presNote = state.activePresentations > 0 ? ` (+${state.activePresentations} screen share excluded)` : '';

    if (!state.meetingEnabled) {
      hud.statusDot.style.backgroundColor = '#9aa0a6';
      hud.statusDot.style.boxShadow = 'none';
      hud.container.style.backgroundColor = 'rgba(32, 33, 36, 0.9)';
      hud.container.style.borderColor = 'rgba(255, 255, 255, 0.16)';
      hud.container.style.color = '#9aa0a6';
      hud.titleText.textContent = 'IrishExit · Off';
      hud.tooltipHeader.textContent = 'IrishExit · Turned Off';
      hud.tooltipStats.textContent = `Current attendees: ${state.currentParticipants}${presNote}. Click this pill to activate auto-leave for this call.`;
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
      hud.tooltipStats.textContent = `Peak: ${state.peakParticipants} · Current: ${state.currentParticipants}${presNote}. Waiting for room to reach ≥${settings.minPeakToArm} people before activating.`;
      return;
    }

    if (state.triggerStartTime !== null) {
      const requiredSustainedSec =
        state.peakParticipants >= 4 && state.currentParticipants <= 2
          ? Math.max(settings.sustainedSeconds, 3)
          : settings.sustainedSeconds;
      const elapsedSec = (Date.now() - state.triggerStartTime) / 1000;
      const remainingSec = Math.max(0, Math.ceil(requiredSustainedSec - elapsedSec));

      hud.statusDot.style.backgroundColor = '#ea4335';
      hud.statusDot.style.boxShadow = '0 0 8px rgba(234, 67, 53, 0.8)';
      hud.container.style.backgroundColor = 'rgba(56, 18, 18, 0.95)';
      hud.container.style.borderColor = 'rgba(234, 67, 53, 0.7)';
      hud.container.style.color = '#f28b82';
      hud.titleText.textContent = `Leaving in ${remainingSec}s...`;
      hud.tooltipHeader.textContent =
        state.floorTriggered && settings.useMinFloor && state.currentParticipants <= settings.minFloor
          ? 'IrishExit · Safety Floor Reached'
          : 'IrishExit · Threshold Reached';
      hud.tooltipStats.textContent = `Attendance dropped to ${state.currentParticipants}${presNote} (threshold was ≤${state.leaveAtOrBelow}). Disconnecting in ${remainingSec}s... Click pill to abort.`;
    } else {
      hud.statusDot.style.backgroundColor = '#34a853';
      hud.statusDot.style.boxShadow = '0 0 6px rgba(52, 168, 83, 0.6)';
      hud.container.style.backgroundColor = 'rgba(18, 42, 28, 0.92)';
      hud.container.style.borderColor = 'rgba(52, 168, 83, 0.45)';
      hud.container.style.color = '#a8dab5';
      hud.titleText.textContent = `Active · Leaves at ≤ ${state.leaveAtOrBelow}`;
      hud.tooltipHeader.textContent = 'IrishExit · Active & Watching';
      hud.tooltipStats.textContent = `Peak: ${state.peakParticipants} · Current: ${state.currentParticipants}${presNote} · Auto-leaves when room drops to ≤ ${state.leaveAtOrBelow}.`;
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
                activePresentations: state.activePresentations,
                armed: state.armed,
                floorTriggered: state.floorTriggered,
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
