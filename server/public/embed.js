/* Pinpoint feedback widget. Usage:
 *   <script src="https://your-server/embed.js" data-project="pk_..." defer></script>
 * Optional attributes: data-position (bottom-right|bottom-left|top-right|top-left), data-label, data-color, data-hidden
 * JS API: Pinpoint.open(), Pinpoint.close(), Pinpoint.identify({ name })
 */
(function () {
  'use strict';
  if (window.Pinpoint) return;

  var script = document.currentScript;
  if (!script) return;
  var project = script.getAttribute('data-project');
  var base = new URL(script.src).origin;
  if (!project) { console.warn('[Pinpoint] missing data-project attribute'); return; }

  var position = script.getAttribute('data-position') || 'bottom-right';
  var label = script.getAttribute('data-label') || 'Feedback';
  var color = script.getAttribute('data-color') || '#2563eb';
  var hiddenButton = script.hasAttribute('data-hidden') && new URLSearchParams(location.search).get('feedback') !== '1';
  var NAME_KEY = 'pinpoint:name';
  var HOST_ID = 'pinpoint-host';
  var MIN_SIZE = 12;

  var css = '\
:host{all:initial}\
*{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}\
.btn{position:fixed;z-index:2147483646;padding:10px 16px;border:0;border-radius:999px;background:' + color + ';color:#fff;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.25)}\
.btn:hover{filter:brightness(1.1)}\
.btn.bottom-right{right:20px;bottom:20px}.btn.bottom-left{left:20px;bottom:20px}.btn.top-right{right:20px;top:20px}.btn.top-left{left:20px;top:20px}\
.overlay{position:fixed;inset:0;z-index:2147483647;cursor:crosshair;background:rgba(0,0,0,.35);user-select:none;-webkit-user-select:none}\
.overlay.drawn{cursor:default}\
.hint{position:fixed;top:14px;left:50%;transform:translateX(-50%);background:#111;color:#fff;padding:8px 14px;border-radius:8px;font-size:13px;pointer-events:none;z-index:2147483647}\
.rect{position:fixed;border:2px solid #ef4444;background:transparent;box-shadow:0 0 0 9999px rgba(0,0,0,.35);pointer-events:none;z-index:2147483647}\
.form{position:fixed;z-index:2147483647;width:300px;background:#fff;color:#111;border-radius:12px;padding:14px;box-shadow:0 10px 40px rgba(0,0,0,.35);cursor:default}\
.form label{display:block;font-size:12px;font-weight:600;margin:0 0 4px;color:#444}\
.form textarea,.form input{width:100%;border:1px solid #cbd5e1;border-radius:8px;padding:8px;font-size:14px;color:#111;background:#fff;margin-bottom:10px}\
.form textarea{height:84px;resize:vertical}\
.form textarea:focus,.form input:focus{outline:2px solid ' + color + ';border-color:transparent}\
.row{display:flex;gap:8px;justify-content:flex-end;align-items:center}\
.row button{border:0;border-radius:8px;padding:8px 14px;font-size:14px;font-weight:600;cursor:pointer}\
.send{background:' + color + ';color:#fff}.send[disabled]{opacity:.6;cursor:default}\
.cancel{background:#e2e8f0;color:#111}\
.msg{font-size:12px;margin-right:auto;color:#b91c1c}\
.toast{position:fixed;z-index:2147483647;left:50%;bottom:28px;transform:translateX(-50%);background:#111;color:#fff;padding:10px 16px;border-radius:10px;font-size:14px}\
.hp{position:absolute;left:-9999px;width:1px;height:1px;opacity:0}';

  var host, root, btn, overlay;
  var state = null; // { rect, shot (promise), meta }
  var knownName = '';
  try { knownName = localStorage.getItem(NAME_KEY) || ''; } catch (e) {}

  function el(tag, props, children) {
    var n = document.createElement(tag);
    for (var k in props || {}) {
      if (k === 'class') n.className = props[k];
      else if (k === 'text') n.textContent = props[k];
      else n.setAttribute(k, props[k]);
    }
    (children || []).forEach(function (c) { n.appendChild(c); });
    return n;
  }

  function mount() {
    host = document.createElement('div');
    host.id = HOST_ID;
    host.setAttribute('data-html2canvas-ignore', 'true');
    root = host.attachShadow({ mode: 'open' });
    root.appendChild(el('style', { text: css }));
    btn = el('button', { class: 'btn ' + position, type: 'button', text: label, 'aria-label': 'Leave feedback' });
    btn.addEventListener('click', open);
    if (!hiddenButton) root.appendChild(btn);
    document.body.appendChild(host);
  }

  // ---- screenshot ----
  var libPromise;
  function loadLib() {
    if (window.htmlToImage) return Promise.resolve();
    if (!libPromise) libPromise = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = base + '/vendor/html-to-image.js';
      s.onload = resolve;
      s.onerror = function () { libPromise = null; reject(new Error('screenshot library failed to load')); };
      document.head.appendChild(s);
    });
    return libPromise;
  }

  function hasWebFonts() {
    try {
      for (var i = 0; i < document.styleSheets.length; i++) {
        var rules;
        try { rules = document.styleSheets[i].cssRules; } catch (e) { return true; } // cross-origin sheet: may hold fonts
        for (var j = 0; j < rules.length; j++) if (rules[j].type === 5) return true; // CSSFontFaceRule
      }
    } catch (e) {}
    return false;
  }

  function withTimeout(p, ms) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { reject(new Error('timeout')); }, ms);
      p.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
    });
  }

  // The rendered copy has no scrolling, so a position:sticky element would sit at its natural spot
  // instead of where it is stuck. For the duration of the capture, turn each into position:relative with the
  // same visual offset. The page does not visibly change. (position:fixed needs no help: the copy is shifted
  // with margins, which leave fixed elements anchored to the viewport.)
  function freezeSticky() {
    var all = document.body.querySelectorAll('*');
    var items = [];
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.id !== HOST_ID && getComputedStyle(el).position === 'sticky') items.push({ el: el, rect: el.getBoundingClientRect() });
    }
    items.forEach(function (it) {
      var st = it.el.style;
      it.saved = [st.position, st.top, st.left];
      st.position = 'static';
      var natural = it.el.getBoundingClientRect();
      it.dx = it.rect.left - natural.left; it.dy = it.rect.top - natural.top;
    });
    items.forEach(function (it) {
      var st = it.el.style;
      st.position = 'relative'; st.top = it.dy + 'px'; st.left = it.dx + 'px';
    });
    var restored = false;
    return function restore() {
      if (restored) return;
      restored = true;
      items.forEach(function (it) {
        var st = it.el.style;
        st.position = it.saved[0]; st.top = it.saved[1]; st.left = it.saved[2];
      });
    };
  }

  function capture(rect) {
    // Viewport snapshot taken the moment the area is chosen, so it matches what the reviewer saw.
    var vw = window.innerWidth, vh = window.innerHeight;
    var sx = window.scrollX, sy = window.scrollY;
    var de = document.documentElement;
    function render(skipFonts) {
      return window.htmlToImage.toCanvas(de, {
        pixelRatio: Math.min(window.devicePixelRatio || 1, 2),
        width: vw, height: vh, canvasWidth: vw, canvasHeight: vh,
        cacheBust: false, skipFonts: skipFonts,
        filter: function (n) { return n.id !== HOST_ID; },
        // Shift with margins, not a transform: a transform would turn position:fixed children
        // into children of the root and push them out of view.
        style: {
          position: 'relative', // makes the root the containing block for unpositioned-ancestor absolutes
          margin: (-sy) + 'px 0 0 ' + (-sx) + 'px',
          width: Math.max(de.scrollWidth, vw) + 'px',
          height: Math.max(de.scrollHeight, vh) + 'px'
        }
      });
    }
    var restore = null;
    return loadLib().then(function () {
      restore = freezeSticky(); // held for the whole capture, including the font fallback
      // Embedding web fonts can stall on some pages: try it with a timeout, then fall back to system fonts.
      if (!hasWebFonts()) return render(true);
      return withTimeout(render(false), 4000).catch(function () { return render(true); });
    }).then(function (canvas) {
      restore();
      var k = canvas.width / vw;
      // full viewport with the highlight drawn on it
      var full = document.createElement('canvas');
      full.width = canvas.width; full.height = canvas.height;
      var ctx = full.getContext('2d');
      ctx.drawImage(canvas, 0, 0);
      ctx.strokeStyle = '#ef4444';
      ctx.lineWidth = 3 * k;
      ctx.strokeRect(rect.x * k, rect.y * k, rect.w * k, rect.h * k);
      // close-up of the region with some context around it
      var pad = 24;
      var cx = Math.max(0, rect.x - pad), cy = Math.max(0, rect.y - pad);
      var cw = Math.min(vw - cx, rect.w + pad * 2), ch = Math.min(vh - cy, rect.h + pad * 2);
      var crop = document.createElement('canvas');
      crop.width = Math.round(cw * k); crop.height = Math.round(ch * k);
      var cctx = crop.getContext('2d');
      cctx.drawImage(canvas, cx * k, cy * k, cw * k, ch * k, 0, 0, crop.width, crop.height);
      cctx.strokeStyle = '#ef4444'; cctx.lineWidth = 3 * k;
      cctx.strokeRect((rect.x - cx) * k, (rect.y - cy) * k, rect.w * k, rect.h * k);
      return { full: full.toDataURL('image/jpeg', 0.85), crop: crop.toDataURL('image/png') };
    }).catch(function (e) {
      if (restore) restore(); // never leave the page altered if capture fails
      throw e;
    });
  }

  // ---- element description ----
  function describe(rect) {
    var x = rect.x + rect.w / 2, y = rect.y + rect.h / 2;
    var e = document.elementsFromPoint(x, y).filter(function (n) { return n.id !== HOST_ID; })[0];
    if (!e) return '';
    var parts = [];
    while (e && e.nodeType === 1 && e !== document.documentElement && parts.length < 5) {
      var p = e.tagName.toLowerCase();
      if (e.id) { parts.unshift(p + '#' + e.id); break; }
      var cls = (e.getAttribute('class') || '').trim().split(/\s+/).filter(Boolean).slice(0, 2);
      if (cls.length) p += '.' + cls.join('.');
      parts.unshift(p);
      e = e.parentElement;
    }
    return parts.join(' > ');
  }

  // ---- capture flow ----
  function open() {
    if (overlay) return;
    state = null;
    overlay = el('div', { class: 'overlay' });
    var hint = el('div', { class: 'hint', text: 'Drag to highlight an area · Esc to cancel' });
    root.appendChild(overlay);
    root.appendChild(hint);
    btn.style.display = 'none';
    document.addEventListener('keydown', onKey, true);

    var start = null, rectEl = null;
    overlay.addEventListener('pointerdown', function (ev) {
      if (state) return;
      start = { x: ev.clientX, y: ev.clientY };
      overlay.style.background = 'transparent';
      rectEl = el('div', { class: 'rect' });
      root.appendChild(rectEl);
      try { overlay.setPointerCapture(ev.pointerId); } catch (e) {}
      ev.preventDefault();
    });
    overlay.addEventListener('pointermove', function (ev) {
      if (!start || state) return;
      setRect(rectEl, norm(start, ev));
    });
    overlay.addEventListener('pointerup', function (ev) {
      if (!start || state) return;
      var r = norm(start, ev);
      start = null;
      if (r.w < MIN_SIZE || r.h < MIN_SIZE) { rectEl.remove(); rectEl = null; overlay.style.background = ''; return; }
      setRect(rectEl, r);
      overlay.classList.add('drawn');
      hint.remove();
      choose(r, rectEl);
    });
    function done() { hint.remove(); }
    overlay._cleanup = function () { done(); if (rectEl) rectEl.remove(); };
  }

  function norm(a, b) {
    var x = Math.max(0, Math.min(a.x, b.clientX)), y = Math.max(0, Math.min(a.y, b.clientY));
    var x2 = Math.min(window.innerWidth, Math.max(a.x, b.clientX)), y2 = Math.min(window.innerHeight, Math.max(a.y, b.clientY));
    return { x: x, y: y, w: x2 - x, h: y2 - y };
  }
  function setRect(n, r) {
    n.style.left = r.x + 'px'; n.style.top = r.y + 'px'; n.style.width = r.w + 'px'; n.style.height = r.h + 'px';
  }

  function choose(rect, rectEl) {
    var meta = {
      url: location.href, title: document.title, region: rect,
      scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
      viewport: { w: window.innerWidth, h: window.innerHeight },
      selector: describe(rect)
    };
    // overlay dim is drawn by .rect's box-shadow now; the overlay itself becomes transparent
    overlay.style.background = 'transparent';
    var shot = capture(rect).then(function (s) { return { ok: true, s: s }; }, function (e) { console.warn('[Pinpoint] screenshot failed', e); return { ok: false }; });
    state = { rect: rect, meta: meta, shot: shot };
    showForm(rect);
  }

  function showForm(rect) {
    var comment = el('textarea', { placeholder: 'What should we know about this area?', 'aria-label': 'Comment', maxlength: '5000' });
    var name = el('input', { type: 'text', placeholder: 'Your name', 'aria-label': 'Your name', maxlength: '100' });
    name.value = knownName;
    var hp = el('input', { class: 'hp', name: 'website', tabindex: '-1', autocomplete: 'off', 'aria-hidden': 'true' });
    var msg = el('span', { class: 'msg' });
    var send = el('button', { class: 'send', type: 'button', text: 'Send' });
    var cancel = el('button', { class: 'cancel', type: 'button', text: 'Cancel' });
    var form = el('div', { class: 'form', role: 'dialog', 'aria-label': 'Send feedback' }, [
      el('label', { text: 'Comment' }), comment,
      el('label', { text: 'Your name' }), name, hp,
      el('div', { class: 'row' }, [msg, cancel, send])
    ]);
    root.appendChild(form);
    // place below the highlight if it fits, else above, else inside the viewport edge
    var fw = 300, fh = form.offsetHeight || 230;
    var left = Math.min(Math.max(8, rect.x), window.innerWidth - fw - 8);
    var top = rect.y + rect.h + 10;
    if (top + fh > window.innerHeight - 8) top = rect.y - fh - 10;
    if (top < 8) top = Math.max(8, window.innerHeight - fh - 8);
    form.style.left = left + 'px'; form.style.top = top + 'px';
    (knownName ? comment : name).focus();

    cancel.addEventListener('click', close);
    send.addEventListener('click', function () {
      var c = comment.value.trim(), n = name.value.trim();
      if (!c) { msg.textContent = 'Please add a comment.'; comment.focus(); return; }
      if (!n) { msg.textContent = 'Please add your name.'; name.focus(); return; }
      msg.textContent = '';
      send.disabled = true; send.textContent = 'Sending…';
      knownName = n;
      try { localStorage.setItem(NAME_KEY, n); } catch (e) {}
      submit(c, n, hp.value).then(function () {
        close();
        toast('Thanks! Your feedback was sent.');
      }, function (e) {
        send.disabled = false; send.textContent = 'Send';
        msg.textContent = e.message || 'Could not send. Try again.';
      });
    });
    form.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) send.click();
    });
  }

  function submit(comment, name, honeypot) {
    return state.shot.then(function (r) {
      var meta = state.meta;
      if (!r.ok) meta = Object.assign({}, meta, { screenshot_failed: true });
      var body = { project: project, name: name, comment: comment, website: honeypot, meta: meta, screenshot: r.ok ? r.s : {} };
      // text/plain keeps this a "simple" CORS request, so no preflight is needed
      return fetch(base + '/api/feedback', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify(body) });
    }).then(function (res) {
      if (res.ok) return;
      return res.json().catch(function () { return {}; }).then(function (j) { throw new Error(j.error || 'Server error ' + res.status); });
    }, function (e) {
      if (e instanceof TypeError) throw new Error('Could not reach the feedback server.');
      throw e;
    });
  }

  function toast(text) {
    var t = el('div', { class: 'toast', text: text });
    root.appendChild(t);
    setTimeout(function () { t.remove(); }, 3000);
  }

  function onKey(ev) { if (ev.key === 'Escape') { ev.stopPropagation(); close(); } }

  function close() {
    document.removeEventListener('keydown', onKey, true);
    if (!overlay) return;
    overlay._cleanup && overlay._cleanup();
    ['.overlay', '.rect', '.hint', '.form'].forEach(function (s) {
      root.querySelectorAll(s).forEach(function (n) { n.remove(); });
    });
    overlay = null; state = null;
    if (!hiddenButton) btn.style.display = '';
  }

  window.Pinpoint = {
    open: open,
    close: close,
    identify: function (u) { if (u && u.name) { knownName = String(u.name); } }
  };

  if (document.body) mount();
  else document.addEventListener('DOMContentLoaded', mount);
})();
