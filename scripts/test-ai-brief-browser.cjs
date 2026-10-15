const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

async function test() {
  const modules = process.env.CODEX_NODE_MODULES;
  const { chromium } = modules ? require(path.join(modules, "playwright")) : require("playwright");
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe",
    headless: true, args: ["--mute-audio"] });
  const wav = Buffer.alloc(44 + 32000);
  wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(32000, 40);
  const paragraph = "The article describes the key finding and the people involved in a detailed account. It gives background, explains what happened, and explores why the outcome matters to readers. The report presents a clear sequence of events with enough context to follow the story.";
  const summary = "The story explains its central finding and the context behind it. ".repeat(18).trim();
  try {
    const page = await browser.newPage({ viewport: { width: 980, height: 750 } });
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.setContent(`<article style="max-width:650px;margin:40px auto;font:18px/1.6 Georgia"><h1>Article for AI Brief</h1>${Array.from({ length: 4 }, (_, i) => `<p>Paragraph ${i + 1}. ${paragraph}</p>`).join("")}</article>`);
    await page.evaluate(({ audio, summary }) => {
      window.saved = { rate: 1, voice: "ash" };
      window.speech = []; window.briefs = []; window.cancelled = []; window.briefMode = "success";
      const pending = new Map();
      const listeners = [];
      window.chrome = {
        storage: { sync: { get: async () => ({ speechSettings: { ...window.saved } }), set: async ({ speechSettings }) => { window.saved = speechSettings; } } },
        runtime: { onMessage: { addListener(fn) { listeners.push(fn); } }, async sendMessage(message) {
          if (message.type === "BLOG_LISTENER_SPEECH_CONFIG") return { configured: true };
          if (message.type === "BLOG_LISTENER_GENERATE_SPEECH") {
            window.speech.push(message);
            await new Promise((resolve) => setTimeout(resolve, 50));
            return { ok: true, audio };
          }
          if (message.type === "BLOG_LISTENER_GENERATE_BRIEF") {
            window.briefs.push(message);
            if (window.briefMode === "hold") return new Promise((resolve) => pending.set(message.requestId, resolve));
            if (window.briefMode === "fail") return { ok: false, error: "Summary request failed." };
            await new Promise((resolve) => setTimeout(resolve, 100));
            return { ok: true, summary };
          }
          if (message.type === "BLOG_LISTENER_CANCEL_BRIEF") {
            window.cancelled.push(message.requestId);
            pending.get(message.requestId)?.({ ok: true, summary });
            pending.delete(message.requestId);
          }
          return { ok: true };
        } }
      };
      window.dispatch = (message) => new Promise((resolve) => listeners.forEach((fn) => fn(message, {}, resolve)));
    }, { audio: "data:audio/wav;base64," + wav.toString("base64"), summary });
    for (const file of ["voices.js", "audio-player.js", "content.js"]) await page.addScriptTag({ path: path.join(__dirname, "../src", file) });
    await page.addStyleTag({ path: path.join(__dirname, "../src/content.css") });
    await page.waitForFunction(() => window.speech.length === 2);
    assert.equal(await page.locator("[data-action=brief]").isVisible(), false);
    await page.locator("[data-action=play]").hover();
    assert.equal(await page.locator("[data-action=brief]").isVisible(), true);
    const bubble = await page.locator("[data-action=brief]").boundingBox();
    const prompt = await page.locator(".blog-listener-nudge").boundingBox();
    assert(bubble.y + bubble.height < prompt.y, "AI Brief is above the listening prompt");
    if (process.env.WIDGET_PREVIEW_DIR) {
      fs.mkdirSync(process.env.WIDGET_PREVIEW_DIR, { recursive: true });
      await page.screenshot({ path: path.join(process.env.WIDGET_PREVIEW_DIR, "ai-brief-hover.png"),
        clip: { x: 8, y: 510, width: 260, height: 230 } });
    }
    await page.evaluate(() => { window.saved.voice = "nova"; });
    await page.locator("[data-action=brief]").click();
    await page.waitForFunction(() => window.briefs.length === 1);
    assert.equal(await page.locator(".blog-listener-title").textContent(), "Creating AI Brief…");
    assert((await page.evaluate(() => window.briefs[0].text)).includes("key finding"));
    await page.waitForFunction(() => window.speech.some((request) => request.text.includes("central finding")));
    assert.equal(await page.evaluate(() => window.speech.at(-1).voice), "nova");
    assert.equal(await page.locator(".blog-listener-word-highlight:not([hidden])").count(), 0);
    await page.locator("[data-action=stop]").click();

    await page.evaluate(() => { window.briefMode = "hold"; });
    await page.locator("[data-action=play]").hover();
    await page.locator("[data-action=brief]").click();
    await page.waitForFunction(() => window.briefs.length === 2);
    await page.locator("[data-action=stop]").click();
    await page.waitForFunction(() => window.cancelled.length === 1);
    assert.equal(await page.locator(".blog-listener-player").evaluate((node) => node.classList.contains("blog-listener-idle")), true);

    await page.evaluate(() => { window.briefMode = "fail"; });
    await page.locator("[data-action=play]").hover();
    await page.locator("[data-action=brief]").click();
    await page.waitForFunction(() => document.querySelector(".blog-listener-title")?.textContent === "Summary request failed.");
    await page.locator("[data-action=play]").click();
    await page.waitForFunction(() => document.querySelector(".blog-listener-word-highlight:not([hidden])"));
    assert.deepEqual(errors, []);
    console.log("AI Brief browser checks passed: hover action, summary speech, hidden article highlight, Stop cancellation, error and normal playback recovery.");
  } finally { await browser.close(); }
}
test().catch((error) => { console.error(error); process.exitCode = 1; });
