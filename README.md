# IrishExit — Auto Leave for Google Meet

A modern Manifest V3 Chrome extension designed to slip you out of Google Meet calls smoothly when participant attendance drops—whether you are in a 5-person sync or a 100+ person all-hands. Never be the awkward last person left in an empty room.

📖 **[Read the Full User Guide & How It Works (HOW_IT_WORKS.md)](HOW_IT_WORKS.md)**

---

## 🍀 Features

- **Per-Meeting Opt-In (OFF by Default)**:
  - Every meeting defaults to **OFF** so IrishExit never interrupts calls you want to stay in until the very end.
  - Activate IrishExit with a single click using the in-call button in the top-right header of Google Meet or via the toolbar popup.
  - *(Optional)* Check **"Auto-turn ON for every new call"** if you prefer it active automatically on every call.
- **Adaptive Scaling (5–10 Person Syncs up to 100+ Person All-Hands)**:
  - **Drop % from Peak** (default `30%`):
    - Uses `max(2, round(peak * dropPercent%))` people leaving from peak attendance.
    - **5-person call (`peak = 5`)**: requires at least **2 people** to leave (`leaves at ≤ 3`), preventing accidental disconnects when one person refreshes.
    - **10-person call (`peak = 10`)**: requires **3 people** to leave (`leaves at ≤ 7`).
    - **120-person all-hands (`peak = 120`)**: requires **36 people** (`30%`) to leave (`leaves at ≤ 84`), naturally absorbing mid-meeting turnover without kicking you out prematurely.
  - **Safety Net Floor** (default `≤ 2` participants left):
    - Acts as a hard safety net so you are never left 1-on-1 with the presenter or host.
- **Dynamic Clover Status Icon**:
  - **Neon Emerald Clover**: Armed and actively watching your meeting.
  - **Dimmed Slate Monochrome Clover**: Idle or turned off for the current call.
  - Toolbar badge shows live participant count or `OFF`.
- **Exit Presets**:
  - **Quick Exit**: `-20%` drop / `≤ 3` floor (fast response, 1s delay).
  - **Balanced**: `-30%` drop / `≤ 2` floor (default, ideal for most meetings).
  - **Patient**: `-40%` drop / `≤ 2` floor (extra leeway for large presentations).
- **3-Layer Guaranteed Hangup**:
  1. Triggers Google Meet's official **Leave call** button.
  2. Auto-clicks **"Just leave the call"** if the host/moderator confirmation dialog appears.
  3. **Hard WebRTC Disconnect Failsafe**: Disconnects camera and microphone by redirecting to `https://meet.google.com/?autoleft=1` (or closes the tab if configured).

---

## 🛠️ Local Installation (Load Unpacked)

1. Open Chrome and go to `chrome://extensions/`.
2. Enable **Developer mode** (toggle in the top-right corner).
3. Click **Load unpacked** (top-left button).
4. Select the `irishexit` folder.
5. Join any Google Meet call and toggle **Turn ON for This Meet** whenever you want IrishExit armed.

---

## 🔒 Privacy & Permissions

IrishExit runs 100% locally on your machine:
- **Zero data collection**: No telemetry, analytics, or remote tracking.
- **Strictly scoped permissions**: Only interacts with `https://meet.google.com/*`.
- **No audio/video capture**: IrishExit only inspects the attendee counter element to know when meetings end.
