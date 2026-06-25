(() => {
if (window.__blogListenerLoaded) {
  return;
}

window.__blogListenerLoaded = true;

const MIN_ARTICLE_WORDS = 80;
const MAX_UTTERANCE_CHARS = 1800;
const AD_BREAK_INTERVAL = 4;
const SEEK_SECONDS = 5;
const ESTIMATED_CHARS_PER_SECOND = 14;
const DEFAULT_WORDS_PER_MINUTE = 175;
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
    pitch: 1,
    voiceURI: ""
  }
};

let playerElement = null;
let currentUtterance = null;
let currentReadingElement = null;
let wordHighlightElement = null;
let currentWordHighlight = null;
let wordHighlightFrameId = null;
let wordAdvanceTimerId = null;
let wordAdvanceContext = null;
let nudgeTimeoutId = null;

createPlayer();
window.addEventListener("scroll", scheduleWordHighlightReflow, { passive: true });
window.addEventListener("resize", scheduleWordHighlightReflow);

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
      isPaused: state.isPaused
    });
    return false;
  }

  if (message.type === "BLOG_LISTENER_PLAY") {
    playArticle(message.settings || {});
    sendResponse({ ok: true });
    return false;
  }

  if (message.type === "BLOG_LISTENER_PAUSE") {
    pauseArticle();
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

function playArticle(settings = {}) {
  state.settings = { ...state.settings, ...settings };
  hideNudge();

  if (state.isPaused) {
    resumeArticle();
    return;
  }

  const article = extractArticle();
  if (article.wordCount < MIN_ARTICLE_WORDS) {
    setPlayerMessage("No readable article found");
    return;
  }

  stopArticle(false);
  state.sessionId += 1;
  state.title = article.title;
  state.chunks = article.chunks;
  state.adMarkerPercents = getAdMarkerPercents(article.chunks);
  state.chunkIndex = 0;
  state.currentChunkCharIndex = 0;
  state.currentUtteranceOffset = 0;
  state.currentAdCharIndex = 0;
  state.currentAdOffset = 0;
  state.currentAdText = "";
  state.currentAd = null;
  state.totalChars = article.chunks.reduce((total, chunk) => total + chunk.text.length, 0);
  state.isPlaying = true;
  state.isPaused = false;
  state.isAdPlaying = false;
  state.adBreaksPlayed = new Set();
  speakNextChunk();
}

function pauseArticle() {
  if (!state.isPlaying) {
    return;
  }

  if (!state.isPaused) {
    state.isPaused = true;
    stopWordAdvanceTimer();
    speechSynthesis.pause();
  }

  updatePlayer();
}

function resumeArticle() {
  if (!state.isPlaying || !state.isPaused) {
    return;
  }

  state.isPaused = false;
  resumeWordAdvanceTimer();

  if (speechSynthesis.paused || speechSynthesis.speaking) {
    speechSynthesis.resume();
  }

  updatePlayer();

  window.setTimeout(() => {
    if (!state.isPlaying || state.isPaused || speechSynthesis.speaking) {
      return;
    }

    if (state.isAdPlaying) {
      speakAdBreak(getResumeOffset(state.currentAdText, state.currentAdCharIndex), state.currentAd);
    } else {
      speakCurrentChunkFromSavedPosition();
    }
  }, 180);
}

function seekPlayback(direction) {
  if (!state.isPlaying || state.chunks.length === 0) {
    return;
  }

  const wasPaused = state.isPaused;
  const charDelta = direction * SEEK_SECONDS * ESTIMATED_CHARS_PER_SECOND * getPlaybackRate();
  state.sessionId += 1;
  stopWordAdvanceTimer();
  speechSynthesis.cancel();
  state.isPaused = false;

  if (state.isAdPlaying) {
    seekAdByCharacters(charDelta, wasPaused);
  } else {
    seekArticleByCharacters(charDelta, wasPaused);
  }
}

function seekAdByCharacters(charDelta, wasPaused) {
  const targetOffset = clamp(
    getResumeOffset(state.currentAdText, state.currentAdCharIndex + charDelta),
    0,
    Math.max(0, state.currentAdText.length - 1)
  );

  if (targetOffset >= state.currentAdText.length - 2) {
    finishAdBreak();
    return;
  }

  if (wasPaused) {
    state.currentAdCharIndex = targetOffset;
    state.currentAdOffset = targetOffset;
    state.isPaused = true;
    updatePlayer();
    return;
  }

  speakAdBreak(targetOffset, state.currentAd);
}

function seekArticleByCharacters(charDelta, wasPaused) {
  const target = getArticlePositionFromAbsoluteOffset(getCurrentArticleAbsoluteOffset() + charDelta);
  state.chunkIndex = target.chunkIndex;
  state.currentChunkCharIndex = target.charIndex;
  state.currentUtteranceOffset = target.charIndex;

  if (wasPaused) {
    state.isPaused = true;
    const chunk = state.chunks[state.chunkIndex];
    setReadingElement(chunk?.element);
    updateWordHighlight(chunk, state.currentChunkCharIndex);
    updatePlayer();
    return;
  }

  speakCurrentChunkFromSavedPosition();
}

function stopArticle(hidePlayer = true) {
  state.sessionId += 1;
  stopWordAdvanceTimer(true);
  speechSynthesis.cancel();
  currentUtterance = null;
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

function speakNextChunk() {
  if (!state.isPlaying || state.chunkIndex >= state.chunks.length) {
    stopArticle(false);
    setPlayerMessage("Finished");
    return;
  }

  if (shouldPlayAdBreak()) {
    speakAdBreak();
    return;
  }

  const chunk = state.chunks[state.chunkIndex];
  speakChunk(chunk, 0);
}

function speakCurrentChunkFromSavedPosition() {
  if (!state.isPlaying || state.chunkIndex >= state.chunks.length) {
    return;
  }

  const chunk = state.chunks[state.chunkIndex];
  const offset = getResumeOffset(chunk.text, state.currentChunkCharIndex);
  speakChunk(chunk, offset);
}

function speakChunk(chunk, offset) {
  const sessionId = state.sessionId;
  const text = chunk.text.slice(offset).trim();

  if (!text) {
    state.chunkIndex += 1;
    state.currentChunkCharIndex = 0;
    state.currentUtteranceOffset = 0;
    speakNextChunk();
    return;
  }

  const utterance = new SpeechSynthesisUtterance(text);
  const voice = speechSynthesis
    .getVoices()
    .find((availableVoice) => availableVoice.voiceURI === state.settings.voiceURI);

  if (voice) {
    utterance.voice = voice;
  }

  utterance.rate = Number(state.settings.rate) || 1;
  utterance.pitch = Number(state.settings.pitch) || 1;
  state.currentUtteranceOffset = offset;
  state.currentChunkCharIndex = offset;
  setReadingElement(chunk.element);
  updateWordHighlight(chunk, offset, 1);
  startWordAdvanceTimer(chunk, offset, sessionId);
  utterance.onboundary = (event) => {
    if (sessionId !== state.sessionId || typeof event.charIndex !== "number") {
      return;
    }

    state.currentChunkCharIndex = state.currentUtteranceOffset + event.charIndex;
    updateWordHighlight(
      chunk,
      state.currentChunkCharIndex,
      event.name === "word" ? event.charLength : 1
    );
    syncWordAdvanceTimer(state.currentChunkCharIndex);
    updatePlayer();
  };
  utterance.onend = () => {
    if (sessionId !== state.sessionId) {
      return;
    }

    stopWordAdvanceTimer();
    state.chunkIndex += 1;
    state.currentChunkCharIndex = 0;
    state.currentUtteranceOffset = 0;
    speakNextChunk();
  };
  utterance.onerror = () => {
    if (sessionId !== state.sessionId) {
      return;
    }

    stopWordAdvanceTimer();
    stopArticle(false);
    setPlayerMessage("Speech playback stopped");
  };

  currentUtterance = utterance;
  speechSynthesis.speak(utterance);
  updatePlayer();
}

function shouldPlayAdBreak() {
  return (
    state.chunkIndex > 0 &&
    state.chunkIndex < state.chunks.length &&
    state.chunkIndex % AD_BREAK_INTERVAL === 0 &&
    !state.adBreaksPlayed.has(state.chunkIndex)
  );
}

function speakAdBreak(offset = 0, resumeAd = null) {
  const sessionId = state.sessionId;
  const ad = resumeAd || state.currentAd || getNextAd();
  const adText = ad.script;
  const text = adText.slice(offset).trim();

  if (!text) {
    finishAdBreak();
    return;
  }

  state.isAdPlaying = true;
  stopWordAdvanceTimer(true);
  state.currentAd = ad;
  state.currentAdText = adText;
  state.currentAdOffset = offset;
  state.currentAdCharIndex = offset;
  clearReadingState();

  const utterance = new SpeechSynthesisUtterance(text);
  const voice = speechSynthesis
    .getVoices()
    .find((availableVoice) => availableVoice.voiceURI === state.settings.voiceURI);

  if (voice) {
    utterance.voice = voice;
  }

  utterance.rate = Math.max(0.85, Number(state.settings.rate) || 1);
  utterance.pitch = Number(state.settings.pitch) || 1;
  utterance.onboundary = (event) => {
    if (sessionId !== state.sessionId || typeof event.charIndex !== "number") {
      return;
    }

    state.currentAdCharIndex = state.currentAdOffset + event.charIndex;
    updatePlayer();
  };
  utterance.onend = () => {
    if (sessionId !== state.sessionId) {
      return;
    }

    finishAdBreak();
  };
  utterance.onerror = () => {
    if (sessionId !== state.sessionId) {
      return;
    }

    finishAdBreak();
  };

  currentUtterance = utterance;
  speechSynthesis.speak(utterance);
  updatePlayer();
}

function finishAdBreak() {
  state.adBreaksPlayed.add(state.chunkIndex);
  state.isAdPlaying = false;
  state.currentAdText = "";
  state.currentAd = null;
  state.currentAdCharIndex = 0;
  state.currentAdOffset = 0;
  speakNextChunk();
}

function getNextAd() {
  return SIMULATED_ADS[state.adBreaksPlayed.size % SIMULATED_ADS.length];
}

function getResumeOffset(text, charIndex) {
  if (!charIndex || charIndex <= 0) {
    return 0;
  }

  const clampedIndex = Math.min(charIndex, text.length - 1);
  const previousSpace = text.lastIndexOf(" ", clampedIndex);

  return previousSpace > 0 ? previousSpace + 1 : clampedIndex;
}

function getCurrentArticleAbsoluteOffset() {
  const completedChars = state.chunks
    .slice(0, state.chunkIndex)
    .reduce((total, chunk) => total + chunk.text.length, 0);

  return completedChars + state.currentChunkCharIndex;
}

function getArticlePositionFromAbsoluteOffset(offset) {
  let remaining = clamp(offset, 0, Math.max(0, state.totalChars - 1));

  for (let index = 0; index < state.chunks.length; index += 1) {
    const chunkLength = state.chunks[index].text.length;

    if (remaining <= chunkLength) {
      return {
        chunkIndex: index,
        charIndex: getResumeOffset(state.chunks[index].text, remaining)
      };
    }

    remaining -= chunkLength;
  }

  return {
    chunkIndex: Math.max(0, state.chunks.length - 1),
    charIndex: 0
  };
}

function getPlaybackRate() {
  return Math.max(0.7, Number(state.settings.rate) || 1);
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

  return [
    {
      text: normalizeText(root.innerText || root.textContent || ""),
      element: root,
      blockOffset: 0
    }
  ];
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
  const sentences = Array.from(text.matchAll(/[^.!?]+[.!?]+|\S[\s\S]*$/g));
  const chunks = [];
  let currentChunk = "";
  let currentOffset = 0;

  if (sentences.length === 0) {
    return [{ text, offset: 0 }];
  }

  sentences.forEach((match) => {
    const rawSentence = match[0];
    const sentence = rawSentence.trim();
    const firstCharacterOffset = rawSentence.search(/\S/);
    const sentenceOffset = match.index + Math.max(0, firstCharacterOffset);

    if (!sentence) {
      return;
    }

    const nextChunk = currentChunk ? `${currentChunk} ${sentence}` : sentence;

    if (nextChunk.length > MAX_UTTERANCE_CHARS && currentChunk) {
      chunks.push({
        text: currentChunk,
        offset: currentOffset
      });
      currentChunk = sentence.trim();
      currentOffset = sentenceOffset;
    } else {
      if (!currentChunk) {
        currentOffset = sentenceOffset;
      }

      currentChunk = nextChunk;
    }
  });

  if (currentChunk) {
    chunks.push({
      text: currentChunk,
      offset: currentOffset
    });
  }

  return chunks;
}

function createPlayer() {
  if (!playerElement) {
    playerElement = document.createElement("div");
    playerElement.className = "blog-listener-player blog-listener-idle";
    playerElement.innerHTML = `
      <span class="blog-listener-nudge">Listen to this blog and save time</span>
      <span class="blog-listener-copy">
        <span class="blog-listener-ad-label">Sponsored ad</span>
        <span class="blog-listener-title"></span>
        <a class="blog-listener-ad-link" href="#" target="_blank" rel="noopener noreferrer"></a>
      </span>
      <span class="blog-listener-progress" aria-hidden="true">
        <span class="blog-listener-progress-fill"></span>
        <span class="blog-listener-ad-markers"></span>
      </span>
      <button class="blog-listener-button blog-listener-secondary" type="button" data-action="rewind" title="Back 5 seconds" aria-label="Go back 5 seconds">${ICONS.rewind5}</button>
      <button class="blog-listener-button blog-listener-primary" type="button" data-action="play" title="Play" aria-label="Play article">${ICONS.play}</button>
      <button class="blog-listener-button blog-listener-secondary" type="button" data-action="forward" title="Skip forward 5 seconds" aria-label="Skip forward 5 seconds">${ICONS.forward5}</button>
      <button class="blog-listener-button blog-listener-stop" type="button" data-action="stop" title="Stop" aria-label="Stop reading">${ICONS.stop}</button>
    `;

    playerElement.addEventListener("click", (event) => {
      const button = event.target.closest("button[data-action]");
      if (!button) {
        return;
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
    scheduleNudgeDismissal();
  }

  updatePlayer();
}

function scheduleNudgeDismissal() {
  if (nudgeTimeoutId) {
    window.clearTimeout(nudgeTimeoutId);
  }

  nudgeTimeoutId = window.setTimeout(() => {
    hideNudge();
  }, 9000);
}

function hideNudge() {
  if (!playerElement) {
    return;
  }

  playerElement.classList.add("blog-listener-nudge-hidden");
}

async function playFromPageButton() {
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
  if (!playerElement) {
    return;
  }

  const playButton = playerElement.querySelector("[data-action='play']");
  const titleElement = playerElement.querySelector(".blog-listener-title");
  const adLinkElement = playerElement.querySelector(".blog-listener-ad-link");
  const progressFill = playerElement.querySelector(".blog-listener-progress-fill");
  const isActivelyReading = state.isPlaying && !state.isPaused;

  playButton.innerHTML = isActivelyReading ? ICONS.pause : ICONS.play;
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

function startWordAdvanceTimer(chunk, offset, sessionId) {
  stopWordAdvanceTimer();

  const words = getWordRanges(chunk.text).filter((word) => word.end >= offset);
  if (words.length === 0) {
    return;
  }

  const wordIndex = Math.max(0, words.findIndex((word) => word.end >= offset));
  wordAdvanceContext = {
    chunk,
    sessionId,
    words,
    wordIndex,
    intervalMs: getEstimatedWordIntervalMs()
  };

  updateWordFromAdvanceContext();
  wordAdvanceTimerId = window.setInterval(() => {
    if (!wordAdvanceContext || state.sessionId !== wordAdvanceContext.sessionId || state.isPaused || state.isAdPlaying) {
      return;
    }

    if (wordAdvanceContext.wordIndex < wordAdvanceContext.words.length - 1) {
      wordAdvanceContext.wordIndex += 1;
      updateWordFromAdvanceContext();
    }
  }, wordAdvanceContext.intervalMs);
}

function updateWordFromAdvanceContext() {
  if (!wordAdvanceContext) {
    return;
  }

  const word = wordAdvanceContext.words[wordAdvanceContext.wordIndex];
  state.currentChunkCharIndex = word.start;
  updateWordHighlight(wordAdvanceContext.chunk, word.start, word.end - word.start);
  updatePlayer();
}

function syncWordAdvanceTimer(charIndex) {
  if (!wordAdvanceContext) {
    return;
  }

  const nextIndex = wordAdvanceContext.words.findIndex((word) => word.end >= charIndex);
  if (nextIndex >= 0) {
    wordAdvanceContext.wordIndex = nextIndex;
  }
}

function resumeWordAdvanceTimer() {
  if (!wordAdvanceContext || wordAdvanceTimerId) {
    return;
  }

  wordAdvanceTimerId = window.setInterval(() => {
    if (!wordAdvanceContext || state.sessionId !== wordAdvanceContext.sessionId || state.isPaused || state.isAdPlaying) {
      return;
    }

    if (wordAdvanceContext.wordIndex < wordAdvanceContext.words.length - 1) {
      wordAdvanceContext.wordIndex += 1;
      updateWordFromAdvanceContext();
    }
  }, wordAdvanceContext.intervalMs);
}

function stopWordAdvanceTimer(clearContext = false) {
  if (wordAdvanceTimerId) {
    window.clearInterval(wordAdvanceTimerId);
    wordAdvanceTimerId = null;
  }

  if (clearContext) {
    wordAdvanceContext = null;
  }
}

function getEstimatedWordIntervalMs() {
  const rate = getPlaybackRate();
  return Math.max(120, Math.round(60000 / (DEFAULT_WORDS_PER_MINUTE * rate)));
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
      updateWordHighlight(highlight.chunk, highlight.chunkCharIndex, highlight.charLength);
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
