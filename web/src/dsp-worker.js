// TextGrid 频谱 Worker 入口；计算逻辑仍由 dsp.js 统一提供。
import { spectrogramJob } from './dsp.js';

/** 处理一条主线程消息，post 用于注入消息发送实现，便于 Node 直接测试。 */
export function handleMessage(data, post) {
  if (!data || data.type !== 'compute') return;
  try {
    const mono = data.mono instanceof Float32Array ? data.mono : new Float32Array(data.mono);
    const job = spectrogramJob(mono, data.sampleRate, data.options || {});
    let lastSent = 0;
    while (true) {
      const step = job.next();
      if (step.done) {
        post({ type: 'done', id: data.id, spec: step.value }, [step.value.data.buffer]);
        return;
      }
      const now = Date.now();
      if (step.value >= 1 || now - lastSent >= 50) {
        post({ type: 'progress', id: data.id, ratio: step.value });
        lastSent = now;
      }
    }
  } catch (error) {
    post({ type: 'error', id: data?.id, message: error instanceof Error ? error.message : 'Worker 计算失败' });
  }
}

if (typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self.postMessage && typeof self.postMessage === 'function') {
  self.onmessage = event => handleMessage(event.data, (message, transfer) => self.postMessage(message, transfer));
}

