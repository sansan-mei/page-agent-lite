// Landing page behaviour: language switch, GSAP motion and the hero demo loop.
(function () {
  'use strict';
  // Set this once the Chrome Web Store listing is live.
  const STORE_URL = '';
  const params = new URLSearchParams(location.search);
  const SHOT = params.get('shot');
  const STATIC = params.has('static') || !!SHOT;
  // ?shot=<section class> renders one section full-viewport for store screenshots.
  if (SHOT) {
    document.documentElement.classList.add('shot');
    const target = document.querySelector('main > .' + CSS.escape(SHOT));
    if (target) { target.hidden = false; target.classList.add('shot-on'); }
  }
  const dict = window.PAGE_I18N || {};
  const hasGsap = typeof window.gsap !== 'undefined';
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const animate = hasGsap && !reduced && !STATIC;

  // ---------- i18n ----------
  // Double the marquee before collecting translatable nodes so both copies switch language.
  if (animate) { const tr = document.querySelector('.track'); tr.innerHTML += tr.innerHTML; }
  const nodes = [...document.querySelectorAll('[data-i18n]')];
  const zh = new Map(nodes.map(n => [n, n.innerHTML]));
  let lang = params.get('lang') || localStorage.getItem('pal-lang') || (navigator.language.startsWith('zh') ? 'zh' : 'en');
  if (!['zh', 'en'].includes(lang)) lang = 'zh';
  const t = key => (dict[lang] && dict[lang][key]) || (dict.zh && dict.zh[key]) || key;

  function applyLang() {
    document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
    for (const n of nodes) {
      const key = n.dataset.i18n;
      n.innerHTML = lang === 'en' && dict.en[key] ? dict.en[key] : zh.get(n);
    }
    document.querySelectorAll('[data-i18n-aria]').forEach(n => n.setAttribute('aria-label', t(n.dataset.i18nAria)));
    document.getElementById('lang').textContent = lang === 'zh' ? 'EN' : '中文';
    if (STORE_URL) document.querySelectorAll('.store-link').forEach(a => { a.href = STORE_URL; a.textContent = t('cta.storeLive'); });
    splitHeadings();
  }

  // Wrap each character in a span so headings can animate per character.
  function splitHeadings() {
    document.querySelectorAll('.split').forEach(el => {
      const parts = el.innerHTML.split(/<br\s*\/?>/i);
      el.innerHTML = parts.map(p => {
        const text = p.replace(/<[^>]+>/g, '');
        // Keep Latin words unbreakable; CJK characters may still wrap anywhere,
        // but punctuation sticks to the previous character so it never starts a line.
        return text.split(' ').map(word => {
          const groups = [];
          for (const c of word) {
            if (groups.length && /[，。、！？；：,.!?;:]/.test(c)) groups[groups.length - 1] += c; else groups.push(c);
          }
          return `<span class="w">${groups.map(g => `<span class="ch">${g}</span>`).join('')}</span>`;
        }).join(' ');
      }).join('<br>');
    });
  }

  // ---------- Hero demo ----------
  const page = document.querySelector('.mock-page');
  const msgs = document.querySelector('.msgs');
  const box = document.querySelector('.target-box');
  const pointer = document.querySelector('.pointer');
  const round = document.querySelector('.round');
  const fields = ['name', 'email', 'city'].map(k => page.querySelector(`[data-field="${k}"]`));
  let demo;

  function addMsg(html, cls) {
    const m = document.createElement('div');
    m.className = 'msg ' + (cls || '');
    m.innerHTML = html;
    msgs.append(m);
    if (animate) gsap.from(m, { y: 10, opacity: 0, duration: .4, ease: 'power2.out' });
    return m;
  }
  function resetDemo() {
    msgs.innerHTML = '';
    fields.forEach(f => { f.classList.remove('done', 'typing'); f.querySelector('.typed').textContent = ''; });
    round.textContent = '0 / 100';
    if (hasGsap) gsap.set(box, { opacity: 0 });
  }
  function rectIn(el) {
    const a = el.getBoundingClientRect(), b = page.getBoundingClientRect();
    return { x: a.left - b.left, y: a.top - b.top, w: a.width, h: a.height };
  }
  function typeInto(tl, field, text, at) {
    const span = field.querySelector('.typed'), o = { n: 0 };
    tl.call(() => field.classList.add('typing'), null, at);
    tl.to(o, { n: text.length, duration: Math.max(.35, text.length * .06), ease: 'none', onUpdate: () => { span.textContent = text.slice(0, Math.round(o.n)); } });
    tl.call(() => { field.classList.remove('typing'); field.classList.add('done'); });
  }
  function staticDemo() {
    resetDemo();
    const vals = [t('val.name'), t('val.email'), t('val.city')];
    fields.forEach((f, i) => { f.querySelector('.typed').textContent = vals[i]; f.classList.add('done'); });
    addMsg(`<small>${t('msg.agent')}</small>${t('msg.read')}`);
    ['name', 'email', 'city'].forEach((k, i) => addMsg(`ƒ <b>${i === 2 ? 'select' : 'fill'}</b> · ${fieldLabel(i)} · <span class="v">${t('msg.verified')}</span>`, 'tool'));
    addMsg(t('msg.pause'), 'notice');
    round.textContent = '5 / 100';
    const r = rectIn(page.querySelector('.mock-submit'));
    pointer.style.left = r.x + r.w * .7 + 'px'; pointer.style.top = r.y + r.h * .6 + 'px';
  }
  function fieldLabel(i) { return fields[i].closest('label').querySelector('span').textContent; }

  function buildDemo() {
    if (demo) demo.kill();
    if (!animate) { staticDemo(); return; }
    resetDemo();
    const vals = [t('val.name'), t('val.email'), t('val.city')];
    const tl = gsap.timeline({ repeat: -1, repeatDelay: 2.2, onRepeat: resetDemo, delay: .6 });
    tl.set(pointer, { left: '62%', top: '78%' });
    tl.call(() => { round.textContent = '1 / 100'; addMsg(`<small>${t('msg.agent')}</small>${t('msg.read')}`); }, null, '+=0.5');
    fields.forEach((f, i) => {
      const r = rectIn(f);
      tl.to(pointer, { left: r.x + r.w * .55, top: r.y + r.h * .55, duration: .7, ease: 'power3.inOut' }, '+=0.45');
      tl.set(box, { x: r.x - 4, y: r.y - 4, width: r.w + 8, height: r.h + 8 }, '<');
      tl.to(box, { opacity: 1, duration: .25 }, '<0.35');
      tl.to(pointer, { scale: .82, duration: .08, yoyo: true, repeat: 1 });
      typeInto(tl, f, vals[i]);
      tl.call(() => { round.textContent = (i + 2) + ' / 100'; addMsg(`ƒ <b>${i === 2 ? 'select' : 'fill'}</b> · ${fieldLabel(i)} · <span class="v">${t('msg.verified')}</span>`, 'tool'); });
      tl.to(box, { opacity: 0, duration: .25 }, '+=0.25');
    });
    const s = rectIn(page.querySelector('.mock-submit'));
    tl.to(pointer, { left: s.x + s.w * .7, top: s.y + s.h * .6, duration: .7, ease: 'power3.inOut' }, '+=0.3');
    tl.set(box, { x: s.x - 4, y: s.y - 4, width: s.w + 8, height: s.h + 8 }, '<');
    tl.to(box, { opacity: 1, duration: .25, borderColor: '#c27a12' }, '<0.4');
    tl.call(() => { round.textContent = '5 / 100'; addMsg(t('msg.pause'), 'notice'); }, null, '+=0.2');
    tl.to(box, { opacity: 0, borderColor: '#2563eb', duration: .3 }, '+=2.4');
    demo = tl;
  }

  // ---------- Scroll motion ----------
  function chars(sel) { return document.querySelectorAll(sel + ' .ch'); }
  // Split the statement into words (Latin) or characters (CJK) for the scrub fill.
  function splitWords() {
    const el = document.querySelector('.say');
    const text = el.textContent;
    const tokens = lang === 'en' ? text.split(/(\s+)/) : [...text];
    el.innerHTML = tokens.map(w => /^\s+$/.test(w) ? w : `<span class="wd">${w}</span>`).join('');
  }
  let ctx;
  function setupScroll() {
    splitWords();
    if (!animate) { document.querySelectorAll('.say .wd').forEach(w => { w.style.opacity = 1; }); return; }
    gsap.registerPlugin(ScrollTrigger);
    document.documentElement.classList.add('js-anim');
    if (ctx) ctx.revert();
    ctx = gsap.context(() => {
      // Hero entrance: 3D flip-up characters, then the rest cascades in.
      gsap.timeline({ defaults: { ease: 'expo.out' } })
        .from(chars('.hero h1'), { yPercent: 120, rotateX: -90, opacity: 0, duration: 1.2, stagger: .035 })
        .from('.hero .eyebrow, .hero .lede, .hero .cta > *, .hero .facts li', { y: 30, opacity: 0, duration: .9, stagger: .07 }, '-=.9')
        .from('.window', { y: 120, rotateX: 18, rotateZ: -3, opacity: 0, scale: .9, duration: 1.4, transformPerspective: 1200 }, '-=1.1')
        .from('.mascot', { y: 80, scale: .4, rotate: -30, opacity: 0, duration: 1.1, ease: 'elastic.out(1, .55)' }, '-=.7')
        .from('.orb', { scale: 0, opacity: 0, duration: 1.6, stagger: .15 }, 0)
        .from('.spark', { scale: 0, rotate: -180, opacity: 0, duration: 1, stagger: .1, ease: 'back.out(3)' }, .4);
      gsap.to('.mascot', { y: -10, rotate: 3, duration: 2.4, ease: 'sine.inOut', yoyo: true, repeat: -1, delay: 2.2 });
      gsap.to('.spark', { rotate: 360, duration: 14, ease: 'none', repeat: -1, stagger: { each: 2 } });

      // Mouse parallax on hero layers.
      const layers = [['.o1', 40], ['.o2', -30], ['.o3', 24], ['.spark', -18], ['.window', 10], ['.mascot', -22]];
      const movers = layers.map(([s, d]) => [gsap.quickTo(s, 'x', { duration: .9, ease: 'power3' }), gsap.quickTo(s, 'y', { duration: .9, ease: 'power3' }), d]);
      const hero = document.querySelector('.hero');
      hero.addEventListener('pointermove', e => {
        const nx = e.clientX / innerWidth - .5, ny = e.clientY / innerHeight - .5;
        movers.forEach(([mx, my, d]) => { mx(nx * d); my(ny * d); });
      });
      // Scroll away: hero copy drifts up and fades, orbs scale.
      gsap.to('.hero-copy', { yPercent: -18, opacity: .2, ease: 'none', scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true } });
      gsap.to('.o1', { scale: 1.4, ease: 'none', scrollTrigger: { trigger: '.hero', start: 'top top', end: 'bottom top', scrub: true } });

      // Marquee reacts to scroll velocity and direction.
      const track = document.querySelector('.track');
      const loop = gsap.to(track, { xPercent: -50, duration: 26, ease: 'none', repeat: -1 });
      ScrollTrigger.create({ onUpdate: self => gsap.to(loop, { timeScale: self.direction * (1 + Math.min(Math.abs(self.getVelocity()) / 300, 6)), duration: .25, overwrite: true }) });
      gsap.fromTo('.marquee', { rotate: -2.5 }, { rotate: 1.5, ease: 'none', scrollTrigger: { trigger: '.marquee', start: 'top bottom', end: 'bottom top', scrub: true } });

      // Statement: words light up with scroll.
      gsap.to('.say .wd', { opacity: 1, stagger: .1, ease: 'none', scrollTrigger: { trigger: '.statement', start: 'top 70%', end: 'bottom 60%', scrub: true } });

      const mm = gsap.matchMedia();
      mm.add('(min-width: 981px)', () => {
        // Horizontal pinned scroll through the three steps.
        const how = document.querySelector('.how');
        how.classList.add('horizontal');
        const pin = how.querySelector('.how-pin');
        const dist = () => pin.scrollWidth - innerWidth;
        const tween = gsap.to(pin, { x: () => -dist(), ease: 'none', scrollTrigger: { trigger: how, start: 'top top', end: () => '+=' + dist(), pin: true, scrub: .8, invalidateOnRefresh: true } });
        gsap.to('.progress i', { scaleX: 1, ease: 'none', scrollTrigger: { trigger: how, start: 'top top', end: () => '+=' + dist(), scrub: true } });
        gsap.utils.toArray('.step').forEach(s => {
          gsap.from(s.querySelector('.num'), { yPercent: 60, opacity: 0, ease: 'power3.out', scrollTrigger: { trigger: s, containerAnimation: tween, start: 'left 85%', end: 'left 45%', scrub: true } });
          gsap.from(s, { rotate: 6, y: 60, ease: 'power2.out', scrollTrigger: { trigger: s, containerAnimation: tween, start: 'left 100%', end: 'left 50%', scrub: true } });
        });
        // Dark section grows from a card into full width.
        gsap.from('.verify', { scale: .9, borderRadius: 80, ease: 'none', scrollTrigger: { trigger: '.verify', start: 'top bottom', end: 'top 25%', scrub: true } });
        return () => how.classList.remove('horizontal');
      });
      mm.add('(max-width: 980px)', () => {
        gsap.utils.toArray('.step').forEach(s => gsap.from(s, { y: 60, opacity: 0, rotate: 3, duration: .8, ease: 'power3.out', scrollTrigger: { trigger: s, start: 'top 88%' } }));
      });

      gsap.from(chars('.verify h2'), { yPercent: 120, rotateX: -80, opacity: 0, duration: 1, stagger: .03, ease: 'expo.out', scrollTrigger: { trigger: '.verify h2', start: 'top 80%' } });
      gsap.from('.verify .lede', { y: 30, opacity: 0, duration: .8, scrollTrigger: { trigger: '.verify .lede', start: 'top 85%' } });
      gsap.from('.row', { x: -80, opacity: 0, duration: .8, stagger: .14, ease: 'expo.out', scrollTrigger: { trigger: '.log', start: 'top 75%' } });
      gsap.from('.row em', { scale: 0, opacity: 0, duration: .6, stagger: .14, delay: .4, ease: 'back.out(3)', scrollTrigger: { trigger: '.log', start: 'top 75%' } });
      gsap.from('.pills li', { y: 30, scale: .8, opacity: 0, duration: .6, stagger: .07, ease: 'back.out(2)', scrollTrigger: { trigger: '.pills', start: 'top 90%' } });

      // Memory cards fan out from a single stacked card.
      gsap.from('.layer', { y: i => -120 * i, rotate: i => (i - 1) * 8, scale: i => 1 - i * .04, ease: 'power2.out', stagger: .05, scrollTrigger: { trigger: '.layers', start: 'top 85%', end: 'top 30%', scrub: .8 } });
      gsap.from('.memory-copy > *', { y: 40, opacity: 0, duration: .8, stagger: .1, ease: 'expo.out', scrollTrigger: { trigger: '.memory', start: 'top 70%' } });

      gsap.from(chars('.privacy h2'), { yPercent: 120, rotateX: -80, opacity: 0, duration: 1, stagger: .03, ease: 'expo.out', scrollTrigger: { trigger: '.privacy h2', start: 'top 80%' } });
      gsap.from('.privacy article', { y: 120, rotate: i => (i - 1) * 5, opacity: 0, duration: 1.1, stagger: .12, ease: 'expo.out', scrollTrigger: { trigger: '.privacy .grid', start: 'top 85%' } });
      gsap.from('.limits li', { x: 60, opacity: 0, duration: .7, stagger: .07, ease: 'expo.out', scrollTrigger: { trigger: '.limits', start: 'top 75%' } });

      // Final CTA: wipe in from a circle, mascot bounces.
      gsap.from('.final', { clipPath: 'circle(12% at 50% 45%)', ease: 'none', scrollTrigger: { trigger: '.final', start: 'top bottom', end: 'bottom bottom', scrub: true } });
      gsap.from('.final img', { y: 120, rotate: -25, scale: .5, opacity: 0, duration: 1.3, ease: 'elastic.out(1, .5)', scrollTrigger: { trigger: '.final', start: 'top 75%' } });

      // Magnetic buttons.
      document.querySelectorAll('.btn').forEach(b => {
        const mx = gsap.quickTo(b, 'x', { duration: .5, ease: 'elastic.out(1, .4)' }), my = gsap.quickTo(b, 'y', { duration: .5, ease: 'elastic.out(1, .4)' });
        b.addEventListener('pointermove', e => { const r = b.getBoundingClientRect(); mx((e.clientX - r.left - r.width / 2) * .3); my((e.clientY - r.top - r.height / 2) * .4); });
        b.addEventListener('pointerleave', () => { mx(0); my(0); });
      });
    });
  }

  // ---------- Init ----------
  const nav = document.querySelector('.nav');
  addEventListener('scroll', () => nav.classList.toggle('scrolled', scrollY > 10), { passive: true });
  document.getElementById('lang').addEventListener('click', () => {
    lang = lang === 'zh' ? 'en' : 'zh';
    localStorage.setItem('pal-lang', lang);
    applyLang();
    buildDemo();
    setupScroll();
    if (animate) ScrollTrigger.refresh();
  });
  applyLang();
  const start = () => { buildDemo(); setupScroll(); };
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(start); else start();
  let w = innerWidth;
  addEventListener('resize', () => { if (Math.abs(innerWidth - w) > 40) { w = innerWidth; buildDemo(); } });
})();
