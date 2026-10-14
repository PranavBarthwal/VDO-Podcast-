const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

async function test() {
  const packageRoot = process.env.CODEX_NODE_MODULES;
  const { chromium } = packageRoot ? require(path.join(packageRoot, "playwright")) : require("playwright");
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: true, args: ["--mute-audio"] });
  const wav = Buffer.alloc(44 + 8000 * 2 * 30);
  wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(wav.length - 44, 40);
  try {
    const page = await browser.newPage({ viewport: { width: 1024, height: 800 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const text = "The rhythm of a good story leaves room to think. Listening brings a different perspective to familiar words, turning the everyday moments between tasks into time for discovery. This article explores how thoughtful design can make that experience feel natural, comfortable, and easy to return to.";
    await page.setContent(`<style>body { margin: 0; background: #f6f5f2; color: #333; font: 16px/1.8 Georgia, serif; } article { max-width: 620px; margin: 60px auto; } h1 { font-size: 32px; } </style><article><h1>A little room to listen</h1>${Array.from({ length: 5 }, (_, i) => `<p>Chapter ${i + 1}. ${text}</p>`).join("")}</article>`);
    await page.evaluate((audio) => {
      window.requests = [];
      window.saved = { rate: 1, voice: "ash" };
      const listeners = [];
      window.chrome = {
        storage: { sync: { get: async () => ({ speechSettings: { ...window.saved } }), set: async ({ speechSettings }) => { window.saved = { ...speechSettings }; } } },
        runtime: { onMessage: { addListener(fn) { listeners.push(fn); } }, async sendMessage(message) {
          if (message.type === "BLOG_LISTENER_SPEECH_CONFIG") return { configured: true };
          if (message.type === "BLOG_LISTENER_GENERATE_SPEECH") {
            window.requests.push({ text: message.text, voice: message.voice });
            await new Promise((resolve) => setTimeout(resolve, 60));
            return { ok: true, audio };
          }
          return { ok: true };
        } }
      };
      window.dispatch = (message) => new Promise((resolve) => listeners.forEach((fn) => fn(message, {}, resolve)));
    }, "data:audio/wav;base64," + wav.toString("base64"));
    for (const file of ["voices.js", "audio-player.js"]) await page.addScriptTag({ path: path.join(__dirname, "../src", file) });
    await page.evaluate(() => {
      const Player = window.BlogAudioPlayer;
      window.BlogAudioPlayer = class extends Player { constructor(options) { super(options); window.player = this; } };
    });
    await page.addScriptTag({ path: path.join(__dirname, "../src/content.js") });
    await page.addStyleTag({ path: path.join(__dirname, "../src/content.css") });
    await page.waitForFunction(() => window.player.cache.size === 2);
    const idle = await page.locator(".blog-listener-player").boundingBox();
    assert.equal(idle.width, 54);
    assert.equal(idle.height, 54);
    assert.equal(await page.locator(".blog-listener-nudge").textContent(), "Listen to this article?");
    assert.equal(await page.locator(".blog-listener-nudge").isVisible(), true);
    assert.equal(await page.locator("[data-action=settings]").isVisible(), false);
    assert.equal(await page.locator(".blog-listener-playback-status").textContent(), "");
    assert.equal(await page.locator(".blog-listener-playback-status").isVisible(), false);
    if (process.env.WIDGET_PREVIEW_DIR) {
      fs.mkdirSync(process.env.WIDGET_PREVIEW_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.WIDGET_PREVIEW_DIR, "widget-idle.png"), clip: { x: 8, y: 680, width: 120, height: 110 } });
    }
    await page.locator("[data-action=play]").click();
    await page.waitForFunction(() => window.player.scheduled.length === 2);
    assert.equal(await page.locator(".blog-listener-nudge").isVisible(), false);
    await page.locator("[data-action=settings]").click();
    assert.equal(await page.locator(".blog-listener-voice-option").count(), 9);
    await page.locator("[data-action=faster]").click();
    await page.waitForFunction(() => window.player.rate === 1.1);
    await page.locator("[data-action=slower]").click();
    await page.waitForFunction(() => window.player.rate === 1);
    assert.equal(await page.evaluate(() => window.requests.length), 2, "Speed must reuse prepared audio");
    await page.locator(".blog-listener-voice-option").filter({ has: page.locator("input[value=nova]") }).click();
    await page.waitForFunction(() => window.saved.voice === "nova");
    assert.equal(await page.evaluate(() => window.requests.length), 2, "Voice choice must not interrupt the current session");
    await page.keyboard.press("Escape");
    assert.equal(await page.locator("[data-action=settings]").evaluate((node) => node === document.activeElement), true);
    const bounds = await page.locator(".blog-listener-player").boundingBox();
    assert(bounds.height <= 60 && bounds.width < 380, "Active player remains compact");
    await page.evaluate(() => window.player.seek(31));
    await page.waitForFunction(() => window.requests.length === 3);
    assert.equal(await page.evaluate(() => window.requests.at(-1).voice), "ash", "Current session keeps its voice");
    await page.locator("[data-action=stop]").click();
    assert.equal(await page.locator("[data-action=settings]").isVisible(), false);
    await page.evaluate(() => document.querySelector(".blog-listener-player").classList.add("blog-listener-nudge-hidden"));
    await page.mouse.move(500, 200);
    assert.equal(await page.locator(".blog-listener-nudge").isVisible(), false);
    await page.locator("[data-action=play]").hover();
    assert.equal(await page.locator(".blog-listener-nudge").isVisible(), true);
    await page.locator("[data-action=play]").click();
    await page.waitForFunction(() => window.player.scheduled.length === 2);
    assert.deepEqual(await page.evaluate(() => window.requests.slice(-2).map((r) => r.voice)), ["nova", "nova"]);
    await page.locator("[data-action=settings]").click();
    await page.locator(".blog-listener-voice-option").filter({ has: page.locator("input[value=onyx]") }).click();
    await page.waitForFunction(() => window.saved.voice === "onyx");
    assert.equal(await page.evaluate(() => window.player.active), true);
    assert.equal(await page.evaluate(() => window.requests.length), 5, "Voice selection must not interrupt active audio");
    if (process.env.WIDGET_PREVIEW_DIR) {
      fs.mkdirSync(process.env.WIDGET_PREVIEW_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.WIDGET_PREVIEW_DIR, "widget-settings.png"), clip: { x: 8, y: 260, width: 395, height: 530 } });
      await page.keyboard.press("Escape");
      await page.screenshot({ path: path.join(process.env.WIDGET_PREVIEW_DIR, "widget-player.png"), clip: { x: 8, y: 680, width: 395, height: 110 } });
    }
    await page.setViewportSize({ width: 320, height: 650 });
    const narrow = await page.locator(".blog-listener-player").boundingBox();
    assert(narrow.x >= 0 && narrow.x + narrow.width <= 320);
    if (await page.locator(".blog-listener-settings").isHidden()) await page.locator("[data-action=settings]").click();
    const panel = await page.locator(".blog-listener-settings").boundingBox();
    assert(panel.x >= 0 && panel.y >= 0 && panel.x + panel.width <= 320);
    await page.keyboard.press("Escape");
    await page.locator("[data-action=stop]").click();
    await page.locator("[data-action=play]").click();
    await page.waitForFunction(() => window.player.scheduled.length === 2);
    assert.deepEqual(await page.evaluate(() => window.requests.slice(-2).map((r) => r.voice)), ["onyx", "onyx"]);
    assert.deepEqual(errors, []);
    console.log("Widget checks passed: circular idle button, no readiness labels, sizing, keyboard dismissal, speed without new requests, voice persistence and uninterrupted playback.");
  } finally { await browser.close(); }
}
test().catch((error) => { console.error(error); process.exitCode = 1; });
