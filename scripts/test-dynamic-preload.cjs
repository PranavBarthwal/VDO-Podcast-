const assert = require("node:assert/strict");
const path = require("node:path");
const paragraph = "This article paragraph contains enough readable words to be recognised by the reader. It describes a sporting event and provides details for readers who want to listen while browsing the page. The report includes the players involved, the events of the day, and additional context about the competition and upcoming matches.";
const markup = (count) => `<article><h1>Dynamic article</h1>${Array.from({ length: count }, (_, i) => `<p>Paragraph ${i + 1}. ${paragraph}</p>`).join("")}</article>`;
const wav = Buffer.alloc(44 + 32000);
wav.write("RIFF"); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28); wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34);
wav.write("data", 36); wav.writeUInt32LE(32000, 40);

async function mount(browser, html) {
  const page = await browser.newPage();
  await page.setContent(html);
  await page.evaluate((audio) => {
    window.requests = [];
    const listeners = [];
    window.chrome = {
      storage: { sync: { get: async () => ({ speechSettings: { rate: 1 } }) } },
      runtime: { onMessage: { addListener(fn) { listeners.push(fn); } }, async sendMessage(message) {
        if (message.type === "BLOG_LISTENER_SPEECH_CONFIG") return { configured: true };
        if (message.type === "BLOG_LISTENER_GENERATE_SPEECH") {
          window.requests.push(message.text);
          await new Promise((resolve) => setTimeout(resolve, 100));
          return { ok: true, audio };
        }
        return { ok: true };
      } }
    };
    window.dispatch = (payload) => new Promise((resolve) => listeners.forEach((fn) => fn(payload, {}, resolve)));
  }, "data:audio/wav;base64," + wav.toString("base64"));
  await page.addScriptTag({ path: path.join(__dirname, "../src/voices.js") });
  await page.addScriptTag({ path: path.join(__dirname, "../src/audio-player.js") });
  await page.evaluate(() => {
    const Player = window.BlogAudioPlayer;
    window.BlogAudioPlayer = class extends Player { constructor(options) { super(options); window.player = this; } };
  });
  await page.addScriptTag({ path: path.join(__dirname, "../src/content.js") });
  await page.addStyleTag({ path: path.join(__dirname, "../src/content.css") });
  return page;
}

async function test() {
  const packageRoot = process.env.CODEX_NODE_MODULES;
  const { chromium } = packageRoot ? require(path.join(packageRoot, "playwright")) : require("playwright");
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: ["--mute-audio"] });
  const failures = [];
  try {
    const late = await mount(browser, "<article><h1>Loading article</h1></article>");
    await late.waitForTimeout(150);
    await late.evaluate((html) => { document.querySelector("article").outerHTML = html; }, markup(4));
    await late.waitForTimeout(1000);
    try { assert.equal(await late.evaluate(() => window.requests.length), 2, "Article inserted after document_idle must preload two paragraphs"); }
    catch (error) { failures.push(error.message); }
    await late.close();

    const hydrated = await mount(browser, markup(2));
    await hydrated.waitForFunction(() => window.player.cache.size === 2);
    assert.equal(await hydrated.locator(".blog-listener-playback-status").textContent(), "");
    assert.equal(await hydrated.locator(".blog-listener-playback-status").isVisible(), false);
    await hydrated.evaluate((html) => { document.querySelector("article").outerHTML = html; }, markup(5));
    await hydrated.waitForTimeout(700);
    await hydrated.locator("[data-action=play]").click();
    await hydrated.waitForFunction(() => window.player.scheduled.length >= 2);
    try { assert.equal(await hydrated.evaluate(() => window.requests.length), 2,
      "Hydration and appended paragraphs must preserve the first two prepared audio files"); }
    catch (error) { failures.push(error.message); }
    await hydrated.locator("[data-action=stop]").click();
    await hydrated.evaluate(() => { document.querySelector("article p").append(" Updated after Stop."); });
    const stoppedRequests = await hydrated.evaluate(() => window.requests.length);
    await hydrated.waitForTimeout(700);
    assert.equal(await hydrated.evaluate(() => window.requests.length), stoppedRequests, "Stop must prevent background restart");
    await hydrated.close();
    assert.deepEqual(failures, []);
    console.log("Dynamic preload checks passed: delayed article, replaced DOM, appended paragraphs, cache reuse and Stop.");
  } finally { await browser.close(); }
}
test().catch((error) => { console.error(error); process.exitCode = 1; });
