const pageStatus = document.querySelector("#pageStatus");
const message = document.querySelector("#message");
const playButton = document.querySelector("#playButton");
const pauseButton = document.querySelector("#pauseButton");
const stopButton = document.querySelector("#stopButton");
const voiceSelect = document.querySelector("#voiceSelect");
const rateInput = document.querySelector("#rateInput");
const rateValue = document.querySelector("#rateValue");
const pitchInput = document.querySelector("#pitchInput");
const pitchValue = document.querySelector("#pitchValue");

let activeTabId = null;
let speechSettings = {
  rate: 1,
  pitch: 1,
  voiceURI: ""
};

document.addEventListener("DOMContentLoaded", init);

playButton.addEventListener("click", () => sendPlaybackMessage("BLOG_LISTENER_PLAY"));
pauseButton.addEventListener("click", () => sendPlaybackMessage("BLOG_LISTENER_PAUSE"));
stopButton.addEventListener("click", () => sendPlaybackMessage("BLOG_LISTENER_STOP"));

voiceSelect.addEventListener("change", () => {
  speechSettings.voiceURI = voiceSelect.value;
  saveSettings();
});

rateInput.addEventListener("input", () => {
  speechSettings.rate = Number(rateInput.value);
  rateValue.textContent = `${speechSettings.rate.toFixed(1)}x`;
  saveSettings();
});

pitchInput.addEventListener("input", () => {
  speechSettings.pitch = Number(pitchInput.value);
  pitchValue.textContent = speechSettings.pitch.toFixed(1);
  saveSettings();
});

async function init() {
  setControlsDisabled(true);
  await loadSettings();
  populateVoices();

  if (speechSynthesis.onvoiceschanged !== undefined) {
    speechSynthesis.onvoiceschanged = populateVoices;
  }

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
  } catch (_error) {
    pageStatus.textContent = "This page cannot be read right now.";
    message.textContent = "Refresh the tab, wait for the article to load, and try again.";
  }
}

async function loadSettings() {
  const result = await chrome.storage.sync.get("speechSettings");
  speechSettings = {
    ...speechSettings,
    ...(result.speechSettings || {})
  };

  rateInput.value = speechSettings.rate;
  pitchInput.value = speechSettings.pitch;
  rateValue.textContent = `${Number(speechSettings.rate).toFixed(1)}x`;
  pitchValue.textContent = Number(speechSettings.pitch).toFixed(1);
}

function populateVoices() {
  const voices = speechSynthesis.getVoices();
  voiceSelect.textContent = "";

  const defaultOption = document.createElement("option");
  defaultOption.value = "";
  defaultOption.textContent = "Default voice";
  voiceSelect.append(defaultOption);

  voices.forEach((voice) => {
    const option = document.createElement("option");
    option.value = voice.voiceURI;
    option.textContent = `${voice.name} (${voice.lang})`;
    voiceSelect.append(option);
  });

  voiceSelect.value = speechSettings.voiceURI;
}

async function saveSettings() {
  await chrome.storage.sync.set({ speechSettings });
}

async function sendPlaybackMessage(type) {
  if (!activeTabId) {
    return;
  }

  message.textContent = "";

  try {
    await sendToTab(activeTabId, {
      type,
      settings: speechSettings
    });

    if (type === "BLOG_LISTENER_PLAY") {
      message.textContent = "Reading started on this page.";
    }

    if (type === "BLOG_LISTENER_PAUSE") {
      message.textContent = "Playback toggled.";
    }

    if (type === "BLOG_LISTENER_STOP") {
      message.textContent = "Playback stopped.";
    }
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
    files: ["src/content.js"]
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
