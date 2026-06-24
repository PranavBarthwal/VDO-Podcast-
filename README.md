# Blog Listener Chrome Extension

Blog Listener is a Manifest V3 Chrome extension that reads blog posts and article pages aloud using the browser's built-in text-to-speech engine.

## Features

- Detects the most likely article content on blog pages.
- Skips common non-article text such as dates, captions, bylines, share controls, ads, related posts, and newsletter prompts.
- Reads the article aloud with play, pause/resume, and stop controls.
- Adds a compact bottom-left Play button and floating player to the current page.
- Lets you choose voice, speed, and pitch from the extension popup.
- Stores speech settings with Chrome sync storage.
- Runs only on the active tab after you open the extension popup.

## Load the Extension in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose the `dist` folder inside this project: `C:\Users\Pranav\Documents\Projects\VDO-Podcast-\dist`.
5. Open a blog post, click the Blog Listener extension icon, and press **Play**.

## Build

Run this after changing extension source files:

```powershell
.\scripts\build.cmd
```

## Project Structure

```text
manifest.json
popup.html
src/
  background.js
  content.css
  content.js
  popup.css
  popup.js
```

## Notes

- Chrome internal pages, extension pages, and restricted browser pages cannot be read.
- Speech quality and available voices depend on the operating system and browser.
- Some websites render content lazily. If no article is detected, scroll the page or refresh it before opening the extension.
