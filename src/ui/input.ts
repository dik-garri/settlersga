import type { Camera } from '../render/camera';
import type { Area, GameRenderer, Ghost } from '../render/renderer';
import { BUILDINGS, PIONEER, PROSPECT_RADIUS } from '../sim/config';
import { isFighter, isMilitary } from '../sim/military';
import { claimable } from '../sim/specialists';
import { Terrain, type BuildingType } from '../sim/types';
import { LOCAL_PLAYER, type World } from '../sim/world';
import { isCommand, type GameState, type Placeable } from './state';

const KEY_PAN_SPEED = 900; // screen px per second
const EDGE_PAN_SPEED = 700;
const EDGE = 10;
const DRAG_THRESHOLD = 5;
/** Two clicks on a fighter within this many ms: select every own fighter of that kind on screen. */
const DOUBLE_CLICK_MS = 350;

export interface InputCallbacks {
  onSelectBuildType(type: Placeable | null): void;
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
  /** Selection box drawn while dragging with the left button (Settlers 4: drag to select fighters). */
  private readonly box: HTMLDivElement;
  private lastClick = { at: -Infinity, id: -1 };

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly camera: Camera,
    private readonly renderer: GameRenderer,
    private readonly world: World,
    private readonly state: GameState,
    private readonly cb: InputCallbacks,
  ) {
    this.box = document.createElement('div');
    this.box.className = 'selbox';
    this.box.hidden = true;
    canvas.parentElement?.appendChild(this.box);
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
    if (!placing || isCommand(placing) || !this.pointer) return null;
    const t = this.tileAt(this.pointer.x, this.pointer.y);
    const a = this.anchorFor(placing, t.x, t.y);
    return { type: placing, ...a, valid: this.world.canPlace(placing, a.x, a.y) };
  }

  /** Tiles a geologist sent to the cursor would examine. */
  area(): Area | null {
    const { placing } = this.state;
    if ((placing !== 'geologist' && placing !== 'pioneer') || !this.pointer) return null;
    const t = this.tileAt(this.pointer.x, this.pointer.y);
    const x = Math.round(t.x);
    const y = Math.round(t.y);
    const m = this.world.map;
    if (placing === 'pioneer') {
      // Where a pioneer sent here would push the border: valid if some tile there is claimable.
      let valid = false;
      const r = PIONEER.radius;
      for (let ty = y - r; ty <= y + r && !valid; ty++) {
        for (let tx = x - r; tx <= x + r && !valid; tx++) {
          if (Math.hypot(tx - x, ty - y) <= r && claimable(this.world, tx, ty, LOCAL_PLAYER)) valid = true;
        }
      }
      return { x, y, r, valid };
    }
    const valid = this.world.owns(x, y) && m.terrain[m.idx(x, y)] === Terrain.Mountain;
    return { x, y, r: PROSPECT_RADIUS, valid };
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
    if (d.moved && this.selecting(d)) {
      // Left drag (not while placing): a selection box, as in Settlers 4.
      const r = this.canvas.getBoundingClientRect();
      const host = this.box.parentElement!.getBoundingClientRect();
      Object.assign(this.box.style, {
        left: `${Math.min(d.startX, p.x) + r.left - host.left}px`,
        top: `${Math.min(d.startY, p.y) + r.top - host.top}px`,
        width: `${Math.abs(p.x - d.startX)}px`,
        height: `${Math.abs(p.y - d.startY)}px`,
      });
      this.box.hidden = false;
    } else if (d.moved) {
      this.camera.panScreen(p.x - d.lastX, p.y - d.lastY);
      this.canvas.style.cursor = 'grabbing';
    }
    d.lastX = p.x;
    d.lastY = p.y;
  }

  /** A left-button drag selects fighters unless something is being placed (then it pans). */
  private selecting(d: { button: number }): boolean {
    return d.button === 0 && !this.state.placing;
  }

  /** The player's own living fighters among settler ids. */
  private ownFighters(ids: number[]): number[] {
    return ids.filter((id) => {
      const s = this.world.getSettler(id);
      return !!s && s.owner === LOCAL_PLAYER && isFighter(s);
    });
  }

  private onUp(e: PointerEvent): void {
    const d = this.drag;
    this.drag = null;
    this.canvas.style.cursor = '';
    if (!d) return;
    if (d.moved && this.selecting(d)) {
      this.box.hidden = true;
      const p = this.local(e);
      const caught = this.ownFighters(this.renderer.settlersInRect(d.startX, d.startY, p.x, p.y));
      this.state.selectedUnits = e.shiftKey ? [...new Set([...this.state.selectedUnits, ...caught])] : caught;
      if (this.state.selectedUnits.length > 0) {
        this.state.selected = null;
        this.state.selectedSettler = null;
      }
      return;
    }
    if (d.moved) return;
    if (d.button === 2) {
      if (this.state.selectedUnits.length > 0 && !this.state.placing) this.order(this.local(e));
      else this.cancel();
      return;
    }
    if (d.button !== 0) return;
    const p = this.local(e);
    const t = this.tileAt(p.x, p.y);
    const { placing } = this.state;
    if (placing === 'pioneer') {
      const ok = this.world.sendPioneer(Math.round(t.x), Math.round(t.y));
      this.cb.onMessage(ok ? 'Первопроходец отправлен' : 'Нужна ничейная земля у своей границы и свободный первопроходец (заказ — в ⚙)');
      if (ok && !e.shiftKey) this.cb.onSelectBuildType(null);
      return;
    }
    if (placing === 'thief') {
      const target = this.world.buildingAt(Math.round(t.x), Math.round(t.y));
      const ok = target ? this.world.sendThief(target.id) : false;
      this.cb.onMessage(ok ? 'Вор отправлен' : 'Нужно разведанное чужое здание с товарами и свободный вор (заказ — в ⚙)');
      if (ok && !e.shiftKey) this.cb.onSelectBuildType(null);
      return;
    }
    if (placing === 'geologist') {
      const ok = this.world.sendGeologist(Math.round(t.x), Math.round(t.y));
      this.cb.onMessage(ok ? 'Геолог отправлен' : 'Нужна неразведанная гора на своей земле и свободный носильщик');
      if (ok && !e.shiftKey) this.cb.onSelectBuildType(null);
      return;
    }
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
    // A figure under the cursor wins over the ground and the building behind it.
    const sid = this.renderer.settlerAt(p.x, p.y);
    if (sid !== null && this.ownFighters([sid]).length > 0) {
      // An own fighter: select it for orders (shift adds; a double click takes all of its kind on screen).
      const now = performance.now();
      const kind = this.world.getSettler(sid)!.kind;
      if (this.lastClick.id === sid && now - this.lastClick.at < DOUBLE_CLICK_MS) {
        const [w, h] = this.view;
        this.state.selectedUnits = this.ownFighters(this.renderer.settlersInRect(0, 0, w, h)).filter(
          (id) => this.world.getSettler(id)!.kind === kind,
        );
      } else if (e.shiftKey) {
        const set = new Set(this.state.selectedUnits);
        if (set.has(sid)) set.delete(sid);
        else set.add(sid);
        this.state.selectedUnits = [...set];
      } else {
        this.state.selectedUnits = [sid];
      }
      this.lastClick = { at: now, id: sid };
      this.state.selectedSettler = null;
      this.state.selected = null;
      return;
    }
    if (sid !== null) {
      this.state.selectedSettler = sid;
      this.state.selected = null;
      this.state.selectedUnits = [];
      return;
    }
    this.state.selectedSettler = null;
    this.state.selectedUnits = [];
    const tx = Math.round(t.x);
    const ty = Math.round(t.y);
    const b = this.world.buildingAt(tx, ty);
    // Under the fog nothing can be picked: the player does not know what stands there.
    const known = !this.state.fog || (b !== undefined && b.owner === LOCAL_PLAYER) || this.world.isExplored(tx, ty);
    this.state.selected = b && known ? b.id : null;
  }

  /**
   * Right click with fighters selected, as in Settlers 4: on an enemy military building — attack it;
   * on an own military building — go in; anywhere else — move there.
   */
  private order(p: { x: number; y: number }): void {
    const ids = this.state.selectedUnits;
    const t = this.tileAt(p.x, p.y);
    const tx = Math.round(t.x);
    const ty = Math.round(t.y);
    const b = this.world.buildingAt(tx, ty);
    const known = !this.state.fog || (b !== undefined && b.owner === LOCAL_PLAYER) || this.world.isExplored(tx, ty);
    if (b && known && isMilitary(b) && b.done && b.owner !== LOCAL_PLAYER && !this.world.allied(b.owner, LOCAL_PLAYER)) {
      const n = this.world.orderAttack(ids, b.id);
      this.cb.onMessage(n > 0 ? `В атаку: ${n}` : 'Эти бойцы сейчас не могут атаковать');
      return;
    }
    if (b && isMilitary(b) && b.done && b.owner === LOCAL_PLAYER) {
      const n = this.world.orderGarrison(ids, b.id);
      this.cb.onMessage(n > 0 ? `В гарнизон: ${n}` : 'В этом здании нет мест для них');
      return;
    }
    const n = this.world.orderMove(ids, tx, ty);
    if (n === 0) this.cb.onMessage('Туда не пройти');
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const p = this.local(e);
    this.camera.zoomAt(Math.exp(-e.deltaY * 0.0015), p.x, p.y, ...this.view);
  }

  private cancel(): void {
    if (this.state.placing) this.cb.onSelectBuildType(null);
    else {
      this.state.selected = null;
      this.state.selectedSettler = null;
      this.state.selectedUnits = [];
    }
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
