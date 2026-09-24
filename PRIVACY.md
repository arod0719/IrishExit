# Privacy Policy for IrishExit

**Effective Date:** September 24, 2026  
**Last Updated:** September 24, 2026  

---

## 1. Introduction

**IrishExit** ("we", "our", or "the extension") is a lightweight Chrome extension designed to automatically disconnect you from Google Meet calls when attendee numbers drop. 

We believe that browser extensions should respect user privacy. IrishExit is engineered from the ground up with a **privacy-by-design, 100% client-side architecture**. **We do not collect, store, transmit, sell, or monetize any user data whatsoever.**

---

## 2. Information We Do NOT Collect

To be completely explicit, IrishExit does **NOT** collect, access, log, or transmit any of the following:

- **Personal Information:** No names, email addresses, Google account information, profile pictures, or user identifiers.
- **Audio & Video Streams:** IrishExit never accesses, intercepts, records, or analyzes microphone audio, camera video, or screen sharing.
- **Meeting Content:** IrishExit never reads, logs, or stores meeting titles, chat messages, closed captions, transcripts, notes, shared files, or meeting codes.
- **Browsing History:** IrishExit does not track the websites you visit or your browsing activity. It only runs when you are actively on a `https://meet.google.com/*` webpage.
- **Device & Location Data:** No IP addresses, geolocation data, hardware IDs, or device fingerprints are collected.
- **Telemetry & Analytics:** IrishExit contains zero third-party tracking scripts, zero Google Analytics, zero advertising trackers, and zero crash-reporting pings to external servers.

---

## 3. What the Extension Reads Locally

To perform its single intended function, IrishExit operates exclusively inside your browser's local sandbox:

1. **Participant Count Number**: The content script inspects the publicly visible participant badge counter in the Google Meet interface (e.g., the number `"12"`). This number is processed purely in local memory to calculate whether meeting attendance has dropped past your configured threshold.
2. **Leave Call Button**: When the exit threshold is met, the extension simulates a click on the standard Google Meet "Leave call" button.

This information is processed **entirely in volatile browser memory** and is **never transmitted across the network**.

---

## 4. Permissions & Justifications

IrishExit requests only the minimum permissions necessary to function in accordance with the Chrome Web Store Least Privilege principle:

| Permission | Purpose |
| :--- | :--- |
| `host_permissions` (`https://meet.google.com/*`) | Required to monitor the participant count and interact with the leave call button exclusively on Google Meet domains. |
| `storage` | Required solely to save your local user preferences (such as drop percentage, exit delay, and audio chime toggle) in `chrome.storage.local`. This data stays on your machine. |
| `alarms` | Required for reliable periodic polling and timing checks in Manifest V3 service workers while a meeting is in progress. |
| `tabs` & `scripting` | Required to detect when a Google Meet tab is open and inject the client-side controller script. |

---

## 5. Third-Party Sharing & Remote Code

- **Zero Data Sharing:** Because we collect no data, no user information is ever shared, sold, rented, or transferred to third parties.
- **Zero Remote Code:** IrishExit complies strictly with Manifest V3 policies. All code, scripts, styles, and assets are bundled locally within the extension package. No remote scripts or dynamic code evaluation (`eval()`) are executed.

---

## 6. Data Retention & Deletion

IrishExit stores user settings (such as sensitivity thresholds) exclusively in `chrome.storage.local` on your local computer. 
- You can reset all data at any time by clearing extension data or uninstalling IrishExit.
- Uninstalling the extension permanently and immediately removes all local settings from your device.

---

## 7. Open Source & Transparency

IrishExit is an open-source project released under the MIT License. The complete source code is publicly inspectable and verifiable on GitHub:  
👉 **[https://github.com/arod0719/IrishExit](https://github.com/arod0719/IrishExit)**

---

## 8. Changes to This Privacy Policy

If we update this Privacy Policy, the revised version will be posted directly to our GitHub repository with an updated "Last Updated" date.

---

## 9. Contact Us

If you have questions, feedback, or security concerns regarding IrishExit's privacy practices, please open an issue on our GitHub repository:  
👉 **[https://github.com/arod0719/IrishExit/issues](https://github.com/arod0719/IrishExit/issues)**
