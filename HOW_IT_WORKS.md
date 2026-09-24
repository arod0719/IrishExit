# 🍀 How IrishExit Works

**IrishExit** is an intelligent, privacy-first Chrome extension that automatically disconnects you from Google Meet calls when attendance drops. Whether you're in a 5-person team sync or a 100+ person all-hands, it ensures you are never the awkward last person left lingering in an empty meeting room.

---

## 🎯 The Two Exit Rules

IrishExit monitors meeting attendance in real-time and disconnects your call when **either** of these two conditions is met:

![Adaptive Scaling Infographic](store-assets/screenshot-3-adaptive-scaling.png)

### 1. Attendance Drop Threshold (Default: `30%` drop from peak)
- IrishExit remembers the **highest number of people** present during your call (the "peak").
- If attendance drops by your configured percentage (e.g. 30%), IrishExit smoothly leaves.
- **Adaptive scaling examples:**
  - **Small 5-person meeting (`peak = 5`)**: Requires at least **2 people** to leave (`exits at ≤ 3`), preventing accidental disconnects if a single person refreshes their browser.
  - **10-person sync (`peak = 10`)**: Exits when attendance drops to **`≤ 7`**.
  - **120-person all-hands (`peak = 120`)**: Requires **36 people** (`30%`) to leave (`exits at ≤ 84`), naturally absorbing mid-meeting churn without kicking you out early.

### 2. Safety Net Floor (Default: `≤ 2` people left)
- Acts as an absolute safety net regardless of percentage.
- If only **2 people remain** (usually just you and the presenter), IrishExit leaves immediately so you are never stuck in an unintentional 1-on-1.

---

## 🎛️ In-Call Top-Right Button

While in any Google Meet call, IrishExit places a sleek, unobtrusive pill button in the **top-right header**, directly beside Google Meet's participant chip:

![In-Call Google Meet Header Button](store-assets/screenshot-1-in-call.png)

* **🍀 IrishExit · Off**: Click once to turn ON for this meeting.
* **🍀 Waiting (need ≥3)**: The meeting has just started; waiting for attendees to join before arming.
* **🍀 Active · Leaves at ≤ X**: Actively monitoring. Shows the exact attendee count that triggers an exit. Click once to turn OFF.
* **Hover Tooltip**: Hovering your cursor over the pill displays live stats (`Peak`, `Current`, `Threshold`) and a **Reset Peak** button.

---

## ⚡ Exit Presets & Live Telemetry

You can choose from three built-in presets in the extension popup:

![IrishExit Popup & Live Telemetry](store-assets/screenshot-2-popup.png)

| Preset | Drop Threshold | Safety Floor | Delay | Best Used For |
| :--- | :---: | :---: | :---: | :--- |
| **Quick Exit** | 20% drop | ≤ 3 people | 1 sec | Fast syncs where meetings end promptly |
| **Balanced (Default)** | 30% drop | ≤ 2 people | 2 sec | Everyday team meetings & presentations |
| **Patient** | 40% drop | ≤ 2 people | 2 sec | Large webinars or Q&A sessions with high attendee fluctuation |

---

## ⏱️ Smart Activation Threshold (Default: `3 people`)

* **What is it?** IrishExit waits until at least **3 people** have entered the meeting before it begins watching for drops.
* **Why this matters:** When you join a meeting room early and only 1 or 2 people are there, you don't want the extension to trigger an immediate exit. IrishExit stays in a **"Waiting"** state until the call is in session.

---

## 🔒 3-Layer Guaranteed Hangup

When the exit threshold is reached, IrishExit disconnects in three robust stages:
1. **Official Hangup**: Programmatically triggers Google Meet's red **Leave call** button.
2. **Dialog Bypass**: Automatically clicks **"Just leave the call"** if the host confirmation popup appears.
3. **WebRTC Failsafe**: Guarantees your microphone and camera stop transmitting by navigating to the Meet end screen (or closes the tab if enabled).

---

## 🛡️ Privacy & Security

![Preferences & Privacy](store-assets/screenshot-4-preferences.png)

* **100% Local**: IrishExit runs entirely in your local browser sandbox.
* **Zero Telemetry**: No external servers, no tracking, no analytics, no cookies collected.
* **No Recording**: IrishExit only reads the participant count displayed on your screen. It never captures, records, or transmits audio or video.

---

## 💬 Frequently Asked Questions

#### Q: Is IrishExit on by default?
**No.** Every meeting starts with IrishExit **OFF** so it never interrupts calls you want to stay in until the very end. You can arm it with one click using the top-right button in Meet or check *"Auto-turn ON for every new call"* in settings.

#### Q: What if someone's connection temporarily drops?
The **Confirmation Delay** (default 2 seconds) ensures temporary disconnects or page reloads don't cause a premature exit.

#### Q: How do I reset the peak if a lot of people leave early for a break?
Simply click **"Reset Peak"** in the extension popup or the in-call hover menu. It immediately sets the peak to the current attendee count.
