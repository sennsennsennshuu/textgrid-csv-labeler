// TextGrid 工作台控制器。标注只存在本机 History 中；所有写入统一经过 commit 的模式门禁。
import * as core from './core.js';
import { buildPeaks, readPeakColumns, niceTimeTicks, niceFreqTicks, renderSpectrogramRGBA, SpectrogramEngine } from './dsp.js';
import { readEntries, collectDrop, pickLocalFiles, saveBytes, saveAsBytes } from './io.js';
import { decodeAudioFile, AudioPlayer } from './audio.js';

const $ = id => document.getElementById(id);
const node = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fmt = t => Number.isFinite(t) ? t.toFixed(3) : '—';
const player = new AudioPlayer();
const workerURL = URL.createObjectURL(new Blob([__TEXTGRID_WORKER_SOURCE__], { type: 'text/javascript' }));
const engine = new SpectrogramEngine({ workerFactory: () => new Worker(workerURL) });
let sessions = [], csvItems = [], csvSerial = 0, active = null, entries = [], mode = 'view', ti = 0, ii = -1;
let audio = null, peaks = null, spec = null, duration = 1, t0 = 0, t1 = 1, cursor = 0, selection = null;
// 保存本次播放的真实起点，手动停止与自然结束均使用同一个起点回退。
let playbackStart = null;
let generation = 0, controller = null, specController = null, loading = false, frame = 0;
let dragDepth = 0, dragging = false, renderKey = '', spectrumCanvas = null, waveScale = 1;
let phonemeTable = null;
let toastTimer = null;
let savingAll = false;
const PHONEME_TABLE_MAX_BYTES = 8 * 1024 * 1024;
const PHONEME_TIER_NAMES = ['phones', 'phone', 'ph_seq', 'phonemes', 'phoneme'];
// 非词典音素：仅 DiffSinger 基础/配置附加音素不参与音素表覆盖检查。
const EXTRA_PHONEME_TAGS = new Set(['AP', 'SP', 'EP', 'GS', 'VF']);
const grid = () => active?.history?.current || null;
const tier = () => grid()?.tiers[ti] || null;
const item = () => tier()?.items[ii] || null;
const editable = () => mode === 'edit' && !!grid() && !loading;
// CSV 独立标注保存在主会话的 csvVariant 中，离页保护必须同时检查两份历史。
const hasDirty = () => sessions.some(s => s.history?.dirty || s.csvVariant?.history?.dirty);
// TextGrid 没有显式父子树；按常见语义把父层稳定显示在子层上方。
function tierDisplayOrder() {
  const tiers = grid()?.tiers || [];
  // CSV 没有 words 语义，也不应被 TextGrid 的标准层排序重排；严格保留文件内三层层序。
  if (active?.historySource === 'csv') return tiers.map((_, index) => index);
  const rank = layer => {
    const name = String(layer.name || '').trim().toLocaleLowerCase();
    if (['sentence', 'utterance'].includes(name)) return 0;
    if (['word', 'words'].includes(name)) return 1;
    if (['syllable', 'syllables'].includes(name)) return 2;
    if (name === 'ph_num') return 3;
    if (['phone', 'phones', 'ph_seq', 'phoneme', 'phonemes'].includes(name)) return 4;
    if (name === 'ph_dur') return 5;
    // 自定义层不猜测语义，保留原文件位置；下面只在原标准层槽位之间重排。
    return null;
  };
  const order = tiers.map((_, index) => index);
  const knownSlots = order.filter(index => rank(tiers[index]) !== null);
  const knownSorted = knownSlots.slice().sort((a, b) => rank(tiers[a]) - rank(tiers[b]) || a - b);
  let cursor = 0;
  for (let position = 0; position < order.length; position++) {
    if (rank(tiers[order[position]]) !== null) order[position] = knownSorted[cursor++];
  }
  return order;
}
function stepTier(direction) {
  const order = tierDisplayOrder();
  if (!order.length) return;
  const position = Math.max(0, order.indexOf(ti));
  choose(order[clamp(position + direction, 0, order.length - 1)], 0);
}
function findPhonemeTier() {
  const tiers = grid()?.tiers || [];
  // 优先精确匹配用户约定的 phones；其他常见别名仅作为兼容回退。
  for (const name of PHONEME_TIER_NAMES) {
    const found = tiers.find(layer => layer.kind === 'interval' &&
      String(layer.name || '').trim().toLocaleLowerCase() === name);
    if (found) return found;
  }
  return null;
}
function parsePhonemeTable(text) {
  const phones = new Set();
  for (const raw of String(text).replace(/^\uFEFF/, '').split(/\r?\n/)) {
    let line = raw.trim();
    if (!line || /^[;#]/.test(line)) continue;
    // 只把空白后的 # 当行尾注释，避免误删合法音素文本。
    line = line.replace(/\s+#.*$/, '').trim();
    if (!line) continue;
    // DiffSinger 字典左侧是字/拼音，右侧才是音素；普通单列音素表则整行读取。
    const tab = line.indexOf('\t');
    const payload = tab >= 0 ? line.slice(tab + 1) : line;
    for (const rawToken of payload.split(/[\s,]+/)) {
      const token = rawToken.replace(/^["']|["']$/g, '').trim();
      if (token) phones.add(token);
    }
  }
  return phones;
}
function isExtraPhoneme(token) {
  // 部分 TextGrid 使用 <AP>/<SP> 包裹附加音素；统一去壳并忽略大小写。
  const normalized = String(token).trim().replace(/^<([^<>]+)>$/, '$1').toLocaleUpperCase();
  return EXTRA_PHONEME_TAGS.has(normalized);
}
function updatePhonemeStatus() {
  const status = $('phone-table-status');
  const enabled = $('use-phone-table').checked;
  status.hidden = !enabled;
  status.className = 'phone-table-status';
  status.textContent = '';
  status.title = '';
  if (!enabled) return;
  if (!phonemeTable) {
    status.textContent = '音素表：请选择本地文件';
    return;
  }
  if (!phonemeTable.phones.size) {
    status.textContent = '音素表：文件为空';
    return;
  }
  const layer = findPhonemeTier();
  if (!layer) {
    status.textContent = '音素表：未找到 phones 层';
    return;
  }
  if (!layer.items.length) {
    status.textContent = '音素表：phones 层为空';
    return;
  }
  const errors = [];
  layer.items.forEach((entry, index) => {
    const tokens = String(entry.text || '').trim().split(/\s+/).filter(Boolean);
    const invalid = tokens.filter(token => !isExtraPhoneme(token) && !phonemeTable.phones.has(token));
    for (const token of invalid) errors.push({ index: index + 1, token, item: entry });
  });
  if (!errors.length) {
    status.textContent = '音素表：无错误';
    return;
  }
  status.textContent = `音素表：${errors.length} 个错误 · ${errors.map(error =>
    `第 ${error.index} 项 ${fmt(error.item.xmin)}–${fmt(error.item.xmax)} s`,
  ).join('；')}`;
  status.title = errors.map(error =>
    `第 ${error.index} 项：${error.token}（${fmt(error.item.xmin)}–${fmt(error.item.xmax)} s）`,
  ).join('\n');
}

// 用浮动反馈替代常驻说明栏。用户操作成功提示严格显示 1 秒；错误保留 5 秒便于读完。
function message(text, error = false) {
  const toast = $('toast'); clearTimeout(toastTimer);
  toast.textContent = text; toast.classList.toggle('error', error); toast.classList.toggle('success', !error); toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; toast.textContent = ''; toastTimer = null; }, error ? 5000 : 1000);
}
function failure(error) { if (error?.name !== 'AbortError') message(error?.message || String(error), true); }
function run(fn) { return (...args) => { try { Promise.resolve(fn(...args)).catch(failure); } catch (e) { failure(e); } }; }
function stop() { player.stop(); playbackStart = null; $('play').textContent = '▶'; }
function requestDraw() { if (!frame) frame = requestAnimationFrame(() => { frame = 0; draw(); }); }
function setComputeStatus(text = '', state = '') {
  const node = $('compute-status');
  node.textContent = text;
  node.dataset.state = state;
  node.hidden = !text;
}

// HTML 首帧已选好默认暗色或有效偏好；主题改变只重绘画布，不重载标注或音频。
function updateTheme() {
  const dark = document.documentElement.dataset.theme !== 'light';
  const button = $('theme-toggle'), label = `切换至${dark ? '浅' : '深'}色主题`;
  button.setAttribute('aria-label', label); button.title = label;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  for (const [name, value] of Object.entries({ viewBox: '0 0 24 24', width: '18', height: '18', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'aria-hidden': 'true' })) svg.setAttribute(name, value);
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', dark ? 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8ZM12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5' : 'M20.7 13A8.8 8.8 0 0 1 11 3.3 8.8 8.8 0 1 0 20.7 13Z');
  svg.append(path); button.replaceChildren(svg);
  document.querySelector('meta[name="theme-color"]').content = getComputedStyle(document.documentElement).getPropertyValue('--bg').trim();
  requestDraw();
}

// 文件列表保持 History 独立；重配对时复用已导入条目的历史，避免文件切换丢失编辑。
function parseCsvRows(text) {
  // RFC 4180 子集：支持 BOM、引号字段、双引号转义、字段内逗号与换行。
  const source = String(text).replace(/^\uFEFF/, '');
  const rows = [];
  let row = [], field = '', quoted = false;
  for (let index = 0; index < source.length; index++) {
    const char = source[index];
    if (quoted) {
      if (char === '"') {
        if (source[index + 1] === '"') { field += '"'; index++; }
        else quoted = false;
      } else field += char;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === ',') { row.push(field); field = ''; continue; }
    if (char === '\r' || char === '\n') {
      if (char === '\r' && source[index + 1] === '\n') index++;
      row.push(field); rows.push(row); row = []; field = '';
      continue;
    }
    field += char;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}
function buildCsvDocument(text, metadata = {}) {
  const rows = parseCsvRows(text);
  const nonempty = rows
    .map((row, index) => ({ row, index }))
    .filter(entry => entry.row.some(value => String(value).trim()));
  if (!nonempty.length) {
    return {
      rows,
      records: [],
      names: [],
      columns: { name: 0, ph_seq: -1, ph_dur: -1, ph_num: -1 },
      hasHeader: false,
      encoding: metadata.encoding || 'utf-8',
      newline: metadata.newline || '\n',
      finalNewline: /(?:\r\n|\r|\n)$/.test(String(text)),
    };
  }
  const header = nonempty[0].row.map(value => String(value).trim().toLocaleLowerCase());
  const nameColumn = header.indexOf('name');
  const hasHeader = nameColumn >= 0;
  const column = label => header.indexOf(label);
  const columns = {
    name: hasHeader ? nameColumn : 0,
    ph_seq: column('ph_seq'),
    ph_dur: column('ph_dur'),
    ph_num: column('ph_num'),
  };
  const records = nonempty.slice(hasHeader ? 1 : 0).map(({ row, index }) => ({
    sourceRowIndex: index,
    rowNumber: index + 1,
    name: String(row[columns.name] || '').trim(),
    ph_seq: columns.ph_seq >= 0 ? String(row[columns.ph_seq] || '').trim() : '',
    ph_dur: columns.ph_dur >= 0 ? String(row[columns.ph_dur] || '').trim() : '',
    ph_num: columns.ph_num >= 0 ? String(row[columns.ph_num] || '').trim() : '',
  })).filter(record => record.name);
  return {
    rows,
    records,
    names: records.map(record => record.name),
    columns,
    hasHeader,
    encoding: metadata.encoding || 'utf-8',
    newline: metadata.newline || '\n',
    finalNewline: /(?:\r\n|\r|\n)$/.test(String(text)),
  };
}
async function readCsvData(file) {
  const decoded = core.decodeTextBytes(new Uint8Array(await file.arrayBuffer()));
  return buildCsvDocument(decoded.text, decoded);
}
function csvEscape(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
function csvValuesFromGrid(sourceGrid) {
  const layer = name => sourceGrid?.tiers.find(candidate =>
    candidate.kind === 'interval' && String(candidate.name || '').trim().toLocaleLowerCase() === name,
  );
  const sequence = layer('ph_seq'), durations = layer('ph_dur'), groups = layer('ph_num');
  if (!sequence || !durations || !groups) throw new Error('CSV 标注缺少 ph_seq、ph_dur 或 ph_num 层，无法保存。');
  const values = {
    ph_seq: sequence.items.map(entry => String(entry.text || '').trim()).join(' '),
    // CSV 的 ph_dur 必须取界面中的真实区间长度，不能沿用批量编辑前的旧文本。
    ph_dur: durations.items.map(entry => core.formatSeconds(entry.xmax - entry.xmin)).join(' '),
    ph_num: groups.items.map(entry => String(entry.text || '').trim()).join(' '),
  };
  const validated = buildCsvGrid(values);
  if (validated.error) throw new Error(`CSV 标注无法保存：${validated.error}`);
  return values;
}
function serializeCsvDocument(document, updates) {
  const { columns, rows } = document;
  if (!document.hasHeader || columns.ph_seq < 0 || columns.ph_dur < 0 || columns.ph_num < 0) {
    throw new Error('CSV 缺少 name、ph_seq、ph_dur 或 ph_num 表头，无法覆盖保存。');
  }
  const nextRows = rows.map(row => row.slice());
  for (const update of updates) {
    const row = nextRows[update.sourceRowIndex];
    if (!row) throw new Error(`CSV 第 ${update.sourceRowIndex + 1} 行已不存在，无法保存。`);
    for (const key of ['ph_seq', 'ph_dur', 'ph_num']) {
      const index = columns[key];
      while (row.length <= index) row.push('');
      row[index] = update[key];
    }
  }
  let text = nextRows.map(row => row.map(csvEscape).join(',')).join(document.newline);
  if (document.finalNewline) text += document.newline;
  return core.encodeTextBytes(text, document.encoding);
}
function csvNameKey(value) {
  const name = String(value || '').replaceAll('\\', '/').split('/').pop().toLocaleLowerCase();
  const dot = name.lastIndexOf('.');
  return dot >= 0 && core.AUDIO_EXTENSIONS.includes(name.slice(dot + 1)) ? name.slice(0, dot) : name;
}
function findCsvRecord(name) {
  const key = csvNameKey(name);
  const matches = [];
  for (const item of csvItems) {
    for (const record of item.records) if (csvNameKey(record.name) === key) matches.push({ record, item });
  }
  return matches.length === 1 ? matches[0] : null;
}
function buildCsvGrid(record) {
  const phones = record.ph_seq.split(/\s+/).filter(Boolean);
  const durations = record.ph_dur.split(/\s+/).filter(Boolean).map(Number);
  const groups = record.ph_num.split(/\s+/).filter(Boolean).map(Number);
  if (!phones.length) return { error: 'ph_seq 为空' };
  if (durations.length !== phones.length) return { error: `ph_seq 有 ${phones.length} 项，ph_dur 有 ${durations.length} 项` };
  if (durations.some(value => !Number.isFinite(value) || value <= 0)) return { error: 'ph_dur 必须全部是正数' };
  if (!groups.length || groups.some(value => !Number.isInteger(value) || value <= 0)) return { error: 'ph_num 必须全部是正整数' };
  if (groups.reduce((sum, value) => sum + value, 0) !== phones.length) return { error: 'ph_num 之和必须等于 ph_seq 数量' };

  const phoneIntervals = [], durationIntervals = [], numIntervals = [];
  let phoneIndex = 0, time = 0;
  for (const count of groups) {
    const groupStart = time;
    for (let index = 0; index < count; index++) {
      const phone = phones[phoneIndex];
      const duration = durations[phoneIndex];
      const end = time + duration;
      phoneIntervals.push({ xmin: time, xmax: end, text: phone });
      durationIntervals.push({ xmin: time, xmax: end, text: String(duration) });
      time = end; phoneIndex++;
    }
    numIntervals.push({ xmin: groupStart, xmax: time, text: String(count) });
  }
  const grid = core.createEmptyGrid(time, []);
  grid.tiers = [
    { kind: 'interval', name: 'ph_seq', xmin: 0, xmax: time, items: phoneIntervals },
    { kind: 'interval', name: 'ph_dur', xmin: 0, xmax: time, items: durationIntervals },
    { kind: 'interval', name: 'ph_num', xmin: 0, xmax: time, items: numIntervals },
  ];
  return { grid };
}
function rebuildCsvDurations(sourceGrid, durationIndex, durationText) {
  const byName = name => sourceGrid.tiers.find(layer => layer.kind === 'interval' && layer.name === name);
  const sequence = byName('ph_seq'), durations = byName('ph_dur'), groups = byName('ph_num');
  if (!sequence || !durations || !groups) return { error: '缺少 ph_seq、ph_dur 或 ph_num 层' };
  const nextDurations = durations.items.map((entry, index) =>
    index === durationIndex ? String(durationText).trim() : String(entry.text).trim(),
  );
  return buildCsvGrid({
    ph_seq: sequence.items.map(entry => String(entry.text).trim()).join(' '),
    ph_dur: nextDurations.join(' '),
    ph_num: groups.items.map(entry => String(entry.text).trim()).join(' '),
  });
}
function refreshCsvDurationTexts(sourceGrid) {
  if (active?.historySource !== 'csv' || !sourceGrid) return sourceGrid;
  const index = sourceGrid.tiers.findIndex(layer => layer.kind === 'interval' && layer.name === 'ph_dur');
  if (index < 0) return sourceGrid;
  const layer = sourceGrid.tiers[index];
  let changed = false;
  const items = layer.items.map(item => {
    const text = core.formatSeconds(item.xmax - item.xmin);
    if (text === item.text) return item;
    changed = true;
    return { ...item, text };
  });
  if (!changed) return sourceGrid;
  const tiers = sourceGrid.tiers.slice();
  tiers[index] = { ...layer, items };
  return { ...sourceGrid, tiers };
}
function createCsvVariant(parent, history = null, match = parent.csvMatch, error = null) {
  return {
    name: parent.name,
    pair: parent.pair,
    history,
    historySource: 'csv',
    csvMatch: match,
    csvRecord: match?.record || null,
    csvError: error,
    isCsvVariant: true,
    linked: true,
    exported: false,
    warnings: [],
  };
}
function sessionsForCsvRecord(record) {
  const key = csvNameKey(record.name);
  return sessions.flatMap(session => {
    if (session.draft || csvNameKey(session.name) !== key) return [];
    // TextGrid 会话的 CSV 标注放在独立变体中；纯 CSV 会话仍由主会话承载。
    return [session.pair?.textgrid ? session.csvVariant : session].filter(Boolean);
  });
}
// 同一音频的 TextGrid 与 CSV 标注是两份独立数据；二级关系行明确说明 CSV 独立来源。
function sessionRelations(session, inCsv) {
  const relations = [];
  if (session.isCsvVariant) {
    relations.push('CSV 独立标注');
    if (session.pair?.textgrid) relations.push('TextGrid 已配对');
  } else if (inCsv) relations.push('CSV 已配对');
  else if (session.pair?.textgrid) relations.push('TextGrid 已配对');
  if (!session.pair?.audio) relations.push('缺音频');
  else if (!session.pair?.textgrid && !inCsv) relations.push('缺标注');
  if (session.csvError) relations.push('CSV 数据错误');
  return relations.join(' · ');
}
function syncCsvAnnotations() {
  let changed = false;
  const errors = [];
  for (const session of sessions) {
    if (session.draft) continue;
    const match = findCsvRecord(session.name);
    if (!match) {
      const hadCsv = !!session.csvMatch;
      session.csvMatch = null; session.csvRecord = null; session.csvError = null;
      if (session.csvVariant && !session.csvVariant.history?.dirty) session.csvVariant = null;
      if (session.historySource === 'csv') {
        session.history = null; session.historySource = null; changed = true;
      }
      if (hadCsv) changed = true;
      continue;
    }
    const hadCsv = !!session.csvMatch;
    const previousRecord = session.csvRecord;
    session.csvMatch = match;
    session.csvRecord = match.record;
    if (!hadCsv || previousRecord !== match.record) changed = true;
    const built = buildCsvGrid(match.record);
    if (built.error) {
      session.csvError = built.error;
      if (session.pair?.textgrid) {
        session.csvVariant ||= createCsvVariant(session, null, match, built.error);
        session.csvVariant.csvMatch = match;
        session.csvVariant.csvRecord = match.record;
        session.csvVariant.csvError = built.error;
      }
      errors.push(`${match.record.name}：${built.error}`);
      continue;
    }
    if (session.pair?.textgrid) {
      const previousVariantRecord = session.csvVariant?.csvRecord;
      session.csvVariant ||= createCsvVariant(session, null, match);
      const variant = session.csvVariant;
      variant.name = session.name;
      variant.pair = session.pair;
      variant.csvMatch = match;
      variant.csvRecord = match.record;
      variant.csvError = null;
      // 已有未保存修改时绝不覆盖；CSV 记录变化且未修改时更新独立历史。
      if (!variant.history || (!variant.history.dirty && previousVariantRecord !== match.record)) {
        variant.history = new core.History(built.grid);
        variant.historySource = 'csv';
        variant.exported = false;
        changed = true;
      }
      continue;
    }
    // 用户已在空白工作区中编辑过时，不静默覆盖本机修改。
    if (session.history?.dirty && session.historySource !== 'csv') continue;
    if (session.historySource === 'csv' && session.history?.dirty) continue;
    session.history = new core.History(built.grid);
    session.historySource = 'csv';
    session.csvError = null;
    session.exported = false;
    changed = true;
  }
  return { changed, errors };
}
function renderFiles() {
  const list = $('file-list'); list.replaceChildren();
  const query = $('file-search').value.trim().toLocaleLowerCase();
  // CSV 专属音频只放在 CSV 二级列表；同时拥有 TextGrid 的音频仍回到一级列表。
  const primarySessions = sessions.filter(session => !session.csvMatch || !!session.pair?.textgrid);
  // 数据集徽标只统计真实导入的音频文件；CSV 清单和同名标注不额外计数。
  $('file-count').textContent = String(entries.filter(entry => core.classifyFile(entry.path) === 'audio').length);
  for (const s of primarySessions) {
    if (!s.name.toLocaleLowerCase().includes(query)) continue;
    const status = s.pair?.audio && s.pair?.textgrid ? 'paired'
      : s.pair?.audio && s.historySource === 'csv' ? 'csv-annotation'
        : s.pair?.audio ? 'missing-annotation' : 'missing-audio';
    const statusText = { paired: '已配对', 'csv-annotation': 'CSV 自动标注', 'missing-audio': '缺音频', 'missing-annotation': '缺标注' }[status];
    const button = node('button', `file-card${s === active ? ' active' : ''}`);
    button.dataset.pairing = status; button.dataset.dirty = String(!!s.history?.dirty);
    button.setAttribute('aria-current', String(s === active));
    button.append(node('strong', '', `${s.history?.dirty ? '● ' : ''}${s.name}`));
    button.append(node('small', '', statusText));
    button.setAttribute('aria-label', `${s.name}，${statusText}${s.history?.dirty ? '，有未保存修改' : ''}`);
    button.title = s.pair?.textgrid?.path || (s.historySource === 'csv' ? `${s.csvRecord?.name || s.name} · CSV 自动标注` : s.pair?.audio?.path || '本机工作副本');
    button.addEventListener('click', run(() => activate(s))); list.append(button);
  }
  for (const item of csvItems) {
    const matchingRecords = query
      ? item.records.filter(record => record.name.toLocaleLowerCase().includes(query))
      : item.records;
    if (query && !item.name.toLocaleLowerCase().includes(query) && !matchingRecords.length) continue;
    const card = node('div', `file-card csv-card${item.expanded ? ' expanded' : ''}`);
    card.dataset.pairing = 'csv'; card.dataset.csv = String(item.id); card.dataset.csvName = item.name;
    if (item.records.some(record => sessionsForCsvRecord(record).includes(active))) card.classList.add('active');
    const toggle = node('button', 'csv-toggle');
    toggle.type = 'button';
    toggle.setAttribute('aria-expanded', String(item.expanded));
    toggle.append(
      node('strong', '', item.name),
      node('small', '', item.error ? `CSV 读取失败：${item.error}` : `CSV 清单 · ${item.names.length} 个文件名`),
      node('span', 'csv-chevron', '›'),
    );
    const listId = `csv-names-${item.id}`;
    toggle.setAttribute('aria-controls', listId);
    toggle.setAttribute('aria-label', `${item.name}，CSV 清单，${item.names.length} 个文件名，点击${item.expanded ? '收起' : '展开'}`);
    const names = node('div', 'csv-name-list');
    names.id = listId; names.role = 'list'; names.hidden = !item.expanded;
    const visibleRecords = query && !item.name.toLocaleLowerCase().includes(query) ? matchingRecords : item.records;
    if (visibleRecords.length) {
      for (const record of visibleRecords) {
        const row = node('div', 'csv-name-item');
        row.role = 'listitem';
        const matches = sessionsForCsvRecord(record);
        if (matches.length) {
          for (const session of matches) {
            const sessionButton = node('button', `csv-session-button${session === active ? ' active' : ''}`);
            sessionButton.type = 'button';
            const relations = sessionRelations(session, true);
            sessionButton.dataset.pairing = session.pair?.textgrid && session.pair?.audio ? 'csv-textgrid-paired'
              : session.pair?.textgrid ? 'csv-textgrid-missing-audio'
                : session.pair?.audio ? 'csv-audio-paired' : 'csv-missing-audio';
            sessionButton.dataset.dirty = String(!!session.history?.dirty);
            sessionButton.dataset.sessionName = session.name;
            sessionButton.setAttribute('aria-current', String(session === active));
            sessionButton.setAttribute('aria-label',
              `${session.name}，${relations}${session.history?.dirty ? '，有未保存修改' : ''}`);
            sessionButton.title = session.pair?.textgrid?.path || session.pair?.audio?.path || record.name;
            sessionButton.append(
              node('span', 'csv-session-name', `${session.history?.dirty ? '● ' : ''}${session.name}`),
              node('span', 'csv-session-relation', relations),
            );
            sessionButton.onclick = run(() => activate(session));
            row.append(sessionButton);
          }
        } else {
          row.classList.add('csv-missing-audio');
          row.append(
            node('span', 'csv-session-name', record.name),
            node('span', 'csv-session-relation', '缺音频'),
          );
        }
        names.append(row);
      }
    } else {
      const empty = node('div', 'csv-name-empty', item.error ? '无法读取 name 列' : 'CSV 中没有 name 列内容');
      empty.role = 'listitem';
      names.append(empty);
    }
    toggle.onclick = () => {
      item.expanded = !item.expanded;
      card.classList.toggle('expanded', item.expanded);
      names.hidden = !item.expanded;
      toggle.setAttribute('aria-expanded', String(item.expanded));
      toggle.setAttribute('aria-label', `${item.name}，CSV 清单，${item.names.length} 个文件名，点击${item.expanded ? '收起' : '展开'}`);
    };
    card.append(toggle, names);
    list.append(card);
  }
}
async function importEntries(incoming) {
  incoming = incoming.filter(e => core.classifyFile(e.path));
  if (!incoming.length) { message('没有找到音频、TextGrid 或 CSV 文件。', true); return; }
  const pathKey = e => String(e?.path || e?.file?.name || '').replaceAll('\\', '/').toLocaleLowerCase();
  const sameFile = (a, b) => a.file.size === b.file.size && a.file.lastModified === b.file.lastModified;
  const csvIncoming = incoming.filter(e => core.classifyFile(e.path) === 'csv');
  incoming = incoming.filter(e => ['audio', 'textgrid'].includes(core.classifyFile(e.path)));
  const csvAccepted = [];
  for (const entry of csvIncoming) {
    const index = csvItems.findIndex(item => pathKey(item.path) === pathKey(entry.path));
    const previous = index >= 0 ? csvItems[index] : null;
    if (previous && sameFile(previous, entry)) {
      // 新选择器可能补回了可写句柄，复用已有编辑状态时只更新 I/O 来源。
      previous.handle ||= entry.handle;
      previous.file = entry.file;
      csvAccepted.push(previous);
      continue;
    }
    let document = null, error = null;
    try { document = await readCsvData(entry.file); }
    catch (failure) { error = failure?.message || String(failure); }
    const item = {
      id: previous?.id ?? ++csvSerial,
      path: String(entry.path || entry.file.name || ''),
      name: String(entry.path || entry.file.name || '').replaceAll('\\', '/').split('/').pop(),
      file: entry.file,
      handle: entry.handle || null,
      document,
      records: document?.records || [],
      names: document?.names || [],
      error,
      expanded: previous?.expanded ?? false,
    };
    if (index >= 0) csvItems[index] = item; else csvItems.push(item);
    csvAccepted.push(item);
  }
  if (!incoming.length) {
    const synced = syncCsvAnnotations();
    if (synced.changed && active) await activate(active); else renderFiles();
    const csvCount = sessions.filter(session => session.historySource === 'csv' || session.csvVariant).length;
    if (csvAccepted.length) message(synced.errors.length ? synced.errors.join('；') : `已读取 ${csvAccepted.length} 个 CSV 清单文件，自动匹配 ${csvCount} 个音频标注。`, synced.errors.length > 0);
    return;
  }
  const accepted = [], notes = [];
  for (const e of incoming) {
    const index = entries.findIndex(old => pathKey(old) === pathKey(e));
    if (index < 0) { entries.push(e); accepted.push(e); continue; }
    const previous = entries[index];
    if (sameFile(previous, e)) {
      // 重新选择同一文件时不重建 History；若本次来自文件句柄选择器则补充可写句柄。
      previous.handle ||= e.handle;
      previous.file = e.file;
      accepted.push(previous);
      continue;
    }
    const owner = sessions.find(s => s.pair?.textgrid === previous || s.pair?.audio === previous);
    if (owner?.history?.dirty) { notes.push(`${e.path} 有未保存修改，已保留当前版本；请保存后重新导入`); continue; }
    entries[index] = e; accepted.push(e);
    if (owner?.pair?.textgrid === previous) { owner.history = null; owner.exported = false; }
  }
  const retained = sessions.filter(s => s.draft);
  const old = sessions.filter(s => !s.draft);
  const claimed = new Set();
  const paired = core.pairFiles(entries).map(pair => {
    const match = old.find(s => !claimed.has(s) && (s.pair?.textgrid && pair.textgrid && pathKey(s.pair.textgrid) === pathKey(pair.textgrid) || s.pair?.audio && pair.audio && pathKey(s.pair.audio) === pathKey(pair.audio)));
    if (match) claimed.add(match);
    // 原先仅音频的会话后来导入同名 TextGrid 时，CSV 历史迁移到独立变体；
    // 手工新建的空白层若已有修改，仍保留为独立工作副本。
    if (match?.history && !match.pair?.textgrid && pair.textgrid) {
      if (match.historySource === 'csv') {
        match.csvVariant = createCsvVariant(match, match.history, match.csvMatch, match.csvError);
        match.csvVariant.linked = match.linked ?? true;
        match.linked = true;
        notes.push(`${match.name} 的 CSV 标注已保留为独立版本`);
      } else if (match.history.dirty) {
        const copy = { ...match, pair: { ...match.pair }, name: `${match.name}（未保存副本）`, draft: true };
        retained.push(copy); notes.push(`${match.name} 的本机新建标注已保留为未保存副本`);
      }
      match.history = null; match.historySource = null; match.csvRecord = null; match.csvError = null;
      match.warnings = []; match.exported = false;
    }
    return Object.assign(match || {}, { pair, name: pair.stem });
  });
  sessions = [...retained, ...paired];
  const synced = syncCsvAnnotations();
  if (synced.errors.length) notes.push(...synced.errors);
  const target = sessions.find(s => accepted.includes(s.pair?.textgrid) || accepted.includes(s.pair?.audio)) || active || sessions[0];
  renderFiles();
  await activate(target);
  const summary = [`${accepted.length} 个音频/标注文件`];
  if (csvAccepted.length) summary.push(`${csvAccepted.length} 个 CSV 清单`);
  message(notes.length ? notes.join('；') : `已读取 ${summary.join('、')}，共 ${sessions.length} 组。未配对项会单独保留；同名歧义不会自动合并。`, !!notes.length);
}

async function activate(s) {
  if (!s) return;
  stop(); controller?.abort(); specController?.abort();
  const localController = new AbortController(); controller = localController;
  const token = ++generation;
  active = s; loading = true; audio = peaks = spec = null; ti = 0; ii = -1; selection = null; cursor = 0;
  $('linked').checked = s.linked ?? true;
  duration = Math.max(0.001, s.history?.current.xmax || 1); t0 = 0; t1 = duration; renderKey = '';
  $('document-name').textContent = s.name;
  setComputeStatus('读取中…', 'loading');
  renderFiles(); renderTiers(); controls(); requestDraw();
  const problems = [];
  try {
    if (!s.history && s.pair?.textgrid) {
      const parsed = core.parseTextGrid(await s.pair.textgrid.file.arrayBuffer());
      // 解析期间切换到其他文件时，只保留该会话的历史，不再改当前界面。
      s.history = new core.History(parsed.grid); s.warnings = parsed.warnings;
    }
  } catch (e) { problems.push(`标注读取失败：${e.message}`); }
  if (token !== generation) return;
  try {
    const decoded = s.pair?.audio ? await decodeAudioFile(s.pair.audio.file, { signal: localController.signal }) : null;
    if (token !== generation) return;
    if (decoded && !decoded.mono.length) throw new Error('音频没有可播放的采样点。');
    audio = decoded;
  } catch (e) { if (e.name !== 'AbortError') problems.push(`音频读取失败：${e.message}`); }
  if (token !== generation) return;
  duration = Math.max(audio?.duration || 0, s.history?.current.xmax || 0, 0.001);
  t0 = Math.min(0, s.history?.current.xmin || 0); t1 = duration;
  loading = false;
  if (s.history) { ti = Math.max(0, s.history.current.tiers.findIndex(t => t.name === 'phones')); ii = tier()?.items.length ? 0 : -1; }
  if (audio) { peaks = buildPeaks(audio.mono, audio.sampleRate); }
  if (audio && grid() && Math.abs(audio.duration - grid().xmax) > .05) problems.push(`音频终点 ${fmt(audio.duration)} s 与标注终点 ${fmt(grid().xmax)} s 不同，请核对配对。`);
  if (s.warnings?.length) problems.push(...s.warnings.slice(0, 4));
  if (problems.length) message(problems.join('；'), true);
  renderTiers(); inspector(); controls(); requestDraw();
  if (audio) await calculateSpectrum(); else setComputeStatus('仅标注模式', 'annotation-only');
}

// 窗长改变会取消上一任务；generation 和 AbortSignal 同时隔离文件切换产生的陈旧结果。
async function calculateSpectrum() {
  specController?.abort(); specController = new AbortController();
  const signal = specController.signal, token = generation, source = audio;
  if (!source) return;
  spec = null; renderKey = ''; setComputeStatus('正在计算频谱…', 'loading'); requestDraw();
  try {
    const next = await engine.compute(source.mono, source.sampleRate, { windowMs: +$('window-ms').value, maxFreq: +$('max-freq').value, maxCells: 24e6 }, { signal, onProgress: p => { if (!signal.aborted && token === generation) setComputeStatus(`频谱 ${Math.round(p * 100)}%`, 'loading'); } });
    if (signal.aborted || token !== generation) return;
    spec = next; setComputeStatus('', 'ready'); requestDraw();
  } catch (e) { if (e.name !== 'AbortError') { setComputeStatus('频谱计算失败', 'error'); failure(e); } }
}

function setMode(value) {
  mode = value;
  // 仅有音频时，到明确进入编辑模式才建立新标注；查看模式始终没有标注写操作。
  if (mode === 'edit' && active && !active.history && audio) {
    active.history = new core.History(core.createEmptyGrid(audio.duration));
    // 新建的标注尚未导出，需要与导入文件一样触发离页提醒。
    active.history.push({ ...active.history.current });
    ti = 0; ii = 0;
  }
  $('mode-view').setAttribute('aria-pressed', String(mode === 'view')); $('mode-edit').setAttribute('aria-pressed', String(mode === 'edit'));
  $('mode-hint').textContent = mode === 'view' ? '浏览波形、频谱与标注' : '拖动边界或修改文字，完成后保存';
  renderTiers(); inspector(); controls(); requestDraw();
}
function controls() {
  const edit = editable(), h = active?.history;
  $('undo').disabled = !edit || !h.canUndo; $('redo').disabled = !edit || !h.canRedo;
  $('save').disabled = !hasDirty() || loading || savingAll;
  $('save-as').disabled = !h || loading || savingAll || !!active?.saving;
  $('play').disabled = !audio || loading; $('play-selection').disabled = loading || !playbackRange();
  $('apply').disabled = !edit || !item(); $('insert').disabled = !edit || !tier();
  $('insert').textContent = tier()?.kind === 'interval' && !tier().items.length ? '初始化整段空区间' : tier()?.kind === 'point' ? '在光标处新增点' : '在光标处分割区间';
  $('remove').disabled = !edit || !item() || tier()?.kind === 'interval' && tier().items.length <= 1;
  $('manage-tier').disabled = !edit;
  $('annotation-text').readOnly = !edit; $('start-time').readOnly = !edit || !item() || tier()?.kind === 'interval' && ii === 0;
  $('end-time').readOnly = !edit || !item() || tier()?.kind === 'point' || ii === tier()?.items.length - 1;
  $('edit-badge').textContent = edit ? '可编辑' : '只读';
  $('inspector-note').textContent = edit ? '边界拖动可跨层吸附。修改后请保存；关闭页面前会提示未保存内容。' : '查看模式下无法修改标注。双击区间可快速进入编辑。';
}
function inspector() {
  const g = grid(), t = tier(), it = item();
  const select = $('tier-select'); select.replaceChildren();
  for (const i of tierDisplayOrder()) {
    const layer = g.tiers[i], opt = node('option', '', layer.name || `未命名层 ${i + 1}`);
    opt.value = i; select.append(opt);
  }
  select.value = ti; select.disabled = !g?.tiers.length;
  $('tier-kind').textContent = t?.kind === 'point' ? '点层 · TextTier' : t ? '区间层 · IntervalTier' : '没有标注层';
  $('item-position').textContent = it ? `${ii + 1} / ${t.items.length}` : `${t?.items.length || 0} 条`;
  $('annotation-text').value = it ? t.kind === 'point' ? it.mark : it.text : '';
  $('start-time').value = it ? core.formatSeconds(t.kind === 'point' ? it.time : it.xmin) : '';
  $('end-time').value = it && t.kind === 'interval' ? core.formatSeconds(it.xmax) : '';
  $('duration-info').textContent = it && t.kind === 'interval' ? `时长 ${fmt(it.xmax - it.xmin)} s` : t?.kind === 'point' ? '点标注没有时长' : '点击时间轴上的区间或点';
  $('selection-info').textContent = selection ? `选区 ${fmt(selection[0])} — ${fmt(selection[1])} s · ${fmt(selection[1] - selection[0])} s` : `光标 ${fmt(cursor)} s`;
  $('previous').disabled = !t || ii <= 0; $('next').disabled = !t || ii >= t.items.length - 1;
  updatePhonemeStatus();
  controls();
}
function choose(layer, index, selectRange = true) {
  ti = layer; ii = index;
  const t = tier(), it = item();
  if (it) { cursor = t.kind === 'point' ? it.time : it.xmin; selection = selectRange && t.kind === 'interval' ? [it.xmin, it.xmax] : null; }
  stop(); renderTiers(); inspector(); requestDraw();
}
function commit(result, selectedIndex = ii) {
  if (!editable() || !result?.grid) return false;
  // CSV 的 ph_dur 必须始终反映当前区间真实长度；边界拖动、起终点输入和分割/合并都经过这里。
  const nextGrid = refreshCsvDurationTexts(result.grid);
  const issues = core.validateTextGrid(nextGrid).filter(i => i.level === 'error');
  if (issues.length) { message(`修改未应用：${issues[0].message}`, true); return false; }
  if (!active.history.push(nextGrid)) return false;
  ii = selectedIndex; const n = tier()?.items.length || 0; ii = n ? clamp(ii, 0, n - 1) : -1;
  active.exported = false; renderFiles(); renderTiers(); inspector(); requestDraw(); return true;
}

function applyForm(event) {
  event.preventDefault(); if (!editable() || !item()) return;
  const t = tier(), original = item(), a = +$('start-time').value, b = +$('end-time').value;
  // 任意层的起终点变化都视为时长编辑：提交后只保留当前条目选中，不保留播放选区。
  const timingChanged = t.kind === 'point'
    ? Math.abs(a - original.time) >= 1e-9
    : Math.abs(a - original.xmin) >= 1e-9 || Math.abs(b - original.xmax) >= 1e-9;
  // CSV 的 ph_dur 是时序参数：修改文本后按全部持续时间重建三层边界。
  if (active?.historySource === 'csv' && t.name === 'ph_dur'
    && String($('annotation-text').value).trim() !== String(original.text).trim()) {
    const duration = Number($('annotation-text').value);
    if (!Number.isFinite(duration) || duration <= 0) {
      message('ph_dur 必须是大于 0 的秒数。', true);
      return;
    }
    const rebuilt = rebuildCsvDurations(grid(), ii, $('annotation-text').value);
    if (rebuilt.error) { message(`修改未应用：${rebuilt.error}`, true); return; }
    if (commit({ grid: rebuilt.grid })) {
      const changed = item();
      // 时长修改后仅保留当前区间选中，不继续建立播放选区。
      selection = null;
      cursor = changed.xmin;
      inspector();
      updateOverlay();
      message('修改已应用，标注边界已重新计算');
      requestDraw();
    }
    return;
  }
  let next = grid();
  if (!Number.isFinite(a) || (t.kind === 'interval' && (!Number.isFinite(b) || a >= b))) { message('时间必须是有效数字，且区间起点须早于终点。', true); return; }
  if (t.kind === 'point') {
    const moved = core.movePoint(next, ti, ii, a);
    if (moved && Math.abs(moved.time - a) > 1e-8) { message('时间超出层范围或越过相邻点，请修改。', true); return; }
    next = moved?.grid || next; next = core.setPointMark(next, ti, ii, $('annotation-text').value)?.grid || next;
  } else {
    // 精确输入整体向右移动时先移右边界，向左时先移左边界，避免被原边界错误夹紧。
    const changes = [{ boundary: ii - 1, value: a, old: original.xmin }, { boundary: ii, value: b, old: original.xmax }];
    if (a >= original.xmax) changes.reverse();
    for (const c of changes) {
      if (Math.abs(c.value - c.old) < 1e-12) continue;
      if (c.boundary < 0 || c.boundary >= t.items.length - 1) { message('层的首尾边界固定，请编辑内部边界。', true); return; }
      const moved = core.moveBoundary(next, ti, c.boundary, c.value, { linked: $('linked').checked });
      if (!moved || Math.abs(moved.time - c.value) > 1e-8) { message('时间超出相邻区间允许的范围，请检查层间联动或时间输入。', true); return; }
      next = moved.grid;
    }
    next = core.setIntervalText(next, ti, ii, $('annotation-text').value)?.grid || next;
  }
  if (commit({ grid: next })) {
    const it = item();
    // 仅修改文字应延续现有选区状态，不能把“仅选中区间”重新变成时间选区。
    if (timingChanged || t.kind === 'point') selection = null;
    cursor = t.kind === 'point' ? it.time : it.xmin;
    inspector();
    updateOverlay();
    message('修改已应用');
    requestDraw();
  }
  else if (next === grid()) message('没有需要应用的修改');
}

function renderTiers() {
  const host = $('tiers'); host.replaceChildren();
  for (const index of tierDisplayOrder()) {
    const t = grid().tiers[index];
    const row = node('div', `tier-row${index === ti ? ' active' : ''}`); row.dataset.tier = index;
    const label = node('button', 'plot-label', t.name || '未命名层'); label.title = t.name;
    label.addEventListener('click', () => choose(index, t.items.length ? 0 : -1));
    const track = node('div', 'tier-track'); track.dataset.tier = index;
    track.addEventListener('pointerdown', e => { if (e.target === track) { ti = index; ii = -1; cursor = eventTime(e, track); selection = null; inspector(); requestDraw(); } });
    const range = core.visibleRange(t, t0, t1);
    for (let j = range.first; j <= range.last && j < t.items.length; j++) {
      const it = t.items[j], point = t.kind === 'point';
      const button = node('button', `${point ? 'point-item' : 'tier-item'}${index === ti && j === ii ? ' selected' : ''}`, point ? `◆ ${it.mark || '·'}` : it.text || '·');
      button.dataset.item = j; button.dataset.tier = index;
      const start = point ? it.time : Math.max(it.xmin, t0), end = point ? it.time : Math.min(it.xmax, t1);
      button.style.left = `${(start - t0) / (t1 - t0) * 100}%`;
      if (!point) button.style.width = `${Math.max(0, (end - start) / (t1 - t0) * 100)}%`;
      button.title = point ? `${it.mark} · ${fmt(it.time)} s` : `${it.text || '空区间'} · ${fmt(it.xmin)} — ${fmt(it.xmax)} s`;
      button.setAttribute('aria-label', `${t.name} ${j + 1} ${button.title}`);
      button.addEventListener('click', () => { if (!dragging) choose(index, j); });
      button.addEventListener('dblclick', () => { choose(index, j); setMode('edit'); $('annotation-text').focus(); });
      if (point && editable()) button.addEventListener('pointerdown', e => beginBoundaryDrag(e, index, j, true, track));
      track.append(button);
      if (!point && j < t.items.length - 1 && it.xmax >= t0 && it.xmax <= t1 && editable()) {
        const handle = node('button', 'boundary'); handle.style.left = `${(it.xmax - t0) / (t1 - t0) * 100}%`;
        handle.setAttribute('aria-label', `拖动 ${t.name} 第 ${j + 1} 个边界 ${fmt(it.xmax)} 秒`);
        handle.addEventListener('pointerdown', e => beginBoundaryDrag(e, index, j, false, track)); track.append(handle);
      }
    }
    row.append(label, track, node('div', 'axis')); host.append(row);
  }
}

function eventTime(event, track = $('waveform')) { const rect = track.getBoundingClientRect(); return clamp(t0 + (event.clientX - rect.left) / Math.max(1, rect.width) * (t1 - t0), Math.max(0, grid()?.xmin || 0), duration); }
// 手动定位时间指针时按屏幕像素换算吸附阈值，并面向所有层收集边界与点。
// Alt 可临时取消本次吸附，行为与拖动边界时保持一致。
function manualPointerTime(event, track) {
  let time = eventTime(event, track);
  const currentGrid = grid();
  // 音频-only 工作区没有 TextGrid，仍需正常定位和框选，不能调用边界收集。
  if ($('pointer-snap').checked && currentGrid && !event.altKey) {
    const rect = track.getBoundingClientRect();
    const tolerance = 7 / Math.max(1, rect.width) * (t1 - t0);
    time = core.nearestTime(core.collectSnapTimes(currentGrid), time, tolerance) ?? time;
  }
  return time;
}
function beginBoundaryDrag(event, layer, index, point, track) {
  if (!editable() || event.button !== 0) return;
  event.preventDefault(); event.stopPropagation(); stop();
  const origin = grid(), dragSession = active, dragGeneration = generation;
  const linked = $('linked').checked, snap = $('snap').checked;
  const validDrag = () => editable() && active === dragSession && generation === dragGeneration && grid() === origin;
  const base = point ? origin.tiers[layer].items[index].time : origin.tiers[layer].items[index].xmax;
  const rect = track.getBoundingClientRect(), times = core.collectSnapTimes(origin, layer);
  let target = base, moved = false;
  const line = $('drag-line'); line.hidden = false;
  function update(e) {
    if (!validDrag()) return;
    moved ||= Math.abs(e.clientX - event.clientX) > 2;
    let time = eventTime(e, track);
    if (snap && !e.altKey) time = core.nearestTime(times, time, 7 / rect.width * (t1 - t0)) ?? time;
    const result = point ? core.movePoint(origin, layer, index, time) : core.moveBoundary(origin, layer, index, time, { linked });
    target = result?.time ?? base; line.style.left = `${(target - t0) / (t1 - t0) * 100}%`;
    setComputeStatus(`边界 ${fmt(target)} s${$('snap').checked ? ' · Alt 临时取消吸附' : ''}`, 'boundary');
  }
  function finish(e) {
    window.removeEventListener('pointermove', update); window.removeEventListener('pointerup', finish); window.removeEventListener('pointercancel', cancel);
    line.hidden = true;
    if (e.type !== 'pointercancel' && moved && validDrag()) {
      ti = layer; ii = index; const result = point ? core.movePoint(origin, layer, index, target) : core.moveBoundary(origin, layer, index, target, { linked });
      commit(result); cursor = target; selection = null;
    }
    dragging = moved; setTimeout(() => { dragging = false; }, 0); inspector(); requestDraw();
  }
  const cancel = e => finish(e);
  window.addEventListener('pointermove', update); window.addEventListener('pointerup', finish); window.addEventListener('pointercancel', cancel); update(event);
}

function canvasContext(canvas) {
  const r = canvas.getBoundingClientRect(), ratio = Math.min(devicePixelRatio || 1, 2);
  const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
  if (canvas.width !== Math.round(w * ratio) || canvas.height !== Math.round(h * ratio)) { canvas.width = Math.round(w * ratio); canvas.height = Math.round(h * ratio); }
  const ctx = canvas.getContext('2d'); ctx.setTransform(ratio, 0, 0, ratio, 0, 0); ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}
function draw() {
  if (t1 <= t0) return;
  // Canvas 不继承 CSS 的绘图颜色；每次重绘读取同一主题色表，保持坐标轴和波形同步。
  const colors = getComputedStyle(document.documentElement);
  const color = name => colors.getPropertyValue(`--${name}`).trim();
  const { ctx: r, w, h } = canvasContext($('ruler'));
  r.fillStyle = color('ruler-bg'); r.fillRect(0, 0, w, h); r.font = '9px Segoe UI, sans-serif'; r.textAlign = 'center';
  const ticks = niceTimeTicks(t0, t1, w, 70).ticks;
  for (const tick of ticks) { const x = (tick.time - t0) / (t1 - t0) * w; r.strokeStyle = color('ruler-tick'); r.beginPath(); r.moveTo(x, h); r.lineTo(x, tick.major ? 21 : 25); r.stroke(); if (tick.major) { r.fillStyle = color('ruler-text'); r.fillText(tick.label, clamp(x, 15, w - 15), 14); } }
  const { ctx, w: ww, h: wh } = canvasContext($('waveform'));
  ctx.fillStyle = color('plot-bg'); ctx.fillRect(0, 0, ww, wh); ctx.lineWidth = 1;
  for (const tick of ticks.filter(t => t.major)) { const x = (tick.time - t0) / (t1 - t0) * ww; ctx.strokeStyle = color('plot-grid'); ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, wh); ctx.stroke(); }
  ctx.strokeStyle = color('plot-zero'); ctx.beginPath(); ctx.moveTo(0, wh / 2); ctx.lineTo(ww, wh / 2); ctx.stroke();
  if (peaks) {
    const columns = readPeakColumns(peaks, t0, t1, ww); ctx.strokeStyle = color('plot-wave'); ctx.beginPath();
    for (let x = 0; x < ww; x++) {
      const top = clamp(columns.max[x] * waveScale, -1, 1);
      const bottom = clamp(columns.min[x] * waveScale, -1, 1);
      ctx.moveTo(x + .5, wh / 2 - top * wh * .43);
      ctx.lineTo(x + .5, wh / 2 - bottom * wh * .43 + .5);
    }
    ctx.stroke();
  } else { ctx.fillStyle = color('plot-label-text'); ctx.font = '11px Segoe UI, sans-serif'; ctx.textAlign = 'center'; ctx.fillText(loading ? '正在读取音频…' : '打开音频以显示波形', ww / 2, wh / 2 - 12); }
  const { ctx: sc, w: sw, h: sh } = canvasContext($('spectrogram'));
  sc.fillStyle = '#0b0916'; sc.fillRect(0, 0, sw, sh);
  if (spec) {
    const fMax = Math.min(+$('max-freq').value, audio.sampleRate / 2);
    const key = [t0, t1, sw, sh, $('palette').value, fMax, $('db-range').value].join('|');
    if (key !== renderKey) {
      spectrumCanvas ||= document.createElement('canvas'); spectrumCanvas.width = sw; spectrumCanvas.height = sh;
      const pixels = renderSpectrogramRGBA(spec, { t0, t1, width: sw, height: sh, fMax, rangeDb: +$('db-range').value }, $('palette').value);
      spectrumCanvas.getContext('2d').putImageData(new ImageData(pixels, sw, sh), 0, 0); renderKey = key;
    }
    sc.drawImage(spectrumCanvas, 0, 0, sw, sh);
    const axis = $('frequency-axis'); axis.replaceChildren();
    for (const tick of niceFreqTicks(0, fMax, sh, 36)) { const label = node('span', '', tick.label); label.style.top = `${clamp((1 - tick.ratio) * 100, 5, 95)}%`; axis.append(label); }
  } else { sc.fillStyle = '#b6b0c3'; sc.textAlign = 'center'; sc.font = '11px Segoe UI, sans-serif'; sc.fillText(audio ? '正在计算频谱…' : '打开音频以显示频谱', sw / 2, sh / 2); }
  $('view-start').textContent = fmt(t0); $('view-end').textContent = `${fmt(t1)} s`;
  const halfRange = 1 / waveScale;
  const label = value => halfRange >= 1 ? String(value) : value.toFixed(halfRange < .2 ? 2 : 1);
  const waveLabels = $('wave-axis').querySelectorAll('span');
  if (waveLabels.length === 3) {
    waveLabels[0].textContent = label(halfRange);
    waveLabels[1].textContent = '0';
    waveLabels[2].textContent = `−${label(halfRange)}`;
  }
  $('pan').value = duration > t1 - t0 ? t0 / (duration - (t1 - t0)) * 1000 : 0; $('pan').disabled = t1 - t0 >= duration;
  updateOverlay();
}
function updateOverlay() {
  const line = $('cursor-line'); line.style.left = `${(cursor - t0) / (t1 - t0) * 100}%`; line.hidden = cursor < t0 || cursor > t1;
  const sel = $('selection-region'); sel.hidden = !selection;
  if (selection) { sel.style.left = `${(selection[0] - t0) / (t1 - t0) * 100}%`; sel.style.width = `${(selection[1] - selection[0]) / (t1 - t0) * 100}%`; }
  $('clock').textContent = `${fmt(cursor)} s`;
  // 播放、暂停及自然结束都更新底栏，避免底栏仍显示上一次手动定位的位置。
  $('selection-info').textContent = selection ? `选区 ${fmt(selection[0])} — ${fmt(selection[1])} s · ${fmt(selection[1] - selection[0])} s` : `光标 ${fmt(cursor)} s`;
}
function setView(start, end) {
  const span = clamp(end - start, Math.min(.002, duration), duration);
  t0 = clamp(start, 0, Math.max(0, duration - span)); t1 = t0 + span; renderTiers(); requestDraw();
}
function zoom(factor, focus = cursor) { const span = (t1 - t0) * factor, ratio = clamp((focus - t0) / (t1 - t0), 0, 1); setView(focus - span * ratio, focus + span * (1 - ratio)); }

// 时间选区与当前条目选中是独立状态；清除前者后仍可试听当前标注区间。
// 显式框选优先，并将播放范围裁到真实音频内，避免越界区间意外播放整段。
function playbackRange() {
  if (!audio) return null;
  const current = item();
  const range = selection || (tier()?.kind === 'interval' && current ? [current.xmin, current.xmax] : null);
  if (!range) return null;
  const start = clamp(range[0], 0, audio.duration), end = clamp(range[1], 0, audio.duration);
  return Number.isFinite(start) && Number.isFinite(end) && end > start ? [start, end] : null;
}

async function play(onlySelection = false) {
  if (!audio || loading) return;
  if (player.playing) {
    // Space、Ctrl+Space 和播放按钮停止时也遵守“播放结束”选项。
    // 直接定位/框选调用 stop()，仍以用户的新位置为准，不经过这里回退。
    const target = $('play-end').value === 'return' ? playbackStart ?? cursor : player.currentTime;
    stop(); cursor = player.seek(target); updateOverlay(); return;
  }
  const range = onlySelection ? playbackRange() : null;
  if (onlySelection && !range) return;
  const source = audio, token = generation;
  await player.load(source.mono, source.sampleRate);
  if (token !== generation || source !== audio) return;
  const start = range ? range[0] : cursor >= audio.duration - .001 ? 0 : cursor;
  const end = range ? range[1] : audio.duration;
  playbackStart = start;
  await player.play(start, end, {
    rate: +$('rate').value,
    onTime: time => { if (token === generation) { cursor = time; updateOverlay(); } },
    onEnd: () => {
      if (token !== generation) return;
      const target = $('play-end').value === 'return' ? start : Math.min(end, audio.duration);
      // 同时重置播放器内部 offset 与可视时间指针，避免不同浏览器只更新其中一个。
      cursor = player.seek(target);
      playbackStart = null;
      $('play').textContent = '▶';
      updateOverlay();
    },
  });
  if (token === generation) $('play').textContent = player.playing ? 'Ⅱ' : '▶';
}

function exportName(s) {
  if (s.isCsvVariant) return `${s.name}.csv.TextGrid`;
  const path = s.pair?.textgrid?.path || `${s.name}.TextGrid`;
  return path.split(/[\\/]/).at(-1);
}
function serialize(g) { return core.serializeTextGrid(g, { format: $('export-format').value }); }

// 汇总所有 History 中的脏数据；同一 CSV 的多个记录合并成一次文件写入。
function collectSavePlan() {
  const jobs = [], csvGroups = new Map();
  let recordCount = 0;
  const addCsvSession = session => {
    const match = session.csvMatch;
    const item = match?.item;
    const record = session.csvRecord || match?.record;
    if (!item?.document || !record) {
      throw new Error(`${session.name} 的 CSV 来源已失效，请重新导入该 CSV 文件后再保存。`);
    }
    const values = csvValuesFromGrid(session.history.current);
    let group = csvGroups.get(item.id);
    if (!group) {
      group = {
        type: 'csv',
        item,
        handle: item.handle || null,
        name: item.name,
        updates: [],
        sessions: [],
      };
      csvGroups.set(item.id, group);
    }
    // 同一行只能由一个 History 提供快照，避免批量保存时静默覆盖另一份修改。
    if (group.updates.some(update => update.sourceRowIndex === record.sourceRowIndex)) {
      throw new Error(`CSV 文件 ${item.name} 中的 ${record.name} 同时存在两份未保存版本，请先处理冲突。`);
    }
    group.updates.push({ sourceRowIndex: record.sourceRowIndex, ...values });
    group.sessions.push({
      session,
      history: session.history,
      snapshot: session.history.current,
    });
    recordCount++;
  };

  for (const session of sessions) {
    if (session.csvVariant?.history?.dirty) addCsvSession(session.csvVariant);
    if (!session.history?.dirty) continue;
    if (session.historySource === 'csv') {
      addCsvSession(session);
      continue;
    }
    const source = session.pair?.textgrid || null;
    const snapshot = session.history.current;
    jobs.push({
      type: source ? 'textgrid' : 'new',
      session,
      history: session.history,
      snapshot,
      source,
      handle: source?.handle || session.savedHandle || null,
      name: source ? String(source.path || source.file.name).replaceAll('\\', '/').split('/').pop() : `${session.name}.TextGrid`,
      bytes: serialize(snapshot),
      records: [{ session, history: session.history, snapshot }],
    });
    recordCount++;
  }
  jobs.push(...csvGroups.values());
  return { jobs, recordCount };
}

// 传统 input/拖放没有句柄时，在保存用户手势内要求重新选择原文件以取得覆盖权限。
async function requestMissingSourceHandles(jobs) {
  const missing = jobs.filter(job => job.type !== 'new' && !job.handle?.createWritable);
  if (!missing.length) return;
  const picker = globalThis.showOpenFilePicker;
  if (typeof picker !== 'function') {
    throw new Error('当前浏览器不支持覆盖原文件，请使用最新版 Chrome 或 Edge。');
  }
  const handles = await picker({
    multiple: missing.length > 1,
    types: [{ description: 'TextGrid 或 CSV 标注文件', accept: { 'text/plain': ['.TextGrid', '.textgrid', '.csv'] } }],
  });
  const byName = new Map();
  for (const handle of handles) {
    const key = String(handle.name || '').toLocaleLowerCase();
    if (!byName.has(key)) byName.set(key, []);
    byName.get(key).push(handle);
  }
  const unresolved = [];
  for (const job of missing) {
    const matches = byName.get(job.name.toLocaleLowerCase()) || [];
    if (matches.length !== 1) {
      unresolved.push(job.name);
      continue;
    }
    job.handle = matches[0];
    if (job.item) job.item.handle = job.handle;
    if (job.source) job.source.handle = job.handle;
  }
  if (unresolved.length) {
    throw new Error(`未获得以下原文件的写入权限：${unresolved.join('、')}。请重新选择全部被覆盖的文件。`);
  }
}

// 保存成功后立即重建 CSV 索引，并更新所有会话指向的新记录对象。
function refreshCsvRecords(item, bytes) {
  const decoded = core.decodeTextBytes(bytes);
  const document = buildCsvDocument(decoded.text, decoded);
  const previous = item.records;
  item.document = document;
  item.records = document.records;
  item.names = document.names;
  const replace = session => {
    const match = session?.csvMatch;
    if (match?.item !== item) return;
    const source = match.record || session.csvRecord;
    const record = document.records.find(entry => entry.sourceRowIndex === source?.sourceRowIndex);
    if (record) {
      session.csvMatch = { record, item };
      session.csvRecord = record;
    }
  };
  for (const session of sessions) {
    replace(session);
    replace(session.csvVariant);
  }
  // previous 仅用于保留旧对象引用语义；保存后的新文件才是后续读取来源。
  void previous;
}

function markSaveJob(job) {
  for (const entry of job.records) {
    if (entry.history.current === entry.snapshot) {
      entry.history.markSaved();
      entry.session.exported = true;
    } else {
      entry.session.exported = false;
    }
  }
}

async function saveAllDirty() {
  if (loading || savingAll) return;
  const plan = collectSavePlan();
  if (!plan.jobs.length) { message('没有未保存的标注修改。'); return; }
  savingAll = true;
  controls();
  let writtenFiles = 0, writtenRecords = 0;
  try {
    // 先把所有缺失句柄一次性补齐；用户取消时不会出现只写了一半的情况。
    await requestMissingSourceHandles(plan.jobs);
    for (const job of plan.jobs) {
      if (job.type === 'csv') {
        const bytes = serializeCsvDocument(job.item.document, job.updates);
        await saveBytes(job.name, bytes, { handle: job.handle });
        refreshCsvRecords(job.item, bytes);
        job.records = job.sessions;
      } else if (job.type === 'new') {
        const result = await saveAsBytes(job.name, job.bytes);
        job.session.savedHandle = result.handle || null;
        job.handle = result.handle || null;
      } else {
        await saveBytes(job.name, job.bytes, { handle: job.handle });
      }
      markSaveJob(job);
      writtenFiles++;
      writtenRecords += job.records.length;
    }
    message(`已保存 ${writtenRecords} 条修改，写入 ${writtenFiles} 个标注文件。`);
  } catch (error) {
    if (error.name === 'AbortError') message('已取消保存');
    else throw error;
  } finally {
    savingAll = false; controls(); renderFiles(); renderTiers(); inspector();
  }
}

// “另存为”只创建新文件，不把原文件的未保存状态误标为已保存。
async function saveCurrentAs() {
  if (!active?.history || loading || savingAll || active.saving) return;
  const session = active, snapshot = session.history.current, bytes = serialize(snapshot);
  session.saving = true; controls();
  try {
    await saveAsBytes(exportName(session), bytes);
    message(`${exportName(session)} 已另存为本地文件`);
  } catch (error) {
    if (error.name === 'AbortError') message('已取消另存为');
    else throw error;
  } finally {
    session.saving = false; controls(); renderFiles();
  }
}

function requestSaveConfirmation() {
  if (loading || savingAll) return;
  const plan = collectSavePlan();
  if (!plan.jobs.length) { message('没有未保存的标注修改。'); return; }
  const names = plan.jobs.map(job => job.name);
  const visible = names.length > 6 ? `${names.slice(0, 6).join('、')} 等 ${names.length} 个文件` : names.join('、');
  const originalCount = plan.jobs.filter(job => job.type !== 'new').length;
  const newCount = plan.jobs.length - originalCount;
  const actions = [
    originalCount ? `覆盖 ${originalCount} 个原始标注文件` : '',
    newCount ? `为 ${newCount} 个新标注选择保存位置` : '',
  ].filter(Boolean).join('，并');
  $('save-confirm-name').textContent =
    `将保存全部 ${plan.recordCount} 条已修改标注，${actions}：${visible}。文件仅在浏览器本地写入，不会上传云端。`;
  $('save-confirm-dialog').showModal();
  $('save-confirm-accept').focus();
}

// 交互事件集中绑定，避免每次渲染积累全局监听器。
$('mode-view').onclick = () => setMode('view'); $('mode-edit').onclick = () => setMode('edit');
$('annotation-form').onsubmit = applyForm;
// 浏览器原生选择器不能在同一次对话框同时选择文件与目录，因此同一导入按钮提供两项选择。
// 菜单关闭不改变工作区；只有实际选择文件后才读取，取消选择器不会清空数据。
const importMenus = [['import-audio', 'audio-menu'], ['import-textgrid', 'textgrid-menu']];
function closeImportMenus() {
  for (const [button, menu] of importMenus) { $(button).setAttribute('aria-expanded', 'false'); $(menu).hidden = true; }
}
for (const [buttonId, menuId] of importMenus) {
  const button = $(buttonId), menu = $(menuId);
  function openImportMenu() { closeImportMenus(); menu.hidden = false; button.setAttribute('aria-expanded', 'true'); menu.querySelector('button').focus(); }
  button.onclick = () => { if (menu.hidden) openImportMenu(); else closeImportMenus(); };
  button.onkeydown = event => { if (event.key === 'ArrowDown') { event.preventDefault(); openImportMenu(); } };
  menu.onkeydown = event => {
    const choices = [...menu.querySelectorAll('button')], index = choices.indexOf(document.activeElement);
    if (event.key === 'Escape') { event.preventDefault(); closeImportMenus(); button.focus(); }
    else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : -1) + choices.length) % choices.length;
      choices[next].focus();
    } else if (event.key === 'Tab') closeImportMenus();
  };
}
const pickerInputs = { 'audio-files': 'audio-input', 'audio-folder': 'audio-folder-input', 'textgrid-files': 'textgrid-input', 'textgrid-folder': 'textgrid-folder-input', 'csv-files': 'csv-input' };
const inputKinds = { 'audio-input': 'audio', 'audio-folder-input': 'audio', 'textgrid-input': 'textgrid', 'textgrid-folder-input': 'textgrid', 'csv-input': 'csv' };
for (const option of document.querySelectorAll('[data-picker]')) option.onclick = run(async () => {
  closeImportMenus();
  const picker = option.dataset.picker;
  const directory = picker.endsWith('-folder');
  try {
    // 优先保存可写文件句柄，使右上角保存可以直接覆盖原标注文件。
    const selected = await pickLocalFiles({ directory });
    if (selected !== null) {
      await importEntries(selected);
      return;
    }
  } catch (error) {
    if (error?.name === 'AbortError') return;
    throw error;
  }
  $(pickerInputs[picker]).click();
});
document.addEventListener('pointerdown', event => { if (!event.target.closest('.import-control')) closeImportMenus(); });
document.addEventListener('focusin', event => { if (!event.target.closest('.import-control')) closeImportMenus(); });
for (const [id, kind] of Object.entries(inputKinds)) $(id).onchange = run(async e => {
  const selected = readEntries(e.target.files).filter(entry => core.classifyFile(entry.path) === kind);
  try { await importEntries(selected); } finally { e.target.value = ''; }
});
$('use-phone-table').onchange = () => {
  $('phoneme-table-picker').hidden = !$('use-phone-table').checked;
  updatePhonemeStatus();
};
$('open-phone-table').onclick = () => $('phone-table-input').click();
$('phone-table-input').onchange = run(async event => {
  const file = event.target.files?.[0];
  if (!file) return;
  try {
    if (file.size > PHONEME_TABLE_MAX_BYTES) {
      throw new Error(`音素表超过 ${PHONEME_TABLE_MAX_BYTES / 1024 / 1024} MiB 上限。`);
    }
    const decoded = core.decodeTextBytes(new Uint8Array(await file.arrayBuffer()));
    phonemeTable = { name: file.name, phones: parsePhonemeTable(decoded.text) };
    $('phone-table-file').textContent = `${file.name} · ${phonemeTable.phones.size} 个音素`;
  } catch (error) {
    phonemeTable = null;
    $('phone-table-file').textContent = `读取失败：${file.name}`;
    updatePhonemeStatus();
    throw error;
  } finally {
    event.target.value = '';
  }
  updatePhonemeStatus();
});
$('file-search').oninput = renderFiles;
$('save').onclick = run(requestSaveConfirmation); $('save-as').onclick = run(saveCurrentAs);
$('save-confirm-accept').onclick = run(async () => {
  $('save-confirm-dialog').close();
  await saveAllDirty();
});
$('play').onclick = run(() => play()); $('play-selection').onclick = run(() => play(true));
$('rate').onchange = run(async () => { if (player.playing) { cursor = player.currentTime; stop(); await play(); } });
$('zoom-in').onclick = () => zoom(.5); $('zoom-out').onclick = () => zoom(2); $('fit').onclick = () => setView(0, duration);
$('zoom-selection').onclick = () => { if (selection) { const pad = Math.max(.01, (selection[1] - selection[0]) * .1); setView(selection[0] - pad, selection[1] + pad); } };
$('pan').oninput = () => { const span = t1 - t0; setView(+$('pan').value / 1000 * (duration - span), +$('pan').value / 1000 * (duration - span) + span); };
for (const id of ['palette', 'db-range']) $(id).onchange = requestDraw;
for (const id of ['window-ms', 'max-freq']) $(id).onchange = run(calculateSpectrum);
$('tier-select').onchange = () => choose(+$('tier-select').value, grid().tiers[+$('tier-select').value].items.length ? 0 : -1);
$('previous').onclick = () => choose(ti, Math.max(0, ii - 1)); $('next').onclick = () => choose(ti, Math.min(tier().items.length - 1, ii + 1));
$('linked').onchange = () => { if (active) active.linked = $('linked').checked; };
for (const action of ['undo', 'redo']) $(action).onclick = () => { if (editable() && active.history[action]()) { ti = clamp(ti, 0, Math.max(0, grid().tiers.length - 1)); ii = tier()?.items.length ? clamp(ii, 0, tier().items.length - 1) : -1; selection = null; renderFiles(); renderTiers(); inspector(); requestDraw(); } };
$('insert').onclick = () => {
  if (!editable() || !tier()) return;
  if (tier().kind === 'interval' && !tier().items.length) { commit(core.initializeIntervalTier(grid(), ti), 0); return; }
  const result = tier().kind === 'point' ? core.insertPoint(grid(), ti, cursor) : core.insertBoundary(grid(), ti, cursor);
  if (!commit(result, result?.index ?? (result?.boundaryIndex ?? ii) + 1)) message('光标需要位于区间内部，且不能与已有边界或点重合。', true);
};
$('remove').onclick = () => {
  if (!editable() || !item()) return;
  if (tier().kind === 'point') {
    commit(core.removePoint(grid(), ti, ii), Math.max(0, ii - 1));
    return;
  }
  // 删除当前区间时保留左邻文本并吸收当前区间时长；首区间则保留右侧文本。
  const result = ii > 0
    ? core.removeBoundary(grid(), ti, ii - 1, { textMerge: 'left' })
    : core.removeBoundary(grid(), ti, 0, { textMerge: 'right' });
  commit(result, Math.max(0, ii - 1));
};
$('manage-tier').onclick = () => { if (!editable()) return; $('tier-name').value = tier()?.name || ''; $('tier-dialog').showModal(); };
for (const [id, operation] of [['rename-tier', () => core.renameTier(grid(), ti, $('tier-name').value)], ['add-tier', () => core.addTier(grid(), { name: $('tier-name').value || '新标注层', kind: $('new-tier-kind').value })], ['duplicate-tier', () => core.duplicateTier(grid(), ti, $('tier-name').value || `${tier()?.name} 副本`)], ['delete-tier', () => core.removeTier(grid(), ti)]]) {
  $(id).onclick = () => { if (!editable()) return; const result = operation(); if (result) { ti = result.tierIndex ?? Math.max(0, Math.min(ti, result.grid.tiers.length - 1)); commit(result, 0); $('tier-dialog').close(); } };
}
$('theme-toggle').onclick = () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('sen-textgrid-theme', next); } catch {}
  updateTheme();
};
for (const b of document.querySelectorAll('[data-close]')) b.onclick = () => $(b.dataset.close).close();
for (const canvas of [$('waveform'), $('spectrogram')]) canvas.addEventListener('pointerdown', event => {
  if (event.button !== 0 || loading) return; stop(); event.preventDefault();
  const start = manualPointerTime(event, canvas); let end = start;
  cursor = start; selection = null; updateOverlay();
  canvas.setPointerCapture(event.pointerId);
  const move = e => { end = eventTime(e, canvas); selection = Math.abs(end - start) > .001 ? [Math.min(start, end), Math.max(start, end)] : null; updateOverlay(); };
  const finish = () => { canvas.removeEventListener('pointermove', move); canvas.removeEventListener('pointerup', finish); canvas.removeEventListener('pointercancel', finish); inspector(); };
  canvas.addEventListener('pointermove', move); canvas.addEventListener('pointerup', finish); canvas.addEventListener('pointercancel', finish);
});
// 刻度栏本身就是可拖动的播放头：按下或拖动时同步移动时间指针，不产生选区。
$('ruler').addEventListener('pointerdown', event => {
  if (event.button !== 0 || loading) return;
  stop(); event.preventDefault();
  const ruler = $('ruler');
  const move = e => { cursor = manualPointerTime(e, ruler); selection = null; updateOverlay(); };
  move(event);
  ruler.setPointerCapture(event.pointerId);
  const finish = () => {
    ruler.removeEventListener('pointermove', move);
    ruler.removeEventListener('pointerup', finish);
    ruler.removeEventListener('pointercancel', finish);
    inspector();
  };
  ruler.addEventListener('pointermove', move);
  ruler.addEventListener('pointerup', finish);
  ruler.addEventListener('pointercancel', finish);
});
function zoomWaveformVertical(direction) {
  waveScale = clamp(waveScale * (direction < 0 ? 1.25 : .8), .25, 12);
  requestDraw();
  message(`波形纵向缩放：${waveScale.toFixed(2).replace(/\.?0+$/, '')}×`);
}
function zoomSpectrumVertical(direction) {
  const select = $('max-freq');
  const values = [...select.options].map(option => Number(option.value)).sort((a, b) => a - b);
  const current = Number(select.value);
  let index = values.indexOf(current);
  if (index < 0) index = values.reduce((best, value, i) => Math.abs(value - current) < Math.abs(values[best] - current) ? i : best, 0);
  index = clamp(index + (direction < 0 ? -1 : 1), 0, values.length - 1);
  if (values[index] === current) return;
  select.value = String(values[index]);
  message(`频谱纵向上限：${values[index] / 1000} kHz`);
  run(calculateSpectrum)();
}
$('timeline').addEventListener('wheel', e => {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey) {
    e.preventDefault();
    const id = e.target.closest?.('canvas')?.id;
    if (id === 'waveform' && audio) zoomWaveformVertical(e.deltaY);
    else if (id === 'spectrogram' && audio) zoomSpectrumVertical(e.deltaY);
    return;
  }
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    const track = e.target.closest?.('canvas') || $('waveform');
    zoom(e.deltaY > 0 ? 1.25 : .8, eventTime(e, track));
  } else if (e.shiftKey) {
    e.preventDefault();
    const delta = (e.deltaY || e.deltaX) / 600 * (t1 - t0);
    setView(t0 + delta, t1 + delta);
  }
}, { passive: false });
document.addEventListener('keydown', e => {
  // 导入菜单已处理的方向键不能再冒泡为时间轴快捷键，避免切换导入选项时改变当前标注。
  if (e.defaultPrevented) return;
  const tag = e.target.tagName;
  const inputType = tag === 'INPUT' ? String(e.target.type || 'text').toLowerCase() : '';
  // 仅文本类输入保留 Space 输入能力；按钮、下拉框和复选框等控件统一让位给播放快捷键。
  const textEntry = tag === 'TEXTAREA' || e.target.isContentEditable
    || (tag === 'INPUT' && !['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'file', 'color'].includes(inputType));
  const field = /INPUT|TEXTAREA|SELECT/.test(tag) || e.target.isContentEditable;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
    // 对话框打开时不重复触发保存；Shift 组合键用于跳过确认并直接保存。
    if (document.querySelector('dialog[open]')) return;
    if (e.shiftKey) run(saveAllDirty)();
    else run(requestSaveConfirmation)();
    return;
  }
  if (document.querySelector('dialog[open]')) return;
  if ((e.ctrlKey || e.metaKey) && e.code === 'Space') {
    e.preventDefault();
    // 可播放范围由播放逻辑实时计算，避免旧按钮状态阻断当前区间或新框选。
    if (e.repeat) return;
    run(() => play(true))();
    return;
  }
  if (e.code === 'Space') {
    if (textEntry) return;
    e.preventDefault();
    if (!e.repeat) run(() => play())();
    return;
  }
  if (field) return;
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); $(e.shiftKey ? 'redo' : 'undo').click(); }
  else if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
    e.preventDefault();
    $(mode === 'view' ? 'mode-edit' : 'mode-view').click();
  }
  else if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && e.code === 'KeyC') {
    e.preventDefault();
    if (!editable()) { message('切换到编辑模式后，才能用 Shift+C 新增标注。', true); return; }
    if (!tier()) { message('请先在标注详情中选择一个标注层。', true); return; }
    $('insert').click();
  }
  else if (e.key === 'ArrowLeft' && tier()) { e.preventDefault(); $('previous').click(); }
  else if (e.key === 'ArrowRight' && tier()) { e.preventDefault(); $('next').click(); }
  else if (e.key === 'ArrowUp' && grid()) { e.preventDefault(); stepTier(-1); }
  else if (e.key === 'ArrowDown' && grid()) { e.preventDefault(); stepTier(1); }
});
window.addEventListener('dragenter', e => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); dragDepth++; $('drop-overlay').hidden = false; } });
window.addEventListener('dragover', e => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('drop-overlay').hidden = true; } });
window.addEventListener('drop', run(async e => { e.preventDefault(); dragDepth = 0; $('drop-overlay').hidden = true; await importEntries(await collectDrop(e.dataTransfer)); }));
window.addEventListener('beforeunload', e => { if (hasDirty()) { e.preventDefault(); e.returnValue = ''; } });
window.addEventListener('pagehide', event => { stop(); if (!event.persisted) { engine.dispose(); URL.revokeObjectURL(workerURL); player.dispose(); } });
new ResizeObserver(() => { renderKey = ''; requestDraw(); }).observe($('timeline'));
updateTheme();
// 默认保持空工作区；示例不会自动载入，用户文件只能通过本地选择或拖放进入。
renderFiles();
renderTiers();
inspector();
controls();
updateOverlay();
requestDraw();
