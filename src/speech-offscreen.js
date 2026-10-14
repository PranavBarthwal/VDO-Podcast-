const SPEECH_TIMEOUT_MS = 120000;
const activeSpeechRequests = new Map();
let heartbeat = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target !== "speech-offscreen") return false;
  if (sender.id !== chrome.runtime.id || sender.tab) return false;
  if (typeof message.requestId !== "string") return false;
  if (message.type === "BLOG_LISTENER_OFFSCREEN_CANCEL") {
    activeSpeechRequests.get(message.requestId)?.abort();
    sendResponse({ ok: true });
    return false;
  }
  if (message.type !== "BLOG_LISTENER_OFFSCREEN_GENERATE") return false;
  if (activeSpeechRequests.has(message.requestId)) {
    sendResponse({ ok: false, error: "Speech request is already running." });
    return false;
  }
  const controller = new AbortController();
  activeSpeechRequests.set(message.requestId, controller);
  // Only active downloads keep the message-routing worker awake.
  if (heartbeat === null) heartbeat = setInterval(() => {
    chrome.runtime.sendMessage({ type: "BLOG_LISTENER_SPEECH_HEARTBEAT" }).catch(() => {});
  }, 20000);
  generateSpeechAudio(message.text, message.apiKey, controller.signal, message.voice).then(sendResponse).catch((error) => {
    sendResponse({ ok: false, error: error.name === "TimeoutError"
      ? "Speech generation took longer than 2 minutes. Try again."
      : error.message });
  }).finally(() => {
    activeSpeechRequests.delete(message.requestId);
    if (!activeSpeechRequests.size && heartbeat !== null) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  });
  return true;
});

async function generateSpeechAudio(text, apiKey, signal, voice = "ash") {
  if (!BlogListenerVoices.some((option) => option.id === voice)) throw new Error("Choose a supported voice.");
  if (typeof text !== "string" || !text.trim() || text.length > 4096) {
    throw new Error("Speech text must contain 1–4096 characters.");
  }
  if (!apiKey) throw new Error("Add your OpenAI API key in the extension popup.");
  signal?.throwIfAborted();
  const timeout = AbortSignal.timeout(SPEECH_TIMEOUT_MS);
  const response = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ model: "gpt-4o-mini-tts-2025-12-15", voice, input: text, response_format: "mp3" }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout
  });
  if (!response.ok) throw new Error(`OpenAI speech request failed (${response.status}). Check your key and API access.`);
  const audio = await response.blob();
  const bytes = new Uint8Array(await audio.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return { ok: true, audio: `data:audio/mpeg;base64,${btoa(binary)}` };
}
