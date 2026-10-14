(() => {
if (window.__blogListenerLoaded) {
  return;
}

window.__blogListenerLoaded = true;

const MIN_ARTICLE_WORDS = 80;
const MAX_UTTERANCE_CHARS = 1800;
const AD_BREAK_INTERVAL = 4;
const SEEK_SECONDS = 5;
const SIMULATED_ADS = [
  {
    title: "Blog Listener Pro",
    url: "https://example.com/blog-listener-pro",
    script:
      "Quick sponsor break. Blog Listener Pro turns long reads into hands free audio in seconds. Now, back to the article."
  },
  {
    title: "FocusFlow Notes",
    url: "https://example.com/focusflow-notes",
    script:
      "A short message from FocusFlow Notes. Capture ideas while Blog Listener reads the web for you. Your article continues now."
  },
  {
    title: "ReadCast Studio",
    url: "https://example.com/readcast-studio",
    script:
      "Sponsor break from ReadCast Studio. Build smooth text to speech, smart highlights, and podcast style controls. Back to the story."
  }
];
const READABLE_BLOCK_SELECTOR = "p, h2, h3, h4, li, blockquote";
const IGNORED_CONTENT_SELECTOR = [
  "aside",
  "nav",
  "footer",
  "form",
  "button",
  "figure",
  "figcaption",
  "time",
  "small",
  "[aria-label*='share' i]",
  "[aria-label*='subscribe' i]",
  "[role='navigation']",
  "[role='complementary']"
].join(",");
const IGNORED_ATTRIBUTE_PATTERN =
  /(^|[-_\s])(ad|ads|advert|author|bio|breadcrumb|byline|caption|category|comment|cookie|credit|date|figcaption|footer|meta|metadata|newsletter|promo|published|related|share|social|sponsor|subscribe|tag|time|timestamp|toc|updated)([-_\s]|$)/i;
const ICONS = {
  play: `
    <svg class="blog-listener-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 5.4v13.2c0 .8.9 1.3 1.6.9l10.2-6.6c.6-.4.6-1.3 0-1.7L9.6 4.5C8.9 4.1 8 4.6 8 5.4Z"></path>
    </svg>
  `,
  pause: `
    <svg class="blog-listener-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7.8 5.2h2.8c.5 0 .9.4.9.9v11.8c0 .5-.4.9-.9.9H7.8c-.5 0-.9-.4-.9-.9V6.1c0-.5.4-.9.9-.9Zm5.6 0h2.8c.5 0 .9.4.9.9v11.8c0 .5-.4.9-.9.9h-2.8c-.5 0-.9-.4-.9-.9V6.1c0-.5.4-.9.9-.9Z"></path>
    </svg>
  `,
  stop: `
    <svg class="blog-listener-icon" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7.2 6.4h9.6c.5 0 .8.4.8.8v9.6c0 .5-.4.8-.8.8H7.2a.8.8 0 0 1-.8-.8V7.2c0-.5.4-.8.8-.8Z"></path>
    </svg>
  `,
  rewind5: `
    <span class="blog-listener-seek-control blog-listener-seek-back" aria-hidden="true">
      <span class="blog-listener-seek-chevron"></span>
      <span class="blog-listener-seek-label">5s</span>
    </span>
  `,
  forward5: `
    <span class="blog-listener-seek-control blog-listener-seek-forward" aria-hidden="true">
      <span class="blog-listener-seek-label">5s</span>
      <span class="blog-listener-seek-chevron"></span>
    </span>
  `
};

const state = {
  chunks: [],
  adMarkerPercents: [],
  chunkIndex: 0,
  currentChunkCharIndex: 0,
  currentUtteranceOffset: 0,
  currentAdCharIndex: 0,
  currentAdOffset: 0,
  currentAdText: "",
  currentAd: null,
  totalChars: 0,
  isPlaying: false,
  isPaused: false,
  isAdPlaying: false,
  adBreaksPlayed: new Set(),
  title: "",
  sessionId: 0,
  settings: {
    rate: 1,
    model: "gpt-4o-mini-tts-2025-12-15",
    voice: "ash"
  }
};

let playerElement = null;
let currentReadingElement = null;
let wordHighlightElement = null;
let currentWordHighlight = null;
let wordHighlightFrameId = null;
let lastPlaybackMessage = "";
let lastRenderedWord = null;
let preloadGeneration = 0;
let preloadAllowed = true;
let preloadObserver = null;
let preloadTimer = null;
let preloadChecking = false;
let preloadCheckAgain = false;
let speechConfigured = null;
let sessionVoice = "ash";
let renderedSettings = "";

const speechPlayback = new BlogAudioPlayer({
  requestAudio: (text, requestId) => chrome.runtime.sendMessage({
    type: "BLOG_LISTENER_GENERATE_SPEECH", text, requestId, voice: sessionVoice
  }),
  cancelRequest: (requestId) => chrome.runtime.sendMessage({
    type: "BLOG_LISTENER_CANCEL_SPEECH", requestId
  }),
  onPosition: (segment, _index, seconds, duration) => {
    const charIndex = duration ? Math.min(segment.text.length - 1,
      Math.floor(seconds / duration * segment.text.length)) : 0;
    const changed = state.chunkIndex !== segment.chunkIndex || state.isAdPlaying !== !!segment.ad;
    state.chunkIndex = segment.chunkIndex;
    state.isAdPlaying = !!segment.ad;
    if (segment.ad) {
      state.currentAd = segment.ad;
      state.currentAdText = segment.text;
      state.currentAdCharIndex = charIndex;
      if (changed) clearReadingState();
    } else {
      state.currentAd = null;
      state.currentAdText = "";
      state.currentChunkCharIndex = charIndex;
      if (changed || currentReadingElement !== segment.element) setReadingElement(segment.element);
      updateWordHighlight(segment, charIndex, 1);
    }
    updatePlayer();
  },
  onState: (status) => {
    state.playbackStatus = status;
    updatePlayer();
  },
  onPreparation: () => updatePlayer(),
  onFinish: () => { stopArticle(false); setPlayerMessage("Finished"); },
  onError: (error) => { stopArticle(false); setPlayerMessage(error.message || "Speech playback stopped"); }
});

createPlayer();
watchArticleContent();
preloadArticle();
window.addEventListener("scroll", scheduleWordHighlightReflow, { passive: true });
window.addEventListener("resize", scheduleWordHighlightReflow);
window.addEventListener("pagehide", () => stopArticle(false));

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || !message.type) {
    return false;
  }

  if (message.type === "BLOG_LISTENER_STATUS") {
    const article = extractArticle();
    sendResponse({
      ok: true,
      title: article.title,
      wordCount: article.wordCount,
      canRead: article.wordCount >= MIN_ARTICLE_WORDS,
      isPlaying: state.isPlaying,
      isPaused: state.isPaused,
      playbackStatus: state.playbackStatus || "idle",
      settings: state.settings, voice: sessionVoice,
      preparation: speechPlayback.getPreparationStatus()
    });
    return false;
  }

  if (message.type === "BLOG_LISTENER_PLAY") {
    playArticle(message.settings || {});
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "BLOG_LISTENER_PRELOAD") {
    preloadGeneration++;
    speechConfigured = null;
    preloadAllowed = true;
    watchArticleContent();
    preloadArticle();
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "BLOG_LISTENER_PAUSE") {
    if (state.isPaused) resumeArticle(); else pauseArticle();
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "BLOG_LISTENER_SETTINGS") {
    applySpeechSettings(message.settings || {});
    if (!state.isPlaying && preloadAllowed) { preloadGeneration++; preloadArticle(); }
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "BLOG_LISTENER_STOP") {
    stopArticle();
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

function articleSegments(article) {
  const segments = [];
  let adIndex = 0;
  let paragraphIndex = -1;
  let previousElement = null;
  article.chunks.forEach((chunk, chunkIndex) => {
    if (chunk.element !== previousElement) paragraphIndex++;
    previousElement = chunk.element;
    if (chunkIndex > 0 && chunkIndex % AD_BREAK_INTERVAL === 0) {
      const ad = SIMULATED_ADS[adIndex++ % SIMULATED_ADS.length];
      segments.push({ text: ad.script, ad, chunkIndex, paragraphIndex });
    }
    segments.push({ ...chunk, chunkIndex, paragraphIndex });
  });
  return segments;
}

function watchArticleContent() {
  if (preloadObserver || !document.body) return;
  const isReaderNode = (node) => {
    const element = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
    return element && (element === playerElement || playerElement?.contains(element) ||
      element === wordHighlightElement || wordHighlightElement?.contains(element));
  };
  preloadObserver = new MutationObserver((records) => {
    if (!preloadAllowed || state.isPlaying) return;
    const articleChanged = records.some((record) => {
      if (isReaderNode(record.target)) return false;
      if (record.type === "characterData") return !!record.target.parentElement?.closest(READABLE_BLOCK_SELECTOR);
      return [...record.addedNodes, ...record.removedNodes].some((node) => !isReaderNode(node) &&
        (node.nodeType === Node.TEXT_NODE || (node.nodeType === Node.ELEMENT_NODE &&
          (node.matches(READABLE_BLOCK_SELECTOR) || node.querySelector(READABLE_BLOCK_SELECTOR)))));
    });
    if (articleChanged && preloadTimer === null) {
      preloadTimer = window.setTimeout(() => { preloadTimer = null; preloadArticle(); }, 200);
    }
  });
  preloadObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
}

async function preloadArticle() {
  if (!preloadAllowed || state.isPlaying) return;
  if (preloadChecking) { preloadCheckAgain = true; return; }
  preloadChecking = true;
  const generation = preloadGeneration;
  try {
    const { speechSettings } = await chrome.storage.sync.get("speechSettings");
    if (generation !== preloadGeneration || state.isPlaying || !preloadAllowed) return;
    applySpeechSettings(speechSettings || {});
    if (speechConfigured === null) {
      const config = await chrome.runtime.sendMessage({ type: "BLOG_LISTENER_SPEECH_CONFIG" });
      if (generation !== preloadGeneration) return;
      speechConfigured = !!config?.configured;
    }
    if (!speechConfigured || generation !== preloadGeneration || state.isPlaying || !preloadAllowed) return;
    const article = extractArticle();
    if (article.wordCount < MIN_ARTICLE_WORDS) return;
    speechPlayback.refreshPreparation(articleSegments(article), getPlaybackRate());
  } catch (_error) {
    // Missing configuration or preload errors must not interrupt browsing.
  } finally {
    preloadChecking = false;
    if (preloadCheckAgain) { preloadCheckAgain = false; preloadArticle(); }
  }
}

function playArticle(settings = {}) {
  applySpeechSettings(settings);
  if (state.isPaused) { resumeArticle(); return; }
  if (state.isPlaying) return;
  const article = extractArticle();
  if (article.wordCount < MIN_ARTICLE_WORDS) {
    setPlayerMessage("No readable article found");
    return;
  }
  preloadGeneration++;
  speechPlayback.refreshPreparation(articleSegments(article), getPlaybackRate());
  state.sessionId++;
  state.title = article.title;
  state.chunks = article.chunks;
  state.adMarkerPercents = getAdMarkerPercents(article.chunks);
  state.totalChars = article.chunks.reduce((sum, chunk) => sum + chunk.text.length, 0);
  state.isPlaying = true;
  speechPlayback.startPrepared(getPlaybackRate());
  updatePlayer();
}

function pauseArticle() {
  if (!state.isPlaying || state.isPaused) return;
  state.isPaused = true;
  speechPlayback.pause();
  updatePlayer();
}

function resumeArticle() {
  if (!state.isPlaying || !state.isPaused) return;
  state.isPaused = false;
  speechPlayback.resume();
  updatePlayer();
}

function seekPlayback(direction) {
  if (state.isPlaying) speechPlayback.seek(direction * SEEK_SECONDS);
}

function stopArticle(hidePlayer = true) {
  if (playerElement) setSettingsOpen(false, false);
  preloadAllowed = false;
  preloadObserver?.disconnect();
  preloadObserver = null;
  if (preloadTimer !== null) window.clearTimeout(preloadTimer);
  preloadTimer = null;
  preloadGeneration++;
  state.sessionId += 1;
  speechPlayback.stop();
  state.isPlaying = false;
  state.isPaused = false;
  state.chunkIndex = 0;
  state.currentChunkCharIndex = 0;
  state.currentUtteranceOffset = 0;
  state.currentAdCharIndex = 0;
  state.currentAdOffset = 0;
  state.currentAdText = "";
  state.currentAd = null;
  state.totalChars = 0;
  state.chunks = [];
  state.adMarkerPercents = [];
  state.isAdPlaying = false;
  state.adBreaksPlayed = new Set();
  clearReadingState();

  if (hidePlayer && playerElement) {
    playerElement.querySelector(".blog-listener-title").textContent = "";
    playerElement.classList.add("blog-listener-idle");
    updatePlayer();
    return;
  }

  updatePlayer();
}



function getPlaybackRate() {
  return Math.min(2, Math.max(0.7, Number(state.settings.rate) || 1));
}

function applySpeechSettings(settings) {
  state.settings = { ...state.settings, ...settings, model: "gpt-4o-mini-tts-2025-12-15" };
  if (!BlogListenerVoices.some((voice) => voice.id === state.settings.voice)) state.settings.voice = "ash";
  state.settings.rate = getPlaybackRate();
  // Keep one voice per listening session so cached paragraphs never mix voices.
  if (!state.isPlaying && sessionVoice !== state.settings.voice) {
    speechPlayback.stop();
    sessionVoice = state.settings.voice;
  }
  speechPlayback.setRate(state.settings.rate);
  updatePlayer();
}

async function changeWidgetSettings(changes) {
  const settings = { ...state.settings, ...changes };
  try {
    await chrome.storage.sync.set({ speechSettings: settings });
    applySpeechSettings(settings);
    if (changes.voice && !state.isPlaying && preloadAllowed) { preloadGeneration++; preloadArticle(); }
  } catch (_error) {
    playerElement.querySelector(".blog-listener-settings-note").textContent = "Could not save settings. Please try again.";
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function extractArticle() {
  const title = getReadableText(document.querySelector("h1")) || document.title || "This page";
  const mainCandidate = findBestArticleNode();
  const chunks = getArticleChunks(mainCandidate || document.body);
  const text = chunks.map((chunk) => chunk.text).join(" ");
  const wordCount = countWords(text);

  return {
    title: normalizeText(title),
    text,
    wordCount,
    chunks
  };
}

function findBestArticleNode() {
  const selectors = [
    "article",
    "[role='article']",
    "main",
    ".post-content",
    ".entry-content",
    ".article-content",
    ".blog-post",
    ".post",
    ".content"
  ];

  const candidates = selectors
    .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
    .filter((element) => isVisible(element))
    .map((element) => ({
      element,
      score: scoreArticleNode(element)
    }))
    .sort((a, b) => b.score - a.score);

  if (candidates.length > 0 && candidates[0].score > 0) {
    return candidates[0].element;
  }

  const paragraphs = Array.from(document.querySelectorAll("p")).filter((paragraph) => {
    return isReadableContentBlock(paragraph);
  });

  if (paragraphs.length === 0) {
    return document.body;
  }

  return document.body;
}

function scoreArticleNode(element) {
  const text = getCleanArticleText(element);
  const words = countWords(text);
  const paragraphCount = element.querySelectorAll("p").length;
  const headingBonus = element.querySelector("h1, h2") ? 40 : 0;
  const mediaPenalty = element.querySelectorAll(`${IGNORED_CONTENT_SELECTOR}, figure, img, video`).length * 12;

  return words + paragraphCount * 20 + headingBonus - mediaPenalty;
}

function getCleanArticleText(root) {
  return getArticleChunks(root)
    .map((chunk) => chunk.text)
    .join(" ");
}

function getArticleChunks(root) {
  const blocks = Array.from(root.querySelectorAll(READABLE_BLOCK_SELECTOR)).filter(isReadableContentBlock);
  const chunks = [];
  const seen = new Set();

  blocks.forEach((block) => {
    const text = normalizeText(block.innerText || block.textContent || "");
    const dedupeKey = text.toLowerCase();

    if (!seen.has(dedupeKey)) {
      seen.add(dedupeKey);
      splitTextIntoChunks(text).forEach((chunkPart) => {
        chunks.push({
          text: chunkPart.text,
          element: block,
          blockOffset: chunkPart.offset
        });
      });
    }
  });

  if (chunks.length > 0) {
    return chunks;
  }

  return splitTextIntoChunks(normalizeText(root.innerText || root.textContent || ""))
    .map((part) => ({ text: part.text, element: root, blockOffset: part.offset }));
}

function isReadableContentBlock(element) {
  if (!isVisible(element) || isIgnoredElement(element)) {
    return false;
  }

  const text = normalizeText(element.innerText || element.textContent || "");
  const words = countWords(text);
  const tagName = element.tagName.toLowerCase();

  if (shouldSkipText(text)) {
    return false;
  }

  if (tagName.startsWith("h")) {
    return words >= 3 && words <= 24;
  }

  if (tagName === "li") {
    return words >= 5 && words <= 80;
  }

  return words >= 8;
}

function isIgnoredElement(element) {
  if (element.closest(IGNORED_CONTENT_SELECTOR)) {
    return true;
  }

  return hasIgnoredAttribute(element) || Boolean(element.closest("[class], [id]") && closestIgnoredAttribute(element));
}

function closestIgnoredAttribute(element) {
  let currentElement = element;

  while (currentElement && currentElement !== document.body && currentElement !== document.documentElement) {
    if (hasIgnoredAttribute(currentElement)) {
      return currentElement;
    }

    currentElement = currentElement.parentElement;
  }

  return null;
}

function hasIgnoredAttribute(element) {
  const attributeText = `${element.id || ""} ${element.className || ""}`;
  return IGNORED_ATTRIBUTE_PATTERN.test(attributeText);
}

function shouldSkipText(text) {
  if (!text || text.length < 24) {
    return true;
  }

  const lowerText = text.toLowerCase();
  const wordCount = countWords(text);

  if (/^(by|posted by|written by|published|updated|last updated)\b/i.test(text)) {
    return true;
  }

  if (/^(share|subscribe|related|read more|advertisement|sponsored|tags?|categories)\b/i.test(text)) {
    return true;
  }

  if (wordCount <= 12 && /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{4})\b/i.test(text)) {
    return true;
  }

  return wordCount <= 10 && lowerText.includes("min read");
}

function splitTextIntoChunks(text) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    while (/\s/.test(text[start] || "") && start < text.length) start++;
    if (start >= text.length) break;
    let end = Math.min(start + MAX_UTTERANCE_CHARS, text.length);
    if (end < text.length) {
      const window = text.slice(start, end);
      const boundaries = [...window.matchAll(/[.!?](?:\s|$)/g)];
      const sentenceEnd = boundaries.at(-1);
      const wordEnd = window.lastIndexOf(" ");
      if (sentenceEnd && sentenceEnd.index > MAX_UTTERANCE_CHARS / 2) end = start + sentenceEnd.index + 1;
      else if (wordEnd > 0) end = start + wordEnd;
    }
    chunks.push({ text: text.slice(start, end).trim(), offset: start });
    start = end;
  }
  return chunks;
}

function createPlayer() {
  if (!playerElement) {
    playerElement = document.createElement("div");
    playerElement.className = "blog-listener-player blog-listener-idle";
    playerElement.innerHTML = `
      <span class="blog-listener-nudge">Listen to this article?</span>
      <span class="blog-listener-copy">
        <span class="blog-listener-meta">AI narration</span>
        <span class="blog-listener-ad-label">Sponsored ad</span>
        <span class="blog-listener-title"></span>
        <a class="blog-listener-ad-link" href="#" target="_blank" rel="noopener noreferrer"></a>
      </span>
      <span class="blog-listener-playback-status" role="status"></span>
      <span class="blog-listener-progress" aria-hidden="true">
        <span class="blog-listener-progress-fill"></span>
        <span class="blog-listener-ad-markers"></span>
      </span>
      <button class="blog-listener-button blog-listener-secondary" type="button" data-action="rewind" title="Back 5 seconds" aria-label="Go back 5 seconds">${ICONS.rewind5}</button>
      <button class="blog-listener-button blog-listener-primary" type="button" data-action="play" title="Play" aria-label="Play article">${ICONS.play}</button>
      <button class="blog-listener-button blog-listener-secondary" type="button" data-action="forward" title="Skip forward 5 seconds" aria-label="Skip forward 5 seconds">${ICONS.forward5}</button>
      <button class="blog-listener-button blog-listener-settings-toggle" type="button" data-action="settings" title="Speed and voice" aria-label="Speed and voice settings" aria-expanded="false" aria-controls="blog-listener-settings">1×</button>
      <button class="blog-listener-button blog-listener-stop" type="button" data-action="stop" title="Stop" aria-label="Stop reading">${ICONS.stop}</button>
      <section class="blog-listener-settings" id="blog-listener-settings" aria-label="Listening settings" hidden>
        <div class="blog-listener-panel-heading"><strong>Listening settings</strong><button class="blog-listener-button" type="button" data-action="close-settings" aria-label="Close settings">×</button></div>
        <div class="blog-listener-speed-row"><span>Speed</span><div class="blog-listener-stepper">
          <button class="blog-listener-button" type="button" data-action="slower" aria-label="Decrease speed">−</button>
          <output class="blog-listener-rate" aria-live="polite">1.0×</output>
          <button class="blog-listener-button" type="button" data-action="faster" aria-label="Increase speed">+</button>
        </div></div>
        <div class="blog-listener-voice-heading">Voice <span>AI narration</span></div>
        <div class="blog-listener-voices" role="radiogroup" aria-label="Narration voice">
          ${BlogListenerVoices.map((voice) => `<label class="blog-listener-voice-option"><input type="radio" name="blog-listener-voice" value="${voice.id}"><span><strong>${voice.name}</strong><small>${voice.description}</small></span><span class="blog-listener-voice-check" aria-hidden="true">✓</span></label>`).join("")}
        </div>
        <p class="blog-listener-settings-note">Voice descriptions are approximate.</p>
      </section>
    `;

    playerElement.addEventListener("change", (event) => {
      if (event.target.matches("input[name='blog-listener-voice']")) changeWidgetSettings({ voice: event.target.value });
    });
    playerElement.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { setSettingsOpen(false); event.stopPropagation(); }
    });
    document.addEventListener("pointerdown", (event) => {
      if (!playerElement.contains(event.target)) setSettingsOpen(false, false);
    });

    playerElement.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button) {
        return;
      }

      if (button.dataset.action === "settings") setSettingsOpen(button.getAttribute("aria-expanded") !== "true");
      if (button.dataset.action === "close-settings") setSettingsOpen(false);
      if (["slower", "faster"].includes(button.dataset.action)) {
        const delta = button.dataset.action === "faster" ? 0.1 : -0.1;
        changeWidgetSettings({ rate: Math.min(2, Math.max(0.7, Math.round((getPlaybackRate() + delta) * 10) / 10)) });
      }

      if (button.dataset.action === "play") {
        if (state.isPaused) {
          resumeArticle();
        } else if (state.isPlaying) {
          pauseArticle();
        } else {
          playFromPageButton();
        }
      }

      if (button.dataset.action === "rewind") {
        seekPlayback(-1);
      }

      if (button.dataset.action === "forward") {
        seekPlayback(1);
      }

      if (button.dataset.action === "pause") {
        pauseArticle();
      }

      if (button.dataset.action === "stop") {
        stopArticle();
      }
    });

    document.documentElement.append(playerElement);
    window.setTimeout(() => playerElement?.classList.add("blog-listener-nudge-hidden"), 9000);
  }

  updatePlayer();
}

function setSettingsOpen(open, restoreFocus = true) {
  const panel = playerElement.querySelector(".blog-listener-settings");
  if (panel.hidden === !open) return;
  panel.hidden = !open;
  const toggle = playerElement.querySelector("[data-action='settings']");
  toggle.setAttribute("aria-expanded", String(open));
  if (open) panel.querySelector("[data-action='close-settings']").focus();
  else if (restoreFocus) toggle.focus();
}

async function playFromPageButton() {
  // Unlock Web Audio during the page-button gesture, before loading settings.
  try { await speechPlayback.ensureContext().resume(); }
  catch (error) { setPlayerMessage(error.message); return; }
  const result = await chrome.storage.sync.get("speechSettings");
  playArticle(result.speechSettings || {});
}

function setPlayerMessage(text) {
  createPlayer();
  playerElement.classList.remove("blog-listener-idle");
  playerElement.querySelector(".blog-listener-title").textContent = text;
  updatePlayer();
}

function updatePlayer() {
  const preparation = speechPlayback.getPreparationStatus();
  const playbackMessage = { type: "BLOG_LISTENER_PLAYBACK_STATE",
    isPlaying: state.isPlaying, isPaused: state.isPaused, playbackStatus: state.playbackStatus || "idle", preparation,
    settings: state.settings, voice: sessionVoice };
  const signature = JSON.stringify(playbackMessage);
  if (signature !== lastPlaybackMessage) {
    lastPlaybackMessage = signature;
    chrome.runtime.sendMessage(playbackMessage).catch(() => {});
  }
  if (playerElement) {
    playerElement.querySelector(".blog-listener-playback-status").textContent =
      preparationMessage();
  }
  if (!playerElement) {
    return;
  }

  const settingsSignature = `${state.settings.voice}:${state.settings.rate}:${state.isPlaying}:${sessionVoice}`;
  if (settingsSignature !== renderedSettings) {
    renderedSettings = settingsSignature;
    playerElement.querySelector(".blog-listener-rate").textContent = `${getPlaybackRate().toFixed(1)}×`;
    playerElement.querySelector("[data-action='settings']").textContent = `${getPlaybackRate()}×`;
    playerElement.querySelector("[data-action='slower']").disabled = getPlaybackRate() <= 0.7;
    playerElement.querySelector("[data-action='faster']").disabled = getPlaybackRate() >= 2;
    playerElement.querySelectorAll("input[name='blog-listener-voice']").forEach((input) => { input.checked = input.value === state.settings.voice; });
    const voice = BlogListenerVoices.find((option) => option.id === (state.isPlaying ? sessionVoice : state.settings.voice));
    playerElement.querySelector(".blog-listener-meta").textContent = `${voice.name} · AI voice`;
    playerElement.querySelector(".blog-listener-settings-note").textContent = state.isPlaying
      ? "Voice changes apply after Stop, then Play."
      : "Voice descriptions are approximate.";
  }

  const playButton = playerElement.querySelector("[data-action='play']");
  const titleElement = playerElement.querySelector(".blog-listener-title");
  const adLinkElement = playerElement.querySelector(".blog-listener-ad-link");
  const progressFill = playerElement.querySelector(".blog-listener-progress-fill");
  const isActivelyReading = state.isPlaying && !state.isPaused;

  const playbackIcon = isActivelyReading ? "pause" : "play";
  if (playButton.dataset.playbackIcon !== playbackIcon) {
    playButton.dataset.playbackIcon = playbackIcon;
    playButton.innerHTML = ICONS[playbackIcon];
  }
  playButton.title = isActivelyReading ? "Pause" : "Play";
  playButton.setAttribute("aria-label", isActivelyReading ? "Pause reading" : "Play article");

  if (state.isPlaying && state.chunks.length > 0) {
    playerElement.classList.remove("blog-listener-idle");
    playerElement.classList.toggle("blog-listener-ad-mode", state.isAdPlaying);
    if (state.isAdPlaying && state.currentAd) {
      titleElement.textContent = "";
      adLinkElement.textContent = state.currentAd.title;
      adLinkElement.href = state.currentAd.url;
    } else {
      titleElement.textContent = `${state.title} (${state.chunkIndex + 1}/${state.chunks.length})`;
      titleElement.title = titleElement.textContent;
      adLinkElement.textContent = "";
      adLinkElement.removeAttribute("href");
    }
    renderAdMarkers();
    progressFill.style.width = `${getProgressPercent()}%`;
  } else if (!titleElement.textContent || titleElement.textContent === state.title) {
    playerElement.classList.add("blog-listener-idle");
    playerElement.classList.remove("blog-listener-ad-mode");
    adLinkElement.textContent = "";
    adLinkElement.removeAttribute("href");
    renderAdMarkers();
    progressFill.style.width = "0%";
  } else {
    playerElement.classList.remove("blog-listener-ad-mode");
    adLinkElement.textContent = "";
    adLinkElement.removeAttribute("href");
    renderAdMarkers();
    progressFill.style.width = "0%";
  }
}

function preparationMessage() {
  return state.isPlaying && state.playbackStatus === "buffering" ? "Buffering…" : "";
}

function getProgressPercent() {
  if (state.isAdPlaying && state.currentAdText) {
    return Math.min(100, Math.round((state.currentAdCharIndex / state.currentAdText.length) * 100));
  }

  if (!state.totalChars) {
    return 0;
  }

  const completedChars = state.chunks
    .slice(0, state.chunkIndex)
    .reduce((total, chunk) => total + chunk.text.length, 0);

  return Math.min(100, Math.round(((completedChars + state.currentChunkCharIndex) / state.totalChars) * 100));
}

function getAdMarkerPercents(chunks) {
  const totalChars = chunks.reduce((total, chunk) => total + chunk.text.length, 0);

  if (!totalChars) {
    return [];
  }

  return chunks
    .map((_chunk, index) => index)
    .filter((index) => index > 0 && index < chunks.length && index % AD_BREAK_INTERVAL === 0)
    .map((index) => {
      const completedChars = chunks.slice(0, index).reduce((total, chunk) => total + chunk.text.length, 0);
      return Math.min(98, Math.max(2, (completedChars / totalChars) * 100));
    });
}

function renderAdMarkers() {
  if (!playerElement) {
    return;
  }

  const markerLayer = playerElement.querySelector(".blog-listener-ad-markers");
  if (!markerLayer) {
    return;
  }

  const signature = state.adMarkerPercents.join(",");
  if (markerLayer.dataset.signature === signature) return;
  markerLayer.dataset.signature = signature;

  markerLayer.textContent = "";
  state.adMarkerPercents.forEach((percent) => {
    const marker = document.createElement("span");
    marker.className = "blog-listener-ad-marker";
    marker.style.left = `${percent}%`;
    marker.title = "Ad break";
    markerLayer.append(marker);
  });
}

function setReadingElement(element) {
  if (!element) {
    hideWordHighlight();
    return;
  }

  currentReadingElement = element;

  if (!isElementComfortablyVisible(currentReadingElement)) {
    currentReadingElement.scrollIntoView({
      behavior: "smooth",
      block: "center",
      inline: "nearest"
    });
  }
}

function clearReadingState() {
  currentReadingElement = null;
  hideWordHighlight();
}

function updateWordHighlight(chunk, chunkCharIndex, charLength = 1, updateContext = true) {
  if (!chunk?.element || typeof chunkCharIndex !== "number") {
    hideWordHighlight();
    return;
  }

  if (updateContext) {
    currentWordHighlight = {
      chunk,
      chunkCharIndex,
      charLength
    };
  }

  const wordBounds = getWordBounds(chunk.text, chunkCharIndex, charLength);
  if (!wordBounds) {
    hideWordHighlight();
    return;
  }

  const blockStart = (chunk.blockOffset || 0) + wordBounds.start;
  const blockEnd = (chunk.blockOffset || 0) + wordBounds.end;
  if (updateContext && lastRenderedWord?.element === chunk.element &&
      lastRenderedWord.start === blockStart && lastRenderedWord.end === blockEnd) return;
  const range = getNormalizedTextRange(chunk.element, blockStart, blockEnd);

  if (!range) {
    hideWordHighlight();
    return;
  }

  const rectangle = Array.from(range.getClientRects()).find((rect) => rect.width > 0 && rect.height > 0);
  range.detach();

  if (!rectangle) {
    hideWordHighlight();
    return;
  }

  const highlight = getWordHighlightElement();
  const horizontalPadding = Math.min(8, Math.max(4, rectangle.height * 0.22));
  const verticalPadding = Math.min(5, Math.max(3, rectangle.height * 0.12));

  highlight.style.left = `${rectangle.left - horizontalPadding}px`;
  highlight.style.top = `${rectangle.top - verticalPadding}px`;
  highlight.style.width = `${rectangle.width + horizontalPadding * 2}px`;
  highlight.style.height = `${rectangle.height + verticalPadding * 2}px`;
  highlight.hidden = false;
  lastRenderedWord = { element: chunk.element, start: blockStart, end: blockEnd };
}

function getWordBounds(text, charIndex, charLength = 1) {
  if (!text) {
    return null;
  }

  let index = clamp(charIndex, 0, Math.max(0, text.length - 1));
  const explicitEnd = Number.isFinite(charLength) && charLength > 1 ? index + charLength : null;

  while (index < text.length && /\s/.test(text[index])) {
    index += 1;
  }

  if (index >= text.length) {
    index = text.length - 1;
  }

  let start = index;
  let end = explicitEnd ? clamp(explicitEnd, index + 1, text.length) : index;

  while (start > 0 && !/\s/.test(text[start - 1])) {
    start -= 1;
  }

  while (end < text.length && !/\s/.test(text[end])) {
    end += 1;
  }

  if (start === end) {
    return null;
  }

  return { start, end };
}

function getWordRanges(text) {
  return Array.from(text.matchAll(/\S+/g)).map((match) => ({
    start: match.index,
    end: match.index + match[0].length
  }));
}

function getNormalizedTextRange(root, startIndex, endIndex) {
  const positions = getNormalizedTextPositions(root);
  if (positions.length === 0) {
    return null;
  }

  const safeStart = clamp(startIndex, 0, positions.length - 1);
  const safeEnd = clamp(Math.max(endIndex - 1, safeStart), safeStart, positions.length - 1);
  const startPosition = positions[safeStart];
  const endPosition = positions[safeEnd];
  const range = document.createRange();

  try {
    range.setStart(startPosition.node, startPosition.offset);
    range.setEnd(endPosition.node, endPosition.offset + 1);
    return range;
  } catch (_error) {
    return null;
  }
}

function getNormalizedTextPositions(root) {
  const positions = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  let lastWasSpace = true;

  while (node) {
    const value = node.nodeValue || "";

    for (let index = 0; index < value.length; index += 1) {
      const character = value[index];
      const isSpace = /\s/.test(character);

      if (isSpace) {
        if (!lastWasSpace && positions.length > 0) {
          positions.push({ node, offset: index });
          lastWasSpace = true;
        }
      } else {
        positions.push({ node, offset: index });
        lastWasSpace = false;
      }
    }

    node = walker.nextNode();
  }

  return positions;
}

function getWordHighlightElement() {
  if (!wordHighlightElement) {
    wordHighlightElement = document.createElement("div");
    wordHighlightElement.className = "blog-listener-word-highlight";
    wordHighlightElement.hidden = true;
    document.documentElement.append(wordHighlightElement);
  }

  return wordHighlightElement;
}

function hideWordHighlight() {
  currentWordHighlight = null;
  lastRenderedWord = null;

  if (wordHighlightElement) {
    wordHighlightElement.hidden = true;
  }
}

function scheduleWordHighlightReflow() {
  if (!currentWordHighlight || wordHighlightFrameId) {
    return;
  }

  wordHighlightFrameId = window.requestAnimationFrame(() => {
    const highlight = currentWordHighlight;
    wordHighlightFrameId = null;

    if (highlight) {
      updateWordHighlight(highlight.chunk, highlight.chunkCharIndex, highlight.charLength, false);
    }
  });
}

function isElementComfortablyVisible(element) {
  const rectangle = element.getBoundingClientRect();
  const topMargin = 96;
  const bottomMargin = 140;

  return rectangle.top >= topMargin && rectangle.bottom <= window.innerHeight - bottomMargin;
}

function normalizeText(value = "") {
  return value.replace(/\s+/g, " ").trim();
}

function getReadableText(element) {
  return element ? normalizeText(element.innerText || element.textContent || "") : "";
}

function countWords(text) {
  return normalizeText(text).split(/\s+/).filter(Boolean).length;
}

function isVisible(element) {
  const style = window.getComputedStyle(element);
  const rectangle = element.getBoundingClientRect();

  return style.display !== "none" && style.visibility !== "hidden" && rectangle.width > 0 && rectangle.height > 0;
}
})();
