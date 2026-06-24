(() => {
if (window.__blogListenerLoaded) {
  return;
}

window.__blogListenerLoaded = true;

const MIN_ARTICLE_WORDS = 80;
const MAX_UTTERANCE_CHARS = 1800;
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
  `
};

const state = {
  chunks: [],
  chunkIndex: 0,
  currentChunkCharIndex: 0,
  currentUtteranceOffset: 0,
  totalChars: 0,
  isPlaying: false,
  isPaused: false,
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
let highlightedElement = null;

createPlayer();

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
  state.chunkIndex = 0;
  state.currentChunkCharIndex = 0;
  state.currentUtteranceOffset = 0;
  state.totalChars = article.chunks.reduce((total, chunk) => total + chunk.text.length, 0);
  state.isPlaying = true;
  state.isPaused = false;
  speakNextChunk();
}

function pauseArticle() {
  if (!state.isPlaying) {
    return;
  }

  if (!state.isPaused) {
    state.isPaused = true;
    speechSynthesis.pause();
  }

  updatePlayer();
}

function resumeArticle() {
  if (!state.isPlaying || !state.isPaused) {
    return;
  }

  state.isPaused = false;

  if (speechSynthesis.paused || speechSynthesis.speaking) {
    speechSynthesis.resume();
  }

  updatePlayer();

  window.setTimeout(() => {
    if (!state.isPlaying || state.isPaused || speechSynthesis.speaking) {
      return;
    }

    speakCurrentChunkFromSavedPosition();
  }, 180);
}

function stopArticle(hidePlayer = true) {
  state.sessionId += 1;
  speechSynthesis.cancel();
  currentUtterance = null;
  state.isPlaying = false;
  state.isPaused = false;
  state.chunkIndex = 0;
  state.currentChunkCharIndex = 0;
  state.currentUtteranceOffset = 0;
  state.totalChars = 0;
  state.chunks = [];
  clearReadingHighlight();

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
  setReadingHighlight(chunk.element);
  utterance.onboundary = (event) => {
    if (sessionId !== state.sessionId || typeof event.charIndex !== "number") {
      return;
    }

    state.currentChunkCharIndex = state.currentUtteranceOffset + event.charIndex;
    updatePlayer();
  };
  utterance.onend = () => {
    if (sessionId !== state.sessionId) {
      return;
    }

    state.chunkIndex += 1;
    state.currentChunkCharIndex = 0;
    state.currentUtteranceOffset = 0;
    speakNextChunk();
  };
  utterance.onerror = () => {
    if (sessionId !== state.sessionId) {
      return;
    }

    stopArticle(false);
    setPlayerMessage("Speech playback stopped");
  };

  currentUtterance = utterance;
  speechSynthesis.speak(utterance);
  updatePlayer();
}

function getResumeOffset(text, charIndex) {
  if (!charIndex || charIndex <= 0) {
    return 0;
  }

  const clampedIndex = Math.min(charIndex, text.length - 1);
  const previousSpace = text.lastIndexOf(" ", clampedIndex);

  return previousSpace > 0 ? previousSpace + 1 : clampedIndex;
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
      splitTextIntoChunks(text).forEach((chunkText) => {
        chunks.push({
          text: chunkText,
          element: block
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
      element: root
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
  const sentences = text.match(/[^.!?]+[.!?]+|\S[\s\S]*$/g) || [text];
  const chunks = [];
  let currentChunk = "";

  sentences.forEach((sentence) => {
    const nextChunk = `${currentChunk} ${sentence}`.trim();

    if (nextChunk.length > MAX_UTTERANCE_CHARS && currentChunk) {
      chunks.push(currentChunk);
      currentChunk = sentence.trim();
    } else {
      currentChunk = nextChunk;
    }
  });

  if (currentChunk) {
    chunks.push(currentChunk);
  }

  return chunks;
}

function createPlayer() {
  if (!playerElement) {
    playerElement = document.createElement("div");
    playerElement.className = "blog-listener-player blog-listener-idle";
    playerElement.innerHTML = `
      <span class="blog-listener-title"></span>
      <span class="blog-listener-progress" aria-hidden="true"><span class="blog-listener-progress-fill"></span></span>
      <button class="blog-listener-button blog-listener-primary" type="button" data-action="play" title="Play" aria-label="Play article">${ICONS.play}</button>
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

      if (button.dataset.action === "pause") {
        pauseArticle();
      }

      if (button.dataset.action === "stop") {
        stopArticle();
      }
    });

    document.documentElement.append(playerElement);
  }

  updatePlayer();
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
  const progressFill = playerElement.querySelector(".blog-listener-progress-fill");
  const isActivelyReading = state.isPlaying && !state.isPaused;

  playButton.innerHTML = isActivelyReading ? ICONS.pause : ICONS.play;
  playButton.title = isActivelyReading ? "Pause" : "Play";
  playButton.setAttribute("aria-label", isActivelyReading ? "Pause reading" : "Play article");

  if (state.isPlaying && state.chunks.length > 0) {
    playerElement.classList.remove("blog-listener-idle");
    titleElement.textContent = `${state.title} (${state.chunkIndex + 1}/${state.chunks.length})`;
    progressFill.style.width = `${getProgressPercent()}%`;
  } else if (!titleElement.textContent || titleElement.textContent === state.title) {
    playerElement.classList.add("blog-listener-idle");
    progressFill.style.width = "0%";
  } else {
    progressFill.style.width = "0%";
  }
}

function getProgressPercent() {
  if (!state.totalChars) {
    return 0;
  }

  const completedChars = state.chunks
    .slice(0, state.chunkIndex)
    .reduce((total, chunk) => total + chunk.text.length, 0);

  return Math.min(100, Math.round(((completedChars + state.currentChunkCharIndex) / state.totalChars) * 100));
}

function setReadingHighlight(element) {
  if (!element || highlightedElement === element) {
    return;
  }

  clearReadingHighlight();
  highlightedElement = element;
  highlightedElement.classList.add("blog-listener-reading-highlight");
  highlightedElement.setAttribute("data-blog-listener-reading", "true");

  if (!isElementComfortablyVisible(highlightedElement)) {
    highlightedElement.scrollIntoView({
      behavior: "smooth",
      block: "center",
      inline: "nearest"
    });
  }
}

function clearReadingHighlight() {
  if (!highlightedElement) {
    return;
  }

  highlightedElement.classList.remove("blog-listener-reading-highlight");
  highlightedElement.removeAttribute("data-blog-listener-reading");
  highlightedElement = null;
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
