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

const HELP_URL = 'https://github.com/arod0719/IrishExit/blob/main/HOW_IT_WORKS.md';

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) {
    return fallback;
  }
  return Math.min(max, Math.max(min, parsed));
}

function getMeetingCodeFromUrl(url) {
  if (!url) {
    return null;
  }
  const match = url.match(/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})/i);
  return match ? match[1].toLowerCase() : null;
}

function readSettingsFromForm() {
  return {
    autoArmNewMeetings: Boolean(document.getElementById('autoArmNewMeetings').checked),
    useDropPercent: Boolean(document.getElementById('useDropPercent').checked),
    dropPercent: clampInt(document.getElementById('dropPercent').value, 10, 90, DEFAULT_SETTINGS.dropPercent),
    useMinFloor: Boolean(document.getElementById('useMinFloor').checked),
    minFloor: clampInt(document.getElementById('minFloor').value, 1, 50, DEFAULT_SETTINGS.minFloor),
    minPeakToArm: clampInt(document.getElementById('minPeakToArm').value, 2, 100, DEFAULT_SETTINGS.minPeakToArm),
    sustainedSeconds: clampInt(
      document.getElementById('sustainedSeconds').value,
      0,
      30,
      DEFAULT_SETTINGS.sustainedSeconds
    ),
    hardDisconnectFailsafe: Boolean(document.getElementById('hardDisconnectFailsafe').checked),
    closeTabOnLeave: Boolean(document.getElementById('closeTabOnLeave').checked),
    showHud: Boolean(document.getElementById('showHud').checked)
  };
}

function updateActivePresetHighlight() {
  const s = readSettingsFromForm();
  const fastBtn = document.getElementById('presetFast');
  const balancedBtn = document.getElementById('presetBalanced');
  const largeBtn = document.getElementById('presetLarge');

  const isFast = s.useDropPercent && s.dropPercent === 30 && s.useMinFloor && s.minFloor === 3;
  const isBalanced = s.useDropPercent && s.dropPercent === 40 && s.useMinFloor && s.minFloor === 2;
  const isLarge = s.useDropPercent && s.dropPercent === 50 && s.useMinFloor && s.minFloor === 2;

  if (fastBtn) fastBtn.classList.toggle('active', isFast);
  if (balancedBtn) balancedBtn.classList.toggle('active', isBalanced);
  if (largeBtn) largeBtn.classList.toggle('active', isLarge);
}

function writeSettingsToForm(cfg) {
  const s = Object.assign({}, DEFAULT_SETTINGS, cfg || {});
  document.getElementById('autoArmNewMeetings').checked = Boolean(s.autoArmNewMeetings);
  document.getElementById('useDropPercent').checked = Boolean(s.useDropPercent);
  document.getElementById('dropPercent').value = String(s.dropPercent);
  document.getElementById('useMinFloor').checked = Boolean(s.useMinFloor);
  document.getElementById('minFloor').value = String(s.minFloor);
  document.getElementById('minPeakToArm').value = String(s.minPeakToArm);
  document.getElementById('sustainedSeconds').value = String(s.sustainedSeconds);
  document.getElementById('hardDisconnectFailsafe').checked = Boolean(s.hardDisconnectFailsafe);
  document.getElementById('closeTabOnLeave').checked = Boolean(s.closeTabOnLeave);
  document.getElementById('showHud').checked = Boolean(s.showHud);
  updateActivePresetHighlight();
}

function saveSettings() {
  const nextSettings = readSettingsFromForm();
  writeSettingsToForm(nextSettings);
  chrome.storage.local.set({ almSettings: nextSettings }, () => {
    const saveEl = document.getElementById('saveStatus');
    saveEl.textContent = 'Synced live to Meet ✓';
    setTimeout(() => {
      saveEl.textContent = 'All changes auto-saved';
    }, 1500);
    refreshActiveMeetTelemetry();
  });
}

function isMeetTab(tab) {
  return Boolean(
    tab &&
    typeof tab.id === 'number' &&
    typeof tab.url === 'string' &&
    tab.url.startsWith('https://meet.google.com/')
  );
}

function setMeetingEnabledOnActiveTab(enabled) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const activeTab = Array.isArray(tabs) && tabs[0] ? tabs[0] : null;
    if (!isMeetTab(activeTab)) {
      return;
    }

    // Optimistic UI update
    const headerLogo = document.getElementById('headerLogo');
    const headerSub = document.getElementById('headerSub');
    const meetingToggle = document.getElementById('meetingToggle');
    meetingToggle.checked = Boolean(enabled);
    if (headerLogo) {
      headerLogo.src = enabled ? 'icons/icon-on-48.png' : 'icons/icon-off-48.png';
    }
    headerSub.textContent = enabled ? 'Active on This Call' : 'Turned OFF for This Call';

    // Store in chrome.storage.local for this meeting code
    const meetingCode = getMeetingCodeFromUrl(activeTab.url);
    if (meetingCode) {
      chrome.storage.local.set({ [`alm_meet_${meetingCode}`]: Boolean(enabled) });
    }

    // Tell content script
    chrome.tabs.sendMessage(
      activeTab.id,
      { type: 'ALM_SET_MEETING_ENABLED', enabled: Boolean(enabled) },
      () => {
        if (chrome.runtime.lastError) {
          chrome.scripting.executeScript(
            {
              target: { tabId: activeTab.id, allFrames: false },
              files: ['content.js']
            },
            () => {
              void chrome.runtime.lastError;
              setTimeout(refreshActiveMeetTelemetry, 300);
            }
          );
        } else {
          refreshActiveMeetTelemetry();
        }
      }
    );
  });
}

function applyPreset(preset) {
  const current = readSettingsFromForm();
  const updated = Object.assign({}, current, preset);
  writeSettingsToForm(updated);
  saveSettings();
  setMeetingEnabledOnActiveTab(true);
}

function refreshActiveMeetTelemetry() {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const activeTab = Array.isArray(tabs) && tabs[0] ? tabs[0] : null;
    const badge = document.getElementById('callStatusBadge');
    const peakEl = document.getElementById('peakVal');
    const nowEl = document.getElementById('nowVal');
    const leaveAtEl = document.getElementById('leaveAtVal');
    const meetingToggle = document.getElementById('meetingToggle');
    const headerLogo = document.getElementById('headerLogo');
    const headerSub = document.getElementById('headerSub');
    const testLeaveBtn = document.getElementById('testLeaveBtn');
    const resetPeakBtn = document.getElementById('resetPeakBtn');

    if (!isMeetTab(activeTab)) {
      badge.className = 'badge badge-idle';
      badge.textContent = 'Open a Google Meet Tab';
      peakEl.textContent = '—';
      nowEl.textContent = '—';
      leaveAtEl.textContent = '—';
      meetingToggle.checked = false;
      meetingToggle.disabled = true;
      if (headerLogo) {
        headerLogo.src = 'icons/icon-off-48.png';
      }
      headerSub.textContent = 'Join a call to start';
      if (testLeaveBtn) {
        testLeaveBtn.disabled = true;
        testLeaveBtn.style.opacity = '0.4';
        testLeaveBtn.style.cursor = 'not-allowed';
        testLeaveBtn.title = 'Test Leave requires an active Google Meet call';
      }
      if (resetPeakBtn) {
        resetPeakBtn.disabled = true;
        resetPeakBtn.style.opacity = '0.4';
        resetPeakBtn.style.cursor = 'not-allowed';
      }
      return;
    }

    meetingToggle.disabled = false;

    chrome.tabs.sendMessage(activeTab.id, { type: 'ALM_GET_STATUS' }, (response) => {
      if (chrome.runtime.lastError || !response || !response.ok || !response.state) {
        const meetingCode = getMeetingCodeFromUrl(activeTab.url);
        if (meetingCode) {
          chrome.storage.local.get([`alm_meet_${meetingCode}`], (stRes) => {
            const isSavedOn = Boolean(stRes && stRes[`alm_meet_${meetingCode}`]);
            meetingToggle.checked = isSavedOn;
            if (headerLogo) {
              headerLogo.src = isSavedOn ? 'icons/icon-on-48.png' : 'icons/icon-off-48.png';
            }
            headerSub.textContent = isSavedOn ? 'Active on This Call' : 'Turned OFF for This Call';
          });
        }
        badge.className = 'badge badge-waiting';
        badge.textContent = 'Connecting to Meet...';
        if (testLeaveBtn) {
          testLeaveBtn.disabled = true;
          testLeaveBtn.style.opacity = '0.4';
          testLeaveBtn.style.cursor = 'not-allowed';
        }
        if (resetPeakBtn) {
          resetPeakBtn.disabled = true;
          resetPeakBtn.style.opacity = '0.4';
          resetPeakBtn.style.cursor = 'not-allowed';
        }
        return;
      }

      const st = response.state;
      meetingToggle.checked = Boolean(st.meetingEnabled);
      if (headerLogo) {
        headerLogo.src = st.meetingEnabled ? 'icons/icon-on-48.png' : 'icons/icon-off-48.png';
      }
      headerSub.textContent = st.meetingEnabled ? 'Active on This Call' : 'Turned OFF for This Call';

      if (!st.inCall) {
        badge.className = 'badge badge-idle';
        badge.textContent = st.meetingEnabled ? 'Armed for Call Entry' : 'In Lobby (OFF)';
        peakEl.textContent = '—';
        nowEl.textContent = '—';
        leaveAtEl.textContent = '—';
        if (testLeaveBtn) {
          testLeaveBtn.disabled = true;
          testLeaveBtn.style.opacity = '0.4';
          testLeaveBtn.style.cursor = 'not-allowed';
          testLeaveBtn.title = 'Join a call first to test leave';
        }
        if (resetPeakBtn) {
          resetPeakBtn.disabled = true;
          resetPeakBtn.style.opacity = '0.4';
          resetPeakBtn.style.cursor = 'not-allowed';
        }
        return;
      }

      if (testLeaveBtn) {
        testLeaveBtn.disabled = false;
        testLeaveBtn.style.opacity = '1';
        testLeaveBtn.style.cursor = 'pointer';
        testLeaveBtn.title = 'Simulate instant drop threshold and leave the call now';
      }
      if (resetPeakBtn) {
        resetPeakBtn.disabled = false;
        resetPeakBtn.style.opacity = '1';
        resetPeakBtn.style.cursor = 'pointer';
      }

      peakEl.textContent = String(st.peakParticipants);
      nowEl.textContent = String(st.currentParticipants);

      if (!st.meetingEnabled) {
        badge.className = 'badge badge-idle';
        badge.textContent = 'Turned OFF for This Call';
        leaveAtEl.textContent = 'OFF';
      } else if (st.armed) {
        badge.className = 'badge badge-armed';
        badge.textContent = 'Active & Watching';
        leaveAtEl.textContent = `≤ ${st.leaveAtOrBelow}`;
      } else {
        badge.className = 'badge badge-waiting';
        badge.textContent = `Waiting for Attendees (≥${st.minPeakToArm || 3})`;
        leaveAtEl.textContent = '—';
      }
    });
  });
}

function executeDirectHangup(tabId, url) {
  if (!url || !url.startsWith('https://meet.google.com/')) {
    return;
  }
  chrome.scripting.executeScript(
    {
      target: { tabId },
      func: () => {
        const btn = document.querySelector(
          'button[aria-label*="Leave call" i], button[aria-label*="End call" i], button[jsname="CQylAd"]'
        );
        if (btn) {
          btn.click();
        }
        setTimeout(() => {
          const dialogBtns = document.querySelectorAll(
            '[role="dialog"] button, [aria-modal="true"] button, button'
          );
          for (const b of dialogBtns) {
            const text = ((b.textContent || '') + ' ' + (b.getAttribute('aria-label') || '')).toLowerCase();
            if (text.includes('just leave') && !text.includes('everyone')) {
              b.click();
              break;
            }
          }
        }, 200);
        setTimeout(() => {
          window.location.replace('https://meet.google.com/?autoleft=1');
        }, 700);
      }
    },
    () => {
      void chrome.runtime.lastError;
    }
  );
}

document.addEventListener('DOMContentLoaded', () => {
  chrome.storage.local.get(['almSettings'], (res) => {
    writeSettingsToForm(res && res.almSettings);
  });

  // Help button and footer link
  const openHelp = () => {
    chrome.tabs.create({ url: HELP_URL });
  };
  const helpBtn = document.getElementById('helpBtn');
  if (helpBtn) {
    helpBtn.addEventListener('click', openHelp);
  }
  const helpFooterLink = document.getElementById('helpFooterLink');
  if (helpFooterLink) {
    helpFooterLink.addEventListener('click', (e) => {
      e.preventDefault();
      openHelp();
    });
  }

  // Ensure content script is running in active tab immediately on popup open
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const activeTab = Array.isArray(tabs) && tabs[0] ? tabs[0] : null;
    if (isMeetTab(activeTab)) {
      chrome.tabs.sendMessage(activeTab.id, { type: 'ALM_PING' }, (res) => {
        if (chrome.runtime.lastError || !res || !res.ok) {
          chrome.scripting.executeScript(
            {
              target: { tabId: activeTab.id, allFrames: false },
              files: ['content.js']
            },
            () => {
              void chrome.runtime.lastError;
              setTimeout(refreshActiveMeetTelemetry, 250);
            }
          );
        } else {
          refreshActiveMeetTelemetry();
        }
      });
    } else {
      refreshActiveMeetTelemetry();
    }
  });

  document.getElementById('meetingToggle').addEventListener('change', (e) => {
    setMeetingEnabledOnActiveTab(Boolean(e.target.checked));
  });

  const settingIds = [
    'autoArmNewMeetings',
    'useDropPercent',
    'dropPercent',
    'useMinFloor',
    'minFloor',
    'minPeakToArm',
    'sustainedSeconds',
    'hardDisconnectFailsafe',
    'closeTabOnLeave',
    'showHud'
  ];
  for (const id of settingIds) {
    const el = document.getElementById(id);
    if (el) {
      el.addEventListener('change', () => {
        updateActivePresetHighlight();
        saveSettings();
      });
    }
  }

  document.getElementById('presetFast').addEventListener('click', () => {
    applyPreset({
      useDropPercent: true,
      dropPercent: 30,
      useMinFloor: true,
      minFloor: 3,
      sustainedSeconds: 1
    });
  });

  document.getElementById('presetBalanced').addEventListener('click', () => {
    applyPreset({
      useDropPercent: true,
      dropPercent: 40,
      useMinFloor: true,
      minFloor: 2,
      sustainedSeconds: 2
    });
  });

  document.getElementById('presetLarge').addEventListener('click', () => {
    applyPreset({
      useDropPercent: true,
      dropPercent: 50,
      useMinFloor: true,
      minFloor: 2,
      sustainedSeconds: 2
    });
  });

  document.getElementById('resetPeakBtn').addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const activeTab = Array.isArray(tabs) && tabs[0] ? tabs[0] : null;
      if (!isMeetTab(activeTab)) {
        return;
      }
      chrome.tabs.sendMessage(activeTab.id, { type: 'ALM_RESET_PEAK' }, () => {
        void chrome.runtime.lastError;
        refreshActiveMeetTelemetry();
      });
    });
  });

  document.getElementById('testLeaveBtn').addEventListener('click', () => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const activeTab = Array.isArray(tabs) && tabs[0] ? tabs[0] : null;
      if (!isMeetTab(activeTab)) {
        return;
      }
      chrome.tabs.sendMessage(activeTab.id, { type: 'ALM_TEST_LEAVE' }, (response) => {
        if (chrome.runtime.lastError || !response || !response.ok) {
          executeDirectHangup(activeTab.id, activeTab.url);
        }
      });
    });
  });

  setInterval(refreshActiveMeetTelemetry, 1000);
});
