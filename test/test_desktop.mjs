// 桌面程序定向验收。测试数据只在内存中生成，不创建音频/标注夹具或下载文件。
// 运行前 npm install --registry=https://registry.npmmirror.com；然后 npm test。
// 系统需存在 Edge。PLAYWRIGHT_EDGE_EXECUTABLE 可指定非标准安装位置。
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { chromium } from 'playwright';
import * as core from '../web/src/core.js';
import { installTextGridWritableMocks } from './test_file_system_mock.mjs';

const exe = resolve('textgrid-csv-labeler.exe');
const html = await readFile(resolve('ui/textgrid.html'));
const self = spawnSync(exe, ['--self-test'], { encoding: 'utf8' });
assert.equal(self.status, 0, self.stderr);
const extracted = spawnSync(exe, ['--print-html'], { maxBuffer: 2 * 1024 * 1024 });
assert.equal(extracted.status, 0);
assert.equal(Buffer.compare(extracted.stdout, html), 0, 'EXE 内嵌网页必须与发布快照逐字节相同');

const child = spawn(exe, ['--serve', '0'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
let browser;
try {
  const url = await new Promise((accept, reject) => {
    const timer = setTimeout(() => reject(new Error('EXE 启动超时')), 10000);
    child.stdout.once('data', bytes => { clearTimeout(timer); accept(bytes.toString().trim()); });
    child.once('exit', code => reject(new Error('EXE 提前退出：' + code)));
  });
  const response = await fetch(url);
  assert.equal(response.status, 200);
  const pageText = await response.text();
  assert.equal(pageText.replace(/<script id="desktop-lifecycle">[\s\S]*?<\/script>/, ''), html.toString('utf8'));
  assert.equal((await fetch(new URL('/', url))).status, 404);
  assert.equal((await fetch(url, { method: 'POST', body: 'no uploads' })).status, 413);
  assert.equal((await fetch(new URL('desktop/close', url), { method: 'POST' })).status, 403);
  const health = await (await fetch(new URL('health', url))).json();
  assert.equal(health.page_sha256, createHash('sha256').update(html).digest('hex'));

  browser = await chromium.launch({
    executablePath: process.env.PLAYWRIGHT_EDGE_EXECUTABLE || 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    headless: true,
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(url);
  const capability = await page.evaluate(() => ({
    secure: isSecureContext, open: typeof showOpenFilePicker, folder: typeof showDirectoryPicker,
    save: typeof showSaveFilePicker, audio: typeof AudioContext, worker: typeof Worker,
  }));
  assert.equal(capability.secure, true);
  for (const name of ['open', 'folder', 'save', 'audio', 'worker']) assert.equal(capability[name], 'function');

  // 检查明暗按钮和移动布局。像素等同性由本轮现场验收报告另行记录。
  for (const width of [1440, 934, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const theme of ['dark', 'light']) {
      if (await page.locator('html').getAttribute('data-theme') !== theme) await page.locator('#theme-toggle').click();
      await page.waitForTimeout(80);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });

  const count = 16000 * 2.4, wav = Buffer.alloc(44 + count * 2);
  wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVE', 8);
  wav.write('fmt ', 12); wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28);
  wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(count * 2, 40);
  for (let i = 0; i < count; i++) wav.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 220 * i / 16000) * 5000), 44 + i * 2);
  let grid = core.createEmptyGrid(2.4, [{ name: 'phones', kind: 'interval' }]);
  for (const at of [.2, .7, 1.2]) grid = core.insertBoundary(grid, 0, at).grid;
  for (const [i, text] of ['t', 'i', 's', 'a'].entries()) grid = core.setIntervalText(grid, 0, i, text).grid;
  await page.locator('#audio-input').setInputFiles({ name: 'check.wav', mimeType: 'audio/wav', buffer: wav });
  await page.locator('#textgrid-input').setInputFiles({ name: 'check.TextGrid', mimeType: 'text/plain', buffer: Buffer.from(core.serializeTextGrid(grid)) });
  await page.waitForFunction(() => document.querySelector('#compute-status').dataset.state === 'ready' && document.querySelectorAll('.tier-item').length >= 4);
  await page.locator('#csv-input').setInputFiles({ name: 'check.csv', mimeType: 'text/csv',
    buffer: Buffer.from('name,ph_seq,ph_dur,ph_num\ncheck,t i s a,0.2 0.5 0.5 1.2,2 2\n') });
  await page.locator('.csv-toggle').click();
  await page.locator('.csv-session-button').click();
  await page.waitForFunction(() => document.querySelector('#compute-status').dataset.state === 'ready');
  assert.deepEqual(await page.locator('#tier-select option').allTextContents(), ['ph_seq', 'ph_dur', 'ph_num']);
  assert.equal(await page.locator('#linked').isChecked(), true);
  await page.locator('#mode-edit').click();
  await page.locator('#tier-select').selectOption({ label: 'ph_dur' });
  await page.locator('.tier-row.active .tier-item').nth(1).click();
  await page.locator('#annotation-text').fill('0.6');
  await page.locator('#apply').click();
  await page.waitForFunction(() => document.querySelector('#selection-region').hidden);
  assert.equal(Number(await page.locator('#end-time').inputValue()), .8);
  assert.equal(await page.locator('.tier-item.selected').count(), 1);
  await page.locator('#end-time').focus();
  await page.keyboard.press('Control+Space');
  await page.waitForFunction(() => document.querySelector('#play').textContent === 'Ⅱ');
  await page.waitForFunction(() => document.querySelector('#play').textContent === '▶');
  assert.ok(Math.abs(Number.parseFloat(await page.locator('#clock').innerText()) - .2) < .01);

  // 保存测试仅替换系统文件选择器/句柄；业务序列化、全部脏数据合并和无下载路径真实运行。
  // 不声称此处写入用户磁盘，避免测试覆盖用户原始文件。
  await installTextGridWritableMocks(page, ['check.TextGrid', 'check.csv']);
  let downloads = 0;
  page.on('download', () => downloads++);
  await page.locator('#file-list > button.file-card').click();
  await page.waitForFunction(() => document.querySelector('#compute-status').dataset.state === 'ready');
  await page.locator('.tier-row.active .tier-item').nth(1).click();
  await page.locator('#annotation-text').fill('edited-i');
  await page.locator('#apply').click();
  assert.equal(await page.locator('#save-confirm-dialog').isVisible(), false);
  await page.keyboard.press('Control+s');
  await page.locator('#save-confirm-dialog').waitFor({ state: 'visible' });
  await page.locator('#save-confirm-accept').click();
  await page.waitForFunction(() => document.querySelector('#save').disabled);
  const writes = await page.evaluate(() => window.__textgridMockWrites);
  assert.equal(writes.length, 2);
  assert.ok(writes.some(entry => entry.name === 'check.TextGrid' && entry.text.includes('edited-i')));
  assert.ok(writes.some(entry => entry.name === 'check.csv' && entry.text.includes('0.6')));
  assert.equal(downloads, 0);
  assert.equal(errors.length, 0, JSON.stringify(errors));
  console.log('PASS desktop HTTP, exact UI, capabilities, themes, audio/DSP, CSV, duration, Ctrl+Space and save-all');
} finally {
  await browser?.close();
  child.kill();
}
