# Blog Listener Chrome Extension

Blog Listener is a Manifest V3 Chrome extension that reads blog posts and article pages aloud using OpenAI's `gpt-4o-mini-tts-2025-12-15` model. Ash is the default voice.

## Features

- Detects the most likely article content on blog pages.
- Skips common non-article text such as dates, captions, bylines, share controls, ads, related posts, and newsletter prompts.
- Reads the article aloud with play, pause/resume, and stop controls.
- Supports 5-second skip forward and 5-second back controls.
- Highlights the current article block while it is being read.
- Keeps pause/resume on the active speech position.
- Simulates podcast-style sponsored breaks with an ad title and redirect link in the player.
- Shows upcoming ad breaks as small markers on the progress bar.
- Adds a compact bottom-left Play button and floating player to the current page.
- Shows a circular Play button with a brief “Listen to this article?” prompt before playback starts. The prompt disappears after nine seconds and reappears on hover or keyboard focus.
- Reveals a smaller **AI Brief** button above that prompt on hover or keyboard focus. Clicking it creates a medium-length spoken summary with OpenAI's `gpt-4o-mini` through the [Responses API](https://developers.openai.com/api/docs/guides/text), then reads it with the selected voice and speed. The article's word-following bubble stays hidden during the brief.
- Uses a compact black-and-white player. Its speed button opens listening settings with 0.7–2.0× speed controls and nine voice choices with short descriptions.
- Lets you save an OpenAI API key locally in the extension popup.
- Stores speech settings with Chrome sync storage.

## Load the Extension in Chrome

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Select **Load unpacked**.
4. Choose the `dist` folder inside this project: `C:\Users\Pranav\Documents\Projects\VDO-Podcast-\dist`.
5. Open the extension popup, enter your OpenAI API key, and click **Save API key**.
6. Open or refresh a blog post, then use the black Play button in the bottom-left corner. Once playback starts, click **1×** to adjust speed or choose a voice.

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
  audio-player.js
  background.js
  content.css
  content.js
  popup.css
  popup.js
```

## Notes

- Chrome internal pages, extension pages, and restricted browser pages cannot be read.
- Speech requires internet access and an OpenAI API key with speech model access. With a key configured, the first two paragraphs are sent to OpenAI on page load; subsequent paragraphs are prepared as listening advances. API usage is billed to your account, including initial preparation even if you do not press Play.
- AI Brief sends article text to OpenAI only when clicked. It includes at most 60,000 characters, using the beginning and end of very long articles. Summary generation and speech are billed to your account. Stop cancels a summary request in progress.
- The key is stored locally, is not synced, and is accessed only by extension pages and the service worker. For a shared/public deployment, use a backend to manage credentials.
- With an API key configured, page load prepares the first two paragraphs without playing them. Play reuses that audio; if pressed early, it waits until both paragraphs are ready. Entering paragraph two prepares paragraph three, entering paragraph three prepares paragraph four, and so on. At most two speech requests run concurrently. Long paragraphs are split into safe segments and prepared together.
- Pause/resume preserves the exact audio position. Five-second seeking uses decoded audio durations and reuses buffered audio, including across paragraphs and sponsor breaks.
- Speed changes take effect immediately using buffered audio. Voice changes before playback prepare the initial paragraphs in the new voice; changes during playback are saved for the next session (Stop, then Play), keeping current audio uninterrupted. Voice descriptions are approximate listening impressions. Supported voice IDs are documented in the [OpenAI text-to-speech guide](https://developers.openai.com/api/docs/guides/text-to-speech#voice-options).
- Session audio is cached up to 64 MiB. Initial generation, slow connections, and rewinding into evicted audio can show “Buffering…”. Stop cancels pending requests.
- Speech generation allows up to two minutes per request. A hidden extension document handles audio downloads so Chrome's service-worker fetch limit does not cut slow generation short. Requires Chrome 116 or newer.
- Word highlighting remains approximate because generated MP3 audio has no word timestamps.
- Articles inserted after page load are detected automatically. Page updates reuse audio for unchanged text, including requests already in progress. Preparation runs quietly; the player shows “Buffering…” only when playback is waiting for audio.

## Playback checks

```powershell
node scripts/test-speech.cjs
node scripts/test-audio-player.cjs
```

`scripts/test-speech-browser.cjs` additionally tests real WAV decoding and the page/popup controls in isolated headless Chrome. It requires Playwright; set `CODEX_NODE_MODULES` to its package directory when using bundled dependencies. It uses local audio fixtures and does not call OpenAI.

`scripts/test-dynamic-preload.cjs` uses the same browser setup to check delayed article rendering, replaced paragraph elements, appended content, and preventing preparation after Stop.

`scripts/test-widget.cjs` checks the compact widget, speed controls, voice selection, saved settings, keyboard dismissal, and narrow screen layout using local audio fixtures. Set `WIDGET_PREVIEW_DIR` to save rendered UI screenshots.

`scripts/test-ai-brief-browser.cjs` checks the AI Brief hover action, summary playback without article highlighting, cancellation, errors, and return to normal article playback using mocked API responses.
