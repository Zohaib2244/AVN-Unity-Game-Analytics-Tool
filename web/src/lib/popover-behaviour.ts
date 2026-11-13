// What every popover (the shared `.pop` of @avn/ui) does, once, for the whole app:
//  - scrolling over it never moves the page behind it (R4.3), unless the popover itself can still scroll that way;
//  - when the page scrolls its trigger out of view the popover closes instead of hanging at the edge (R4.2).
export function installPopoverBehaviour(): () => void {
  const onWheel = (event: WheelEvent) => {
    const target = event.target as HTMLElement | null;
    const pop = target?.closest?.('.pop');
    if (!pop) return;
    for (let el: HTMLElement | null = target; el && pop.contains(el); el = el.parentElement) {
      if (!/(auto|scroll)/.test(getComputedStyle(el).overflowY) || el.scrollHeight <= el.clientHeight + 1) continue;
      const atTop = el.scrollTop <= 0;
      const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
      if ((event.deltaY < 0 && !atTop) || (event.deltaY > 0 && !atBottom)) return;
    }
    event.preventDefault();
  };
  let frame = 0;
  const onScroll = (event: Event) => {
    if ((event.target as HTMLElement | null)?.closest?.('.pop')) return;
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      const pop = document.querySelector('.pop');
      if (!pop) return;
      const box = pop.getBoundingClientRect();
      // On a phone the popover is a bottom sheet and stays where it is.
      if (getComputedStyle(pop).bottom === '0px' && window.innerWidth <= 700) return;
      if (box.top < 48 || box.bottom > window.innerHeight + 1) document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    });
  };
  document.addEventListener('wheel', onWheel, { passive: false });
  document.addEventListener('scroll', onScroll, true);
  return () => { document.removeEventListener('wheel', onWheel); document.removeEventListener('scroll', onScroll, true); cancelAnimationFrame(frame); };
}
