/**
 * Mobile bottom sheet for the control panel.
 *
 * Three snap points:
 *  - peek: handle + distance slider only (default; leaves most of the screen to the map)
 *  - half: about half the screen
 *  - full: about 88% of the screen, content scrolls inside
 *
 * Drag the handle to resize (snaps to the nearest point, or in the flick direction);
 * tap it to go peek -> half -> full -> peek. Desktop (>= 768px) is untouched: the
 * height lives in the --sheet-h CSS variable, which only the mobile styles read.
 */

export type SheetState = 'peek' | 'half' | 'full';

const MOBILE_QUERY = '(max-width: 767px)';
const FLICK_PX_PER_MS = 0.45;
const TAP_SLOP_PX = 6;

export class BottomSheet {
  private readonly panel: HTMLElement;
  private readonly handle: HTMLElement;
  private readonly peekAnchor: HTMLElement;
  private readonly mq = window.matchMedia(MOBILE_QUERY);
  private state: SheetState = 'peek';
  private height = 0;
  private onChange: ((state: SheetState) => void) | null = null;

  constructor(panel: HTMLElement, handle: HTMLElement, peekAnchor: HTMLElement) {
    this.panel = panel;
    this.handle = handle;
    this.peekAnchor = peekAnchor;
    this.bindDrag();
    window.addEventListener('resize', () => this.snapTo(this.state, false));
    this.mq.addEventListener('change', () => this.snapTo('peek', false));
    this.snapTo('peek', false);
  }

  public onStateChange(cb: (state: SheetState) => void): void {
    this.onChange = cb;
  }

  public get current(): SheetState {
    return this.state;
  }

  /** Height of the peek state in px; used for map padding. */
  public peekHeight(): number {
    return this.snapHeights().peek;
  }

  public snapTo(state: SheetState, animate = true): void {
    if (!this.mq.matches) {
      document.documentElement.removeAttribute('data-sheet');
      document.documentElement.style.removeProperty('--sheet-h');
      return;
    }
    const prev = this.state;
    this.state = state;
    if (!animate) this.panel.classList.add('sheet-dragging');
    this.setHeight(this.snapHeights()[state]);
    if (!animate) {
      void this.panel.offsetHeight; // apply without transition
      this.panel.classList.remove('sheet-dragging');
    }
    this.panel.classList.toggle('sheet-scrollable', state !== 'peek');
    if (state === 'peek') this.panel.scrollTop = 0;
    document.documentElement.dataset.sheet = state;
    this.handle.setAttribute('aria-expanded', String(state !== 'peek'));
    if (prev !== state) this.onChange?.(state);
  }

  private snapHeights(): Record<SheetState, number> {
    const vh = window.innerHeight;
    const padBottom = parseFloat(getComputedStyle(this.panel).paddingBottom) || 12;
    // Peek ends right below the slider section, which is ordered first on mobile.
    const anchorBottom = this.peekAnchor.offsetTop + this.peekAnchor.offsetHeight;
    const peek = Math.min(Math.round(anchorBottom + padBottom), Math.round(vh * 0.3));
    // Full never grows past the content, so there is no empty space under the last section.
    let contentBottom = 0;
    for (const el of Array.from(this.panel.children) as HTMLElement[]) {
      if (el.offsetParent === null) continue; // hidden
      contentBottom = Math.max(contentBottom, el.offsetTop + el.offsetHeight);
    }
    const full = Math.max(peek, Math.min(Math.round(vh * 0.88), Math.round(contentBottom + padBottom)));
    const half = Math.max(peek + 80, Math.round(vh * 0.5));
    return { peek, half: Math.min(half, full), full };
  }

  private setHeight(px: number): void {
    this.height = px;
    document.documentElement.style.setProperty('--sheet-h', `${px}px`);
  }

  private bindDrag(): void {
    let startY = 0;
    let startH = 0;
    let lastY = 0;
    let lastT = 0;
    let velocity = 0; // px/ms, positive = finger moving down
    let moved = false;
    let pointerId: number | null = null;

    this.handle.addEventListener('pointerdown', (e) => {
      if (!this.mq.matches) return;
      pointerId = e.pointerId;
      this.handle.setPointerCapture(e.pointerId);
      startY = lastY = e.clientY;
      lastT = e.timeStamp;
      startH = this.height;
      velocity = 0;
      moved = false;
      this.panel.classList.add('sheet-dragging');
    });

    this.handle.addEventListener('pointermove', (e) => {
      if (e.pointerId !== pointerId) return;
      const dy = e.clientY - startY;
      if (Math.abs(dy) > TAP_SLOP_PX) moved = true;
      const { peek, full } = this.snapHeights();
      this.setHeight(Math.max(peek, Math.min(full, startH - dy)));
      const dt = e.timeStamp - lastT;
      if (dt > 0) velocity = (e.clientY - lastY) / dt;
      lastY = e.clientY;
      lastT = e.timeStamp;
    });

    const end = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      pointerId = null;
      this.panel.classList.remove('sheet-dragging');
      if (!moved) {
        // Tap: peek -> half -> full -> peek
        const next: Record<SheetState, SheetState> = { peek: 'half', half: 'full', full: 'peek' };
        this.snapTo(next[this.state]);
        return;
      }
      const heights = this.snapHeights();
      const order: SheetState[] = ['peek', 'half', 'full'];
      let target: SheetState;
      if (Math.abs(velocity) > FLICK_PX_PER_MS) {
        // Flick: go one step in the flick direction from where the drag ended.
        const above = order.filter((s) => heights[s] > this.height);
        const below = order.filter((s) => heights[s] < this.height);
        target = velocity < 0 ? (above[0] ?? 'full') : (below[below.length - 1] ?? 'peek');
      } else {
        target = order.reduce((best, s) =>
          Math.abs(heights[s] - this.height) < Math.abs(heights[best] - this.height) ? s : best
        );
      }
      this.snapTo(target);
    };
    this.handle.addEventListener('pointerup', end);
    this.handle.addEventListener('pointercancel', end);
    // Pointer taps are handled above. Keyboard activation (Enter/Space) only fires
    // `click` with detail 0, so cycle the sheet for that case.
    this.handle.addEventListener('click', (e) => {
      e.preventDefault();
      if (e.detail === 0 && this.mq.matches) {
        const next: Record<SheetState, SheetState> = { peek: 'half', half: 'full', full: 'peek' };
        this.snapTo(next[this.state]);
      }
    });
  }
}
