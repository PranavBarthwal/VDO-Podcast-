const assert = require("node:assert/strict");
const path = require("node:path");

// Use real Chrome audio decoding and its playback clock with a local WAV fixture.
// This avoids API charges and never reads an API key.
function wave(duration = 2) {
  const rate = 24000;
  const samples = duration * rate;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write("RIFF"); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(rate, 24); bytes.writeUInt32LE(rate * 2, 28);
  bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write("data", 36);
  bytes.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++) bytes.writeInt16LE(Math.round(Math.sin(i / rate * Math.PI * 440 * 2) * 100), 44 + i * 2);
  return "data:audio/wav;base64," + bytes.toString("base64");
}

async function test() {
  const packageRoot = process.env.CODEX_NODE_MODULES;
  const { chromium } = packageRoot ? require(path.join(packageRoot, "playwright")) : require("playwright");
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: true, args: ["--mute-audio"]
  });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));
    const paragraph = "This is a readable paragraph for testing the listening controls with actual decoded audio. Every sentence contains enough words for the article detector to keep this paragraph in the playlist.";
    await page.setContent(`<article><h1>Playback test article</h1>${Array.from({ length: 6 }, (_, i) => `<p>Section ${i}. ${paragraph}</p>`).join("")}</article>`);
    await page.evaluate((audio) => {
      const listeners = [];
      const requests = [];
      const jobs = new Map();
      window.__testRequests = requests;
      window.chrome = {
        storage: { sync: { get: async () => ({ speechSettings: { rate: 1 } }) } },
        runtime: {
          onMessage: { addListener(fn) { listeners.push(fn); } },
          async sendMessage(message) {
            if (message.type === "BLOG_LISTENER_SPEECH_CONFIG") return { configured: true };
            if (message.type === "BLOG_LISTENER_GENERATE_SPEECH") {
              requests.push(message.text);
              return new Promise((resolve) => {
                const timer = setTimeout(() => { jobs.delete(message.requestId); resolve({ ok: true, audio }); }, 80);
                jobs.set(message.requestId, { timer, resolve });
              });
            }
            if (message.type === "BLOG_LISTENER_CANCEL_SPEECH") {
              const job = jobs.get(message.requestId);
              if (job) { clearTimeout(job.timer); job.resolve({ ok: false, error: "Cancelled" }); jobs.delete(message.requestId); }
            }
            return { ok: true };
          }
        }
      };
      window.__dispatch = (payload) => new Promise((resolve) => {
        for (const listener of listeners) listener(payload, {}, resolve);
      });
      // Capture the instance without exposing test-only hooks in shipped code.
      window.__capturePlayer = (Player) => class extends Player {
        constructor(options) { super(options); window.__testPlayer = this; }
      };
    }, wave());
    await page.addScriptTag({ path: path.join(__dirname, "../src/voices.js") });
    await page.addScriptTag({ path: path.join(__dirname, "../src/audio-player.js") });
    await page.evaluate(() => { window.BlogAudioPlayer = window.__capturePlayer(window.BlogAudioPlayer); });
    await page.addScriptTag({ path: path.join(__dirname, "../src/content.js") });
    await page.addStyleTag({ path: path.join(__dirname, "../src/content.css") });
    await page.waitForFunction(() => window.__testPlayer.cache.size === 2);
    assert.equal(await page.evaluate(() => window.__testRequests.length), 2, "Page load prepares the first two paragraphs");
    assert.equal(await page.evaluate(() => window.__testPlayer.active), false);
    await page.locator("[data-action=play]").click();
    await page.waitForFunction(() => window.__testPlayer.scheduled.length === 2);
    await page.waitForFunction(() => {
      const bubble = document.querySelector(".blog-listener-word-highlight");
      return bubble && !bubble.hidden && bubble.getBoundingClientRect().width > 0;
    });
    const initialBubble = await page.locator(".blog-listener-word-highlight").evaluate((bubble) => ({
      left: bubble.getBoundingClientRect().left,
      top: bubble.getBoundingClientRect().top,
      background: getComputedStyle(bubble).backgroundImage
    }));
    assert.match(initialBubble.background, /255, 45, 85/, "Restore the original reading bubble appearance");
    await page.waitForFunction((start) => {
      const bubble = document.querySelector(".blog-listener-word-highlight");
      const rect = bubble?.getBoundingClientRect();
      return rect && !bubble.hidden && (Math.abs(rect.left - start.left) > 2 || Math.abs(rect.top - start.top) > 2);
    }, initialBubble);
    const starts = await page.evaluate(() => window.__testPlayer.scheduled.map(({ start, end }) => ({ start, end })));
    for (let i = 1; i < starts.length; i++) assert.equal(starts[i].start, starts[i - 1].end);
    await page.evaluate(() => {
      window.__dispatch({ type: "BLOG_LISTENER_PLAY" });
      window.__dispatch({ type: "BLOG_LISTENER_PLAY" });
    });
    assert.equal(await page.evaluate(() => window.__testRequests.length), 2, "Repeated Play must not restart generation");
    await page.waitForFunction(() => window.__testPlayer.index === 1 && window.__testRequests.length === 3);
    assert.equal(await page.evaluate(() => window.__testRequests.length), 3, "Entering paragraph two prepares only paragraph three");
    await page.evaluate(() => window.__testPlayer.seek(-99));
    await page.locator("[data-action=play]").click();
    const paused = await page.evaluate(() => ({ offset: window.__testPlayer.offset, paused: window.__testPlayer.paused }));
    assert.equal(paused.paused, true);
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => window.__testPlayer.offset), paused.offset);
    await page.locator("[data-action=forward]").click();
    await page.waitForFunction(() => !window.__testPlayer.seeking);
    const forward = await page.evaluate(() => ({ index: window.__testPlayer.index, offset: window.__testPlayer.offset, paused: window.__testPlayer.paused }));
    assert.equal(forward.index, 2);
    assert(Math.abs(forward.offset - (paused.offset + 1)) < 0.05);
    assert.equal(forward.paused, true);
    await page.locator("[data-action=rewind]").click();
    await page.waitForFunction(() => !window.__testPlayer.seeking);
    assert.equal(await page.evaluate(() => window.__testPlayer.index), 0);
    await page.locator("[data-action=play]").click();
    await page.waitForFunction(() => window.__testPlayer.offset > 0.2);
    const popup = await browser.newPage();
    popup.on("pageerror", (error) => pageErrors.push(error.message));
    await popup.exposeFunction("__sendToTab", (_tabId, payload) => page.evaluate((message) => window.__dispatch(message), payload));
    await popup.addInitScript(() => {
      window.chrome = {
        storage: { sync: { get: async () => ({}), set: async () => {} },
          local: { get: async () => ({}), set: async () => {} } },
        tabs: { query: async () => [{ id: 1, url: "https://example.com/article" }],
          sendMessage: (tabId, payload) => window.__sendToTab(tabId, payload) },
        runtime: { onMessage: { addListener() {} } },
        scripting: { insertCSS: async () => {}, executeScript: async () => {} }
      };
    });
    await popup.goto("file:///" + path.join(__dirname, "../popup.html").replaceAll("\\", "/"));
    await popup.waitForFunction(() => !document.querySelector("#pauseButton").disabled);
    await popup.locator("#pauseButton").click();
    await popup.waitForFunction(() => document.querySelector("#pauseButton").textContent === "Resume");
    assert.equal(await page.evaluate(() => window.__testPlayer.paused), true);
    await popup.locator("#pauseButton").click();
    await popup.waitForFunction(() => document.querySelector("#pauseButton").textContent === "Pause");
    assert.equal(await page.evaluate(() => window.__testPlayer.paused), false);
    const generated = await page.evaluate(() => window.__testRequests);
    assert.equal(new Set(generated).size, generated.length, "Controls must not regenerate cached text");
    await page.locator("[data-action=stop]").click();
    assert.equal(await page.evaluate(() => window.__testPlayer.active), false);
    assert.deepEqual(pageErrors, []);
    console.log("Chrome audio checks passed: page-load preparation, paragraph-two trigger, real WAV decoding, contiguous scheduling and page/popup controls.");
  } finally {
    await browser.close();
  }
}

test().catch((error) => { console.error(error); process.exitCode = 1; });
