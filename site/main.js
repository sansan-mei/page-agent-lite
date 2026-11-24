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
    round.textContent = '0 / 50';
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
    round.textContent = '5 / 50';
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
    tl.call(() => { round.textContent = '1 / 50'; addMsg(`<small>${t('msg.agent')}</small>${t('msg.read')}`); }, null, '+=0.5');
    fields.forEach((f, i) => {
      const r = rectIn(f);
      tl.to(pointer, { left: r.x + r.w * .55, top: r.y + r.h * .55, duration: .7, ease: 'power3.inOut' }, '+=0.45');
      tl.set(box, { x: r.x - 4, y: r.y - 4, width: r.w + 8, height: r.h + 8 }, '<');
      tl.to(box, { opacity: 1, duration: .25 }, '<0.35');
      tl.to(pointer, { scale: .82, duration: .08, yoyo: true, repeat: 1 });
      typeInto(tl, f, vals[i]);
      tl.call(() => { round.textContent = (i + 2) + ' / 50'; addMsg(`ƒ <b>${i === 2 ? 'select' : 'fill'}</b> · ${fieldLabel(i)} · <span class="v">${t('msg.verified')}</span>`, 'tool'); });
      tl.to(box, { opacity: 0, duration: .25 }, '+=0.25');
    });
    const s = rectIn(page.querySelector('.mock-submit'));
    tl.to(pointer, { left: s.x + s.w * .7, top: s.y + s.h * .6, duration: .7, ease: 'power3.inOut' }, '+=0.3');
    tl.set(box, { x: s.x - 4, y: s.y - 4, width: s.w + 8, height: s.h + 8 }, '<');
    tl.to(box, { opacity: 1, duration: .25, borderColor: '#c27a12' }, '<0.4');
    tl.call(() => { round.textContent = '5 / 50'; addMsg(t('msg.pause'), 'notice'); }, null, '+=0.2');
    tl.to(box, { opacity: 0, borderColor: '#2563eb', duration: .3 }, '+=2.4');
    demo = tl;
  }

  // ---------- Scroll motion ----------
  function chars(sel) { return document.querySelectorAll(sel + ' .ch'); }
  function setupScroll() {
    if (!animate) return;
    gsap.registerPlugin(ScrollTrigger);

    gsap.timeline({ defaults: { ease: 'power4.out' } })
      .from(chars('.hero h1'), { yPercent: 110, opacity: 0, rotate: 6, duration: .9, stagger: .025 })
      .from('.hero .eyebrow, .hero .lede, .hero .cta, .hero .facts li', { y: 24, opacity: 0, duration: .7, stagger: .08 }, '-=.6')
      .from('.window', { y: 60, opacity: 0, rotate: 1.5, duration: 1 }, '-=.9')
      .from('.mascot', { y: 40, opacity: 0, rotate: -12, duration: .9, ease: 'back.out(1.8)' }, '-=.5');
    gsap.to('.mascot', { y: -8, duration: 2.2, ease: 'sine.inOut', yoyo: true, repeat: -1, delay: 2 });

    // Marquee: duplicate items so the loop is seamless.
    const track = document.querySelector('.track');
    track.innerHTML += track.innerHTML;
    const loop = gsap.to(track, { xPercent: -50, duration: 28, ease: 'none', repeat: -1 });
    ScrollTrigger.create({ onUpdate: self => gsap.to(loop, { timeScale: self.direction * (1 + Math.min(Math.abs(self.getVelocity()) / 400, 4)), duration: .3, overwrite: true }) });

    const mm = gsap.matchMedia();
    mm.add('(min-width: 981px)', () => {
      const steps = gsap.utils.toArray('.step');
      gsap.set(steps, { opacity: .18, y: 30 });
      const tl = gsap.timeline({ scrollTrigger: { trigger: '.how-pin', start: 'top top', end: '+=1400', pin: true, scrub: .6 } });
      steps.forEach((s, i) => {
        tl.to(s, { opacity: 1, y: 0, duration: 1 }, i);
        if (i) tl.to(steps[i - 1], { opacity: .35, duration: 1 }, i);
      });
      tl.to('.progress i', { scaleX: 1, duration: steps.length, ease: 'none' }, 0);
    });
    mm.add('(max-width: 980px)', () => {
      gsap.utils.toArray('.step').forEach(s => gsap.from(s, { y: 40, opacity: 0, duration: .7, scrollTrigger: { trigger: s, start: 'top 85%' } }));
    });

    gsap.from(chars('.verify h2'), { yPercent: 100, opacity: 0, duration: .7, stagger: .02, ease: 'power3.out', scrollTrigger: { trigger: '.verify h2', start: 'top 80%' } });
    gsap.from('.verify .lede', { y: 24, opacity: 0, duration: .7, scrollTrigger: { trigger: '.verify .lede', start: 'top 85%' } });
    gsap.from('.row', { x: -40, opacity: 0, duration: .6, stagger: .12, ease: 'power3.out', scrollTrigger: { trigger: '.log', start: 'top 75%' } });
    gsap.from('.row em', { scale: .6, opacity: 0, duration: .4, stagger: .12, delay: .35, ease: 'back.out(2)', scrollTrigger: { trigger: '.log', start: 'top 75%' } });
    gsap.from('.pills li', { y: 20, opacity: 0, duration: .5, stagger: .06, scrollTrigger: { trigger: '.pills', start: 'top 90%' } });

    gsap.from('.layer', { y: (i) => -120 * i, rotate: (i) => (i - 1) * 4, duration: 1, ease: 'power3.out', stagger: .08, scrollTrigger: { trigger: '.layers', start: 'top 80%', end: 'top 35%', scrub: .6 } });
    gsap.from('.memory-copy > *', { y: 30, opacity: 0, duration: .7, stagger: .1, scrollTrigger: { trigger: '.memory', start: 'top 70%' } });

    gsap.from(chars('.privacy h2'), { yPercent: 100, opacity: 0, duration: .7, stagger: .02, ease: 'power3.out', scrollTrigger: { trigger: '.privacy h2', start: 'top 80%' } });
    gsap.from('.privacy article', { y: 60, opacity: 0, duration: .8, stagger: .12, ease: 'power3.out', scrollTrigger: { trigger: '.privacy .grid', start: 'top 80%' } });
    gsap.from('.limits li', { x: 30, opacity: 0, duration: .5, stagger: .07, scrollTrigger: { trigger: '.limits', start: 'top 75%' } });
    gsap.from('.final img', { y: 60, rotate: -10, opacity: 0, duration: 1, ease: 'back.out(1.6)', scrollTrigger: { trigger: '.final', start: 'top 70%' } });
  }

  // ---------- Init ----------
  const nav = document.querySelector('.nav');
  addEventListener('scroll', () => nav.classList.toggle('scrolled', scrollY > 10), { passive: true });
  document.getElementById('lang').addEventListener('click', () => {
    lang = lang === 'zh' ? 'en' : 'zh';
    localStorage.setItem('pal-lang', lang);
    applyLang();
    buildDemo();
    if (hasGsap && window.ScrollTrigger) ScrollTrigger.refresh();
  });
  applyLang();
  const start = () => { buildDemo(); setupScroll(); };
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(start); else start();
  let w = innerWidth;
  addEventListener('resize', () => { if (Math.abs(innerWidth - w) > 40) { w = innerWidth; buildDemo(); } });
})();
