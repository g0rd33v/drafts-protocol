// drafts-launch.js — honest handlers for the two-column connect UI.
(function () {
  function ready(fn) {
    if (document.readyState !== 'loading') fn();
    else document.addEventListener('DOMContentLoaded', fn);
  }

  function toast(msg, kind) {
    var t = document.createElement('div');
    t.className = 'toast toast-' + (kind || 'ok');
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(function () { t.classList.add('show'); }, 10);
    setTimeout(function () { t.classList.remove('show'); setTimeout(function () { t.remove(); }, 300); }, 2500);
  }

  function copyText(text) {
    // Try modern clipboard API first
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () { toast('URL copied ✨ paste in your Claude chat'); },
        function () { fallbackCopy(text); }
      );
      return;
    }
    fallbackCopy(text);
  }

  function fallbackCopy(text) {
    var ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.left = '0';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    var ok = false;
    try { ok = document.execCommand('copy'); } catch (e) {}
    ta.remove();
    if (ok) toast('URL copied ✨ paste in your Claude chat');
    else toast('Copy failed — select the URL in the address bar and copy manually', 'err');
  }

  ready(function () {
    var copyBtn = document.getElementById('copyUrlBtn');
    if (copyBtn) {
      copyBtn.addEventListener('click', function () {
        copyText(location.href);
      });
    }
  });
})();
