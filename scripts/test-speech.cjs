const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const root = path.join(__dirname, "..");

async function test() {
  let listener;
  let key = "test-key";
  let request;
  let status = 200;
  let offscreenListener;
  let documentExists = false;
  let documentsCreated = 0;
  let heartbeatCount = 0;
  const timeouts = [];
  const offscreen = vm.createContext({
    chrome: { runtime: { id: "extension", onMessage: { addListener(fn) { offscreenListener = fn; } },
      sendMessage: async () => ({ ok: true }) } },
    fetch: async (url, options) => {
      request = { url, ...options };
      return { ok: status === 200, status, blob: async () => new Blob([new Uint8Array([1, 2, 3])]) };
    },
    AbortSignal: { timeout(ms) { timeouts.push(ms); return AbortSignal.timeout(ms); }, any: AbortSignal.any },
    AbortController, Uint8Array, Blob, btoa,
    setInterval() { heartbeatCount++; return 1; }, clearInterval() { heartbeatCount--; }
  });
  vm.runInContext(fs.readFileSync(path.join(root, "src/voices.js"), "utf8"), offscreen);
  vm.runInContext(fs.readFileSync(path.join(root, "src/speech-offscreen.js"), "utf8"), offscreen);
  const background = vm.createContext({
    chrome: {
      storage: {
        local: { setAccessLevel: async () => {}, get: async () => ({ openaiApiKey: key }) },
        sync: { get: async () => ({}), set: async () => {} }
      },
      tabs: { onRemoved: { addListener() {} } },
      offscreen: { async createDocument() { documentExists = true; documentsCreated++; } },
      runtime: { id: "extension", onInstalled: { addListener() {} },
        getURL: (file) => "chrome-extension://extension/" + file,
        getContexts: async () => documentExists ? [{}] : [],
        sendMessage: (message) => new Promise((resolve) => offscreenListener(message, { id: "extension" }, resolve)),
        onMessage: { addListener(fn) { listener = fn; } } }
    },
    AbortSignal, AbortController,
    importScripts: (file) => vm.runInContext(fs.readFileSync(path.join(root, "src", file), "utf8"), background)
  });
  vm.runInContext(fs.readFileSync(path.join(root, "src/background.js"), "utf8"), background);
  const result = await background.generateSpeech("Read this article.");
  assert.equal(result.audio, "data:audio/mpeg;base64,AQID");
  assert.equal(request.url, "https://api.openai.com/v1/audio/speech");
  assert.deepEqual(JSON.parse(request.body), {
    model: "gpt-4o-mini-tts-2025-12-15", voice: "ash", input: "Read this article.", response_format: "mp3"
  });
  await background.generateSpeech("Another voice.", undefined, "nova");
  assert.equal(JSON.parse(request.body).voice, "nova", "Selected voice reaches the speech API");
  const initialFetch = offscreen.fetch;
  const articleText = "A long article explains its central finding and the context around it. ".repeat(4);
  offscreen.fetch = async (url, options) => {
    request = { url, ...options };
    return { ok: true, status: 200, json: async () => ({ status: "completed",
      output: [{ content: [{ type: "output_text", text: "A clear medium-length summary." }] }] }) };
  };
  const brief = await background.generateBrief("Article title", articleText, new AbortController().signal);
  assert.equal(brief.summary, "A clear medium-length summary.");
  assert.equal(request.url, "https://api.openai.com/v1/responses");
  const briefBody = JSON.parse(request.body);
  assert.equal(briefBody.model, "gpt-4o-mini");
  assert.equal(briefBody.store, false);
  assert.equal(briefBody.max_output_tokens, 500);
  assert(briefBody.input.includes(articleText));
  await assert.rejects(background.generateBrief("Title", "Short", new AbortController().signal), /too short/);
  offscreen.fetch = initialFetch;
  await assert.rejects(background.generateSpeech("Hello", undefined, "invalid"), /supported voice/);
  await assert.rejects(background.generateSpeech("x".repeat(4097)), /4096/);
  key = "";
  await assert.rejects(background.generateSpeech("Hello"), /API key/);
  key = "test-key";
  status = 401;
  await assert.rejects(background.generateSpeech("Hello"), /401/);
  let rejected;
  assert.equal(listener({ type: "BLOG_LISTENER_GENERATE_SPEECH", text: "Hello" },
    { id: "other" }, (response) => { rejected = response; }), false);
  assert.equal(rejected.ok, false);

  const sender = { id: "extension", tab: { id: 1 }, documentId: "document", url: "https://example.com/article" };
  let config;
  listener({ type: "BLOG_LISTENER_SPEECH_CONFIG" }, sender, (value) => { config = value; });
  await new Promise(setImmediate);
  assert.deepEqual(Object.keys(config), ["configured"], "Preload configuration must never expose the API key");
  assert.equal(config.configured, true);
  let response;
  assert.equal(listener({ type: "BLOG_LISTENER_GENERATE_SPEECH", text: "Hello", requestId: "test" }, sender,
    (value) => { response = value; }), true);
  await new Promise(setImmediate);
  assert.equal(response.ok, false);
  status = 200;
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(background.generateSpeech("Hello", controller.signal), { name: "AbortError" });
  let signal;
  offscreen.fetch = async (_url, options) => {
    signal = options.signal;
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason)));
  };
  listener({ type: "BLOG_LISTENER_GENERATE_SPEECH", text: "Cancel me", requestId: "cancel-test" }, sender,
    (value) => { response = value; });
  await new Promise(setImmediate);
  let cancelled;
  listener({ type: "BLOG_LISTENER_CANCEL_SPEECH", requestId: "cancel-test" }, sender,
    (value) => { cancelled = value; });
  await new Promise(setImmediate);
  assert.equal(cancelled.ok, true);
  assert.equal(signal.aborted, true);
  assert.equal(response.ok, false);
  signal = null;
  let briefResponse;
  listener({ type: "BLOG_LISTENER_GENERATE_BRIEF", title: "Article title", text: articleText, requestId: "brief-cancel-test" }, sender,
    (value) => { briefResponse = value; });
  await new Promise(setImmediate);
  assert(signal && !signal.aborted);
  let briefCancelled;
  listener({ type: "BLOG_LISTENER_CANCEL_BRIEF", requestId: "brief-cancel-test" }, sender,
    (value) => { briefCancelled = value; });
  await new Promise(setImmediate);
  assert.equal(briefCancelled.ok, true);
  assert.equal(signal.aborted, true);
  assert.equal(briefResponse.ok, false);
  assert(timeouts.every((ms) => ms === 120000));
  assert.equal(documentsCreated, 1, "Reuse the hidden speech document");
  assert.equal(heartbeatCount, 0, "Stop keep-alive messages after requests finish");
  console.log("Speech API checks passed: TTS and AI Brief routing, model, voice, limits, credentials, sender validation and request cancellation.");
}

test().catch((error) => { console.error(error); process.exitCode = 1; });
