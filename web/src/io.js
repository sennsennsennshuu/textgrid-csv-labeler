// TextGrid 工具的浏览器文件输入输出适配层。

function asArray(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value;
  return Array.from(value);
}

function fileName(file) {
  return typeof file?.name === 'string' ? file.name : '';
}

function entryPath(file, path) {
  return path || fileName(file);
}

// 把 FileList、数组或类似 FileList 的对象统一为带相对路径的记录。
export function readEntries(fileList) {
  return asArray(fileList).filter(Boolean).map((file) => ({
    path: entryPath(file, file.webkitRelativePath || ''),
    file,
  }));
}

function readEntry(entry) {
  return new Promise((resolve, reject) => {
    try {
      if (entry.isFile) {
        entry.file((file) => resolve([{ path: entry.fullPath?.replace(/^\//, '') || fileName(file), file, handle: undefined }]), reject);
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const all = [];
        const next = () => reader.readEntries((batch) => {
          if (!batch.length) return resolve(Promise.all(all).then((groups) => groups.flat()));
          all.push(...batch.map(readEntry));
          // 让同步回调也能安全推进，避免某些测试桩或实现造成同步递归。
          queueMicrotask(next);
        }, reject);
        next();
      } else resolve([]);
    } catch (error) { reject(error); }
  });
}

// 读取 File System Access API 的文件或目录句柄；目录使用相对路径保持配对关系。
async function readHandleEntry(handle, prefix = '') {
  if (handle?.kind === 'file') {
    const file = await handle.getFile();
    return [{ path: prefix || handle.name || fileName(file), file, handle }];
  }
  if (handle?.kind !== 'directory') return [];
  const result = [];
  for await (const [name, child] of handle.entries()) {
    const path = prefix ? `${prefix}/${name}` : name;
    result.push(...await readHandleEntry(child, path));
  }
  return result;
}

// 递归读取拖放目录；webkitGetAsEntry 是 Chromium 系列的目录 API。
export async function collectDrop(dataTransfer) {
  const items = asArray(dataTransfer?.items);
  if (!items.length) return readEntries(dataTransfer?.files);
  // drop 回调返回后 DataTransfer 会进入受保护状态。必须先同步取得所有
  // entry/File，不能在读取第一个目录期间再访问后续 DataTransferItem。
  const snapshots = items.map((item) => ({
    entry: item?.webkitGetAsEntry?.(),
    file: item?.getAsFile?.(),
    // 该调用也必须同步发起；句柄 Promise 在事件结束后仍可继续解析。
    handlePromise: typeof item?.getAsFileSystemHandle === 'function'
      ? item.getAsFileSystemHandle()
      : null,
  }));
  const entries = [];
  for (const { entry, file, handlePromise } of snapshots) {
    if (handlePromise) {
      try {
        const handle = await handlePromise;
        const handled = await readHandleEntry(handle);
        if (handled.length) {
          entries.push(...handled);
          continue;
        }
      } catch {
        // 浏览器可能仅允许传统 entry/File 回退；此时继续使用同一 drop 快照。
      }
    }
    if (entry) entries.push(...await readEntry(entry));
    else if (file) entries.push({ path: fileName(file), file });
  }
  return entries;
}

// 优先使用 File System Access API；不具备能力时交给主线程 input 处理。
export async function pickLocalFiles({ directory = false } = {}) {
  const scope = globalThis;
  if (directory && typeof scope.showDirectoryPicker === 'function') {
    const handle = await scope.showDirectoryPicker();
    const result = [];
    async function visit(dir, prefix = '') {
      for await (const [name, child] of dir.entries()) {
        const path = prefix ? `${prefix}/${name}` : name;
        if (child.kind === 'file') result.push({ path, file: await child.getFile(), handle: child });
        else await visit(child, path);
      }
    }
    await visit(handle);
    return result;
  }
  if (!directory && typeof scope.showOpenFilePicker === 'function') {
    const handles = await scope.showOpenFilePicker({ multiple: true });
    return Promise.all(handles.map(async (handle) => ({ path: handle.name, file: await handle.getFile(), handle })));
  }
  return null;
}

function byteView(bytes) {
  if (bytes instanceof Uint8Array) return bytes;
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  throw new TypeError('要保存的数据必须是 Uint8Array 或 ArrayBuffer');
}

// 只写入用户授权过的原始文件句柄，禁止静默回退到下载。
export async function saveBytes(name, bytes, { handle = null } = {}) {
  const data = byteView(bytes);
  if (!handle?.createWritable) {
    throw new Error(`没有 ${name} 的本地写入权限，请重新选择原文件后再保存。`);
  }
  const writable = await handle.createWritable();
  try {
    await writable.write(data);
    await writable.close();
  } catch (error) {
    await writable.abort?.();
    throw error;
  }
  return { method: 'handle', handle };
}

export async function saveAsBytes(name, bytes, { mime = 'text/plain' } = {}) {
  const picker = globalThis.showSaveFilePicker;
  if (typeof picker !== 'function') throw new Error('当前环境不支持另存为文件选择器');
  const handle = await picker({ suggestedName: name, types: [{ description: mime, accept: { [mime]: [name.includes('.') ? `.${name.split('.').pop()}` : ''] } }] });
  return saveBytes(name, bytes, { handle, mime });
}
