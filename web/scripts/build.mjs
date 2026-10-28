// 重建单文件网页；桌面日常构建直接使用 ui/textgrid.html，无需 Node.js。
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import esbuild from 'esbuild';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const source = resolve(root, 'web');
const worker = await esbuild.build({
  entryPoints: [resolve(source, 'src/dsp-worker.js')], bundle: true,
  format: 'iife', platform: 'browser', target: 'es2022', write: false,
});
const app = await esbuild.build({
  entryPoints: [resolve(source, 'src/app.js')], bundle: true,
  format: 'iife', platform: 'browser', target: 'es2022', write: false,
  define: { __TEXTGRID_WORKER_SOURCE__: JSON.stringify(worker.outputFiles[0].text) },
});
const html = (await readFile(resolve(source, 'index.html'), 'utf8'))
  .replace('<!-- APP_STYLE -->', '<style>\n' + await readFile(resolve(source, 'src/style.css'), 'utf8') + '\n</style>')
  .replace('<!-- APP_SCRIPT -->', '<script>\n' + app.outputFiles[0].text.replace(/<\/script/gi, '<\\/script') + '\n</script>');
await mkdir(resolve(root, 'ui'), { recursive: true });
await writeFile(resolve(root, 'ui/textgrid.html'), html, 'utf8');
console.log('Rebuilt ui/textgrid.html; update PAGE_SHA256 in src/main.rs before release.');
