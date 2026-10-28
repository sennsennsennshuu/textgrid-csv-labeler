// TextGrid 音频与频谱计算模块。
// 该文件只依赖浏览器与 Node 都提供的标准 JavaScript 内置对象。

export const SPECTROGRAM_DEFAULTS = Object.freeze({
  windowMs: 6,
  hopMs: 0,
  maxFreq: 8000,
  preEmphasis: true,
  windowType: 'gaussian',
  maxFrames: 600000,
  maxCells: 96e6,
});

export const PALETTE_NAMES = Object.freeze(['gray', 'praat', 'inferno', 'viridis']);

function asBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  throw new TypeError('音频数据必须是 Uint8Array 或 ArrayBuffer');
}

function readAscii(bytes, offset, length) {
  let value = '';
  for (let i = 0; i < length && offset + i < bytes.length; i++) value += String.fromCharCode(bytes[offset + i]);
  return value;
}

function u16(view, offset) { return view.getUint16(offset, true); }
function u32(view, offset) { return view.getUint32(offset, true); }

/** 解析 RIFF/WAVE，并在解析过程中直接完成多声道混音。 */
export function parseWav(input) {
  const bytes = asBytes(input);
  if (bytes.length < 12 || readAscii(bytes, 0, 4) !== 'RIFF' || readAscii(bytes, 8, 4) !== 'WAVE') {
    throw new Error('不是有效的 WAV 文件');
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let formatTag = 0;
  let channels = 0;
  let sampleRate = 0;
  let blockAlign = 0;
  let bitsPerSample = 0;
  let dataOffset = -1;
  let dataLength = 0;
  let extensibleSubformat = 0;

  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const chunkId = readAscii(bytes, offset, 4);
    const declaredSize = u32(view, offset + 4);
    const payloadOffset = offset + 8;
    const takeToEnd = declaredSize === 0 || declaredSize === 0xffffffff;
    const available = Math.max(0, bytes.length - payloadOffset);
    const payloadSize = takeToEnd ? available : Math.min(declaredSize, available);
    if (chunkId === 'fmt ' && payloadSize >= 16) {
      formatTag = u16(view, payloadOffset);
      channels = u16(view, payloadOffset + 2);
      sampleRate = u32(view, payloadOffset + 4);
      blockAlign = u16(view, payloadOffset + 12);
      bitsPerSample = u16(view, payloadOffset + 14);
      if (formatTag === 0xfffe && payloadSize >= 40) {
        const subformatOffset = payloadOffset + 24;
        extensibleSubformat = u16(view, subformatOffset);
      }
    } else if (chunkId === 'data' && dataOffset < 0) {
      dataOffset = payloadOffset;
      dataLength = payloadSize;
    }
    if (takeToEnd) break;
    const next = payloadOffset + declaredSize + (declaredSize & 1);
    if (next <= offset) break;
    offset = next;
  }

  if (!channels || !sampleRate || !blockAlign || dataOffset < 0) throw new Error('WAV 缺少有效的 fmt 或 data 块');
  if (formatTag === 0xfffe) formatTag = extensibleSubformat;
  let format;
  if (formatTag === 1) format = 'pcm';
  else if (formatTag === 3) format = 'float';
  else throw new Error('不支持的 WAV 编码格式');
  if (format === 'pcm' && ![8, 16, 24, 32].includes(bitsPerSample)) throw new Error('不支持的 PCM 位深');
  if (format === 'float' && ![32, 64].includes(bitsPerSample)) throw new Error('不支持的浮点 WAV 位深');
  const bytesPerSample = Math.ceil(bitsPerSample / 8);
  if (blockAlign < channels * bytesPerSample) throw new Error('WAV 的块对齐大小无效');
  const frames = Math.floor(dataLength / blockAlign);
  const mono = new Float32Array(frames);
  const dataEnd = Math.min(bytes.length, dataOffset + dataLength);
  const scale = format === 'pcm'
    ? (bitsPerSample === 8 ? 128 : bitsPerSample === 16 ? 32768 : bitsPerSample === 24 ? 8388608 : 2147483648)
    : 1;
  for (let frame = 0; frame < frames; frame++) {
    const frameOffset = dataOffset + frame * blockAlign;
    let sum = 0;
    for (let channel = 0; channel < channels; channel++) {
      const p = frameOffset + channel * bytesPerSample;
      let value;
      if (p + bytesPerSample > dataEnd) value = 0;
      else if (format === 'float' && bitsPerSample === 32) value = view.getFloat32(p, true);
      else if (format === 'float' && bitsPerSample === 64) value = view.getFloat64(p, true);
      else if (bitsPerSample === 8) value = bytes[p] - 128;
      else if (bitsPerSample === 16) value = view.getInt16(p, true);
      else if (bitsPerSample === 24) {
        value = bytes[p] | (bytes[p + 1] << 8) | (bytes[p + 2] << 16);
        if (value & 0x800000) value -= 0x1000000;
      } else value = view.getInt32(p, true);
      sum += format === 'pcm' ? value / scale : value;
    }
    mono[frame] = sum / channels;
  }
  return { sampleRate, channels, frames, bitsPerSample, format, mono };
}

/** 将同长度声道逐样点求平均；单声道按契约直接复用原数组。 */
export function mixToMono(channelArrays) {
  if (!Array.isArray(channelArrays) || channelArrays.length === 0) return new Float32Array(0);
  if (channelArrays.length === 1) return channelArrays[0];
  const length = channelArrays[0].length;
  const out = new Float32Array(length);
  for (const channel of channelArrays) {
    if (channel.length !== length) throw new Error('声道长度不一致');
  }
  for (let i = 0; i < length; i++) {
    let sum = 0;
    for (const channel of channelArrays) sum += channel[i];
    out[i] = sum / channelArrays.length;
  }
  return out;
}

function levelForBlock(levels, block) {
  for (let i = levels.length - 1; i >= 0; i--) if (levels[i].block <= block) return levels[i];
  return levels[0];
}

/** 构建逐级二倍放大的波形最小值/最大值金字塔。 */
export function buildPeaks(mono, sampleRate, { baseBlock = 32 } = {}) {
  const block0 = Math.max(1, Math.floor(baseBlock));
  const length = mono.length;
  const levels = [];
  let block = block0;
  while (true) {
    const count = Math.ceil(length / block);
    const min = new Float32Array(count);
    const max = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const begin = i * block;
      const end = Math.min(length, begin + block);
      let lo = Infinity;
      let hi = -Infinity;
      for (let j = begin; j < end; j++) {
        const value = mono[j];
        if (value < lo) lo = value;
        if (value > hi) hi = value;
      }
      min[i] = end > begin ? lo : 0;
      max[i] = end > begin ? hi : 0;
    }
    levels.push({ block, min, max });
    if (count <= 256 || length === 0) break;
    block *= 2;
  }
  let maxAbs = 0;
  for (let i = 0; i < mono.length; i++) {
    const value = Math.abs(mono[i]);
    if (value > maxAbs) maxAbs = value;
  }
  return { sampleRate, length, duration: sampleRate ? length / sampleRate : 0, maxAbs, samples: mono, baseBlock: block0, levels };
}

/** 使用原始边缘样点和已聚合整块，逐值读取波形列。 */
export function readPeakColumns(peaks, t0, t1, columns, out = null) {
  const count = Math.max(0, Math.floor(columns));
  const minOut = out?.min ?? new Float32Array(count);
  const maxOut = out?.max ?? new Float32Array(count);
  if (minOut.length < count || maxOut.length < count) throw new Error('峰值输出数组长度不足');
  const samplesPerColumn = (t1 - t0) * peaks.sampleRate / (count || 1);
  const source = peaks.samples;
  for (let c = 0; c < count; c++) {
    const a = Math.floor((t0 + (t1 - t0) * c / (count || 1)) * peaks.sampleRate);
    const b = Math.max(a + 1, Math.floor((t0 + (t1 - t0) * (c + 1) / (count || 1)) * peaks.sampleRate));
    const begin = Math.max(0, a);
    const end = Math.min(source.length, b);
    if (begin >= end) { minOut[c] = 0; maxOut[c] = 0; continue; }
    let lo = Infinity;
    let hi = -Infinity;
    let cursor = begin;
    while (cursor < end) {
      let picked = null;
      for (let levelIndex = peaks.levels.length - 1; levelIndex >= 0; levelIndex--) {
        const level = peaks.levels[levelIndex];
        if (cursor % level.block === 0 && cursor + level.block <= end) { picked = level; break; }
      }
      if (picked) {
        const index = cursor / picked.block;
        if (picked.min[index] < lo) lo = picked.min[index];
        if (picked.max[index] > hi) hi = picked.max[index];
        cursor += picked.block;
      } else {
        const value = source[cursor++];
        if (value < lo) lo = value;
        if (value > hi) hi = value;
      }
    }
    minOut[c] = lo;
    maxOut[c] = hi;
  }
  return { min: minOut, max: maxOut, samplesPerColumn };
}

function nextPowerOfTwo(value) {
  let result = 1;
  while (result < value) result *= 2;
  return result;
}

function integerOption(value, fallback, min, max) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.min(max, Math.max(min, Math.floor(numeric))) : fallback;
}

/** 解析并夹紧频谱参数，同时计算所有派生尺寸。 */
export function resolveSpectrogramOptions(options, sampleRate, length) {
  const input = options && typeof options === 'object' ? options : {};
  const sr = Number.isFinite(sampleRate) && sampleRate > 0 ? sampleRate : 1;
  const n = Math.max(0, Math.floor(length));
  const windowMsValue = Number(input.windowMs);
  const windowMs = Number.isFinite(windowMsValue) ? Math.min(2000, Math.max(0.1, windowMsValue)) : SPECTROGRAM_DEFAULTS.windowMs;
  const windowSamples = Math.max(8, Math.round(windowMs * sr / 1000));
  const fftSize = Math.max(512, nextPowerOfTwo(windowSamples) * 2);
  const maxFreqValue = Number(input.maxFreq);
  const maxFreq = Number.isFinite(maxFreqValue) ? Math.min(sr / 2, Math.max(0, maxFreqValue)) : Math.min(sr / 2, SPECTROGRAM_DEFAULTS.maxFreq);
  const maxFrames = integerOption(input.maxFrames, SPECTROGRAM_DEFAULTS.maxFrames, 1, SPECTROGRAM_DEFAULTS.maxFrames);
  const windowType = input.windowType === 'hann' ? 'hann' : 'gaussian';
  const binHz = sr / fftSize;
  const bins = Math.floor(maxFreq / binHz) + 1;
  // 单帧至少要容纳全部频点，否则不存在任何 hop 能满足 maxCells。
  const maxCells = Math.max(bins, integerOption(input.maxCells, SPECTROGRAM_DEFAULTS.maxCells, 1, SPECTROGRAM_DEFAULTS.maxCells));
  const hopInput = Number(input.hopMs);
  let hop = Number.isFinite(hopInput) && hopInput > 0 ? Math.max(1, Math.round(hopInput * sr / 1000)) : Math.max(1, Math.round(windowMs * sr / 4000));
  const targetFrames = Math.min(maxFrames, Math.floor(maxCells / bins));
  if (targetFrames < 1) hop = n + 1;
  else if (Math.floor(n / hop) + 1 > targetFrames) hop = Math.floor(n / targetFrames) + 1;
  const frames = Math.floor(n / hop) + 1;
  return {
    windowMs,
    hopMs: hop * 1000 / sr,
    maxFreq,
    preEmphasis: input.preEmphasis === undefined ? SPECTROGRAM_DEFAULTS.preEmphasis : Boolean(input.preEmphasis),
    windowType,
    maxFrames,
    maxCells,
    windowSamples,
    fftSize,
    hop,
    frames,
    bins,
    binHz,
  };
}

function makeFftTables(size) {
  const bitReverse = new Uint32Array(size);
  let bits = 0;
  while ((1 << bits) < size) bits++;
  for (let i = 0; i < size; i++) {
    let value = i;
    let reversed = 0;
    for (let j = 0; j < bits; j++) { reversed = (reversed << 1) | (value & 1); value >>>= 1; }
    bitReverse[i] = reversed;
  }
  const cos = new Float64Array(size / 2);
  const sin = new Float64Array(size / 2);
  for (let i = 0; i < size / 2; i++) {
    const angle = 2 * Math.PI * i / size;
    cos[i] = Math.cos(angle);
    sin[i] = Math.sin(angle);
  }
  return { bitReverse, cos, sin };
}

function fftInPlace(real, imag, tables) {
  const size = real.length;
  const bitReverse = tables.bitReverse;
  for (let i = 0; i < size; i++) {
    const j = bitReverse[i];
    if (j > i) {
      const temp = real[i]; real[i] = real[j]; real[j] = temp;
      const tempImag = imag[i]; imag[i] = imag[j]; imag[j] = tempImag;
    }
  }
  for (let width = 2; width <= size; width <<= 1) {
    const half = width >>> 1;
    const step = size / width;
    for (let start = 0; start < size; start += width) {
      for (let j = 0; j < half; j++) {
        const index = j * step;
        const wr = tables.cos[index];
        const wi = -tables.sin[index];
        const right = start + j + half;
        const tr = wr * real[right] - wi * imag[right];
        const ti = wr * imag[right] + wi * real[right];
        const left = start + j;
        real[right] = real[left] - tr;
        imag[right] = imag[left] - ti;
        real[left] += tr;
        imag[left] += ti;
      }
    }
  }
}

function makeWindow(type, length) {
  const window = new Float64Array(length);
  let sum = 0;
  for (let i = 0; i < length; i++) {
    let value;
    if (type === 'hann') value = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (length - 1));
    else {
      const centered = (i - (length - 1) / 2) / (length / 6);
      value = Math.exp(-0.5 * centered * centered);
    }
    window[i] = value;
    sum += value;
  }
  return { window, sum };
}

function frameDb(context, frame, output, targetOffset, needData) {
  const { mono, options, window, fftTables, real, imag, sumWindow } = context;
  real.fill(0); imag.fill(0);
  const center = frame * options.hop;
  const start = center - Math.floor(options.windowSamples / 2);
  for (let n = 0; n < options.windowSamples; n++) {
    const sampleIndex = start + n;
    let sample = sampleIndex >= 0 && sampleIndex < mono.length ? mono[sampleIndex] : 0;
    if (options.preEmphasis) {
      const previous = sampleIndex > 0 && sampleIndex - 1 < mono.length ? mono[sampleIndex - 1] : 0;
      sample -= 0.97 * previous;
    }
    real[n] = sample * window[n];
  }
  fftInPlace(real, imag, fftTables);
  let localMax = -Infinity;
  for (let bin = 0; bin < options.bins; bin++) {
    const power = real[bin] * real[bin] + imag[bin] * imag[bin];
    const db = 10 * Math.log10(power / (sumWindow * sumWindow) + 1e-12);
    if (db > localMax) localMax = db;
    if (needData) output[targetOffset + bin] = db;
  }
  return localMax;
}

function createSpectrogramContext(mono, sampleRate, options) {
  const resolved = resolveSpectrogramOptions(options, sampleRate, mono.length);
  const tables = makeFftTables(resolved.fftSize);
  const windowInfo = makeWindow(resolved.windowType, resolved.windowSamples);
  return {
    mono,
    sampleRate,
    options: resolved,
    fftTables: tables,
    window: windowInfo.window,
    sumWindow: windowInfo.sum,
    real: new Float64Array(resolved.fftSize),
    imag: new Float64Array(resolved.fftSize),
  };
}

/** 分块生成频谱进度；最终结果通过生成器 return 返回。 */
export function* spectrogramJob(mono, sampleRate, options = {}) {
  if (!(mono instanceof Float32Array)) throw new TypeError('频谱输入必须是 Float32Array');
  const context = createSpectrogramContext(mono, sampleRate, options);
  const { frames, bins } = context.options;
  const cellCount = frames * bins;
  const dbValues = new Float64Array(cellCount);
  const requestedYieldFrames = Number(options?.__yieldFrames);
  const yieldFrames = Number.isFinite(requestedYieldFrames) ? Math.max(1, Math.floor(requestedYieldFrames)) : 4096;
  let refDb = -Infinity;
  for (let frame = 0; frame < frames; frame++) {
    const localMax = frameDb(context, frame, dbValues, frame * bins, true);
    if (localMax > refDb) refDb = localMax;
    if ((frame + 1) % yieldFrames === 0 || frame + 1 === frames) yield (0.5 * (frame + 1) / frames);
  }
  refDb = Math.max(refDb, -90);
  const data = new Uint8Array(cellCount);
  for (let i = 0; i < cellCount; i++) {
    const quantized = Math.round((dbValues[i] - (refDb - 120)) / 120 * 255);
    data[i] = Math.max(0, Math.min(255, quantized));
  }
  yield 1;
  return {
    sampleRate,
    duration: sampleRate ? mono.length / sampleRate : 0,
    frames,
    bins,
    hop: context.options.hop,
    hopSeconds: context.options.hop / sampleRate,
    binHz: context.options.binHz,
    fftSize: context.options.fftSize,
    windowSamples: context.options.windowSamples,
    refDb,
    dbRange: 120,
    data,
    options: context.options,
  };
}

/** 同步执行 spectrogramJob，保持与生成器结果逐字节一致。 */
export function computeSpectrogram(mono, sampleRate, options = {}) {
  const job = spectrogramJob(mono, sampleRate, options);
  let step;
  while (!(step = job.next()).done) { /* 同步包装器故意只消费进度 */ }
  return step.value;
}

function clamp(value, min, max) { return Math.max(min, Math.min(max, value)); }

const PALETTE_KEYS = {
  inferno: [[0, 0, 4], [31, 12, 72], [85, 15, 109], [136, 34, 106], [186, 54, 85], [227, 89, 51], [249, 140, 10], [252, 255, 164]],
  viridis: [[68, 1, 84], [71, 44, 122], [59, 82, 139], [44, 113, 142], [33, 144, 141], [39, 173, 129], [92, 200, 99], [253, 231, 37]],
};

/** 生成 256 项 RGB 调色板。 */
export function getPalette(name = 'gray') {
  const paletteName = PALETTE_NAMES.includes(name) ? name : 'gray';
  const out = new Uint8Array(768);
  for (let i = 0; i < 256; i++) {
    const t = i / 255;
    let r; let g; let b;
    if (paletteName === 'gray') r = g = b = i;
    else if (paletteName === 'praat') r = g = b = 255 - i;
    else {
      const keys = PALETTE_KEYS[paletteName];
      const position = t * (keys.length - 1);
      const left = Math.min(keys.length - 2, Math.floor(position));
      const fraction = position - left;
      r = Math.round(keys[left][0] + (keys[left + 1][0] - keys[left][0]) * fraction);
      g = Math.round(keys[left][1] + (keys[left + 1][1] - keys[left][1]) * fraction);
      b = Math.round(keys[left][2] + (keys[left + 1][2] - keys[left][2]) * fraction);
    }
    out[i * 3] = r; out[i * 3 + 1] = g; out[i * 3 + 2] = b;
  }
  return out;
}

/** 把帧优先频谱双线性插值为 RGBA，行 0 为高频。 */
export function renderSpectrogramRGBA(spec, view, palette, out = null) {
  const width = Math.max(0, Math.floor(view.width));
  const height = Math.max(0, Math.floor(view.height));
  const result = out ?? new Uint8ClampedArray(width * height * 4);
  if (result.length < width * height * 4) throw new Error('RGBA 输出数组长度不足');
  const colors = typeof palette === 'string' ? getPalette(palette) : palette;
  const fMin = Number.isFinite(view.fMin) ? view.fMin : 0;
  const fMax = Number.isFinite(view.fMax) ? view.fMax : spec.binHz * (spec.bins - 1);
  const rangeDb = Math.max(1e-9, Number.isFinite(view.rangeDb) ? view.rangeDb : 70);
  const ceilDb = Number.isFinite(view.ceilDb) ? view.ceilDb : 0;
  for (let y = 0; y < height; y++) {
    const frequency = height <= 1 ? fMin : fMax - (fMax - fMin) * y / (height - 1);
    const binPosition = clamp(frequency / spec.binHz, 0, spec.bins - 1);
    const bin0 = Math.floor(binPosition);
    const bin1 = Math.min(spec.bins - 1, bin0 + 1);
    const binFraction = binPosition - bin0;
    for (let x = 0; x < width; x++) {
      const time = width <= 1 ? view.t0 : view.t0 + (view.t1 - view.t0) * x / (width - 1);
      const target = (y * width + x) * 4;
      if (time < 0 || time > spec.duration || spec.frames === 0) {
        result[target] = colors[0]; result[target + 1] = colors[1]; result[target + 2] = colors[2]; result[target + 3] = 255;
        continue;
      }
      const framePosition = clamp(time / spec.hopSeconds, 0, spec.frames - 1);
      const frame0 = Math.floor(framePosition);
      const frame1 = Math.min(spec.frames - 1, frame0 + 1);
      const frameFraction = framePosition - frame0;
      const a = spec.data[frame0 * spec.bins + bin0];
      const b = spec.data[frame0 * spec.bins + bin1];
      const c = spec.data[frame1 * spec.bins + bin0];
      const d = spec.data[frame1 * spec.bins + bin1];
      const value = a * (1 - frameFraction) * (1 - binFraction) + b * (1 - frameFraction) * binFraction + c * frameFraction * (1 - binFraction) + d * frameFraction * binFraction;
      const level = clamp((value / 255 * 120 - 120 + ceilDb + rangeDb) / rangeDb, 0, 1);
      const colorIndex = Math.round(level * 255) * 3;
      result[target] = colors[colorIndex]; result[target + 1] = colors[colorIndex + 1]; result[target + 2] = colors[colorIndex + 2]; result[target + 3] = 255;
    }
  }
  return result;
}

function niceStep(span, targetCount) {
  const raw = Math.max(Number.EPSILON, span / Math.max(1, targetCount));
  const exponent = Math.floor(Math.log10(raw));
  const unit = raw / 10 ** exponent;
  const factor = unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10;
  return factor * 10 ** exponent;
}

function decimalPlaces(step) {
  if (step >= 1) return 0;
  return Math.max(0, Math.ceil(-Math.log10(step) - 1e-10));
}

function formatClock(seconds, step) {
  if (step >= 60) {
    const sign = seconds < 0 ? '-' : '';
    const absolute = Math.abs(seconds);
    const minutes = Math.floor(absolute / 60);
    const remainder = absolute - minutes * 60;
    return `${sign}${minutes}:${remainder.toFixed(0).padStart(2, '0')}`;
  }
  return seconds.toFixed(decimalPlaces(step)).replace(/\.0+$/, '').replace(/(\.\d*?)0+$/, '$1');
}

/** 生成适合时间轴的主刻度与次刻度。 */
export function niceTimeTicks(t0, t1, widthPx, minLabelPx = 90) {
  const start = Math.min(t0, t1);
  const end = Math.max(t0, t1);
  const step = niceStep(end - start, Math.max(1, widthPx / minLabelPx));
  const minorStep = step / 5;
  const ticks = [];
  const first = Math.floor(start / minorStep) * minorStep;
  const last = Math.ceil(end / minorStep) * minorStep;
  const epsilon = minorStep * 1e-7;
  for (let time = first; time <= last + epsilon; time += minorStep) {
    if (time < start - epsilon || time > end + epsilon) continue;
    const major = Math.abs(time / step - Math.round(time / step)) < 1e-6;
    ticks.push({ time: Math.abs(time) < epsilon ? 0 : time, label: major ? formatClock(time, step) : '', major });
  }
  return { step, minorStep, ticks };
}

function formatFrequency(value) {
  if (value >= 1000) return `${Number((value / 1000).toFixed(value % 1000 === 0 ? 0 : 1))}k`;
  return `${Math.round(value)}`;
}

/** 生成频率刻度，ratio 从低频向高频递增。 */
export function niceFreqTicks(fMin, fMax, heightPx, minLabelPx = 30) {
  const low = Math.min(fMin, fMax);
  const high = Math.max(fMin, fMax);
  const step = niceStep(high - low, Math.max(1, heightPx / minLabelPx));
  const ticks = [];
  const first = Math.ceil(low / step - 1e-10) * step;
  const last = Math.floor(high / step + 1e-10) * step;
  for (let freq = first; freq <= last + step * 1e-7; freq += step) {
    ticks.push({ freq, ratio: high === low ? 0 : (freq - low) / (high - low), label: formatFrequency(freq) });
  }
  return ticks;
}

let nextEngineId = 1;

function abortError() { const error = new Error('操作已中止'); error.name = 'AbortError'; return error; }

/** 管理 Worker 与可中止的主线程分片频谱计算。 */
export class SpectrogramEngine {
  constructor({ workerFactory = null, chunkMs = 12 } = {}) {
    this.workerFactory = workerFactory;
    this.chunkMs = Math.max(1, Number.isFinite(chunkMs) ? chunkMs : 12);
    this.workers = new Set();
    this.tasks = new Set();
    this.disposed = false;
  }

  compute(mono, sampleRate, options = {}, { onProgress, signal } = {}) {
    if (this.disposed) return Promise.reject(new Error('频谱引擎已释放'));
    if (signal?.aborted) return Promise.reject(abortError());
    const task = { worker: null, settled: false, lastProgress: 0, reject: null, abortHandler: null };
    this.tasks.add(task);
    const report = (ratio) => {
      const safe = Math.max(task.lastProgress, Math.min(1, Number(ratio) || 0));
      task.lastProgress = safe;
      if (typeof onProgress === 'function') onProgress(safe);
    };
    const finish = (callback, value) => {
      if (task.settled) return;
      task.settled = true;
      this.tasks.delete(task);
      if (task.abortHandler) signal?.removeEventListener('abort', task.abortHandler);
      if (task.worker) { this.workers.delete(task.worker); task.worker.terminate?.(); }
      callback(value);
    };
    const fallback = () => {
      if (task.settled) return;
      this.runOnMain(mono, sampleRate, options, report, signal, task).then(
        spec => finish(resolve, spec),
        error => finish(reject, error),
      );
    };
    let resolvePromise; let rejectPromise;
    const promise = new Promise((resolve, reject) => { resolvePromise = resolve; rejectPromise = reject; });
    const resolve = resolvePromise;
    const reject = rejectPromise;
    task.reject = reject;
    task.abortHandler = () => {
      if (task.settled) return;
      if (task.worker) task.worker.terminate?.();
      finish(reject, abortError());
    };
    signal?.addEventListener('abort', task.abortHandler, { once: true });
    if (!this.workerFactory) { fallback(); return promise; }
    let worker;
    try { worker = this.workerFactory(); } catch { fallback(); return promise; }
    if (!worker || typeof worker.postMessage !== 'function') { worker?.terminate?.(); fallback(); return promise; }
    task.worker = worker;
    this.workers.add(worker);
    const id = nextEngineId++;
    let sent = false;
    worker.onmessage = (event) => {
      const message = event?.data ?? event;
      if (!message || message.id !== id || task.settled) return;
      if (message.type === 'progress') report(message.ratio);
      else if (message.type === 'done') { report(1); finish(resolve, message.spec); }
      else if (message.type === 'error') finish(reject, new Error(message.message || 'Worker 计算失败'));
    };
    worker.onerror = (event) => {
      if (!sent) {
        worker.terminate?.();
        this.workers.delete(worker);
        task.worker = null;
        fallback();
      }
      else finish(reject, event?.error instanceof Error ? event.error : new Error(event?.message || 'Worker 发生错误'));
    };
    try {
      const copy = mono.slice();
      worker.postMessage({ type: 'compute', id, mono: copy, sampleRate, options }, [copy.buffer]);
      sent = true;
    } catch {
      worker.terminate?.(); this.workers.delete(worker); task.worker = null; fallback();
    }
    return promise;
  }

  async runOnMain(mono, sampleRate, options, report, signal, task) {
    const resolved = resolveSpectrogramOptions(options, sampleRate, mono.length);
    const framesPerChunk = Math.max(1, Math.floor(this.chunkMs / 1000 * sampleRate / resolved.hop));
    const job = spectrogramJob(mono, sampleRate, { ...options, __yieldFrames: framesPerChunk });
    let step;
    while (true) {
      if (signal?.aborted || this.disposed || task.settled) throw abortError();
      step = job.next();
      if (step.done) return step.value;
      report(step.value);
      if (step.value < 1) await new Promise(resolve => setTimeout(resolve, 0));
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    for (const task of [...this.tasks]) {
      if (task.worker) task.worker.terminate?.();
      if (!task.settled) {
        task.settled = true;
        task.reject?.(new Error('频谱引擎已释放'));
      }
    }
    this.tasks.clear();
    this.workers.clear();
  }
}

