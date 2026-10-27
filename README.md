# AeroRecord — Tab & Screen Recorder Chrome Extension

A clean, high-performance Google Chrome Extension (Manifest V3) for recording tabs with resolution selection (720p & 1080p), hybrid mobile-mode cropping, no recording duration limits via OPFS streaming, and MP4/WebM export.

---

## 🌟 Key Features

- **Resolution Options**: Switch between **720p HD** (1280×720 @ 3.5 Mbps) for lightweight files and **1080p Full HD** (1920×1080 @ 7.5 Mbps) for ultra-crisp demos and presentations.
- **Single Tab Recording**: Clean tab capture via `chrome.tabCapture` without capturing operating system notifications or extraneous desktop windows.
- **No Time Limits (Unlimited Duration)**: Built on the browser's **Origin Private File System (OPFS)**. Video chunks stream continuously to disk instead of accumulating in RAM, completely preventing memory leaks and out-of-memory browser crashes.
- **Intelligent Mobile Mode Handling**:
  - **Auto-Detection**: Automatically detects if the active tab is using DevTools mobile emulation, responsive narrow viewport (`<= 768px`), or a centered mobile phone preview container.
  - **Interactive Frame Selector ("Pick Frame")**: Allows you to click any element or phone mockup on the page to crop and record only that region.
  - **Automatic Scaling**: Crops the canvas directly to standard mobile proportions (e.g. 720×1280 or 1080×1920) without dark pillarboxes or wasted space.
- **Dual Audio Support**: Records internal tab audio by default, with an optional toggle for microphone commentary mixed via the Web Audio API.
- **Direct MP4 Export**: Encodes directly to **MP4 (H.264/AAC)** with automatic WebM fallback (including automatic EBML duration header patching for seekability).
- **Floating Tab Pill**: When recording, an unobtrusive floating bar appears on the active tab showing the elapsed timer, Pause/Resume, and Stop & Save buttons so you don't need to re-open the popup.

---

## 📁 File Structure

```
screen-recorder/
├── manifest.json                  # Chrome Extension Manifest V3 configuration
├── README.md                      # Documentation and usage instructions
├── test/
│   └── mobile-demo.html           # Interactive test playground with phone simulator & sound
├── src/
│   ├── icons/                     # Extension icons (16px, 32px, 48px, 128px)
│   │   ├── icon16.png
│   │   ├── icon32.png
│   │   ├── icon48.png
│   │   └── icon128.png
│   ├── background/
│   │   └── service-worker.js      # Lifecycle manager, tabCapture, offscreen coordinator
│   ├── offscreen/
│   │   ├── offscreen.html         # Offscreen DOM host
│   │   └── offscreen.js           # Canvas 60fps cropping, audio mixer, OPFS streaming, MediaRecorder
│   ├── content/
│   │   ├── content.js             # Mobile detector, frame picker, floating in-tab pill
│   │   └── content.css            # Floating pill and picker styling
│   ├── popup/
│   │   ├── popup.html             # Glassmorphic dark-mode popup UI
│   │   ├── popup.css              # Modern design system & micro-animations
│   │   └── popup.js               # Settings, timer, and action triggers
│   └── utils/
│       ├── constants.js           # Message actions, resolutions, and status codes
│       ├── storage.js             # Chrome sync/local storage helpers
│       └── webm-fixer.js          # EBML duration patcher for seekable WebM
```

---

## 🚀 How to Install and Run in Google Chrome

1. Open **Google Chrome** and navigate to:
   ```
   chrome://extensions/
   ```
2. Enable **Developer mode** using the toggle in the top-right corner.
3. If you have already loaded AeroRecord previously, click the **Reload button (circular arrow)** on the AeroRecord card. Otherwise, click **Load unpacked** and select `D:\Projects\screen-recorder`.
4. **Important for testing local HTML files**:
   - On the AeroRecord card in `chrome://extensions/`, click **Details**.
   - Scroll down and toggle **"Allow access to file URLs"** to **ON**. (Chrome blocks all extensions from accessing local `file:///` URLs unless this toggle is enabled).

---

## 🧪 Testing the Extension

1. Open any regular website (e.g. `https://google.com` or `https://github.com`) or open `test/mobile-demo.html`.
   *(Note: Chrome strictly prohibits screen recording on internal `chrome://` pages like the Extensions page or the blank New Tab page).*
2. Click the **AeroRecord** extension icon in your Chrome toolbar.
3. Choose **1080p** or **720p**, and select **Auto Mobile**, **Pick Frame**, or **Full Tab**.
4. Click **Record This Tab**:
   - Tab capture initiates instantly with user gesture validation.
   - The floating control pill appears on the tab displaying the live timer and controls.
5. Click **Stop & Save** on the floating pill or in the popup:
   - Your recording is assembled and immediately downloaded into your **Downloads** folder.
