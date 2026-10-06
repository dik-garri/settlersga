import type { Camera } from '../render/camera';
import type { GameRenderer, Ghost } from '../render/renderer';
import { BUILDINGS } from '../sim/config';
import type { BuildingType } from '../sim/types';
import type { World } from '../sim/world';
import type { GameState } from './state';

const KEY_PAN_SPEED = 900; // screen px per second
const EDGE_PAN_SPEED = 700;
const EDGE = 10;
const DRAG_THRESHOLD = 5;

export interface InputCallbacks {
  onSelectBuildType(type: BuildingType | null): void;
  /** Digit 1–9: pick a building on the open build-menu tab. */
  onHotkey(n: number): void;
  onNextTab(): void;
  onMessage(text: string): void;
}

/** Mouse and keyboard: camera control, placement and selection. */
export class InputController {
  private readonly keys = new Set<string>();
  private pointer: { x: number; y: number } | null = null;
  private drag: { lastX: number; lastY: number; startX: number; startY: number; button: number; moved: boolean } | null =
    null;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly camera: Camera,
    private readonly renderer: GameRenderer,
    private readonly world: World,
    private readonly state: GameState,
    private readonly cb: InputCallbacks,
  ) {
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    canvas.addEventListener('pointerdown', (e) => this.onDown(e));
    canvas.addEventListener('pointermove', (e) => this.onMove(e));
    canvas.addEventListener('pointerup', (e) => this.onUp(e));
    canvas.addEventListener('pointerleave', () => (this.pointer = null));
    canvas.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    window.addEventListener('blur', () => this.keys.clear());
  }

  private get view(): [number, number] {
    return [this.canvas.clientWidth, this.canvas.clientHeight];
  }

  private local(e: PointerEvent | WheelEvent): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private tileAt(sx: number, sy: number): { x: number; y: number } {
    const w = this.camera.toWorld(sx, sy, ...this.view);
    return this.renderer.pickTile(w.x, w.y);
  }

  /** Where the building's top tile goes so the footprint is centered on the cursor. */
  private anchorFor(type: BuildingType, fx: number, fy: number): { x: number; y: number } {
    const def = BUILDINGS[type];
    return { x: Math.round(fx - (def.w - 1) / 2), y: Math.round(fy - (def.h - 1) / 2) };
  }

  ghost(): Ghost | null {
    const { placing } = this.state;
    if (!placing || !this.pointer) return null;
    const t = this.tileAt(this.pointer.x, this.pointer.y);
    const a = this.anchorFor(placing, t.x, t.y);
    return { type: placing, ...a, valid: this.world.canPlace(placing, a.x, a.y) };
  }

  update(dtMs: number): void {
    const dt = dtMs / 1000;
    let dx = 0;
    let dy = 0;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) dx += 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) dx -= 1;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) dy += 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) dy -= 1;
    let speed = KEY_PAN_SPEED;
    if (dx === 0 && dy === 0 && this.pointer && !this.drag) {
      const [w, h] = this.view;
      if (this.pointer.x < EDGE) dx = 1;
      else if (this.pointer.x > w - EDGE) dx = -1;
      if (this.pointer.y < EDGE) dy = 1;
      else if (this.pointer.y > h - EDGE) dy = -1;
      speed = EDGE_PAN_SPEED;
    }
    if (dx || dy) this.camera.panScreen(dx * speed * dt, dy * speed * dt);

    if (this.pointer) {
      const t = this.tileAt(this.pointer.x, this.pointer.y);
      this.state.hover = { x: Math.round(t.x), y: Math.round(t.y) };
    } else {
      this.state.hover = null;
    }
  }

  private onDown(e: PointerEvent): void {
    const p = this.local(e);
    this.pointer = p;
    this.canvas.setPointerCapture(e.pointerId);
    this.drag = { lastX: p.x, lastY: p.y, startX: p.x, startY: p.y, button: e.button, moved: false };
  }

  private onMove(e: PointerEvent): void {
    const p = this.local(e);
    this.pointer = p;
    const d = this.drag;
    if (!d) return;
    if (!d.moved && Math.hypot(p.x - d.startX, p.y - d.startY) > DRAG_THRESHOLD) d.moved = true;
    if (d.moved) {
      this.camera.panScreen(p.x - d.lastX, p.y - d.lastY);
      this.canvas.style.cursor = 'grabbing';
    }
    d.lastX = p.x;
    d.lastY = p.y;
  }

  private onUp(e: PointerEvent): void {
    const d = this.drag;
    this.drag = null;
    this.canvas.style.cursor = '';
    if (!d || d.moved) return;
    if (d.button === 2) {
      this.cancel();
      return;
    }
    if (d.button !== 0) return;
    const p = this.local(e);
    const t = this.tileAt(p.x, p.y);
    const { placing } = this.state;
    if (placing) {
      const a = this.anchorFor(placing, t.x, t.y);
      if (!this.world.canPlace(placing, a.x, a.y)) {
        const outside = !this.world.owns(a.x, a.y);
        this.cb.onMessage(outside ? 'Строить можно только на своей земле' : 'Здесь строить нельзя');
        return;
      }
      const b = this.world.placeBuilding(placing, a.x, a.y);
      if (!b) {
        this.cb.onMessage('Поселенцы не смогут дойти до этого места');
        return;
      }
      if (!e.shiftKey) this.cb.onSelectBuildType(null);
      return;
    }
    const b = this.world.buildingAt(Math.round(t.x), Math.round(t.y));
    this.state.selected = b ? b.id : null;
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const p = this.local(e);
    this.camera.zoomAt(Math.exp(-e.deltaY * 0.0015), p.x, p.y, ...this.view);
  }

  private cancel(): void {
    if (this.state.placing) this.cb.onSelectBuildType(null);
    else this.state.selected = null;
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    if (e.target instanceof HTMLInputElement) return;
    if (down) this.keys.add(e.code);
    else this.keys.delete(e.code);
    if (!down) return;
    switch (e.code) {
      case 'Escape':
        this.cancel();
        break;
      case 'Space':
        e.preventDefault();
        this.state.paused = !this.state.paused;
        break;
      case 'Tab':
        e.preventDefault();
        this.cb.onNextTab();
        break;
      default:
        if (/^Digit[1-9]$/.test(e.code)) this.cb.onHotkey(Number(e.code.slice(5)));
    }
  }
}
