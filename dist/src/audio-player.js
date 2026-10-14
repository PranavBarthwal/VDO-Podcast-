(() => {
  if (globalThis.BlogAudioPlayer) return;

  class BlogAudioPlayer {
    constructor(options) {
      this.options = options;
      this.context = null;
      this.generation = 0;
      this.requestSequence = 0;
      this.inflight = 0;
      this.queue = [];
      this.pending = new Map();
      this.cache = new Map();
      this.cacheBytes = 0;
      this.maxCacheBytes = options.maxCacheBytes ?? 64 * 1024 * 1024;
      this.scheduled = [];
      this.segments = [];
      this.index = 0;
      this.offset = 0;
      this.rate = 1;
      this.active = false;
      this.prepared = false;
      this.warming = false;
      this.paused = false;
      this.seeking = false;
      this.seekVersion = 0;
      this.seekBase = null;
      this.seekDelta = 0;
      this.timer = null;
      this.lastState = "idle";
      this.lastPreparation = "";
    }

    ensureContext() {
      if (!this.context) {
        this.context = this.options.contextFactory
          ? this.options.contextFactory()
          : new (globalThis.AudioContext || globalThis.webkitAudioContext)();
      }
      return this.context;
    }

    prepare(segments, rate = 1) {
      this.stop();
      this.segments = segments.map((segment, index) => ({ ...segment,
        paragraphIndex: segment.paragraphIndex ?? index, duration: null, error: null }));
      this.rate = rate;
      this.prepared = this.segments.length > 0;
      this.fill();
      this.notifyPreparation();
    }

    refreshPreparation(segments, rate = this.rate) {
      if (this.active) return;
      if (!this.prepared) { this.prepare(segments, rate); return; }
      const previous = new Map(this.segments.map((segment) => [segment.text, segment]));
      this.segments = segments.map((segment, index) => ({ ...segment,
        paragraphIndex: segment.paragraphIndex ?? index,
        duration: this.cache.get(segment.text)?.buffer.duration ?? previous.get(segment.text)?.duration ?? null,
        error: previous.get(segment.text)?.error ?? null }));
      this.rate = rate;
      this.prepared = this.segments.length > 0;
      const firstParagraph = this.segments[0]?.paragraphIndex ?? 0;
      const needed = new Set(this.segments.filter((segment) => segment.paragraphIndex <= firstParagraph + 1).map((segment) => segment.text));
      for (const [text, job] of this.pending) {
        if (needed.has(text)) continue;
        this.pending.delete(text);
        this.queue = this.queue.filter((queued) => queued !== job);
        if (job.started) Promise.resolve(this.options.cancelRequest?.(job.id)).catch(() => {});
        job.reject(new Error("Article text changed"));
      }
      const valid = new Set(this.segments.map((segment) => segment.text));
      for (const [text, entry] of this.cache) {
        if (!valid.has(text)) { this.cacheBytes -= entry.bytes; this.cache.delete(text); }
      }
      this.fill();
      this.notifyPreparation();
    }

    getPreparationStatus() {
      const groups = [...new Set(this.segments.map((segment) => segment.paragraphIndex))];
      const initial = groups.slice(0, 2);
      const ready = (group) => this.segments.filter((segment) => segment.paragraphIndex === group)
        .every((segment) => this.cache.has(segment.text));
      const current = this.segments[this.index]?.paragraphIndex;
      const next = groups.find((group) => group > current);
      return {
        initialTotal: initial.length, initialReady: initial.filter(ready).length,
        currentParagraph: this.active && current !== undefined ? current + 1 : null,
        nextParagraph: next === undefined ? null : next + 1,
        nextReady: next === undefined || ready(next),
        error: this.segments.find((segment) => initial.includes(segment.paragraphIndex) && segment.error)?.error.message || null
      };
    }

    notifyPreparation() {
      const status = this.getPreparationStatus();
      const signature = JSON.stringify(status);
      if (signature !== this.lastPreparation) {
        this.lastPreparation = signature;
        this.options.onPreparation?.(status);
      }
    }

    start(segments, rate = 1) {
      this.prepare(segments, rate);
      this.startPrepared(rate);
    }

    startPrepared(rate = this.rate) {
      if (this.active || !this.prepared) return;
      this.rate = rate;
      for (const segment of this.segments) segment.error = null;
      this.active = true;
      this.warming = true;
      const generation = this.generation;
      try {
        const context = this.ensureContext();
        Promise.resolve(context.resume()).then(() => {
          if (generation === this.generation && this.active) this.tick();
        }).catch((error) => this.fail(error, generation));
        this.timer = (this.options.setInterval || globalThis.setInterval)(() => this.tick(), 40);
        this.fill();
        this.tick();
      } catch (error) {
        this.fail(error, generation);
      }
    }

    stop() {
      this.generation++;
      this.seekVersion++;
      this.active = false;
      this.prepared = false;
      this.warming = false;
      this.paused = false;
      this.seeking = false;
      this.seekBase = null;
      this.seekDelta = 0;
      this.unschedule();
      if (this.timer !== null) (this.options.clearInterval || globalThis.clearInterval)(this.timer);
      this.timer = null;
      for (const job of this.pending.values()) {
        if (job.started) Promise.resolve(this.options.cancelRequest?.(job.id)).catch(() => {});
        job.reject(new Error("Playback cancelled"));
      }
      this.pending.clear();
      this.queue = [];
      this.cache.clear();
      this.cacheBytes = 0;
      this.segments = [];
      this.index = 0;
      this.offset = 0;
      this.emitState("idle");
      this.notifyPreparation();
    }

    pause() {
      if (!this.active || this.paused) return;
      this.tick();
      if (!this.active) return;
      this.paused = true;
      this.unschedule();
      this.emitState("paused");
    }

    resume() {
      if (!this.active || !this.paused) return;
      this.paused = false;
      const generation = this.generation;
      Promise.resolve(this.ensureContext().resume()).then(() => {
        if (generation === this.generation) this.tick();
      }).catch((error) => this.fail(error, generation));
      this.fill();
      this.tick();
    }

    setRate(rate) {
      if (!Number.isFinite(rate) || rate <= 0 || rate === this.rate) return;
      this.tick();
      this.rate = rate;
      this.unschedule();
      this.tick();
    }

    async seek(seconds) {
      if (!this.active || !Number.isFinite(seconds)) return;
      this.tick();
      if (!this.active) return;
      if (!this.seekBase) {
        this.seekBase = { index: this.index, offset: this.offset };
        this.seekDelta = 0;
      }
      this.seekDelta += seconds;
      const version = ++this.seekVersion;
      const generation = this.generation;
      this.seeking = true;
      this.warming = false;
      this.unschedule();
      this.emitState(this.paused ? "paused" : "buffering");
      try {
        const position = await this.locate(this.seekBase, this.seekDelta, generation, version);
        if (!position || generation !== this.generation || version !== this.seekVersion) return;
        this.index = position.index;
        this.offset = position.offset;
        this.seekBase = null;
        this.seekDelta = 0;
        this.seeking = false;
        this.notifyPosition();
        this.fill();
        this.tick();
      } catch (error) {
        if (version === this.seekVersion) this.fail(error, generation);
      }
    }

    async locate(base, delta, generation, version) {
      let index = base.index;
      let offset = base.offset + delta;
      while (true) {
        if (generation !== this.generation || version !== this.seekVersion) return null;
        if (offset < 0) {
          if (index === 0) return { index: 0, offset: 0 };
          index--;
          if (this.segments[index].duration === null) await this.load(index, true);
          if (generation !== this.generation || version !== this.seekVersion) return null;
          offset += this.segments[index].duration;
        } else {
          if (this.segments[index].duration === null) await this.load(index, true);
          if (generation !== this.generation || version !== this.seekVersion) return null;
          const duration = this.segments[index].duration;
          if (offset < duration) return { index, offset };
          if (index === this.segments.length - 1) return { index, offset: duration };
          offset -= duration;
          index++;
        }
      }
    }

    getBuffer(index) {
      const key = this.segments[index]?.text;
      const entry = this.cache.get(key);
      if (!entry) return null;
      this.cache.delete(key);
      this.cache.set(key, entry);
      return entry.buffer;
    }

    retain(text, buffer) {
      const bytes = buffer.length * buffer.numberOfChannels * 4;
      if (bytes > this.maxCacheBytes) throw new Error("Audio segment exceeds the buffer limit.");
      const pinned = new Set(this.scheduled.map((item) => this.segments[item.index].text));
      pinned.add(this.segments[this.index]?.text);
      while (this.cacheBytes + bytes > this.maxCacheBytes) {
        const candidate = [...this.cache.keys()].find((key) => !pinned.has(key));
        if (candidate === undefined) throw new Error("Audio buffer is full. Try a shorter segment.");
        this.cacheBytes -= this.cache.get(candidate).bytes;
        this.cache.delete(candidate);
      }
      this.cache.set(text, { buffer, bytes });
      this.cacheBytes += bytes;
    }

    load(index, priority = false) {
      const segment = this.segments[index];
      const buffer = this.getBuffer(index);
      if (buffer) {
        segment.duration = buffer.duration;
        return Promise.resolve(buffer);
      }
      if (segment.error) return Promise.reject(segment.error);
      const existing = this.pending.get(segment.text);
      if (existing) {
        if (priority && !existing.started) {
          this.queue = this.queue.filter((job) => job !== existing);
          this.queue.unshift(existing);
        }
        return existing.promise;
      }
      const job = {
        text: segment.text,
        id: `${this.generation}:${++this.requestSequence}`,
        generation: this.generation,
        started: false
      };
      job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
      this.pending.set(job.text, job);
      if (priority) this.queue.unshift(job); else this.queue.push(job);
      this.pump();
      return job.promise;
    }

    pump() {
      while (this.inflight < 2 && this.queue.length) {
        const job = this.queue.shift();
        if (job.generation !== this.generation) continue;
        job.started = true;
        this.inflight++;
        this.runJob(job);
      }
    }

    async runJob(job) {
      try {
        const result = await this.options.requestAudio(job.text, job.id);
        if (job.generation !== this.generation || this.pending.get(job.text) !== job) return;
        if (!result?.ok) throw new Error(result?.error || "Could not generate speech.");
        const encoded = result.audio.split(",")[1];
        const binary = atob(encoded);
        const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
        const buffer = await this.ensureContext().decodeAudioData(bytes.buffer);
        if (job.generation !== this.generation || this.pending.get(job.text) !== job) return;
        if (!Number.isFinite(buffer.duration) || buffer.duration <= 0) throw new Error("Generated audio is empty.");
        this.retain(job.text, buffer);
        for (const segment of this.segments) {
          if (segment.text === job.text) { segment.duration = buffer.duration; segment.error = null; }
        }
        job.resolve(buffer);
      } catch (error) {
        if (job.generation === this.generation && this.pending.get(job.text) === job) {
          for (const segment of this.segments) if (segment.text === job.text) segment.error = error;
          job.reject(error);
        }
      } finally {
        if (this.pending.get(job.text) === job) this.pending.delete(job.text);
        this.inflight--;
        this.pump();
        if (job.generation === this.generation) { this.tick(); this.notifyPreparation(); }
      }
    }

    fill() {
      if (!this.prepared || !this.segments[this.index]) return;
      const lastParagraph = this.segments[this.index].paragraphIndex + 1;
      for (let index = this.index; index < this.segments.length && this.segments[index].paragraphIndex <= lastParagraph; index++) {
        this.load(index, index === this.index).catch(() => {});
      }
    }

    unschedule() {
      for (const item of this.scheduled) {
        item.source.onended = null;
        item.source.stop();
        item.source.disconnect();
      }
      this.scheduled = [];
    }

    schedule() {
      if (!this.active || this.paused || this.seeking || this.context.state !== "running") return;
      if (this.warming) {
        const lastParagraph = this.segments[this.index].paragraphIndex + 1;
        for (let i = this.index; i < this.segments.length && this.segments[i].paragraphIndex <= lastParagraph; i++) {
          if (this.segments[i].error) { this.fail(this.segments[i].error, this.generation); return; }
          if (!this.getBuffer(i)) return;
        }
        this.warming = false;
      }
      const last = this.scheduled[this.scheduled.length - 1];
      let index = last ? last.index + 1 : this.index;
      let start = last ? last.end : this.context.currentTime + 0.005;
      const lastParagraph = this.segments[this.index].paragraphIndex + 1;
      while (index < this.segments.length && this.segments[index].paragraphIndex <= lastParagraph) {
        const buffer = this.getBuffer(index);
        if (!buffer) break;
        const offset = this.scheduled.length ? 0 : this.offset;
        const source = this.context.createBufferSource();
        source.buffer = buffer;
        source.playbackRate.value = this.rate;
        source.connect(this.context.destination);
        const item = { index, offset, start, end: start + (buffer.duration - offset) / this.rate,
          rate: this.rate, source };
        source.onended = () => this.tick();
        source.start(start, offset);
        this.scheduled.push(item);
        start = item.end;
        index++;
      }
    }

    tick() {
      if (!this.active || !this.context) return;
      const now = this.context.currentTime;
      if (!this.paused && !this.seeking) {
        while (this.scheduled.length && this.scheduled[0].end <= now) {
          const finished = this.scheduled.shift();
          finished.source.onended = null;
          finished.source.disconnect();
          this.index = finished.index + 1;
          this.offset = 0;
        }
        if (this.index >= this.segments.length) {
          this.stop();
          this.options.onFinish?.();
          return;
        }
        const current = this.scheduled[0];
        if (current && current.start <= now) {
          this.index = current.index;
          this.offset = Math.min(this.segments[this.index].duration,
            current.offset + (now - current.start) * current.rate);
        }
        if (this.segments[this.index]?.error) {
          this.fail(this.segments[this.index].error, this.generation);
          return;
        }
        this.fill();
        this.schedule();
        if (!this.active) return;
      }
      this.notifyPosition();
      this.notifyPreparation();
      this.emitState(this.paused ? "paused" : this.seeking || !this.scheduled.length ? "buffering" : "playing");
    }

    notifyPosition() {
      const segment = this.segments[this.index];
      if (segment) this.options.onPosition?.(segment, this.index, this.offset, segment.duration);
    }

    emitState(value) {
      if (value === this.lastState) return;
      this.lastState = value;
      this.options.onState?.(value);
    }

    fail(error, generation) {
      if (generation !== this.generation || !this.active) return;
      this.stop();
      this.options.onError?.(error);
    }
  }

  globalThis.BlogAudioPlayer = BlogAudioPlayer;
  if (typeof module !== "undefined") module.exports = BlogAudioPlayer;
})();
