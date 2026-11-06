// Desktop-only pages (3D labs, editors) on a phone (2026-11-04): first thing in <head>, stops the page from loading
// its heavy scripts and models (several MB) and shows a short notice instead (the rest of the page is turned into
// unparsed text, so none of its scripts, styles or images load). "Open anyway" reloads with ?full=1.
(function () {
  if (/[?&]full=1/.test(location.search)) return;
  if (!matchMedia('(max-width:700px),(pointer:coarse) and (max-height:500px)').matches) return;
  document.write('<plaintext style="display:none">'); // window.stop() left Chrome without a first paint
  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); };
  var title = (document.title || 'This page').split(' — ')[0];
  var full = location.pathname + (location.search ? location.search + '&' : '?') + 'full=1' + location.hash;
  function show() {
    document.documentElement.style.background = '#050b18';
    document.body.innerHTML = '<div style="box-sizing:border-box;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px 16px;font-family:Inter,system-ui,sans-serif;color:#e8eef7">'
      + '<div style="max-width:360px;text-align:center;background:rgba(10,16,28,.9);border:1px solid rgba(255,255,255,.1);border-radius:18px;padding:26px 20px">'
      + '<div style="font-size:40px;line-height:1">🖥️</div>'
      + '<h1 style="font-size:20px;margin:12px 0 8px">' + esc(title) + '</h1>'
      + '<p style="color:#aab6c6;font-size:14px;line-height:1.55;margin:0 0 18px">This page is made for a computer. On a phone it downloads several MB and runs slowly.</p>'
      + '<a href="/" style="display:block;padding:12px;border-radius:999px;background:#2f6fe0;color:#fff;font-weight:800;text-decoration:none;margin-bottom:10px">← Back to TeamStats.pro</a>'
      + '<a href="' + esc(full) + '" style="color:#8fb4ff;font-size:13px">Open anyway</a></div></div>';
  }
  document.addEventListener('DOMContentLoaded', show);
})();
