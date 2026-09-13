/* ==========================================================================
   ShincChat — landing page interactions
   No dependencies. Everything degrades gracefully without JS, and every
   animation is disabled when the visitor asks for reduced motion.
   ========================================================================== */
(function () {
  'use strict';

  /* ---------------------------------------------------------------- config
     Point APP_URL at the live app (e.g. "https://shincchat.com/chat" or
     "/chat" when the landing page is served by the app itself).
     While it is empty, every [data-app-link] CTA opens the on-page
     instant-match preview instead of navigating anywhere.            */
  var APP_URL = '';

  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  var isReduced = function () { return reduce.matches; };
  var fine = window.matchMedia('(hover: hover) and (pointer: fine)');

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var $$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  function el(tag, cls, html) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (html != null) node.innerHTML = html;
    return node;
  }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }
  function fmt(n) { return n.toLocaleString('en-US'); }

  /* ------------------------------------------------------------------ toast */
  var toastEl = $('#toast');
  var toastTimer;
  function toast(msg, ms) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.hidden = false;
    requestAnimationFrame(function () { toastEl.classList.add('is-on'); });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      toastEl.classList.remove('is-on');
      setTimeout(function () { toastEl.hidden = true; }, 400);
    }, ms || 3200);
  }

  /* ------------------------------------------------------- app link routing */
  var appLinks = $$('[data-app-link]');
  if (APP_URL) {
    appLinks.forEach(function (a) { a.setAttribute('href', APP_URL); });
  } else {
    appLinks.forEach(function (a) {
      a.addEventListener('click', function (e) {
        e.preventDefault();
        openDemo();
      });
    });
  }

  /* ------------------------------------------------------------- 06 navbar */
  var nav = $('#nav');
  var progress = $('#scrollProgress');
  var toTop = $('#toTop');
  var ticking = false;

  function onScroll() {
    var y = window.scrollY || window.pageYOffset;
    var doc = document.documentElement;
    var max = doc.scrollHeight - window.innerHeight;
    if (nav) nav.classList.toggle('is-scrolled', y > 10);
    if (progress) progress.style.width = (max > 0 ? clamp(y / max, 0, 1) * 100 : 0) + '%';
    if (toTop) {
      var show = y > 700;
      if (show === toTop.hidden) { toTop.hidden = !show; }
    }
    ticking = false;
  }
  window.addEventListener('scroll', function () {
    if (!ticking) { ticking = true; requestAnimationFrame(onScroll); }
  }, { passive: true });
  onScroll();

  if (toTop) {
    toTop.addEventListener('click', function () {
      window.scrollTo({ top: 0, behavior: isReduced() ? 'auto' : 'smooth' });
    });
  }

  /* ------------------------------------- gentle parallax on floating cards */
  var floaters = $$('[data-float]');
  if (floaters.length && fine.matches) {
    var fTick = false;
    window.addEventListener('scroll', function () {
      if (fTick || isReduced()) return;
      fTick = true;
      requestAnimationFrame(function () {
        fTick = false;
        var y = window.scrollY || 0;
        floaters.forEach(function (node, i) {
          var depth = (i % 3) + 1;
          node.style.translate = '0 ' + (y * 0.012 * depth).toFixed(2) + 'px';
        });
      });
    }, { passive: true });
  }

  /* ------------------------------------------------------ mobile nav sheet */
  var burger = $('#burger');
  var sheet = $('#mobileMenu');
  var lastSheetFocus = null;

  $$('#mobileMenu [data-menu-link]').forEach(function (a, i) { a.style.setProperty('--n', i); });

  function openSheet() {
    if (!sheet || !burger) return;
    lastSheetFocus = document.activeElement;
    sheet.hidden = false;
    document.body.classList.add('is-locked');
    burger.setAttribute('aria-expanded', 'true');
    burger.setAttribute('aria-label', 'Close menu');
    var first = $('#mobileMenu a');
    if (first) setTimeout(function () { first.focus(); }, 60);
  }
  function closeSheet() {
    if (!sheet || !burger) return;
    sheet.hidden = true;
    document.body.classList.remove('is-locked');
    burger.setAttribute('aria-expanded', 'false');
    burger.setAttribute('aria-label', 'Open menu');
    if (lastSheetFocus && lastSheetFocus.focus) lastSheetFocus.focus();
  }
  if (burger) {
    burger.addEventListener('click', function () {
      burger.getAttribute('aria-expanded') === 'true' ? closeSheet() : openSheet();
    });
  }
  $$('[data-close-menu]').forEach(function (n) { n.addEventListener('click', closeSheet); });
  $$('[data-menu-link]').forEach(function (n) { n.addEventListener('click', closeSheet); });
  document.addEventListener('keydown', function (e) {
    if (!sheet || sheet.hidden) return;
    if (e.key === 'Escape') { closeSheet(); return; }
    if (e.key !== 'Tab') return;
    /* keep focus cycling inside the open sheet (plus its toggle) */
    var items = [burger].concat($$('#mobileMenu a, #mobileMenu button')).filter(Boolean);
    var i = items.indexOf(document.activeElement);
    if (e.shiftKey) {
      if (i <= 0) { e.preventDefault(); items[items.length - 1].focus(); }
    } else if (i === items.length - 1) {
      e.preventDefault();
      items[0].focus();
    }
  });
  window.addEventListener('resize', function () {
    if (window.innerWidth >= 1024 && sheet && !sheet.hidden) closeSheet();
  });

  /* ------------------------------------------------- active nav highlight */
  var navLinks = $$('[data-navlink]');
  if ('IntersectionObserver' in window && navLinks.length) {
    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (!entry.isIntersecting) return;
        navLinks.forEach(function (l) {
          l.classList.toggle('is-active', l.getAttribute('href') === '#' + entry.target.id);
        });
      });
    }, { rootMargin: '-45% 0px -50% 0px', threshold: 0 });
    navLinks.forEach(function (l) {
      var sec = $(l.getAttribute('href'));
      if (sec) spy.observe(sec);
    });
  }

  /* ---------------------------------------------------- 20 reveal + stagger */
  $$('[data-stagger]').forEach(function (group) {
    $$('[data-reveal]', group).forEach(function (child, i) {
      if (!child.style.getPropertyValue('--d')) child.style.setProperty('--d', (i * 90) + 'ms');
    });
  });

  var revealables = $$('[data-reveal]');
  if ('IntersectionObserver' in window) {
    var revealer = new IntersectionObserver(function (entries) {
      entries.forEach(function (entry) {
        if (entry.isIntersecting) {
          entry.target.classList.add('in');
          revealer.unobserve(entry.target);
        }
      });
    }, { rootMargin: '0px 0px -7% 0px', threshold: 0.1 });
    revealables.forEach(function (n) { revealer.observe(n); });
  } else {
    revealables.forEach(function (n) { n.classList.add('in'); });
  }

  /* ---------------------------------------------------------- counters */
  function animateCount(node) {
    var target = parseFloat(node.getAttribute('data-count'));
    var decimals = parseInt(node.getAttribute('data-decimals') || '0', 10);
    if (isNaN(target)) return;
    if (isReduced()) { node.textContent = target.toFixed(decimals); return; }
    var dur = 1500, start = performance.now();
    (function step(now) {
      var p = clamp((now - start) / dur, 0, 1);
      var eased = 1 - Math.pow(1 - p, 4);
      node.textContent = (target * eased).toFixed(decimals);
      if (p < 1) requestAnimationFrame(step);
      else node.textContent = target.toFixed(decimals);
    })(start);
  }
  var counters = $$('[data-count]');
  if ('IntersectionObserver' in window) {
    var cObs = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { animateCount(e.target); cObs.unobserve(e.target); }
      });
    }, { threshold: 0.4 });
    counters.forEach(function (n) { cObs.observe(n); });
  } else {
    counters.forEach(animateCount);
  }

  /* ------------------------------------------------- live "online" numbers */
  var onlineNodes = $$('[data-online]');
  var onlineBase = onlineNodes.length ? parseInt(onlineNodes[0].getAttribute('data-online'), 10) : 12483;
  function paintOnline() {
    onlineBase = clamp(onlineBase + Math.round((Math.random() - 0.46) * 46), 11800, 13600);
    onlineNodes.forEach(function (n) { n.textContent = fmt(onlineBase); });
  }
  onlineNodes.forEach(function (n) { n.textContent = fmt(onlineBase); });
  setInterval(paintOnline, 4200);

  /* --------------------------------------------- spotlight + tilt + magnet */
  if (fine.matches) {
    $$('.spot').forEach(function (card) {
      card.addEventListener('pointermove', function (e) {
        var r = card.getBoundingClientRect();
        card.style.setProperty('--mx', ((e.clientX - r.left) / r.width * 100) + '%');
        card.style.setProperty('--my', ((e.clientY - r.top) / r.height * 100) + '%');
      }, { passive: true });
    });

    $$('[data-tilt]').forEach(function (node) {
      var raf = 0;
      node.addEventListener('pointermove', function (e) {
        if (isReduced()) return;
        if (raf) return;
        raf = requestAnimationFrame(function () {
          raf = 0;
          var r = node.getBoundingClientRect();
          var px = (e.clientX - r.left) / r.width - 0.5;
          var py = (e.clientY - r.top) / r.height - 0.5;
          var target = node.firstElementChild || node;
          target.style.transform = 'perspective(1200px) rotateX(' + (-py * 5).toFixed(2) + 'deg) rotateY(' + (px * 6).toFixed(2) + 'deg) translateY(-3px)';
        });
      }, { passive: true });
      node.addEventListener('pointerleave', function () {
        var target = node.firstElementChild || node;
        target.style.transform = '';
      });
    });

    $$('.btn--magnetic').forEach(function (btn) {
      btn.addEventListener('pointermove', function (e) {
        if (isReduced()) return;
        var r = btn.getBoundingClientRect();
        var x = (e.clientX - r.left - r.width / 2) / r.width;
        var y = (e.clientY - r.top - r.height / 2) / r.height;
        btn.style.transform = 'translate(' + (x * 9).toFixed(2) + 'px,' + (y * 6).toFixed(2) + 'px)';
      }, { passive: true });
      btn.addEventListener('pointerleave', function () { btn.style.transform = ''; });
    });
  }

  /* ----------------------------------------------------------- marquee loop */
  $$('[data-marquee]').forEach(function (track) {
    track.innerHTML += track.innerHTML; /* two identical halves => seamless -50% */
  });

  /* ------------------------------------------------------- generated visuals */
  function bars(host, count, min, max, cls) {
    if (!host) return;
    var frag = document.createDocumentFragment();
    for (var i = 0; i < count; i++) {
      var b = document.createElement('i');
      b.style.setProperty('--h', Math.round(min + Math.random() * (max - min)));
      b.style.setProperty('--i', i);
      frag.appendChild(b);
    }
    host.appendChild(frag);
  }
  bars($('#waveform'), 34, 18, 100);
  bars($('#callWave'), 26, 20, 100);
  $$('.vn__wave').forEach(function (w) { bars(w, 12, 25, 100); });

  /* ------------------------------------------------ 07 hero chat simulation */
  var chatLog = $('#chatLog');
  var composerGhost = $('#composerGhost');
  var composerMic = $('.composer__mic');
  var mockName = $('#mockName');
  var mockSub = $('#mockSub');
  var chatToken = { run: 0 };

  var scripts = [
    {
      who: 'Stranger · Lisbon',
      sub: 'Matched in 4.2s · text mode',
      sys: 'Matched in 4.2s · Lisbon, Portugal',
      clock: 21 * 60 + 4,
      lines: [
        { from: 'them', text: 'ok be honest — what\u2019s the most useless thing you know?' },
        { from: 'me', text: 'Wombats have cube-shaped poop. That\u2019s my whole personality.' },
        { from: 'them', text: 'that is incredible. I\u2019m Ana, by the way' },
        { from: 'me', voice: 11 },
        { from: 'them', text: 'a voice note! ok this just got 10x more real' }
      ]
    },
    {
      who: 'Stranger · Osaka',
      sub: 'Matched in 3.1s · text mode',
      sys: 'Matched in 3.1s · Osaka, Japan',
      clock: 23 * 60 + 41,
      lines: [
        { from: 'them', text: 'deep question or random question?' },
        { from: 'me', text: 'Deep. It\u2019s late here and I\u2019m feeling brave.' },
        { from: 'them', text: 'what\u2019s something you\u2019ve never said out loud?' },
        { from: 'me', text: 'That I like talking to strangers more than people I know.' },
        { from: 'them', text: '\u2026same. hi, I\u2019m Kenji' }
      ]
    }
  ];
  scripts.forEach(function (s) { s.startClock = s.clock; });

  function stamp(mins) {
    var h = Math.floor(mins / 60) % 24;
    var m = mins % 60;
    return (h < 10 ? '0' : '') + h + ':' + (m < 10 ? '0' : '') + m;
  }

  function addBubble(script, line, run) {
    if (!chatLog) return null;
    var msg;
    if (line.voice) {
      msg = el('div', 'msg msg--me msg--voice');
      msg.appendChild(el('span', 'vn-play', '<svg class="ic" aria-hidden="true"><use href="#i-play"/></svg>'));
      var wave = el('span', 'vn-wave');
      for (var i = 0; i < 14; i++) {
        var b = document.createElement('i');
        b.style.setProperty('--h', Math.round(25 + Math.random() * 75));
        b.style.setProperty('--i', i);
        b.style.height = b.style.getPropertyValue('--h') + '%';
        wave.appendChild(b);
      }
      msg.appendChild(wave);
      msg.appendChild(el('span', 'vn-time', '0:' + (line.voice < 10 ? '0' : '') + line.voice));
    } else {
      msg = el('div', 'msg msg--' + (line.from === 'me' ? 'me' : 'them'));
      msg.appendChild(el('p', null, line.text));
    }
    msg.appendChild(el('span', 'msg__time', stamp(script.clock++)));
    chatLog.appendChild(msg);
    chatLog.scrollTop = chatLog.scrollHeight;
    return msg;
  }

  function typingDots() {
    if (!chatLog) return null;
    var d = el('div', 'dots', '<i></i><i></i><i></i>');
    chatLog.appendChild(d);
    chatLog.scrollTop = chatLog.scrollHeight;
    return d;
  }

  function typeIntoComposer(text) {
    return new Promise(function (resolve) {
      if (!composerGhost || isReduced()) {
        if (composerGhost) { composerGhost.textContent = text; composerGhost.classList.add('is-typed'); }
        return resolve();
      }
      composerGhost.classList.add('is-typed');
      var i = 0;
      (function tick() {
        composerGhost.textContent = text.slice(0, ++i);
        if (i < text.length) setTimeout(tick, 22 + Math.random() * 34);
        else resolve();
      })();
    });
  }

  async function playScript(index, run) {
    var script = scripts[index % scripts.length];
    if (!chatLog) return;
    chatLog.innerHTML = '';
    if (mockName) mockName.textContent = script.who;
    if (mockSub) mockSub.textContent = script.sub;
    chatLog.appendChild(el('p', 'sysmsg', script.sys));
    script.clock = script.startClock;
    if (composerGhost) { composerGhost.textContent = 'Say something better than \u201chi\u201d\u2026'; composerGhost.classList.remove('is-typed'); }

    for (var i = 0; i < script.lines.length; i++) {
      if (chatToken.run !== run) return;
      while (document.hidden) { await wait(400); if (chatToken.run !== run) return; }
      var line = script.lines[i];

      if (line.from === 'me') {
        if (!line.voice) await typeIntoComposer(line.text);
        else if (composerMic) { composerMic.classList.add('is-hold'); }
        await wait(isReduced() ? 60 : 420);
        if (composerGhost) { composerGhost.textContent = 'Say something better than \u201chi\u201d\u2026'; composerGhost.classList.remove('is-typed'); }
        if (composerMic) composerMic.classList.remove('is-hold');
        addBubble(script, line, run);
        await wait(isReduced() ? 80 : 620);
      } else {
        var dots = typingDots();
        await wait(isReduced() ? 120 : 1050 + Math.random() * 550);
        if (chatToken.run !== run) return;
        if (dots && dots.parentNode) dots.parentNode.removeChild(dots);
        addBubble(script, line, run);
        await wait(isReduced() ? 80 : 760);
      }
    }
    if (chatToken.run !== run) return;
    await wait(isReduced() ? 600 : 4200);
    if (chatToken.run !== run) return;
    playScript(index + 1, run);
  }

  function startChatLoop() {
    if (!chatLog) return;
    chatToken.run += 1;
    playScript(0, chatToken.run);
  }

  /* ---------------------------------------------------- hero mock: modes */
  var mockText = $('#mockText');
  var mockVideo = $('#mockVideo');
  var vidTime = $('#vidTime');
  var vidSeconds = 12;
  var vidTicker = null;

  function setMode(mode) {
    $$('.seg__btn').forEach(function (b) {
      var on = b.getAttribute('data-mode') === mode;
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    var toVideo = mode === 'video';
    if (mockText) mockText.hidden = toVideo;
    if (mockVideo) mockVideo.hidden = !toVideo;
    if (toVideo) {
      if (mockSub) mockSub.textContent = 'Live video · both sides agreed';
      if (mockName) mockName.textContent = 'Stranger · Lisbon';
      if (!vidTicker && !isReduced()) {
        vidTicker = setInterval(function () {
          vidSeconds++;
          if (vidTime) vidTime.textContent = stamp(vidSeconds);
        }, 1000);
      }
    } else {
      if (mockSub) mockSub.textContent = 'Matched in 4.2s · text mode';
      if (vidTicker) { clearInterval(vidTicker); vidTicker = null; }
    }
  }
  $$('.seg__btn').forEach(function (b) {
    b.addEventListener('click', function () {
      setMode(b.getAttribute('data-mode'));
      if (b.getAttribute('data-mode') === 'text') startChatLoop();
    });
  });
  if (vidTime) vidTime.textContent = stamp(vidSeconds);
  startChatLoop();

  /* Only animate the hero conversation while it is actually on screen. */
  var heroMock = $('#heroMock');
  if (heroMock && 'IntersectionObserver' in window) {
    new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) { if (mockText && !mockText.hidden) startChatLoop(); }
        else { chatToken.run += 1; }
      });
    }, { threshold: 0.15 }).observe(heroMock);
  }

  /* ---------------------------------------- 09 preference chips + hint text */
  var prefHints = {
    Recommended: 'We\u2019ll pair you with people you\u2019re most likely to click with.',
    Random: 'Pure chance — anyone, anywhere, right now.',
    Nearby: 'People close to your approximate area. Never your address.',
    India: 'Filter to India — plus 190 other countries on Plus.',
    Brazil: 'Filter to Brazil — great for late-night conversations.',
    Germany: 'Filter to Germany — busy after 21:00 CET.'
  };
  var prefHint = $('#prefHint');
  $$('.pref__chip').forEach(function (chip) {
    chip.addEventListener('click', function () {
      $$('.pref__chip').forEach(function (c) { c.classList.remove('is-on'); });
      chip.classList.add('is-on');
      if (prefHint) {
        prefHint.style.opacity = '0';
        setTimeout(function () {
          prefHint.textContent = prefHints[chip.getAttribute('data-pref')] || prefHint.textContent;
          prefHint.style.opacity = '1';
        }, isReduced() ? 0 : 160);
      }
    });
  });
  if (prefHint) prefHint.style.transition = 'opacity .25s ease';

  /* ------------------------------------------------- 09 blur reveal preview */
  var revealDemo = $('[data-reveal-demo]');
  if (revealDemo) {
    var pinned = false;
    var on = function () { revealDemo.classList.add('is-revealed'); };
    var off = function () { if (!pinned) revealDemo.classList.remove('is-revealed'); };
    revealDemo.setAttribute('tabindex', '0');
    revealDemo.setAttribute('role', 'button');
    revealDemo.setAttribute('aria-label', 'Preview how a blurred verification clip is revealed with consent');
    revealDemo.addEventListener('pointerenter', on);
    revealDemo.addEventListener('pointerleave', off);
    revealDemo.addEventListener('focus', on);
    revealDemo.addEventListener('blur', off);
    revealDemo.addEventListener('click', function () { pinned = !pinned; pinned ? on() : off(); });
    revealDemo.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); revealDemo.click(); }
    });
  }

  /* ------------------------------------------------------ 10 showcase tabs */
  var tabs = $$('.tab');
  var panels = $$('.panel');
  var showProgress = $('#showProgress');
  var autoTimer = null, autoRun = null;
  var AUTO_MS = 7000;

  function selectTab(name, focus) {
    tabs.forEach(function (t) {
      var on = t.getAttribute('data-panel') === name;
      t.classList.toggle('is-on', on);
      t.setAttribute('aria-selected', on ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
      if (on && focus) t.focus();
    });
    panels.forEach(function (p) {
      var on = p.getAttribute('data-panel') === name;
      p.hidden = !on;
      p.classList.toggle('is-on', on);
    });
  }
  function currentTab() {
    var t = $('.tab.is-on');
    return t ? t.getAttribute('data-panel') : 'text';
  }
  function nextTab() {
    var names = tabs.map(function (t) { return t.getAttribute('data-panel'); });
    var i = names.indexOf(currentTab());
    selectTab(names[(i + 1) % names.length]);
  }
  function stopAuto() {
    clearTimeout(autoTimer); autoTimer = null;
    if (autoRun) cancelAnimationFrame(autoRun);
    autoRun = null;
    if (showProgress) { showProgress.style.transition = 'none'; showProgress.style.width = '0%'; }
  }
  function startAuto() {
    if (isReduced() || autoTimer || document.hidden) return;
    if (showProgress) {
      showProgress.style.transition = 'none';
      showProgress.style.width = '0%';
      requestAnimationFrame(function () {
        showProgress.style.transition = 'width ' + AUTO_MS + 'ms linear';
        showProgress.style.width = '100%';
      });
    }
    autoTimer = setTimeout(function () { autoTimer = null; nextTab(); startAuto(); }, AUTO_MS);
  }
  tabs.forEach(function (t) {
    t.addEventListener('click', function () { stopAuto(); selectTab(t.getAttribute('data-panel')); });
    t.addEventListener('keydown', function (e) {
      var names = tabs.map(function (x) { return x.getAttribute('data-panel'); });
      var i = names.indexOf(t.getAttribute('data-panel'));
      var to = null;
      if (e.key === 'ArrowRight') to = names[(i + 1) % names.length];
      else if (e.key === 'ArrowLeft') to = names[(i - 1 + names.length) % names.length];
      else if (e.key === 'Home') to = names[0];
      else if (e.key === 'End') to = names[names.length - 1];
      if (to) { e.preventDefault(); stopAuto(); selectTab(to, true); }
    });
  });
  var stage = $('.show__stage');
  if (stage) {
    stage.addEventListener('pointerenter', stopAuto);
    stage.addEventListener('pointerleave', startAuto);
    stage.addEventListener('focusin', stopAuto);
  }
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) { stopAuto(); if (chatLog) chatToken.run += 1; }
    else { startAuto(); if (chatLog) startChatLoop(); }
  });
  if ('IntersectionObserver' in window && stage) {
    var stageObs = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) { e.isIntersecting ? startAuto() : stopAuto(); });
    }, { threshold: 0.25 });
    stageObs.observe(stage);
  }

  /* --------------------------------------------------- 10 verify demo buttons */
  var verifyMedia = $('.vcard__media');
  var verifyNote = $('#verifyNote');
  var verifyReveal = $('#verifyReveal');
  var verifySkip = $('#verifySkip');
  if (verifyReveal) {
    verifyReveal.addEventListener('click', function () {
      if (!verifyMedia) return;
      var revealed = verifyMedia.classList.toggle('is-revealed');
      verifyReveal.innerHTML = revealed
        ? '<svg class="ic" aria-hidden="true"><use href="#i-eye-off"/></svg> Blur it again'
        : '<svg class="ic" aria-hidden="true"><use href="#i-eye"/></svg> Reveal with consent';
      if (verifyNote) {
        verifyNote.textContent = revealed
          ? 'Revealed — the person who recorded this clip agreed to it.'
          : 'Nothing unblurs until the person who recorded it agrees.';
      }
    });
  }
  if (verifySkip) {
    verifySkip.addEventListener('click', function () {
      if (verifyMedia) verifyMedia.classList.remove('is-revealed');
      if (verifyNote) verifyNote.textContent = 'Skipped — nothing was revealed. Straight back to the chat.';
      toast('Skipped. Your partner never saw anything.');
    });
  }

  /* ------------------------------------------------------- 15 billing switch */
  var billing = $('#billingSwitch');
  var monthlyLabel = $('#billMonthlyLabel');
  var annualLabel = $('#billAnnualLabel');
  function setBilling(annual) {
    if (billing) billing.setAttribute('aria-checked', annual ? 'true' : 'false');
    if (monthlyLabel) monthlyLabel.classList.toggle('is-active', !annual);
    if (annualLabel) annualLabel.classList.toggle('is-active', annual);
    $$('.plan__price .amt').forEach(function (amt) {
      var value = amt.getAttribute(annual ? 'data-annual' : 'data-monthly');
      if (isReduced()) { amt.textContent = value; return; }
      amt.classList.add('is-flip');
      setTimeout(function () { amt.textContent = value; amt.classList.remove('is-flip'); }, 170);
    });
    $$('[data-bill-note]').forEach(function (n) {
      n.textContent = annual ? 'billed annually · save 33%' : 'billed monthly · cancel anytime';
    });
    $$('.plan__price .per').forEach(function (p) {
      if (p.textContent.indexOf('forever') === -1) p.textContent = '/month';
    });
  }
  if (billing) {
    billing.addEventListener('click', function () {
      setBilling(billing.getAttribute('aria-checked') !== 'true');
    });
    setBilling(false);
  }

  /* ----------------------------------------------------------- 16 FAQ */
  $$('.faq__item').forEach(function (item) {
    var btn = $('.faq__q', item);
    if (!btn) return;
    btn.addEventListener('click', function () {
      var open = btn.getAttribute('aria-expanded') === 'true';
      $$('.faq__item').forEach(function (other) {
        var ob = $('.faq__q', other);
        if (!ob) return;
        other.classList.remove('is-open');
        ob.setAttribute('aria-expanded', 'false');
      });
      if (!open) {
        item.classList.add('is-open');
        btn.setAttribute('aria-expanded', 'true');
      }
    });
  });

  /* ------------------------------------------------- 18 newsletter + misc */
  var newsForm = $('#newsForm');
  var newsMsg = $('#newsMsg');
  if (newsForm) {
    newsForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var input = $('#newsEmail');
      var value = input ? input.value.trim() : '';
      var valid = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(value);
      if (!valid) {
        if (newsMsg) { newsMsg.textContent = 'That email doesn\u2019t look right — mind checking it?'; newsMsg.classList.add('is-error'); }
        if (input) input.focus();
        return;
      }
      if (newsMsg) { newsMsg.textContent = 'You\u2019re on the list. First story lands Sunday.'; newsMsg.classList.remove('is-error'); }
      toast('Subscribed — see you Sunday.');
      newsForm.reset();
    });
  }
  var year = $('#year');
  if (year) year.textContent = String(new Date().getFullYear());
  var lang = $('#langSelect');
  if (lang) {
    lang.addEventListener('change', function () {
      toast('Translation for ' + lang.options[lang.selectedIndex].text + ' is on the way.');
      lang.selectedIndex = 0;
    });
  }

  /* ------------------------------------------------- 19 instant-match demo */
  var modal = $('#demoModal');
  var stageSearch = $('[data-view="search"]');
  var stageMatch = $('[data-view="match"]');
  var demoChat = $('#demoChat');
  var demoForm = $('#demoForm');
  var demoInput = $('#demoInput');
  var demoTitle = $('#demoTitle');
  var demoDesc = $('#demoDesc');
  var demoMatchTitle = $('#demoMatchTitle');
  var demoMatchDesc = $('#demoMatchDesc');
  var demoAvatar = $('.demo__match .avatar');
  var lastModalFocus = null;
  var demoTimers = [];

  var people = [
    { name: 'Ana', age: 24, city: 'Lisbon, Portugal', letter: 'A', a: '#2DD4BF', b: '#1a8f80', opener: 'ok be honest \u2014 what\u2019s the most useless thing you know?' },
    { name: 'Kenji', age: 31, city: 'Osaka, Japan', letter: 'K', a: '#6C7CF5', b: '#3b46a8', opener: 'deep question or random question? choose carefully' },
    { name: 'Tolu', age: 24, city: 'Lagos, Nigeria', letter: 'T', a: '#F5A623', b: '#b06f0a', opener: 'I have 11 minutes before my bus. make them count' },
    { name: 'Lena', age: 27, city: 'Berlin, Germany', letter: 'L', a: '#A78BFA', b: '#6d4fc4', opener: 'tell me something true about where you are right now' },
    { name: 'Diego', age: 26, city: 'S\u00e3o Paulo, Brazil', letter: 'D', a: '#F0568C', b: '#a8305c', opener: 'two truths and a lie. you go first' }
  ];
  var replies = [
    'ha! okay you\u2019re interesting. I\u2019m staying for this one.',
    'that\u2019s a genuinely good answer. nobody says that.',
    'wait \u2014 really? tell me more, I have time now.',
    'okay this is better than anything on my feed tonight.',
    'you just made a stranger smile. well played.'
  ];
  var replyIndex = 0;

  function clearDemoTimers() { demoTimers.forEach(clearTimeout); demoTimers = []; }

  function trapFocus(e) {
    if (e.key !== 'Tab' || !modal) return;
    var focusables = $$('a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex="-1"])', modal)
      .filter(function (n) { return n.offsetParent !== null || n === document.activeElement; });
    if (!focusables.length) return;
    var first = focusables[0], last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }

  function openDemo() {
    if (!modal) { toast('Set APP_URL in main.js to link this button to the live app.'); return; }
    lastModalFocus = document.activeElement;
    modal.hidden = false;
    document.body.classList.add('is-locked');
    document.addEventListener('keydown', onDemoKey);
    resetDemo();
    var closeBtn = $('.modal__x');
    if (closeBtn) closeBtn.focus();
    demoTimers.push(setTimeout(showMatch, isReduced() ? 200 : 2500));
  }

  function resetDemo() {
    clearDemoTimers();
    var dialog = $('.modal__dialog');
    if (dialog) dialog.setAttribute('aria-labelledby', 'demoTitle');
    if (dialog) dialog.setAttribute('aria-describedby', 'demoDesc');
    if (stageSearch) stageSearch.hidden = false;
    if (stageMatch) stageMatch.hidden = true;
    if (demoChat) demoChat.innerHTML = '';
    if (demoForm) demoForm.hidden = true;
    replyIndex = 0;
  }

  function showMatch() {
    var person = people[Math.floor(Math.random() * people.length)];
    var dialog = $('.modal__dialog');
    if (dialog) {
      dialog.setAttribute('aria-labelledby', 'demoMatchTitle');
      dialog.setAttribute('aria-describedby', 'demoMatchDesc');
    }
    if (stageSearch) stageSearch.hidden = true;
    if (stageMatch) stageMatch.hidden = false;
    if (demoMatchTitle) demoMatchTitle.textContent = 'You\u2019re matched with ' + person.name;
    if (demoMatchDesc) demoMatchDesc.textContent = person.age + ' \u00b7 ' + person.city + ' \u00b7 matched in ' + (2.8 + Math.random() * 2.4).toFixed(1) + 's';
    if (demoAvatar) {
      demoAvatar.textContent = person.letter;
      demoAvatar.style.setProperty('--a', person.a);
      demoAvatar.style.setProperty('--b', person.b);
    }
    if (demoChat) {
      demoChat.appendChild(el('p', 'demo__bubble demo__bubble--them', person.opener));
      demoChat.scrollTop = demoChat.scrollHeight;
    }
    if (demoForm) demoForm.hidden = false;
    if (demoInput) setTimeout(function () { demoInput.focus(); }, isReduced() ? 0 : 320);
  }

  function closeDemo() {
    if (!modal) return;
    clearDemoTimers();
    modal.hidden = true;
    document.body.classList.remove('is-locked');
    document.removeEventListener('keydown', onDemoKey);
    if (lastModalFocus && lastModalFocus.focus) lastModalFocus.focus();
  }

  function onDemoKey(e) {
    if (e.key === 'Escape') { e.preventDefault(); closeDemo(); }
    else trapFocus(e);
  }

  $$('[data-close-demo]').forEach(function (n) { n.addEventListener('click', closeDemo); });
  if (demoForm) {
    demoForm.hidden = true;
    demoForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var value = demoInput ? demoInput.value.trim() : '';
      if (!value) { if (demoInput) demoInput.focus(); return; }
      if (demoChat) {
        demoChat.appendChild(el('p', 'demo__bubble demo__bubble--me', value.replace(/</g, '&lt;')));
        demoChat.scrollTop = demoChat.scrollHeight;
      }
      demoInput.value = '';
      demoTimers.push(setTimeout(function () {
        if (!demoChat) return;
        var dots = el('div', 'dots', '<i></i><i></i><i></i>');
        dots.style.justifySelf = 'start';
        demoChat.appendChild(dots);
        demoChat.scrollTop = demoChat.scrollHeight;
        demoTimers.push(setTimeout(function () {
          if (dots.parentNode) dots.parentNode.removeChild(dots);
          demoChat.appendChild(el('p', 'demo__bubble demo__bubble--them', replies[replyIndex++ % replies.length]));
          demoChat.scrollTop = demoChat.scrollHeight;
        }, isReduced() ? 60 : 1100));
      }, isReduced() ? 60 : 420));
    });
  }
  if (demoTitle && demoDesc) { /* the searching stage keeps its own labels */ }

  /* ------------------------------- placeholder links (kept honest, no 404s) */
  $$('.footer a[href="#"], .footer__bottom-links a[href="#"]').forEach(function (a) {
    a.addEventListener('click', function (e) {
      e.preventDefault();
      toast('\u201c' + a.textContent.trim() + '\u201d is on the way \u2014 this is a landing page build.');
    });
  });

  /* --------------------------------------------------- small delight: konami */
  var seq = [];
  var code = ['ArrowUp', 'ArrowUp', 'ArrowDown', 'ArrowDown'];
  document.addEventListener('keydown', function (e) {
    seq.push(e.key);
    if (seq.length > code.length) seq.shift();
    if (seq.join() === code.join()) { toast('Nice. Someone is already typing to you.'); openDemo(); seq = []; }
  });
})();
