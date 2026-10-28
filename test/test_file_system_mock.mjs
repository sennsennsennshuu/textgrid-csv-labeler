// 保存回归的浏览器文件系统桩：模拟原文件选择器与可写句柄，不接触真实磁盘。
export async function installTextGridWritableMocks(page, names = []) {
  await page.evaluate((fileNames) => {
    const states = new Map();
    const writes = [];
    const ensure = (name) => {
      if (states.has(name)) return states.get(name);
      let bytes = new Uint8Array();
      const handle = {
        kind: 'file',
        name,
        async getFile() {
          return new File([bytes], name, { type: 'text/plain', lastModified: 1_700_000_000_000 });
        },
        async createWritable() {
          return {
            async write(value) {
              bytes = value instanceof Uint8Array ? value.slice() : new Uint8Array(value);
              const text = new TextDecoder().decode(bytes);
              writes.push({ name, text });
              window.__textgridMockFiles[name] = text;
            },
            async close() {},
            async abort() {},
          };
        },
      };
      states.set(name, handle);
      return handle;
    };
    window.__textgridMockWrites = writes;
    window.__textgridMockFiles = {};
    window.__textgridMockPickerCalls = 0;
    for (const name of fileNames) ensure(name);
    window.showOpenFilePicker = async () => {
      window.__textgridMockPickerCalls++;
      return [...states.values()];
    };
    window.showSaveFilePicker = async (options) => ensure(String(options?.suggestedName || '新标注.TextGrid'));
  }, names);
}

export function readTextGridMockFile(page, name) {
  return page.evaluate(fileName => window.__textgridMockFiles[fileName] || null, name);
}
