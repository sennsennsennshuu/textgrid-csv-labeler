// TextGrid 工具的音频解码与播放适配层。
import { parseWav } from './dsp.js';

// 解码 API 本身无法中断，因此每个异步边界之后都要检查取消状态。
function checkAborted(signal) {
  if (signal?.aborted) throw Object.assign(new Error('音频解码已取消'), { name: 'AbortError' });
}

export async function decodeAudioFile(file, { signal } = {}) {
  checkAborted(signal);
  const bytes = new Uint8Array(await file.arrayBuffer());
  checkAborted(signal);
  try {
    const wav = parseWav(bytes);
    return { mono: wav.mono, sampleRate: wav.sampleRate, duration: wav.mono.length / wav.sampleRate, channels: wav.channels };
  } catch (wavError) {
    const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (typeof Context !== 'function') throw wavError;
    const context = new Context();
    let result;
    try {
      const decoded = await context.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
      checkAborted(signal);
      const mono = new Float32Array(decoded.length);
      for (let channel = 0; channel < decoded.numberOfChannels; channel++) {
        const source = decoded.getChannelData(channel);
        for (let i = 0; i < mono.length; i++) mono[i] += source[i] / decoded.numberOfChannels;
      }
      result = { mono, sampleRate: decoded.sampleRate, duration: decoded.duration, channels: decoded.numberOfChannels };
    } catch (error) {
      checkAborted(signal);
      throw error;
    } finally { await context.close?.(); }
    // close 也可能异步完成；取消后的旧结果不能重新交给界面。
    checkAborted(signal);
    return result;
  }
}

export class AudioPlayer {
  constructor() {
    this.context = null; this.source = null; this.buffer = null;
    this.startedAt = 0; this.offset = 0; this.end = 0; this.rate = 1; this.timer = null;
    this.onTime = null; this.onEnd = null;
    // stop、load 和 dispose 都使尚未完成 resume 的旧播放请求失效。
    this.playGeneration = 0;
  }
  async load(mono, sampleRate) {
    if (!(mono instanceof Float32Array) || !Number.isFinite(sampleRate) || sampleRate <= 0) throw new TypeError('音频数据或采样率无效');
    this.stop();
    const Context = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (typeof Context !== 'function') throw new Error('当前环境不支持 AudioContext');
    if (!this.context) this.context = new Context();
    this.buffer = this.context.createBuffer(1, mono.length, sampleRate);
    this.buffer.copyToChannel(mono, 0);
    this.offset = 0; this.end = this.buffer.duration;
    return this;
  }
  async play(start = 0, end = this.buffer?.duration ?? 0, { rate = 1, onTime, onEnd } = {}) {
    if (!this.buffer) throw new Error('请先加载音频');
    // 先用旧 offset/startedAt 停止旧音源，再设置新位置，避免 seek 叠加旧的已播放时间。
    this.stop();
    const generation = this.playGeneration;
    const context = this.context;
    const duration = this.buffer.duration;
    this.offset = Math.max(0, Math.min(duration, Number(start) || 0));
    this.end = Math.max(this.offset, Math.min(duration, Number(end) || 0));
    this.rate = Number.isFinite(Number(rate)) ? Math.max(0.01, Number(rate) || 1) : 1;
    // resume 在首个 await 之前调用，保留点击/键盘事件的用户激活能力。
    try { await context.resume?.(); }
    catch (error) { if (generation !== this.playGeneration) return this; throw error; }
    if (generation !== this.playGeneration || context !== this.context || !this.buffer) return this;
    if (this.end === this.offset) { onTime?.(this.offset); onEnd?.(); return this; }
    this.onTime = onTime; this.onEnd = onEnd;
    const source = context.createBufferSource();
    this.source = source; source.buffer = this.buffer; source.playbackRate.value = this.rate;
    source.connect(context.destination);
    this.startedAt = context.currentTime;
    source.onended = () => {
      // 已进入事件队列的旧 onended 不能终止新音源或触发旧回调。
      if (this.source !== source) return;
      this.offset = this.end;
      const notifyTime = this.onTime; const notifyEnd = this.onEnd;
      this.releaseSource(false);
      notifyTime?.(this.offset); notifyEnd?.();
    };
    try {
      source.start(0, this.offset, this.end - this.offset);
      this.timer = setInterval(() => { if (this.source === source) this.onTime?.(this.currentTime); }, 30);
    } catch (error) { this.stop(); throw error; }
    return this;
  }
  // 清理音源和定时器时同时释放回调引用；自然结束不再调用 source.stop。
  releaseSource(stop = true) {
    const source = this.source; this.source = null;
    if (source) {
      source.onended = null;
      if (stop) { try { source.stop(); } catch {} }
      source.disconnect?.();
    }
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null; this.onTime = null; this.onEnd = null;
  }
  stop() {
    this.playGeneration++;
    this.offset = this.currentTime;
    this.releaseSource();
  }
  seek(time) {
    const offset = Math.max(0, Math.min(this.buffer?.duration ?? 0, Number(time) || 0));
    if (this.playing) {
      // 不预先改 this.offset；play 会先停止旧音源，并继续原来的通知回调。
      return this.play(offset, this.end, { rate: this.rate, onTime: this.onTime, onEnd: this.onEnd });
    }
    this.stop(); this.offset = offset;
    return offset;
  }
  get currentTime() { return this.source ? Math.min(this.end, this.offset + (this.context.currentTime - this.startedAt) * this.rate) : this.offset; }
  get playing() { return !!this.source; }
  dispose() {
    this.stop(); this.buffer = null;
    const context = this.context; this.context = null;
    return context?.close?.();
  }
}
