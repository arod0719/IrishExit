'use strict';

const DEFAULT_SETTINGS = Object.freeze({
  autoArmNewMeetings: false,
  useDropPercent: true,
  dropPercent: 40,
  useMinFloor: true,
  minFloor: 2,
  minPeakToArm: 3,
  sustainedSeconds: 2,
  hardDisconnectFailsafe: true,
  closeTabOnLeave: false,
  showHud: true
});

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

function ensureContentScriptInjected(tabId) {
  if (typeof tabId !== 'number') {
    return;
  }
  chrome.tabs.sendMessage(tabId, { type: 'ALM_PING' }, (res) => {
    if (chrome.runtime.lastError || !res || !res.ok) {
      chrome.scripting.executeScript(
        {
          target: { tabId, allFrames: false },
          files: ['content.js']
        },
        () => {
          void chrome.runtime.lastError;
        }
      );
    }
  });
}

function updateToolbarIcon(tabId, isEnabled, badgeText, badgeColor) {
  if (typeof tabId !== 'number') {
    return;
  }
  const stateName = isEnabled ? 'on' : 'off';
  chrome.action.setIcon({
    tabId,
    path: {
      16: `icons/icon-${stateName}-16.png`,
      32: `icons/icon-${stateName}-32.png`,
      48: `icons/icon-${stateName}-48.png`,
      128: `icons/icon-${stateName}-128.png`
    }
  });
  if (typeof badgeText === 'string') {
    chrome.action.setBadgeText({ tabId, text: badgeText });
  }
  if (typeof badgeColor === 'string') {
    chrome.action.setBadgeBackgroundColor({ tabId, color: badgeColor });
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get(['almSettings'], (result) => {
    const merged = sanitizeSettings(result && result.almSettings);
    chrome.storage.local.set({ almSettings: merged });
  });

  // Inject content script into any Google Meet tabs that were already open before install/reload
  chrome.tabs.query({ url: 'https://meet.google.com/*' }, (tabs) => {
    if (Array.isArray(tabs)) {
      for (const tab of tabs) {
        if (tab && typeof tab.id === 'number') {
          ensureContentScriptInjected(tab.id);
        }
      }
    }
  });

  chrome.alarms.create('alm-keepalive-tick', { periodInMinutes: 0.5 });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tab && tab.url && tab.url.includes('meet.google.com') && changeInfo.status === 'complete') {
    ensureContentScriptInjected(tabId);
  }
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm || alarm.name !== 'alm-keepalive-tick') {
    return;
  }
  chrome.tabs.query({ url: 'https://meet.google.com/*' }, (tabs) => {
    if (!Array.isArray(tabs)) {
      return;
    }
    for (const tab of tabs) {
      if (tab && typeof tab.id === 'number') {
        ensureContentScriptInjected(tab.id);
        chrome.tabs.sendMessage(tab.id, { type: 'ALM_HEARTBEAT' }, () => {
          void chrome.runtime.lastError;
        });
      }
    }
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
    sendResponse({ ok: false, error: 'Invalid message format' });
    return false;
  }

  if (message.type === 'ALM_UPDATE_BADGE') {
    const tabId = sender && sender.tab && typeof sender.tab.id === 'number' ? sender.tab.id : null;
    if (tabId !== null) {
      const isEnabled = Boolean(message.enabled);
      const text = typeof message.text === 'string' ? message.text.slice(0, 4) : '';
      const color = typeof message.color === 'string' ? message.color : '#64748b';
      updateToolbarIcon(tabId, isEnabled, text, color);
    }
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === 'ALM_TRIGGER_FAILSAFE') {
    const tabId = sender && sender.tab && typeof sender.tab.id === 'number' ? sender.tab.id : null;
    const reason = typeof message.reason === 'string' ? message.reason.slice(0, 200) : 'Threshold reached';
    const eventRecord = {
      timestamp: new Date().toISOString(),
      reason,
      peak: clampInt(message.peak, 0, 10000, 0),
      current: clampInt(message.current, 0, 10000, 0)
    };

    chrome.storage.local.get(['almSettings'], (res) => {
      const settings = sanitizeSettings(res && res.almSettings);
      chrome.storage.local.set({ almLastLeaveEvent: eventRecord });

      if (tabId !== null && settings.hardDisconnectFailsafe) {
        setTimeout(() => {
          if (settings.closeTabOnLeave) {
            chrome.tabs.remove(tabId, () => {
              void chrome.runtime.lastError;
            });
          } else {
            chrome.tabs.update(tabId, { url: 'https://meet.google.com/?autoleft=1' }, () => {
              void chrome.runtime.lastError;
            });
          }
        }, 1000);
      }
      sendResponse({ ok: true });
    });
    return true;
  }

  sendResponse({ ok: false, error: 'Unknown message type' });
  return false;
});
