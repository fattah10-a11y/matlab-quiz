// Applies the saved light/dark choice before the page paints. Without a saved
// choice the page follows the operating system setting.
(function () {
  'use strict';
  const KEY = 'mq.theme';
  let saved = null;
  try { saved = localStorage.getItem(KEY); } catch (_) {}
  if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;

  const current = () => document.documentElement.dataset.theme
    || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

  function sync() {
    const dark = current() === 'dark';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#1a1a19' : '#fcfcfb');
    const button = document.getElementById('theme-toggle');
    if (!button) return;
    const label = `Switch to ${dark ? 'light' : 'dark'} mode`;
    button.setAttribute('aria-label', label);
    button.title = label;
    button.textContent = dark ? '☀' : '☾';
  }

  function toggle() {
    const next = current() === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem(KEY, next); } catch (_) {}
    sync();
  }
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('theme-toggle')?.addEventListener('click', toggle);
    sync();
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', sync);
})();
