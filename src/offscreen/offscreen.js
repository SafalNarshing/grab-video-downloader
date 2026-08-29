/**
 * Grab — offscreen host for the stream assembler.
 *
 * Chrome's service worker has no DOM, so Blob building and DOMParser have to
 * happen inside a document. This file is only the message shim; the work lives
 * in lib/streams.js, which Firefox's background page calls directly because it
 * has no offscreen API and does not need one.
 */

import { assemble, cancel, variants } from '../lib/streams.js';

const onProgress = (jobId, phase, extra) =>
  chrome.runtime.sendMessage({ type: 'progress', jobId, phase, ...extra }).catch(() => {});

const onAssembled = (msg) => chrome.runtime.sendMessage({ type: 'assembled', ...msg });

const handlers = {
  variants: (msg) => variants(msg),

  async assemble(msg) {
    assemble(msg, { onProgress, onAssembled }).catch((e) => {
      const err = String(e?.message || e);
      onProgress(msg.jobId, err === 'cancelled' ? 'cancelled' : 'error', { error: err });
    });
    return { started: true };
  },

  async cancel({ jobId }) {
    cancel(jobId);
    return {};
  },
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return;
  const handler = handlers[msg.type];
  if (!handler) return;

  Promise.resolve(handler(msg)).then(sendResponse, (e) => sendResponse({ error: String(e?.message || e) }));
  return true; // async response
});
