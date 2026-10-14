importScripts("voices.js");
const TTS_MODEL = "gpt-4o-mini-tts-2025-12-15";
const TTS_VOICE = "ash";
const speechRequests = new Map();
let offscreenCreation = null;
let offscreenRequestSequence = 0;

const storageReady = chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
chrome.runtime.onInstalled.addListener(async () => {
  const { speechSettings } = await chrome.storage.sync.get("speechSettings");
  await chrome.storage.sync.set({
    speechSettings: { rate: speechSettings?.rate || 1, model: TTS_MODEL,
      voice: BlogListenerVoices.some((voice) => voice.id === speechSettings?.voice) ? speechSettings.voice : TTS_VOICE }
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "BLOG_LISTENER_SPEECH_CONFIG" && sender.id === chrome.runtime.id && sender.tab) {
    storageReady.then(() => chrome.storage.local.get("openaiApiKey"))
      .then(({ openaiApiKey }) => sendResponse({ configured: !!openaiApiKey }))
      .catch(() => sendResponse({ configured: false }));
    return true;
  }
  if (message?.type === "BLOG_LISTENER_SPEECH_HEARTBEAT" && sender.id === chrome.runtime.id &&
      sender.url === chrome.runtime.getURL("src/speech-offscreen.html")) {
    sendResponse({ ok: true });
    return false;
  }
  if (!["BLOG_LISTENER_GENERATE_SPEECH", "BLOG_LISTENER_CANCEL_SPEECH"].includes(message?.type)) return false;
  if (sender.id !== chrome.runtime.id || !sender.tab || !/^https?:\/\//.test(sender.url || "")) {
    sendResponse({ ok: false, error: "Speech requests must come from an article tab." });
    return false;
  }
  if (typeof message.requestId !== "string" || message.requestId.length > 100) {
    sendResponse({ ok: false, error: "Invalid speech request ID." });
    return false;
  }
  const key = `${sender.tab.id}:${sender.documentId || sender.frameId || 0}:${message.requestId}`;
  if (message.type === "BLOG_LISTENER_CANCEL_SPEECH") {
    speechRequests.get(key)?.controller.abort();
    sendResponse({ ok: true });
    return false;
  }
  if (speechRequests.has(key)) {
    sendResponse({ ok: false, error: "Speech request is already running." });
    return false;
  }
  const controller = new AbortController();
  speechRequests.set(key, { controller, tabId: sender.tab.id });
  generateSpeech(message.text, controller.signal, message.voice).then(sendResponse).catch((error) => {
    sendResponse({ ok: false, error: error.name === "TimeoutError" ? "Speech generation timed out. Try again." : error.message });
  }).finally(() => speechRequests.delete(key));
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  for (const request of speechRequests.values()) if (request.tabId === tabId) request.controller.abort();
});

async function ensureSpeechDocument() {
  if (offscreenCreation) return offscreenCreation;
  offscreenCreation = (async () => {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"],
      documentUrls: [chrome.runtime.getURL("src/speech-offscreen.html")] });
    if (!contexts.length) await chrome.offscreen.createDocument({
      url: "src/speech-offscreen.html", reasons: ["BLOBS"],
      justification: "Download speech audio as a Blob without the service-worker fetch lifetime limit."
    });
  })();
  try { await offscreenCreation; } finally { offscreenCreation = null; }
}

async function generateSpeech(text, signal, voice = TTS_VOICE) {
  if (!BlogListenerVoices.some((option) => option.id === voice)) throw new Error("Choose a supported voice.");
  if (typeof text !== "string" || !text.trim() || text.length > 4096) {
    throw new Error("Speech text must contain 1–4096 characters.");
  }
  await storageReady;
  signal?.throwIfAborted();
  const { openaiApiKey } = await chrome.storage.local.get("openaiApiKey");
  if (!openaiApiKey) throw new Error("Add your OpenAI API key in the extension popup.");
  await ensureSpeechDocument();
  signal?.throwIfAborted();
  const requestId = String(++offscreenRequestSequence);
  const cancel = () => chrome.runtime.sendMessage({ target: "speech-offscreen",
    type: "BLOG_LISTENER_OFFSCREEN_CANCEL", requestId }).catch(() => {});
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    const result = await chrome.runtime.sendMessage({ target: "speech-offscreen",
      type: "BLOG_LISTENER_OFFSCREEN_GENERATE", requestId, text, voice, apiKey: openaiApiKey });
    signal?.throwIfAborted();
    if (!result?.ok) throw new Error(result?.error || "Could not generate speech.");
    return result;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}
