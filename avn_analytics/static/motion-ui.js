// Motion for the whole site (Motion v12, vendored in vendor/motion.js; the site has no React, so this uses its
// plain-JS API: animate, stagger, inView, spring). Rules, from the motion skill and avn-ux motion.md:
//  - only opacity and transform move (GPU, no layout); springs for things you touch, tweens for entrances;
//  - everything plays once, nothing loops except live things, and all of it is skipped with reduced motion.
// Without the library (or with reduced motion) every function leaves the final state straight away.

const mo = (() => {
  const lib = window.Motion;
  const EASE = [0.16, 1, 0.3, 1];
  const SPRING = {type: 'spring', stiffness: 420, damping: 32};
  const SOFT = {type: 'spring', stiffness: 260, damping: 30};
  const reduce = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
  const on = () => Boolean(lib) && !reduce();
  if (lib) document.documentElement.classList.add('has-motion');
  const done = Promise.resolve();
  const play = (target, keyframes, options) => { try { return lib.animate(target, keyframes, options).finished ?? done; } catch { return done; } };
  const list = (root, selector) => [...root.querySelectorAll(selector)];

  // Page open: blocks rise in one after another; blocks below the fold rise when scrolled to, once.
  function pageIn(main) {
    if (!main) return;
    const blocks = [...main.children].filter(child => !child.classList.contains('footnote'));
    if (!on()) return;
    const height = innerHeight;
    const visible = blocks.filter(block => block.getBoundingClientRect().top < height);
    const later = blocks.filter(block => !visible.includes(block));
    blocks.forEach(block => { block.style.opacity = '0'; });
    play(visible, {opacity: [0, 1], y: [14, 0]}, {duration: 0.55, ease: EASE, delay: lib.stagger(0.05)}).then(() => visible.forEach(block => { block.style.opacity = ''; block.style.transform = ''; }));
    later.forEach(block => lib.inView(block, () => { play(block, {opacity: [0, 1], y: [18, 0]}, {duration: 0.5, ease: EASE}).then(() => { block.style.opacity = ''; block.style.transform = ''; }); }, {amount: 0.08}));
  }
  // Page leave: the old content fades out and drifts up for 120 ms before the new page is drawn.
  function pageOut(main) { return on() && main ? play(main, {opacity: [1, 0], y: [0, -6]}, {duration: 0.12, ease: 'easeIn'}).then(() => { main.style.opacity = ''; main.style.transform = ''; }) : done; }

  // Numbers: count up once on entering, roll to the new value when filters change.
  function number(node, end, from = 0) {
    if (!on() || !Number.isFinite(end)) return;
    const decimals = (String(node.textContent).split('.')[1] || '').replace(/\D.*/, '').length;
    node._rolling = true;
    play(from, end, {duration: 0.85, ease: [0.22, 1, 0.36, 1], onUpdate: value => { node.textContent = value.toLocaleString(undefined, {minimumFractionDigits: decimals, maximumFractionDigits: decimals}); }}).finally(() => { node._rolling = false; });
  }

  // Charts and bars grow from their baseline, staggered; the curve draws itself; heat cells pop in.
  function charts(root) {
    if (!on()) return;
    const fresh = selector => list(root, selector).filter(node => !node._grown && (node._grown = true));
    const bars = fresh('.chart-bar');
    if (bars.length) play(bars, {scaleY: [0, 1]}, {duration: 0.55, ease: EASE, delay: lib.stagger(0.012)});
    fresh('.funnel-bar span, .breakdown-bar span, .track i').forEach((bar, index) => play(bar, {scaleX: [0, 1]}, {duration: 0.7, ease: EASE, delay: index * 0.05}));
    fresh('.curve-line').forEach(line => { line.setAttribute('pathLength', '1'); line.style.strokeDasharray = '1'; play(line, {strokeDashoffset: [1, 0]}, {duration: 1, ease: EASE}).then(() => { line.style.strokeDasharray = ''; line.style.strokeDashoffset = ''; }); });
    fresh('.curve-area').forEach(area => play(area, {opacity: [0, 0.1]}, {duration: 0.9, delay: 0.3}));
    const cells = fresh('.lvheat'); if (cells.length) play(cells, {opacity: [0, 1], scale: [0.6, 1]}, {...SOFT, delay: lib.stagger(0.012)});
    const ticks = fresh('.setup .sic.ok, .setup .sic.done'); if (ticks.length) play(ticks, {scale: [0.4, 1], opacity: [0, 1]}, {...SPRING, delay: lib.stagger(0.07)});
  }

  // Overlays slide, pop or fade in; leaving is animated too, then done() hides them.
  const KINDS = {
    drawer: {from: {x: ['100%', '0%']}, to: {x: ['0%', '100%']}, enter: {type: 'spring', stiffness: 320, damping: 34}, leave: {duration: 0.2, ease: 'easeIn'}},
    sheet: {from: {y: ['100%', '0%']}, to: {y: ['0%', '100%']}, enter: {type: 'spring', stiffness: 320, damping: 34}, leave: {duration: 0.2, ease: 'easeIn'}},
    pop: {from: {opacity: [0, 1], y: [6, 0], scale: [0.97, 1]}, to: {opacity: [1, 0], y: [0, 4], scale: [1, 0.98]}, enter: {duration: 0.2, ease: EASE}, leave: {duration: 0.12, ease: 'easeIn'}},
    fade: {from: {opacity: [0, 1]}, to: {opacity: [1, 0]}, enter: {duration: 0.2}, leave: {duration: 0.15}},
    toast: {from: {opacity: [0, 1], y: [16, 0], scale: [0.97, 1]}, to: {opacity: [1, 0], x: [0, 28]}, enter: {...SOFT}, leave: {duration: 0.18, ease: 'easeIn'}},
    cmdk: {from: {opacity: [0, 1], y: [-8, 0], scale: [0.98, 1]}, to: {opacity: [1, 0], y: [0, -6], scale: [1, 0.98]}, enter: {duration: 0.2, ease: EASE}, leave: {duration: 0.12, ease: 'easeIn'}},
  };
  function enter(element, kind) {
    const spec = KINDS[kind]; if (!on() || !spec || !element) return;
    play(element, spec.from, spec.enter).then(() => { element.style.transform = ''; element.style.opacity = ''; });
  }
  function leave(element, kind) {
    const spec = KINDS[kind]; if (!on() || !spec || !element) return done;
    return play(element, spec.to, spec.leave).then(() => { element.style.transform = ''; element.style.opacity = ''; });
  }

  // The active nav highlight and the tab marker glide on a spring.
  function glide(element, to) {
    if (!element) return;
    if (!on() || element.dataset.placed !== '1') { Object.assign(element.style, {transform: to.transform, height: to.height ?? element.style.height}); return; }
    play(element, {transform: to.transform, ...(to.height ? {height: to.height} : {})}, {type: 'spring', stiffness: 380, damping: 30});
  }

  // Touch feedback by delegation, so it also covers content drawn later: cards lift, buttons press, badges pop.
  const LIFT = '.tile, .insight, .game-card, .gcard, .kpi, .rrow, .look';
  const PRESS = '.btn, .button, .icon-btn, .tab, .ni, .opt, .seg button, .segmented button, .range-modes button, .lvheat, .chip';
  let lifted = null;
  document.addEventListener('pointerover', event => {
    if (!on() || event.pointerType === 'touch') return;
    const card = event.target.closest?.(LIFT);
    if (card === lifted) return;
    if (lifted) play(lifted, {y: 0}, SOFT);
    lifted = card;
    if (card && !card.matches('.kpi, .rrow, .look')) play(card, {y: -2}, SOFT);
  });
  document.addEventListener('pointerdown', event => {
    if (!on()) return;
    const target = event.target.closest?.(PRESS);
    if (!target || target.disabled) return;
    play(target, {scale: 0.96}, {type: 'spring', stiffness: 600, damping: 28});
    const release = () => { play(target, {scale: 1}, SPRING).then(() => { target.style.transform = ''; }); window.removeEventListener('pointerup', release); window.removeEventListener('pointercancel', release); };
    window.addEventListener('pointerup', release); window.addEventListener('pointercancel', release);
  });

  return {on, pageIn, pageOut, number, charts, enter, leave, glide, pop: element => on() && element && play(element, {scale: [0.5, 1], opacity: [0, 1]}, SPRING)};
})();
