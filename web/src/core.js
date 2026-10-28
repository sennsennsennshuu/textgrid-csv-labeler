// TextGrid 纯逻辑核心：解析、写出、校验、编辑、历史、配对和 ZIP。
// 本文件不依赖浏览器 API，所有数据均按不可变对象处理。

export class TextGridError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TextGridError';
  }
}

const EPS = 1e-9;
const NUM_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

function hidden(object, key, value) {
  Object.defineProperty(object, key, { value, enumerable: false, configurable: true });
  return object;
}

function asBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  throw new TypeError('输入必须是字符串、Uint8Array 或 ArrayBuffer。');
}

export function decodeTextBytes(input) {
  const bytes = asBytes(input);
  let encoding;
  let text;
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    encoding = 'utf-16be';
    text = new TextDecoder('utf-16be').decode(bytes.subarray(2));
  } else if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    encoding = 'utf-16le';
    text = new TextDecoder('utf-16le').decode(bytes.subarray(2));
  } else if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    encoding = 'utf-8-bom';
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(3));
  } else {
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      encoding = 'utf-8';
    } catch {
      try {
        text = new TextDecoder('gb18030', { fatal: true }).decode(bytes);
        encoding = 'gb18030';
      } catch {
        throw new TextGridError('文件编码无法识别，既不是有效 UTF-8，也不是有效 GB18030。');
      }
    }
  }
  const firstNewline = /\r\n|\r|\n/.exec(text);
  return { text, encoding, newline: firstNewline?.[0] === '\r\n' ? '\r\n' : '\n' };
}

function encodeText(text, encoding) {
  if (encoding === 'utf-16be' || encoding === 'utf-16le') {
    const little = encoding === 'utf-16le';
    const result = new Uint8Array(2 + text.length * 2);
    result[0] = little ? 0xff : 0xfe;
    result[1] = little ? 0xfe : 0xff;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      const offset = 2 + i * 2;
      result[offset] = little ? code & 0xff : code >>> 8;
      result[offset + 1] = little ? code >>> 8 : code & 0xff;
    }
    return result;
  }
  const body = new TextEncoder().encode(text);
  if (encoding === 'utf-8-bom') {
    const result = new Uint8Array(body.length + 3);
    result.set([0xef, 0xbb, 0xbf]);
    result.set(body, 3);
    return result;
  }
  return body;
}

// CSV 覆盖保存需要复用 TextGrid 的编码规则；GB18030 无浏览器编码器时转为 UTF-8。
export function encodeTextBytes(text, encoding = 'utf-8') {
  if (!['utf-8', 'utf-8-bom', 'utf-16be', 'utf-16le', 'gb18030'].includes(encoding)) {
    throw new TypeError('编码不是支持的文本编码。');
  }
  return encodeText(text, encoding === 'gb18030' ? 'utf-8' : encoding);
}

function expandScientific(value) {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?[eE]([+-]?\d+)$/.exec(value);
  if (!match) return value;
  const sign = match[1];
  const digits = match[2] + (match[3] || '');
  const decimal = match[2].length + Number(match[4]);
  if (decimal <= 0) return `${sign}0.${'0'.repeat(-decimal)}${digits}`;
  if (decimal >= digits.length) return `${sign}${digits}${'0'.repeat(decimal - digits.length)}`;
  return `${sign}${digits.slice(0, decimal)}.${digits.slice(decimal)}`;
}

export function formatSeconds(value) {
  if (!Number.isFinite(value) || Object.is(value, -0) || value === 0) return '0';
  let text = expandScientific(value.toPrecision(15));
  if (text.includes('.')) text = text.replace(/0+$/, '').replace(/\.$/, '');
  return text;
}

function numericText(raw, value) {
  return raw !== undefined && Number(raw) === value ? raw : formatSeconds(value);
}

function tokenize(text) {
  const tokens = [];
  let index = 0;
  while (index < text.length) {
    const code = text.charCodeAt(index);
    if (code <= 32) {
      index++;
      continue;
    }
    if (code === 33) {
      while (index < text.length && text.charCodeAt(index) !== 10 && text.charCodeAt(index) !== 13) index++;
      continue;
    }
    if (code === 34) {
      let cursor = index + 1;
      let value = '';
      for (;;) {
        const quote = text.indexOf('"', cursor);
        if (quote < 0) throw new TextGridError('字符串缺少结尾引号，文件可能已损坏。');
        value += text.slice(cursor, quote);
        if (text.charCodeAt(quote + 1) === 34) {
          value += '"';
          cursor = quote + 2;
        } else {
          index = quote + 1;
          break;
        }
      }
      tokens.push({ type: 'string', value });
      continue;
    }
    if (code === 91) {
      const close = text.indexOf(']', index + 1);
      index = close < 0 ? text.length : close + 1;
      if (text.charCodeAt(index) === 58) index++;
      continue;
    }
    let end = index;
    while (end < text.length) {
      const next = text.charCodeAt(end);
      if (next <= 32 || next === 34) break;
      end++;
    }
    let word = text.slice(index, end);
    index = end;
    const equal = word.lastIndexOf('=');
    if (equal >= 0) word = word.slice(equal + 1);
    if (!word) continue;
    if (NUM_RE.test(word)) tokens.push({ type: 'number', value: Number(word), raw: word });
    else if (word === '<exists>' || word === '<absent>') tokens.push({ type: 'exists', value: word });
  }
  return tokens;
}

function parseTokens(tokens) {
  let position = 0;
  const take = (type, description) => {
    const token = tokens[position++];
    if (!token || token.type !== type) throw new TextGridError(`TextGrid 结构错误：这里应当是${description}。`);
    return token;
  };
  const fileType = take('string', '文件类型').value;
  if (!/^ooTextFile(?:\s+short)?$/.test(fileType)) throw new TextGridError('这不是 Praat 文本格式的 TextGrid 文件。');
  const objectClass = take('string', '对象类型').value;
  if (objectClass !== 'TextGrid') throw new TextGridError(`这不是 TextGrid 文件（对象类型为“${objectClass}”）。`);
  const gridStart = take('number', '网格起始时间');
  const gridEnd = take('number', '网格结束时间');
  const exists = take('exists', '<exists> 标记');
  const tiers = [];
  if (exists.value === '<exists>') {
    const tierCount = take('number', '层数').value;
    if (!Number.isInteger(tierCount) || tierCount < 0) throw new TextGridError('层数不是有效的非负整数。');
    for (let tierIndex = 0; tierIndex < tierCount; tierIndex++) {
      const className = take('string', '层类型').value;
      const kind = className === 'IntervalTier' ? 'interval' : (className === 'TextTier' || className === 'PointTier' ? 'point' : null);
      if (!kind) throw new TextGridError(`第 ${tierIndex + 1} 层的类型“${className}”无法识别。`);
      const name = take('string', '层名称').value;
      const tierStart = take('number', '层起始时间');
      const tierEnd = take('number', '层结束时间');
      const size = take('number', '条目数').value;
      if (!Number.isInteger(size) || size < 0) throw new TextGridError(`第 ${tierIndex + 1} 层的条目数无效。`);
      const items = new Array(size);
      for (let itemIndex = 0; itemIndex < size; itemIndex++) {
        if (kind === 'interval') {
          const start = take('number', '区间起点');
          const end = take('number', '区间终点');
          const label = take('string', '区间文本');
          items[itemIndex] = { xmin: start.value, xmax: end.value, text: label.value, raw: { xmin: start.raw, xmax: end.raw } };
        } else {
          const time = take('number', '点时间');
          const mark = take('string', '点标记');
          items[itemIndex] = { time: time.value, mark: mark.value, raw: { time: time.raw } };
        }
      }
      const tier = { kind, name, xmin: tierStart.value, xmax: tierEnd.value, items };
      hidden(tier, 'raw', { xmin: tierStart.raw, xmax: tierEnd.raw });
      tiers.push(tier);
    }
  }
  const grid = { xmin: gridStart.value, xmax: gridEnd.value, tiers };
  hidden(grid, 'raw', { xmin: gridStart.raw, xmax: gridEnd.raw });
  return grid;
}

function hasLongSyntax(text) { return /^[ \t]*xmin\s*=/m.test(text) || /^[ \t]*tiers\?\s+/m.test(text); }
function sourceTrailingSpace(text) {
  const match = /^[ \t]*xmin\s*=\s*[^\r\n]*$/m.exec(text);
  return Boolean(match && /[ \t]$/.test(match[0]));
}

export function validateTextGrid(grid) {
  const issues = [];
  const issue = (level, tier, item, code, message) => issues.push({ level, tier, item, code, message });
  const checkNumber = (value, tier, item, label) => {
    if (Number.isNaN(value) || !Number.isFinite(value)) issue('error', tier, item, 'nan', `${label}不是有效数字。`);
    else if (value < 0) issue('error', tier, item, 'negative', `${label}不能为负数。`);
  };
  checkNumber(grid.xmin, -1, -1, '网格起点');
  checkNumber(grid.xmax, -1, -1, '网格终点');
  if (Number.isFinite(grid.xmin) && Number.isFinite(grid.xmax) && grid.xmax < grid.xmin - EPS) issue('error', -1, -1, 'order', '网格起止时间顺序错误。');
  for (let ti = 0; ti < grid.tiers.length; ti++) {
    const tier = grid.tiers[ti];
    checkNumber(tier.xmin, ti, -1, `第 ${ti + 1} 层起点`);
    checkNumber(tier.xmax, ti, -1, `第 ${ti + 1} 层终点`);
    if (tier.xmin < grid.xmin - EPS || tier.xmax > grid.xmax + EPS) issue('error', ti, -1, 'tier-range', `第 ${ti + 1} 层超出网格范围。`);
    if (tier.xmax < tier.xmin - EPS) issue('error', ti, -1, 'order', `第 ${ti + 1} 层起止时间顺序错误。`);
    if (tier.items.length === 0) issue('warn', ti, -1, 'empty-tier', `第 ${ti + 1} 层没有条目。`);
    if (tier.kind === 'interval') {
      for (let ii = 0; ii < tier.items.length; ii++) {
        const item = tier.items[ii];
        checkNumber(item.xmin, ti, ii, `第 ${ti + 1} 层第 ${ii + 1} 个区间起点`);
        checkNumber(item.xmax, ti, ii, `第 ${ti + 1} 层第 ${ii + 1} 个区间终点`);
        if (item.xmax < item.xmin - EPS) issue('error', ti, ii, 'order', '区间起止时间顺序错误。');
        if (item.xmin < tier.xmin - EPS || item.xmax > tier.xmax + EPS) issue('error', ti, ii, 'range', '区间超出层范围。');
        if (ii > 0) {
          const delta = item.xmin - tier.items[ii - 1].xmax;
          if (delta > EPS) issue('error', ti, ii, 'gap', '区间之间存在缝隙。');
          else if (delta < -EPS) issue('error', ti, ii, 'overlap', '区间之间存在重叠。');
        }
      }
    } else {
      let previous = -Infinity;
      for (let ii = 0; ii < tier.items.length; ii++) {
        const item = tier.items[ii];
        checkNumber(item.time, ti, ii, `第 ${ti + 1} 层第 ${ii + 1} 个点时间`);
        if (item.time < tier.xmin - EPS || item.time > tier.xmax + EPS) issue('error', ti, ii, 'range', '点超出层范围。');
        if (item.time < previous - EPS) issue('error', ti, ii, 'order', '点没有按时间升序排列。');
        previous = item.time;
      }
    }
  }
  return issues;
}

function summarizeIssues(issues) { return issues.map((item) => item.message).filter((message, index, list) => list.indexOf(message) === index); }

export function parseTextGrid(input) {
  let text;
  let encoding = 'utf-8';
  let newline = '\n';
  if (typeof input === 'string') {
    text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input;
    const firstNewline = /\r\n|\r|\n/.exec(text);
    newline = firstNewline?.[0] === '\r\n' ? '\r\n' : '\n';
  } else {
    const bytes = asBytes(input);
    const asciiPrefix = new TextDecoder('ascii').decode(bytes.subarray(0, Math.min(bytes.length, 32))).replace(/^\ufeff/, '');
    if (asciiPrefix.startsWith('ooBinaryFile')) throw new TextGridError('暂不支持 Praat 二进制格式，请先在 Praat 中另存为文本格式。');
    ({ text, encoding, newline } = decodeTextBytes(bytes));
  }
  if (!text.trim()) throw new TextGridError('文件是空的。');
  if (text.replace(/^\ufeff/, '').trimStart().startsWith('ooBinaryFile')) throw new TextGridError('暂不支持 Praat 二进制格式，请先在 Praat 中另存为文本格式。');
  const sourceTokens = tokenize(text);
  const oldShortHeader = sourceTokens[0]?.type === 'string' && sourceTokens[0].value === 'ooTextFile short';
  const grid = parseTokens(sourceTokens);
  const meta = { format: hasLongSyntax(text) ? 'long' : 'short', encoding, newline, trailingSpace: sourceTrailingSpace(text) };
  hidden(meta, 'finalNewline', /(?:\r\n|\r|\n)$/.test(text));
  hidden(meta, 'oldShortHeader', oldShortHeader);
  grid.meta = meta;
  return { grid, warnings: summarizeIssues(validateTextGrid(grid)) };
}

function escaped(text) { return String(text).replaceAll('"', '""'); }
function numberWithRaw(raw, value) { return numericText(raw, value); }

function serializeLong(grid, newline, trailingSpace) {
  const suffix = trailingSpace ? ' ' : '';
  const lines = [];
  const line = (value, equal = false) => lines.push(`${value}${equal ? suffix : ''}`);
  const gridRaw = grid.raw || {};
  line('File type = "ooTextFile"'); line('Object class = "TextGrid"'); line('');
  line(`xmin = ${numberWithRaw(gridRaw.xmin, grid.xmin)}`, true); line(`xmax = ${numberWithRaw(gridRaw.xmax, grid.xmax)}`, true); line('tiers? <exists>', true); line(`size = ${grid.tiers.length}`, true); line('item []:', true); line('');
  grid.tiers.forEach((tier, tierIndex) => {
    const tierRaw = tier.raw || {};
    line(`    item [${tierIndex + 1}]:`); line(`        class = "${tier.kind === 'interval' ? 'IntervalTier' : 'TextTier'}"`, true); line(`        name = "${escaped(tier.name)}"`, true); line(`        xmin = ${numberWithRaw(tierRaw.xmin, tier.xmin)}`, true); line(`        xmax = ${numberWithRaw(tierRaw.xmax, tier.xmax)}`, true);
    if (tier.kind === 'interval') {
      line(`        intervals: size = ${tier.items.length}`, true);
      tier.items.forEach((item, itemIndex) => { line(`        intervals [${itemIndex + 1}]:`); line(`            xmin = ${numberWithRaw(item.raw?.xmin, item.xmin)}`, true); line(`            xmax = ${numberWithRaw(item.raw?.xmax, item.xmax)}`, true); line(`            text = "${escaped(item.text)}"`, true); });
    } else {
      line(`        points: size = ${tier.items.length}`, true);
      tier.items.forEach((item, itemIndex) => { line(`        points [${itemIndex + 1}]:`); line(`            number = ${numberWithRaw(item.raw?.time, item.time)}`, true); line(`            mark = "${escaped(item.mark)}"`, true); });
    }
  });
  return lines.join(newline) + (grid.meta?.finalNewline === false ? '' : newline);
}

function serializeShort(grid, newline) {
  const lines = [];
  const gridRaw = grid.raw || {};
  lines.push(grid.meta?.oldShortHeader ? '"ooTextFile short"' : 'File type = "ooTextFile"', grid.meta?.oldShortHeader ? '"TextGrid"' : 'Object class = "TextGrid"', numberWithRaw(gridRaw.xmin, grid.xmin), numberWithRaw(gridRaw.xmax, grid.xmax), '<exists>', String(grid.tiers.length));
  for (const tier of grid.tiers) {
    const tierRaw = tier.raw || {};
    lines.push(tier.kind === 'interval' ? '"IntervalTier"' : '"TextTier"', `"${escaped(tier.name)}"`, numberWithRaw(tierRaw.xmin, tier.xmin), numberWithRaw(tierRaw.xmax, tier.xmax), String(tier.items.length));
    for (const item of tier.items) if (tier.kind === 'interval') lines.push(numberWithRaw(item.raw?.xmin, item.xmin), numberWithRaw(item.raw?.xmax, item.xmax), `"${escaped(item.text)}"`); else lines.push(numberWithRaw(item.raw?.time, item.time), `"${escaped(item.mark)}"`);
  }
  return lines.join(newline) + (grid.meta?.finalNewline === false ? '' : newline);
}

export function serializeTextGridText(grid, options = {}) {
  const format = options.format === 'keep' || options.format === undefined ? (grid.meta?.format || 'long') : options.format;
  const newline = options.newline === 'keep' || options.newline === undefined ? (grid.meta?.newline || '\n') : options.newline;
  if (!['long', 'short'].includes(format)) throw new TypeError('format 必须是 keep、long 或 short。');
  if (newline !== '\n' && newline !== '\r\n') throw new TypeError('newline 必须是 \\n 或 \\r\\n。');
  return format === 'short' ? serializeShort(grid, newline) : serializeLong(grid, newline, Boolean(grid.meta?.trailingSpace));
}

export function serializeTextGrid(grid, options = {}) {
  const encoding = options.encoding === 'keep' || options.encoding === undefined ? (grid.meta?.encoding || 'utf-8') : options.encoding;
  if (!['keep', 'utf-8', 'utf-8-bom', 'utf-16be', 'utf-16le'].includes(options.encoding ?? 'keep')) throw new TypeError('encoding 不是支持的编码。');
  return encodeText(serializeTextGridText(grid, options), encoding === 'gb18030' ? 'utf-8' : encoding);
}

export function repairGrid(grid, { epsilon = 1e-6 } = {}) {
  let repaired = 0;
  let tiers = grid.tiers;
  for (let ti = 0; ti < grid.tiers.length; ti++) {
    const tier = grid.tiers[ti];
    if (tier.kind !== 'interval' || !tier.items.length) continue;
    let items = tier.items;
    let changed = false;
    const changeItem = (index, next) => { if (!changed) items = items.slice(); items[index] = next; changed = true; repaired++; };
    if (Math.abs(items[0].xmin - tier.xmin) <= epsilon && items[0].xmin !== tier.xmin) changeItem(0, { ...items[0], xmin: tier.xmin, raw: { ...items[0].raw, xmin: undefined } });
    for (let ii = 1; ii < items.length; ii++) if (Math.abs(items[ii].xmin - items[ii - 1].xmax) <= epsilon && items[ii].xmin !== items[ii - 1].xmax) changeItem(ii, { ...items[ii], xmin: items[ii - 1].xmax, raw: { ...items[ii].raw, xmin: undefined } });
    const last = items[items.length - 1];
    if (Math.abs(last.xmax - tier.xmax) <= epsilon && last.xmax !== tier.xmax) changeItem(items.length - 1, { ...last, xmax: tier.xmax, raw: { ...last.raw, xmax: undefined } });
    if (changed) { if (tiers === grid.tiers) tiers = tiers.slice(); tiers[ti] = { ...tier, items }; }
  }
  return repaired ? { grid: { ...grid, tiers }, repaired } : { grid, repaired: 0 };
}

export function createEmptyGrid(duration, tiers = [{ kind: 'interval', name: 'words' }, { kind: 'interval', name: 'phones' }]) {
  if (typeof duration !== 'number') throw new TypeError('duration 必须是数字。');
  return { xmin: 0, xmax: duration, tiers: tiers.map((tier) => tier.kind === 'point' ? { kind: 'point', name: tier.name, xmin: 0, xmax: duration, items: [] } : { kind: 'interval', name: tier.name, xmin: 0, xmax: duration, items: [{ xmin: 0, xmax: duration, text: '' }] }), meta: { format: 'long', encoding: 'utf-8', newline: '\n', trailingSpace: false } };
}

// 为已有的空区间层建立覆盖整个层范围的首个空区间。
// 该操作保持不可变：只复制目标层、目标层的条目数组和外层 tiers 数组，其他结构继续共享。
export function initializeIntervalTier(grid, tierIndex) {
  const tier = grid?.tiers?.[tierIndex];
  if (!tier || tier.kind !== 'interval' || tier.items.length !== 0 || !(tier.xmin < tier.xmax)) return null;
  const initializedTier = { ...tier, items: [{ xmin: tier.xmin, xmax: tier.xmax, text: '' }] };
  const tiers = grid.tiers.slice();
  tiers[tierIndex] = initializedTier;
  return { grid: { ...grid, tiers } };
}

export function findItemAt(tier, time) {
  if (tier.kind !== 'interval' || !tier.items.length || time < tier.xmin || time > tier.xmax) return -1;
  let low = 0; let high = tier.items.length;
  while (low < high) { const middle = (low + high) >>> 1; if (tier.items[middle].xmax > time) high = middle; else low = middle + 1; }
  if (low >= tier.items.length) return tier.items.length - 1;
  return tier.items[low].xmin <= time ? low : -1;
}

export function findBoundaryNear(tier, time, tolerance) {
  if (tier.kind !== 'interval' || tier.items.length < 2) return -1;
  let low = 0; let high = tier.items.length - 1;
  while (low < high) { const middle = (low + high) >>> 1; const value = tier.items[middle].xmax; if (Math.abs(value - time) <= tolerance) return middle; if (value < time) low = middle + 1; else high = middle; }
  return Math.abs(tier.items[low].xmax - time) <= tolerance ? low : -1;
}

export function findPointNear(tier, time, tolerance) {
  if (tier.kind !== 'point' || !tier.items.length) return -1;
  let low = 0; let high = tier.items.length;
  while (low < high) { const middle = (low + high) >>> 1; if (tier.items[middle].time < time) low = middle + 1; else high = middle; }
  let best = -1;
  for (const index of [low - 1, low]) if (index >= 0 && index < tier.items.length && Math.abs(tier.items[index].time - time) <= tolerance && (best < 0 || Math.abs(tier.items[index].time - time) < Math.abs(tier.items[best].time - time))) best = index;
  return best;
}

export function visibleRange(tier, t0, t1) {
  if (!tier.items.length || t1 < t0) return { first: 0, last: -1 };
  if (tier.kind === 'point') {
    let low = 0; let high = tier.items.length;
    while (low < high) { const middle = (low + high) >>> 1; if (tier.items[middle].time < t0) low = middle + 1; else high = middle; }
    const first = low; low = first; high = tier.items.length;
    while (low < high) { const middle = (low + high) >>> 1; if (tier.items[middle].time <= t1) low = middle + 1; else high = middle; }
    return { first, last: low - 1 };
  }
  let low = 0; let high = tier.items.length;
  while (low < high) { const middle = (low + high) >>> 1; if (tier.items[middle].xmax < t0) low = middle + 1; else high = middle; }
  const first = low; low = 0; high = tier.items.length;
  while (low < high) { const middle = (low + high) >>> 1; if (tier.items[middle].xmin <= t1) low = middle + 1; else high = middle; }
  return { first, last: low - 1 };
}

export function listBoundaryGroup(grid, tierIndex, boundaryIndex, tolerance = 1e-6) {
  const source = grid.tiers[tierIndex];
  if (!source || source.kind !== 'interval' || boundaryIndex < 0 || boundaryIndex >= source.items.length - 1) return [];
  const time = source.items[boundaryIndex].xmax; const result = [];
  grid.tiers.forEach((tier, ti) => { if (tier.kind === 'interval') for (let bi = 0; bi < tier.items.length - 1; bi++) if (Math.abs(tier.items[bi].xmax - time) <= tolerance) result.push({ tierIndex: ti, boundaryIndex: bi }); });
  return result;
}

function boundaryFor(tier, index, minDuration) { return { min: tier.items[index].xmin + minDuration, max: tier.items[index + 1].xmax - minDuration, rawMin: tier.items[index].xmin, rawMax: tier.items[index + 1].xmax }; }
export function boundaryLimits(grid, tierIndex, boundaryIndex, { linked = true, tolerance = 1e-6, minDuration = 1e-6 } = {}) {
  const tier = grid.tiers[tierIndex];
  if (!tier || tier.kind !== 'interval' || boundaryIndex < 0 || boundaryIndex >= tier.items.length - 1) return { min: NaN, max: NaN };
  const group = linked ? listBoundaryGroup(grid, tierIndex, boundaryIndex, tolerance) : [{ tierIndex, boundaryIndex }];
  const values = group.map((item) => boundaryFor(grid.tiers[item.tierIndex], item.boundaryIndex, minDuration));
  let min = Math.max(...values.map((value) => value.min)); let max = Math.min(...values.map((value) => value.max));
  if (min > max) { min = Math.max(...values.map((value) => value.rawMin)); max = Math.min(...values.map((value) => value.rawMax)); if (min > max) { min = values[0].rawMin; max = values[0].rawMax; } }
  return { min, max };
}

export function collectSnapTimes(grid, excludeTierIndex = -1) {
  const values = [];
  grid.tiers.forEach((tier, ti) => { if (ti === excludeTierIndex) return; if (tier.kind === 'interval') tier.items.slice(0, -1).forEach((item) => values.push(item.xmax)); else tier.items.forEach((item) => values.push(item.time)); });
  values.sort((a, b) => a - b); const unique = []; for (const value of values) if (!unique.length || value !== unique.at(-1)) unique.push(value); return Float64Array.from(unique);
}

export function nearestTime(sortedTimes, time, maxDelta) {
  let low = 0; let high = sortedTimes.length;
  while (low < high) { const middle = (low + high) >>> 1; if (sortedTimes[middle] < time) low = middle + 1; else high = middle; }
  let result = null;
  for (const index of [low - 1, low]) if (index >= 0 && index < sortedTimes.length && Math.abs(sortedTimes[index] - time) <= maxDelta && (result === null || Math.abs(sortedTimes[index] - time) < Math.abs(result - time))) result = sortedTimes[index];
  return result;
}

export function moveBoundary(grid, tierIndex, boundaryIndex, time, { linked = true, tolerance = 1e-6, minDuration = 1e-6 } = {}) {
  const source = grid.tiers[tierIndex];
  if (!source || source.kind !== 'interval' || !Number.isFinite(time) || boundaryIndex < 0 || boundaryIndex >= source.items.length - 1) return null;
  const moved = linked ? listBoundaryGroup(grid, tierIndex, boundaryIndex, tolerance) : [{ tierIndex, boundaryIndex }];
  const limits = boundaryLimits(grid, tierIndex, boundaryIndex, { linked, tolerance, minDuration });
  const finalTime = Math.min(limits.max, Math.max(limits.min, time));
  const changed = moved.filter((item) => grid.tiers[item.tierIndex].items[item.boundaryIndex].xmax !== finalTime);
  if (!changed.length) return null;
  const tiers = grid.tiers.slice();
  for (const item of changed) {
    const tier = tiers[item.tierIndex]; const items = tier.items.slice(); const left = items[item.boundaryIndex]; const right = items[item.boundaryIndex + 1];
    items[item.boundaryIndex] = { ...left, xmax: finalTime, raw: { ...left.raw, xmax: undefined } };
    items[item.boundaryIndex + 1] = { ...right, xmin: finalTime, raw: { ...right.raw, xmin: undefined } };
    tiers[item.tierIndex] = { ...tier, items };
  }
  return { grid: { ...grid, tiers }, time: finalTime, moved: changed };
}

export function insertBoundary(grid, tierIndex, time, { tolerance = 1e-6 } = {}) {
  const tier = grid.tiers[tierIndex]; const index = tier && tier.kind === 'interval' ? findItemAt(tier, time) : -1;
  if (index < 0 || !Number.isFinite(time)) return null;
  const item = tier.items[index]; if (!(item.xmin + tolerance < time && time < item.xmax - tolerance)) return null;
  const left = { xmin: item.xmin, xmax: time, text: item.text, raw: { xmin: item.raw?.xmin, xmax: undefined } }; const right = { xmin: time, xmax: item.xmax, text: '', raw: { xmin: undefined, xmax: item.raw?.xmax } };
  const items = tier.items.slice(); items.splice(index, 1, left, right); const tiers = grid.tiers.slice(); tiers[tierIndex] = { ...tier, items }; return { grid: { ...grid, tiers }, boundaryIndex: index };
}

export function removeBoundary(grid, tierIndex, boundaryIndex, { textMerge = 'concat' } = {}) {
  const tier = grid.tiers[tierIndex]; if (!tier || tier.kind !== 'interval' || boundaryIndex < 0 || boundaryIndex >= tier.items.length - 1) return null;
  const left = tier.items[boundaryIndex]; const right = tier.items[boundaryIndex + 1]; const text = textMerge === 'left' ? left.text : textMerge === 'right' ? right.text : left.text && right.text ? left.text + right.text : left.text || right.text;
  const merged = { xmin: left.xmin, xmax: right.xmax, text, raw: { xmin: left.raw?.xmin, xmax: right.raw?.xmax } }; const items = tier.items.slice(); items.splice(boundaryIndex, 2, merged); const tiers = grid.tiers.slice(); tiers[tierIndex] = { ...tier, items }; return { grid: { ...grid, tiers } };
}

export function setIntervalText(grid, tierIndex, itemIndex, text) {
  const tier = grid.tiers[tierIndex]; if (!tier || tier.kind !== 'interval' || itemIndex < 0 || itemIndex >= tier.items.length || tier.items[itemIndex].text === text) return null;
  const items = tier.items.slice(); items[itemIndex] = { ...items[itemIndex], text }; const tiers = grid.tiers.slice(); tiers[tierIndex] = { ...tier, items }; return { grid: { ...grid, tiers } };
}

export function insertPoint(grid, tierIndex, time, mark = '', { tolerance = 1e-6 } = {}) {
  const tier = grid.tiers[tierIndex]; if (!tier || tier.kind !== 'point' || !Number.isFinite(time) || time < tier.xmin + tolerance || time > tier.xmax - tolerance) return null;
  const index = tier.items.findIndex((item) => item.time >= time); const actual = index < 0 ? tier.items.length : index;
  if (tier.items[actual] && Math.abs(tier.items[actual].time - time) <= tolerance) return null;
  if (actual > 0 && Math.abs(tier.items[actual - 1].time - time) <= tolerance) return null;
  const items = tier.items.slice(); items.splice(actual, 0, { time, mark, raw: { time: undefined } }); const tiers = grid.tiers.slice(); tiers[tierIndex] = { ...tier, items }; return { grid: { ...grid, tiers }, index: actual };
}

export function movePoint(grid, tierIndex, index, time, { minGap = 1e-6 } = {}) {
  const tier = grid.tiers[tierIndex]; if (!tier || tier.kind !== 'point' || index < 0 || index >= tier.items.length || !Number.isFinite(time)) return null;
  let min = index ? tier.items[index - 1].time + minGap : tier.xmin; let max = index + 1 < tier.items.length ? tier.items[index + 1].time - minGap : tier.xmax;
  if (min > max) { min = index ? tier.items[index - 1].time : tier.xmin; max = index + 1 < tier.items.length ? tier.items[index + 1].time : tier.xmax; }
  const finalTime = Math.min(max, Math.max(min, time)); if (finalTime === tier.items[index].time) return null;
  const items = tier.items.slice(); items[index] = { ...items[index], time: finalTime, raw: { ...items[index].raw, time: undefined } }; const tiers = grid.tiers.slice(); tiers[tierIndex] = { ...tier, items }; return { grid: { ...grid, tiers }, time: finalTime };
}

export function removePoint(grid, tierIndex, index) {
  const tier = grid.tiers[tierIndex]; if (!tier || tier.kind !== 'point' || index < 0 || index >= tier.items.length) return null;
  const items = tier.items.slice(); items.splice(index, 1); const tiers = grid.tiers.slice(); tiers[tierIndex] = { ...tier, items }; return { grid: { ...grid, tiers } };
}

export function setPointMark(grid, tierIndex, index, mark) {
  const tier = grid.tiers[tierIndex]; if (!tier || tier.kind !== 'point' || index < 0 || index >= tier.items.length || tier.items[index].mark === mark) return null;
  const items = tier.items.slice(); items[index] = { ...items[index], mark }; const tiers = grid.tiers.slice(); tiers[tierIndex] = { ...tier, items }; return { grid: { ...grid, tiers } };
}

export function addTier(grid, { kind = 'interval', name = '', index = grid.tiers.length } = {}) {
  if (kind !== 'interval' && kind !== 'point') throw new TypeError('层类型必须是 interval 或 point。');
  const position = Math.max(0, Math.min(grid.tiers.length, index)); const tier = kind === 'interval' ? { kind, name, xmin: grid.xmin, xmax: grid.xmax, items: [{ xmin: grid.xmin, xmax: grid.xmax, text: '' }] } : { kind, name, xmin: grid.xmin, xmax: grid.xmax, items: [] }; const tiers = grid.tiers.slice(); tiers.splice(position, 0, tier); return { grid: { ...grid, tiers }, tierIndex: position };
}

export function removeTier(grid, index) { if (index < 0 || index >= grid.tiers.length) return null; const tiers = grid.tiers.slice(); tiers.splice(index, 1); return { grid: { ...grid, tiers } }; }
export function renameTier(grid, index, name) { if (index < 0 || index >= grid.tiers.length || grid.tiers[index].name === name) return null; const source = grid.tiers[index]; const next = { ...source, name }; if (source.raw) hidden(next, 'raw', source.raw); const tiers = grid.tiers.slice(); tiers[index] = next; return { grid: { ...grid, tiers } }; }
export function moveTier(grid, from, to) { if (from < 0 || from >= grid.tiers.length || to < 0 || to >= grid.tiers.length || from === to) return null; const tiers = grid.tiers.slice(); const [tier] = tiers.splice(from, 1); tiers.splice(to, 0, tier); return { grid: { ...grid, tiers } }; }
export function duplicateTier(grid, index, name) { if (index < 0 || index >= grid.tiers.length) return null; const source = grid.tiers[index]; const tier = { ...source, name: name ?? `${source.name} copy`, items: source.items.slice() }; if (source.raw) hidden(tier, 'raw', source.raw); const tiers = grid.tiers.slice(); tiers.splice(index + 1, 0, tier); return { grid: { ...grid, tiers }, tierIndex: index + 1 }; }

export class History {
  constructor(initial, limit = 200) { this._current = initial; this._undo = []; this._redo = []; this._saved = initial; this._limit = Math.max(1, Math.floor(limit)); }
  get current() { return this._current; }
  get canUndo() { return this._undo.length > 0; }
  get canRedo() { return this._redo.length > 0; }
  get dirty() { return this._current !== this._saved; }
  push(next) { if (next === this._current) return false; this._undo.push(this._current); if (this._undo.length > this._limit) this._undo.shift(); this._current = next; this._redo = []; return true; }
  undo() { if (!this._undo.length) return null; this._redo.push(this._current); this._current = this._undo.pop(); return this._current; }
  redo() { if (!this._redo.length) return null; this._undo.push(this._current); this._current = this._redo.pop(); return this._current; }
  markSaved() { this._saved = this._current; }
  reset(grid) { this._current = grid; this._undo = []; this._redo = []; this._saved = grid; }
}

export const AUDIO_EXTENSIONS = ['wav', 'wave', 'mp3', 'flac', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'aif', 'aiff', 'weba'];
const ROLE_DIRS = new Set(['wav', 'audio', 'sound', 'wavs', 'textgrid', 'tg', 'labels', 'annotation']);
export function classifyFile(name) {
  const base = String(name).replaceAll('\\', '/').split('/').pop().toLowerCase();
  const dot = base.lastIndexOf('.');
  if (dot < 0) return null;
  const ext = base.slice(dot + 1);
  if (AUDIO_EXTENSIONS.includes(ext)) return 'audio';
  if (ext === 'textgrid') return 'textgrid';
  if (ext === 'csv') return 'csv';
  return null;
}

function pathInfo(file) {
  const normalized = String(file.path).replaceAll('\\', '/'); const slash = normalized.lastIndexOf('/'); const dir = slash < 0 ? '' : normalized.slice(0, slash); const name = slash < 0 ? normalized : normalized.slice(slash + 1); const lower = name.toLowerCase();
  let stem = lower.endsWith('.textgrid') ? name.slice(0, -9) : name.replace(/\.[^.]*$/, '');
  if (lower.endsWith('.textgrid')) { const match = stem.toLowerCase().match(/\.([^.]+)$/); if (match && AUDIO_EXTENSIONS.includes(match[1])) stem = stem.slice(0, -(match[1].length + 1)); }
  return { file, type: classifyFile(name), dir, stem };
}
function canonicalDirectory(dir) { const parts = dir ? dir.split('/') : []; if (parts.length && ROLE_DIRS.has(parts.at(-1).toLowerCase())) parts.pop(); return parts; }
function commonDirectory(a, b) { const left = canonicalDirectory(a); const right = canonicalDirectory(b); let length = 0; while (length < left.length && length < right.length && left[length].toLowerCase() === right[length].toLowerCase()) length++; return left.slice(0, length).join('/'); }
function naturalCompare(a, b) { return new Intl.Collator('zh', { numeric: true, sensitivity: 'base' }).compare(a, b); }

export function pairFiles(files) {
  const infos = files.map(pathInfo).filter((info) => info.type).map((info, index) => ({ ...info, index })); const used = new Set(); const pairs = []; const keyOf = (dir, stem) => `${dir.toLowerCase()}\u0000${stem.toLowerCase()}`; const grouped = new Map();
  infos.forEach((info) => { const key = keyOf(info.dir, info.stem); if (!grouped.has(key)) grouped.set(key, []); grouped.get(key).push(info); });
  for (const group of grouped.values()) { const audio = group.filter((item) => item.type === 'audio'); const textgrid = group.filter((item) => item.type === 'textgrid'); if (audio.length === 1 && textgrid.length === 1) { used.add(audio[0].index); used.add(textgrid[0].index); pairs.push({ key: keyOf(audio[0].dir, audio[0].stem), stem: audio[0].stem, dir: audio[0].dir, audio: audio[0].file, textgrid: textgrid[0].file }); } }
  const audios = infos.filter((item) => item.type === 'audio' && !used.has(item.index)); const grids = infos.filter((item) => item.type === 'textgrid' && !used.has(item.index)); const stemKeys = new Set([...audios, ...grids].map((item) => item.stem.toLowerCase()));
  for (const stemKey of stemKeys) {
    const audio = audios.filter((item) => item.stem.toLowerCase() === stemKey && !used.has(item.index)); const textgrid = grids.filter((item) => item.stem.toLowerCase() === stemKey && !used.has(item.index));
    if (audio.length === 1 && textgrid.length === 1) { const a = audio[0]; const t = textgrid[0]; const dir = commonDirectory(a.dir, t.dir); used.add(a.index); used.add(t.index); pairs.push({ key: keyOf(dir, a.stem), stem: a.stem, dir, audio: a.file, textgrid: t.file }); continue; }
    if (!audio.length || !textgrid.length) continue;
    const candidates = []; for (const a of audio) for (const t of textgrid) { const dir = commonDirectory(a.dir, t.dir); candidates.push({ a, t, dir, score: dir.split('/').filter(Boolean).length }); }
    const pendingAudio = audio.slice();
    for (;;) {
      const available = candidates.filter((item) => !used.has(item.a.index) && !used.has(item.t.index));
      if (!available.length) break;
      let selected = null;
      for (const a of pendingAudio.filter((item) => !used.has(item.index))) {
        const choices = available.filter((item) => item.a.index === a.index);
        const score = Math.max(...choices.map((item) => item.score));
        const bestForAudio = choices.filter((item) => item.score === score);
        if (bestForAudio.length !== 1) continue;
        const candidate = bestForAudio[0];
        const choicesForText = available.filter((item) => item.t.index === candidate.t.index);
        const textScore = Math.max(...choicesForText.map((item) => item.score));
        const bestForText = choicesForText.filter((item) => item.score === textScore);
        if (bestForText.length === 1 && bestForText[0].a.index === a.index) { selected = candidate; break; }
      }
      if (!selected) break;
      const { a, t, dir } = selected; used.add(a.index); used.add(t.index); pairs.push({ key: keyOf(dir, a.stem), stem: a.stem, dir, audio: a.file, textgrid: t.file });
    }
  }
  infos.filter((item) => !used.has(item.index)).forEach((item) => pairs.push({ key: keyOf(item.dir, item.stem), stem: item.stem, dir: item.dir, audio: item.type === 'audio' ? item.file : null, textgrid: item.type === 'textgrid' ? item.file : null }));
  pairs.sort((a, b) => naturalCompare(`${a.dir}\u0000${a.stem}`, `${b.dir}\u0000${b.stem}`)); return pairs;
}

const CRC_TABLE = (() => { const table = new Uint32Array(256); for (let i = 0; i < 256; i++) { let value = i; for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1; table[i] = value >>> 0; } return table; })();
export function crc32(bytes) { const data = asBytes(bytes); let crc = 0xffffffff; for (const byte of data) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ byte) & 0xff]; return (crc ^ 0xffffffff) >>> 0; }
function dosDate(date) { const value = date instanceof Date ? date : new Date(1980, 0, 1); const year = Math.max(1980, Math.min(2107, value.getFullYear())); return { time: (value.getHours() << 11) | (value.getMinutes() << 5) | Math.floor(value.getSeconds() / 2), date: ((year - 1980) << 9) | ((value.getMonth() + 1) << 5) | value.getDate() }; }
function write16(view, offset, value) { view.setUint16(offset, value & 0xffff, true); }
function write32(view, offset, value) { view.setUint32(offset, value >>> 0, true); }

export function buildZip(files) {
  const encoder = new TextEncoder(); const entries = []; const names = new Set();
  for (const file of files) { const source = String(file.name).replaceAll('\\', '/'); const slash = source.lastIndexOf('/'); const directory = slash < 0 ? '' : source.slice(0, slash + 1); const leaf = slash < 0 ? source : source.slice(slash + 1); const dot = leaf.lastIndexOf('.'); const base = dot > 0 ? leaf.slice(0, dot) : leaf; const extension = dot > 0 ? leaf.slice(dot) : ''; let name = source; let number = 2; while (names.has(name)) name = `${directory}${base} (${number++})${extension}`; names.add(name); const data = asBytes(file.data); const nameBytes = encoder.encode(name); const date = dosDate(file.date); entries.push({ nameBytes, data, crc: crc32(data), time: date.time, date: date.date }); }
  let localSize = 0; let centralSize = 0; for (const entry of entries) { localSize += 30 + entry.nameBytes.length + entry.data.length; centralSize += 46 + entry.nameBytes.length; }
  const result = new Uint8Array(localSize + centralSize + 22); const view = new DataView(result.buffer); let offset = 0;
  for (const entry of entries) { entry.localOffset = offset; write32(view, offset, 0x04034b50); write16(view, offset + 4, 20); write16(view, offset + 6, 0x800); write16(view, offset + 8, 0); write16(view, offset + 10, entry.time); write16(view, offset + 12, entry.date); write32(view, offset + 14, entry.crc); write32(view, offset + 18, entry.data.length); write32(view, offset + 22, entry.data.length); write16(view, offset + 26, entry.nameBytes.length); write16(view, offset + 28, 0); result.set(entry.nameBytes, offset + 30); result.set(entry.data, offset + 30 + entry.nameBytes.length); offset += 30 + entry.nameBytes.length + entry.data.length; }
  const centralOffset = offset;
  for (const entry of entries) { write32(view, offset, 0x02014b50); write16(view, offset + 4, 20); write16(view, offset + 6, 20); write16(view, offset + 8, 0x800); write16(view, offset + 10, 0); write16(view, offset + 12, entry.time); write16(view, offset + 14, entry.date); write32(view, offset + 16, entry.crc); write32(view, offset + 20, entry.data.length); write32(view, offset + 24, entry.data.length); write16(view, offset + 28, entry.nameBytes.length); write16(view, offset + 30, 0); write16(view, offset + 32, 0); write16(view, offset + 34, 0); write16(view, offset + 36, 0); write32(view, offset + 38, 0); write32(view, offset + 42, entry.localOffset); result.set(entry.nameBytes, offset + 46); offset += 46 + entry.nameBytes.length; }
  write32(view, offset, 0x06054b50); write16(view, offset + 4, 0); write16(view, offset + 6, 0); write16(view, offset + 8, entries.length); write16(view, offset + 10, entries.length); write32(view, offset + 12, centralSize); write32(view, offset + 16, centralOffset); write16(view, offset + 20, 0); return result;
}
