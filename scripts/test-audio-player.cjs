const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");
const Player = require("../src/audio-player.js");
const flush = async () => { for (let i = 0; i < 8; i++) await new Promise(setImmediate); };

function harness(options = {}) {
  const requests = [];
  const cancelled = [];
  const states = [];
  const positions = [];
  const errors = [];
  let activeRequests = 0;
  let maxRequests = 0;
  let finished = 0;
  const context = {
    state: "running", currentTime: 0, destination: {}, sources: [],
    async resume() { this.state = "running"; },
    async decodeAudioData(bytes) {
      const data = JSON.parse(Buffer.from(bytes).toString());
      if (data.invalid) throw new Error("Invalid audio");
      return { duration: data.duration, length: data.length || data.duration * 24000, numberOfChannels: 1 };
    },
    createBufferSource() {
      const source = { playbackRate: { value: 1 }, stopped: false,
        connect() {}, disconnect() {}, stop() { this.stopped = true; },
        start(time, offset) { this.time = time; this.offset = offset; }
      };
      this.sources.push(source);
      return source;
    }
  };
  const player = new Player({
    contextFactory: () => context,
    setInterval: () => 1, clearInterval() {},
    maxCacheBytes: options.maxCacheBytes,
    requestAudio(text, id) {
      activeRequests++;
      maxRequests = Math.max(maxRequests, activeRequests);
      const request = { text, id };
      requests.push(request);
      const promise = new Promise((resolve, reject) => {
        request.resolve = (duration = 10, extra = {}) => resolve({ ok: true,
          audio: "data:audio/mpeg;base64," + Buffer.from(JSON.stringify({ duration, ...extra })).toString("base64") });
        request.reject = reject;
        request.fail = (error) => resolve({ ok: false, error });
      });
      return promise.finally(() => activeRequests--);
    },
    cancelRequest(id) { cancelled.push(id); },
    onState: (state) => states.push(state),
    onPosition: (segment, index, offset, duration) => positions.push({ segment, index, offset, duration }),
    onFinish: () => finished++, onError: (error) => errors.push(error.message)
  });
  return { player, context, requests, cancelled, states, positions, errors,
    maxRequests: () => maxRequests, finished: () => finished,
    advance(seconds) { context.currentTime += seconds; player.tick(); } };
}

const segments = (count = 8) => Array.from({ length: count }, (_, index) => ({ text: `Paragraph ${index}`, chunkIndex: index,
  paragraphIndex: Math.floor(index / 2) }));
async function prepare(h, count = 4) {
  for (let i = 0; i < count; i++) { h.requests[i].resolve(); await flush(); }
}

async function test() {
  const h = harness();
  h.player.start(segments());
  assert.equal(h.requests.length, 2);
  assert.equal(h.states.at(-1), "buffering");
  h.requests[0].resolve(); await flush();
  assert.equal(h.context.sources.length, 0, "Wait for both starting paragraphs when Play is pressed early");
  assert.equal(h.requests.length, 3);
  for (let i = 1; i < 4; i++) { h.requests[i].resolve(); await flush(); }
  assert.equal(h.maxRequests(), 2);
  assert.equal(h.requests.length, 4, "Prefetch all segments of the first two paragraphs only");
  h.context.sources.forEach((source, index) => assert(Math.abs(source.time - (0.005 + index * 10)) < 1e-9));
  h.advance(2.005);
  const beforeControls = h.requests.length;
  h.player.pause();
  assert.equal(h.player.offset, 2);
  assert(h.context.sources.every((source) => source.stopped));
  h.advance(30);
  assert.equal(h.player.offset, 2, "Paused position must not advance");
  h.player.resume();
  assert.equal(h.context.sources.at(-4).offset, 2);
  assert.equal(h.requests.length, beforeControls, "Resume must reuse decoded audio");
  await h.player.seek(5);
  assert.equal(h.player.index, 0); assert.equal(h.player.offset, 7);
  await h.player.seek(-5);
  assert.equal(h.player.offset, 2);
  h.player.pause();
  await h.player.seek(10);
  assert.equal(h.player.index, 1); assert.equal(h.player.offset, 2);
  const sourceCount = h.context.sources.length;
  await h.player.seek(-5);
  assert.equal(h.player.index, 0); assert.equal(h.player.offset, 7);
  assert.equal(h.context.sources.length, sourceCount, "Seeking while paused must remain silent");
  await Promise.all([h.player.seek(5), h.player.seek(5), h.player.seek(-5)]);
  assert.equal(h.player.index, 1); assert.equal(h.player.offset, 2, "Rapid seek clicks accumulate");
  assert.equal(h.player.paused, true);
  h.player.setRate(1.6);
  h.player.resume();
  assert.equal(h.context.sources.at(-1).playbackRate.value, 1.6);
  assert.equal(h.requests.filter((request) => /Paragraph [0-3]$/.test(request.text)).length, 4,
    "Buffered controls must not regenerate existing speech");
  h.player.stop();

  const ads = harness();
  const playlist = [{ text: "Article one", paragraphIndex: 0 },
    { text: "Sponsor", paragraphIndex: 1, ad: { title: "Sponsor" } }, { text: "Article two", paragraphIndex: 1 }];
  ads.player.start(playlist);
  await prepare(ads, 3);
  ads.advance(10.1);
  assert.equal(ads.positions.at(-1).segment.ad.title, "Sponsor");
  assert.equal(ads.context.sources[1].time, ads.context.sources[0].time + 10);
  ads.player.pause();
  await ads.player.seek(15);
  assert.equal(ads.player.index, 2);
  await ads.player.seek(-10);
  assert.equal(ads.player.index, 1, "Rewind crosses sponsor boundaries by audio duration");
  ads.player.resume();
  ads.advance(20);
  assert.equal(ads.finished(), 1);
  assert.equal(ads.player.active, false);

  const slow = harness();
  slow.player.start(segments(3));
  slow.player.pause();
  await prepare(slow, 3);
  assert.equal(slow.context.sources.length, 0, "Generation must not override a pause");
  slow.player.resume();
  assert.equal(slow.context.sources.length, 3);
  slow.player.stop();

  const underrun = harness();
  underrun.player.start(Array.from({ length: 3 }, (_, index) => ({ text: `Slow paragraph ${index}`, paragraphIndex: index })));
  underrun.requests[0].resolve(1); await flush();
  underrun.requests[1].resolve(1); await flush();
  underrun.advance(2.1);
  assert.equal(underrun.states.at(-1), "buffering");
  underrun.requests[2].resolve(); await flush();
  assert.equal(underrun.states.at(-1), "playing");
  assert.equal(underrun.player.index, 2);
  underrun.player.stop();

  const cancelled = harness();
  cancelled.player.start(segments(2));
  cancelled.player.stop();
  assert.equal(cancelled.cancelled.length, 2);
  cancelled.requests.forEach((request) => request.resolve()); await flush();
  assert.equal(cancelled.context.sources.length, 0, "Late responses must not resurrect stopped playback");
  assert.equal(cancelled.player.cacheBytes, 0);

  const failure = harness();
  failure.player.start(segments(2));
  failure.requests[0].fail("OpenAI speech request failed (401)"); await flush();
  assert.match(failure.errors[0], /401/);
  assert.equal(failure.player.active, false);

  const decode = harness();
  decode.player.start(segments(1));
  decode.requests[0].resolve(1, { invalid: true }); await flush();
  assert.equal(decode.errors[0], "Invalid audio");

  const cache = harness({ maxCacheBytes: 160 });
  cache.player.start(segments(1));
  cache.requests[0].resolve(10, { length: 10 }); await flush();
  cache.player.pause();
  cache.player.retain("old", { length: 10, numberOfChannels: 1, duration: 10 });
  cache.player.retain("recent", { length: 10, numberOfChannels: 1, duration: 10 });
  cache.player.retain("new", { length: 20, numberOfChannels: 1, duration: 10 });
  assert.equal(cache.player.cache.has("old"), false);
  assert.equal(cache.player.cache.has("Paragraph 0"), true, "Current audio must stay pinned");
  assert(cache.player.cacheBytes <= 160);
  assert.throws(() => cache.player.retain("oversize", { length: 100, numberOfChannels: 1 }), /limit/);
  cache.player.stop();

  const preload = harness();
  const paragraphs = Array.from({ length: 5 }, (_, index) => ({ text: `Ready paragraph ${index}`, paragraphIndex: index }));
  preload.player.prepare(paragraphs);
  assert.equal(preload.requests.length, 2, "Page load requests exactly two paragraphs");
  await prepare(preload, 2);
  assert.equal(preload.player.active, false);
  assert.equal(preload.context.sources.length, 0, "Preloading must never autoplay");
  preload.player.startPrepared();
  assert.equal(preload.context.sources.length, 2);
  assert.equal(preload.requests.length, 2, "Play must reuse page-load audio");
  preload.advance(10.1);
  assert.equal(preload.requests.length, 3, "Entering paragraph two triggers paragraph three");
  preload.requests[2].resolve(); await flush();
  assert.equal(preload.requests.length, 3, "Do not prepare paragraph four while listening to paragraph two");
  preload.advance(10);
  assert.equal(preload.requests.length, 4, "Entering paragraph three triggers paragraph four");
  assert.equal(preload.maxRequests(), 2);
  preload.player.stop();

  const refreshed = harness();
  refreshed.player.prepare(paragraphs.slice(0, 2));
  const replacementElement = {};
  refreshed.player.refreshPreparation(paragraphs.map((segment) => ({ ...segment, element: replacementElement })));
  assert.equal(refreshed.requests.length, 2, "DOM replacement must reuse pending requests");
  await prepare(refreshed, 2);
  assert.equal(refreshed.player.getPreparationStatus().initialReady, 2);
  assert.equal(refreshed.player.segments[0].element, replacementElement, "Highlighting must bind to the new DOM");
  refreshed.player.startPrepared();
  assert.equal(refreshed.requests.length, 2);
  refreshed.player.stop();

  const edited = harness();
  edited.player.prepare(paragraphs);
  edited.player.refreshPreparation([{ ...paragraphs[0], text: "Corrected first paragraph" }, ...paragraphs.slice(1)]);
  assert.deepEqual(edited.cancelled, [edited.requests[0].id], "Only changed text should be cancelled");
  edited.requests[0].resolve(); await flush();
  assert.equal(edited.player.cache.has(paragraphs[0].text), false, "Ignore late results for replaced text");
  assert.equal(edited.requests.length, 3);
  assert.equal(edited.requests[2].text, "Corrected first paragraph");
  edited.requests[1].resolve(); edited.requests[2].resolve(); await flush();
  assert.equal(edited.player.getPreparationStatus().initialReady, 2);
  assert.equal(edited.maxRequests(), 2, "Refreshing must preserve the concurrency limit");
  edited.player.stop();

  const content = fs.readFileSync(path.join(__dirname, "../src/content.js"), "utf8");
  const splitter = content.slice(content.indexOf("function splitTextIntoChunks("), content.indexOf("function createPlayer()"));
  const split = vm.runInNewContext("const MAX_UTTERANCE_CHARS = 1800; " + splitter + "; splitTextIntoChunks");
  for (const text of ["x".repeat(10000), "word ".repeat(3000), "A short sentence. ".repeat(1000)]) {
    const pieces = split(text);
    assert(pieces.every((part) => part.text.length <= 1800 && part.text.length > 0));
    for (const part of pieces) assert.equal(text.slice(part.offset, part.offset + part.text.length), part.text);
  }
  console.log("Buffered playback checks passed: scheduling, controls, ads, concurrency, cancellation, failures, cache and splitting.");
}

test().catch((error) => { console.error(error); process.exitCode = 1; });
