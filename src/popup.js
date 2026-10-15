const pageStatus = document.querySelector("#pageStatus");
const message = document.querySelector("#message");
const playButton = document.querySelector("#playButton");
const pauseButton = document.querySelector("#pauseButton");
const stopButton = document.querySelector("#stopButton");
const voiceSelect = document.querySelector("#voiceSelect");
const rateInput = document.querySelector("#rateInput");
const rateValue = document.querySelector("#rateValue");
const apiKeyInput = document.querySelector("#apiKeyInput");
const saveApiKeyButton = document.querySelector("#saveApiKeyButton");
for (const voice of BlogListenerVoices) {
  voiceSelect.add(new Option(`${voice.name} — ${voice.description}`, voice.id));
}
voiceSelect.addEventListener("change", () => {
  speechSettings.voice = voiceSelect.value;
  renderSettings();
  saveSettings();
});

let activeTabId = null;
let speechSettings = {
  rate: 1,
  model: "gpt-4o-mini-tts-2025-12-15",
  voice: "ash"
};

document.addEventListener("DOMContentLoaded", init);

playButton.addEventListener("click", () => sendPlaybackMessage("BLOG_LISTENER_PLAY"));
pauseButton.addEventListener("click", () => sendPlaybackMessage("BLOG_LISTENER_PAUSE"));
stopButton.addEventListener("click", () => sendPlaybackMessage("BLOG_LISTENER_STOP"));
chrome.runtime.onMessage.addListener((payload, sender) => {
  if (payload?.type === "BLOG_LISTENER_PLAYBACK_STATE" && sender.tab?.id === activeTabId) {
    updatePlaybackControls(payload);
  }
});

saveApiKeyButton.addEventListener("click", async () => {
  try {
    await chrome.storage.local.set({ openaiApiKey: apiKeyInput.value.trim() });
    if (activeTabId && apiKeyInput.value.trim()) {
      sendToTab(activeTabId, { type: "BLOG_LISTENER_PRELOAD" }).catch(() => {});
    }
    message.textContent = apiKeyInput.value.trim() ? "API key saved on this device." : "API key removed.";
  } catch (_error) {
    message.textContent = "Could not save the API key. Try again.";
  }
});

rateInput.addEventListener("input", () => {
  speechSettings.rate = Number(rateInput.value);
  rateValue.textContent = `${speechSettings.rate.toFixed(1)}x`;
  saveSettings();
});

async function init() {
  setControlsDisabled(true);
  await loadSettings();
  const { openaiApiKey } = await chrome.storage.local.get("openaiApiKey");
  apiKeyInput.value = openaiApiKey || "";

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id || null;

  if (!activeTabId || !tab.url || !/^https?:\/\//.test(tab.url)) {
    pageStatus.textContent = "Open a blog post or article page to listen.";
    message.textContent = "Chrome internal pages cannot be read by extensions.";
    return;
  }

  try {
    const status = await getPageStatus(activeTabId);

    pageStatus.textContent = status.canRead
      ? `${status.title} - ${status.wordCount} words found`
      : "This page does not look like a readable blog post.";

    setControlsDisabled(!status.canRead);
    if (status.canRead) updatePlaybackControls(status);
  } catch (_error) {
    pageStatus.textContent = "This page cannot be read right now.";
    message.textContent = "Refresh the tab, wait for the article to load, and try again.";
  }
}

async function loadSettings() {
  const result = await chrome.storage.sync.get("speechSettings");
  speechSettings = {
    ...speechSettings,
    rate: Number(result.speechSettings?.rate) || 1,
    model: "gpt-4o-mini-tts-2025-12-15",
    voice: BlogListenerVoices.some((voice) => voice.id === result.speechSettings?.voice) ? result.speechSettings.voice : "ash"
  };

  renderSettings();
}

function renderSettings() {
  rateInput.value = speechSettings.rate;
  rateValue.textContent = `${Number(speechSettings.rate).toFixed(1)}×`;
  voiceSelect.value = speechSettings.voice;
  document.querySelector("#voiceDescription").textContent = BlogListenerVoices.find((voice) => voice.id === speechSettings.voice)?.description || "";
}

async function saveSettings() {
  try {
    await chrome.storage.sync.set({ speechSettings });
    if (activeTabId) await sendToTab(activeTabId, { type: "BLOG_LISTENER_SETTINGS", settings: speechSettings });
  } catch (_error) { message.textContent = "Could not apply settings. Refresh the page and try again."; }
}

async function sendPlaybackMessage(type) {
  if (!activeTabId) {
    return;
  }

  message.textContent = "";

  try {
    const response = await sendToTab(activeTabId, {
      type,
      settings: speechSettings
    });

    if (!response?.ok) throw new Error("Playback command failed");
    updatePlaybackControls(await sendToTab(activeTabId, { type: "BLOG_LISTENER_STATUS" }));
  } catch (_error) {
    message.textContent = "Refresh the tab and try again.";
  }
}

async function getPageStatus(tabId) {
  try {
    return await sendToTab(tabId, { type: "BLOG_LISTENER_STATUS" });
  } catch (_error) {
    await injectReader(tabId);
    return sendToTab(tabId, { type: "BLOG_LISTENER_STATUS" });
  }
}

async function injectReader(tabId) {
  await chrome.scripting.insertCSS({
    target: { tabId },
    files: ["src/content.css"]
  });

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ["src/voices.js", "src/audio-player.js", "src/content.js"]
  });
}

function sendToTab(tabId, payload) {
  return chrome.tabs.sendMessage(tabId, payload);
}

function setControlsDisabled(disabled) {
  playButton.disabled = disabled;
  pauseButton.disabled = disabled;
  stopButton.disabled = disabled;
}

function updatePlaybackControls(status) {
  if (status.settings) { speechSettings = { ...speechSettings, ...status.settings }; renderSettings(); }
  document.querySelector("#voiceNotice").textContent = status.isPlaying
    ? "Voice changes apply after Stop, then Play."
    : "AI voices · Descriptions are approximate.";
  pauseButton.textContent = status.isPaused ? "Resume" : "Pause";
  pauseButton.disabled = !status.isPlaying;
  stopButton.disabled = !status.isPlaying && !status.briefLoading;
  playButton.disabled = status.briefLoading || (status.isPlaying && !status.isPaused);
  message.textContent = status.briefLoading ? "Creating AI Brief…" : status.isPaused ? "Paused." : status.playbackStatus === "buffering"
    ? "Buffering…" : status.isPlaying ? `${status.mode === "brief" ? "Playing AI Brief" : "Playing"} with ${BlogListenerVoices.find((voice) => voice.id === status.voice)?.name || "Ash"}.` : "";
  const preparation = status.preparation;
  if (!status.isPlaying && preparation?.error) message.textContent = "Preparation failed. Press Play to retry.";
}
