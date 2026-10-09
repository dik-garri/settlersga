import type { Camera } from '../render/camera';
import type { Area, GameRenderer, Ghost } from '../render/renderer';
import { BUILDINGS, GEOLOGIST, PIONEER } from '../sim/config';
import { isFighter, isMilitary } from '../sim/military';
import { canProspect, isSpecialist, pioneerSpot, SPECIALIST_ORDERS, toolPileNear } from '../sim/specialists';
import { toScreen } from '../render/iso';
import { Terrain, type BuildingType } from '../sim/types';
import { LOCAL_PLAYER, type World } from '../sim/world';
import { isCommand, type GameState, type Placeable } from './state';
import { sameTypeAround, SELECT_RADIUS, SELECTION_MAX, toggleInSelection, withoutHealthy } from './selection';

const KEY_PAN_SPEED = 900; // screen px per second
const EDGE_PAN_SPEED = 700;
const EDGE = 10;
const DRAG_THRESHOLD = 5;
/** Two clicks on a unit within this many ms: select every own unit of that kind on screen. */
const DOUBLE_CLICK_MS = 350;
/** Two presses of a group's digit within this many ms: centre the camera on the group. */
const DOUBLE_TAP_MS = 400;
/** Settler kinds drawn as animals that can be selected but take no orders (pack donkeys, as in Settlers 4). */
const LOOK_ONLY = new Set(['donkey']);

export interface InputCallbacks {
  onSelectBuildType(type: Placeable | null): void;
  /** Digit 1–9: pick a building on the open build-menu tab. */
  onHotkey(n: number): void;
  onNextTab(): void;
  onMessage(text: string): void;
  /** Esc with nothing to cancel: the game menu (pause). */
  onMenu(): void;
  /** Space: the camera to the last message, again for the one before (Settlers 4). */
  onLastMessage(): boolean;
}

/** Mouse and keyboard: camera control, placement and selection. */
export class InputController {
  private readonly keys = new Set<string>();
  private pointer: { x: number; y: number } | null = null;
  private drag: { lastX: number; lastY: number; startX: number; startY: number; button: number; moved: boolean } | null =
    null;
  /** Selection box drawn while dragging with the left button (Settlers 4: drag to select units). */
  private readonly box: HTMLDivElement;
  /** What a right click would do for the selection, shown next to the cursor. */
  private readonly hint: HTMLDivElement;
  private hintKey = '';
  private lastClick = { at: -Infinity, id: -1 };
  private lastRecall = { at: -Infinity, n: -1 };

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
    this.hint = document.createElement('div');
    this.hint.className = 'order-hint';
    this.hint.hidden = true;
    canvas.parentElement?.appendChild(this.hint);
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
  /** Why `sendGeologist` refused (x, y): the first of its conditions that fails, in words. */
  private geologistBlocker(x: number, y: number): string {
    const w = this.world;
    if (!w.map.inBounds(x, y) || w.map.terrain[w.map.idx(x, y)] !== Terrain.Mountain) return 'Геолог разведывает только горы: щёлкните по склону горы';
    if (!canProspect(w, x, y, LOCAL_PLAYER)) return 'Здесь всё уже разведано';
    if (!toolPileNear(w, LOCAL_PLAYER, x, y)) {
      return 'Нет свободного геолога и молотка для нового: закажите геолога в меню «Поселенцы» (молотки делает инструментальщик, их берут и строители)';
    }
    return 'Нет свободного геолога и носильщика, который стал бы им';
  }

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
    // Where he starts: he searches outwards from here (`reach`) and then on from where he stands.
    if (placing === 'pioneer') return { x, y, r: PIONEER.reach, valid: pioneerSpot(this.world, x, y, LOCAL_PLAYER) };
    const valid = m.inBounds(x, y) && m.terrain[m.idx(x, y)] === Terrain.Mountain && canProspect(this.world, x, y, LOCAL_PLAYER);
    return { x, y, r: GEOLOGIST.reach, valid };
  }

  update(dtMs: number): void {
    if (this.state.menu) return;
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
    // Choosing a new work-area centre: the renderer previews it under the cursor.
    const moving = this.state.movingWorkArea;
    const h = this.state.hover;
    this.renderer.workAreaPreview = moving !== null && h ? { id: moving, x: h.x, y: h.y } : null;
    this.updateHint();
  }

  /** Units of the selection still alive and ours, split into fighters and specialists. */
  private selection(): { fighters: number[]; specialists: number[] } {
    const fighters: number[] = [];
    const specialists: number[] = [];
    for (const id of this.state.selectedUnits) {
      const s = this.world.getSettler(id);
      if (!s || this.world.dying.has(id) || s.owner !== LOCAL_PLAYER) continue;
      if (isFighter(s)) fighters.push(id);
      else if (isSpecialist(s)) specialists.push(id);
    }
    return { fighters, specialists };
  }

  /** The building under (tx, ty) if the local player may know it is there. */
  private knownBuildingAt(tx: number, ty: number) {
    const b = this.world.buildingAt(tx, ty);
    const known = !this.state.fog || (b !== undefined && b.owner === LOCAL_PLAYER) || this.world.isExplored(tx, ty);
    return b && known ? b : undefined;
  }

  /** The fighters' part of a right click there: attack, go in, or move. */
  private fighterOrderAt(tx: number, ty: number): 'attack' | 'garrison' | 'move' {
    const b = this.knownBuildingAt(tx, ty);
    if (b && isMilitary(b) && b.done && b.owner !== LOCAL_PLAYER && !this.world.allied(b.owner, LOCAL_PLAYER)) return 'attack';
    if (b && isMilitary(b) && b.done && b.owner === LOCAL_PLAYER) return 'garrison';
    return 'move';
  }

  /**
   * The cursor hint, as in Settlers 4: with units selected and nothing being placed, what a right
   * click on the hovered tile would do (one label per distinct order). Recomputed only when the
   * hovered tile or the selection changes.
   */
  private updateHint(): void {
    const hover = this.state.hover;
    const show = this.pointer !== null && hover !== null && !this.state.placing && this.state.selectedUnits.length > 0;
    if (!show) {
      this.hint.hidden = true;
      this.hintKey = '';
      return;
    }
    const alt = this.altHeld();
    const key = `${hover.x},${hover.y}|${alt}|${this.state.selectedUnits.join(',')}`;
    if (key !== this.hintKey) {
      this.hintKey = key;
      const { fighters, specialists } = this.selection();
      const labels = new Set<string>();
      if (fighters.length > 0) {
        const o = alt ? 'move' : this.fighterOrderAt(hover.x, hover.y);
        labels.add(o === 'attack' ? 'Атаковать' : o === 'garrison' ? 'В гарнизон' : 'Идти сюда');
      }
      const b = this.knownBuildingAt(hover.x, hover.y);
      for (const id of specialists) {
        const s = this.world.getSettler(id)!;
        const order = SPECIALIST_ORDERS[s.kind];
        labels.add(!alt && order && order.can(this.world, hover.x, hover.y, b, LOCAL_PLAYER) ? order.label : 'Идти сюда');
      }
      this.hint.textContent = [...labels].join(' · ');
    }
    if (!this.hint.textContent) {
      this.hint.hidden = true;
      return;
    }
    const r = this.canvas.getBoundingClientRect();
    const host = this.hint.parentElement!.getBoundingClientRect();
    this.hint.style.left = `${this.pointer!.x + r.left - host.left + 16}px`;
    this.hint.style.top = `${this.pointer!.y + r.top - host.top + 18}px`;
    this.hint.hidden = false;
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

  /** A left-button drag selects units unless something is being placed (then it pans). */
  private selecting(d: { button: number }): boolean {
    return d.button === 0 && !this.state.placing;
  }

  /** The player's own living units among settler ids: fighters and specialists (geologists, pioneers, thieves). */
  private ownUnits(ids: number[]): number[] {
    return ids.filter((id) => {
      const s = this.world.getSettler(id);
      return !!s && s.owner === LOCAL_PLAYER && (isFighter(s) || isSpecialist(s));
    });
  }

  /** The player's own pack donkeys among settler ids (selectable, but they take no orders). */
  private ownDonkeys(ids: number[]): number[] {
    return ids.filter((id) => {
      const s = this.world.getSettler(id);
      return !!s && s.owner === LOCAL_PLAYER && LOOK_ONLY.has(s.kind);
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
      const inRect = this.renderer.settlersInRect(d.startX, d.startY, p.x, p.y);
      let caught = boxType(this.world, this.ownUnits(inRect));
      // Only own pack donkeys in the box: select them to look at (they take no orders).
      if (caught.length === 0) caught = this.ownDonkeys(inRect);
      if (caught.length === 1 && !e.shiftKey && LOOK_ONLY.has(this.world.getSettler(caught[0])!.kind)) {
        this.state.selectedSettler = caught[0];
        this.state.selected = null;
        this.state.selectedUnits = [];
        return;
      }
      const add = e.shiftKey || e.ctrlKey || e.metaKey;
      this.state.selectedUnits = (add ? [...new Set([...this.state.selectedUnits, ...caught])] : caught).slice(0, SELECTION_MAX);
      if (this.state.selectedUnits.length > 0) {
        this.state.selected = null;
        this.state.selectedSettler = null;
      }
      return;
    }
    if (d.moved) return;
    if (d.button === 2) {
      if (this.state.selectedUnits.length > 0 && !this.state.placing) this.order(this.local(e), e.altKey);
      else this.cancel();
      return;
    }
    if (d.button !== 0) return;
    const p = this.local(e);
    const t = this.tileAt(p.x, p.y);
    const { placing } = this.state;
    if (this.state.movingWorkArea !== null) {
      const ok = this.world.setWorkArea(this.state.movingWorkArea, { x: Math.round(t.x), y: Math.round(t.y) });
      this.cb.onMessage(ok ? 'Зона работы перенесена' : 'Слишком далеко от здания');
      if (ok) this.state.movingWorkArea = null;
      return;
    }
    if (placing === 'pioneer') {
      const ok = this.world.sendPioneer(Math.round(t.x), Math.round(t.y));
      this.cb.onMessage(ok ? 'Первопроходец отправлен' : 'Нужна ничейная земля, до которой можно дойти, и свободный первопроходец (заказ — в ⚙)');
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
      const gx = Math.round(t.x);
      const gy = Math.round(t.y);
      const ok = this.world.sendGeologist(gx, gy);
      this.cb.onMessage(ok ? 'Геолог отправлен' : this.geologistBlocker(gx, gy));
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
    if (sid !== null && this.ownUnits([sid]).length > 0) {
      // An own fighter or specialist: select it for orders, with Settlers 4's modifiers (`selection.ts`):
      // Alt — every unit of its type in its sector, Shift — those in the vicinity, Ctrl (⌘) — add or
      // take out; a double click takes all of its kind on screen.
      const now = performance.now();
      const unit = this.world.getSettler(sid)!;
      const kind = unit.kind;
      if (e.altKey) {
        this.state.selectedUnits = sameTypeAround(this.world, unit, SELECT_RADIUS.sector, LOCAL_PLAYER);
      } else if (e.shiftKey) {
        this.state.selectedUnits = sameTypeAround(this.world, unit, SELECT_RADIUS.vicinity, LOCAL_PLAYER);
      } else if (e.ctrlKey || e.metaKey) {
        this.state.selectedUnits = toggleInSelection(this.world, this.state.selectedUnits, unit);
      } else if (this.lastClick.id === sid && now - this.lastClick.at < DOUBLE_CLICK_MS) {
        const [w, h] = this.view;
        this.state.selectedUnits = this.ownUnits(this.renderer.settlersInRect(0, 0, w, h))
          .filter((id) => this.world.getSettler(id)!.kind === kind)
          .slice(0, SELECTION_MAX);
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
   * Right click with units selected, as in Settlers 4. Fighters: on an enemy military building —
   * attack it; on an own military building — go in; anywhere else — move there. Specialists: their
   * kind's action where it is possible (`SPECIALIST_ORDERS`: a geologist prospects a mountain, a
   * pioneer claims neutral land, a thief robs an explored enemy store), else walk there. With Alt
   * (Settlers 4's «go to the location») everyone just walks there.
   */
  private order(p: { x: number; y: number }, walkOnly = false): void {
    const { fighters, specialists } = this.selection();
    const t = this.tileAt(p.x, p.y);
    const tx = Math.round(t.x);
    const ty = Math.round(t.y);
    const b = this.knownBuildingAt(tx, ty);
    const said: string[] = [];
    if (fighters.length > 0) {
      const o = walkOnly ? 'move' : this.fighterOrderAt(tx, ty);
      if (o === 'attack') {
        const n = this.world.orderAttack(fighters, b!.id);
        said.push(n > 0 ? `В атаку: ${n}` : 'Эти бойцы сейчас не могут атаковать');
      } else if (o === 'garrison') {
        const n = this.world.orderGarrison(fighters, b!.id);
        said.push(n > 0 ? `В гарнизон: ${n}` : 'В этом здании нет мест для них');
      } else if (this.world.orderMove(fighters, tx, ty) === 0) {
        said.push('Туда не пройти');
      }
    }
    if (specialists.length > 0) {
      const acting = walkOnly
        ? 0
        : specialists.filter((id) => {
            const s = this.world.getSettler(id)!;
            return SPECIALIST_ORDERS[s.kind]?.can(this.world, tx, ty, b, LOCAL_PLAYER) ?? false;
          }).length;
      const n = this.world.orderSpecialists(specialists, tx, ty, b ? b.id : null, LOCAL_PLAYER, walkOnly);
      if (n === 0) said.push('Туда не пройти');
      else if (acting > 0) said.push(`За работу: ${acting}`);
    }
    if (fighters.length === 0 && specialists.length === 0 && this.state.selectedUnits.length > 0) {
      said.push('Ослы ходят только по маршрутам рынков');
    }
    if (said.length > 0) this.cb.onMessage(said.join(' · '));
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const p = this.local(e);
    this.camera.zoomAt(Math.exp(-e.deltaY * 0.0015), p.x, p.y, ...this.view);
  }

  /** Cancels what is being placed or selected; false if there was nothing to cancel. */
  private cancel(): boolean {
    const s = this.state;
    if (s.movingWorkArea !== null) s.movingWorkArea = null;
    else if (s.placing) this.cb.onSelectBuildType(null);
    else if (s.selected !== null || s.selectedSettler !== null || s.selectedUnits.length > 0) {
      s.selected = null;
      s.selectedSettler = null;
      s.selectedUnits = [];
    } else return false;
    return true;
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    if (e.target instanceof HTMLInputElement) return;
    // The game menu has the keyboard while it is open.
    if (this.state.menu) {
      this.keys.clear();
      return;
    }
    if (down) this.keys.add(e.code);
    else this.keys.delete(e.code);
    if (!down) return;
    switch (e.code) {
      case 'Escape':
        if (!this.cancel()) this.cb.onMenu();
        break;
      case 'Space':
        // Settlers 4: Space jumps to the last message (pressed again, the one before).
        e.preventDefault();
        if (!this.cb.onLastMessage()) this.cb.onMessage('Сообщений нет');
        break;
      case 'KeyP':
      case 'Pause':
        e.preventDefault();
        this.state.paused = !this.state.paused;
        break;
      case 'Tab':
        e.preventDefault();
        this.cb.onNextTab();
        break;
      case 'AltLeft':
      case 'AltRight':
        // Alt is a selection and order modifier here (Settlers 4); keep the browser's menu bar shut.
        e.preventDefault();
        break;
      case 'Backspace':
        // Settlers 4: Backspace takes the healthy units out of the selection, the wounded stay.
        if (this.state.selectedUnits.length > 0) {
          e.preventDefault();
          const before = this.state.selectedUnits.length;
          this.state.selectedUnits = withoutHealthy(this.world, this.state.selectedUnits);
          const left = this.state.selectedUnits.length;
          this.cb.onMessage(left > 0 ? `Раненых в выделении: ${left} (здоровых убрано: ${before - left})` : 'Раненых в выделении нет');
        }
        break;
      default: {
        const m = /^Digit([1-9])$/.exec(e.code);
        if (!m) break;
        const n = Number(m[1]);
        // Ctrl+digit stores the selection as a control group; a digit recalls a stored group, and
        // only picks a building of the open build tab when no group is stored under it.
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          this.storeGroup(n);
        } else if (!this.recallGroup(n)) {
          this.cb.onHotkey(n);
        }
      }
    }
  }

  /** Ctrl+digit: the selected units (fighters, specialists, donkeys) become control group `n`. */
  private storeGroup(n: number): void {
    const ids = this.state.selectedUnits.filter((id) => this.ownLiving(id));
    this.state.groups[n] = ids;
    this.cb.onMessage(ids.length > 0 ? `Группа ${n}: ${ids.length}` : `Группа ${n} очищена`);
  }

  /**
   * Digit: selects control group `n` if one is stored (dead or lost units drop out); a second press
   * soon after centres the camera on it. Returns false when no living unit is in the group.
   */
  private recallGroup(n: number): boolean {
    const ids = (this.state.groups[n] ?? []).filter((id) => this.ownLiving(id));
    this.state.groups[n] = ids;
    if (ids.length === 0) return false;
    this.state.selectedUnits = [...ids];
    this.state.selected = null;
    this.state.selectedSettler = null;
    this.cb.onSelectBuildType(null);
    const now = performance.now();
    if (this.lastRecall.n === n && now - this.lastRecall.at < DOUBLE_TAP_MS) {
      let x = 0;
      let y = 0;
      for (const id of ids) {
        const s = this.world.getSettler(id)!;
        x += s.x;
        y += s.y;
      }
      x /= ids.length;
      y /= ids.length;
      const p = toScreen(x, y);
      this.camera.centerOn(p.x, p.y - this.world.map.heightAt(x, y));
      this.lastRecall = { at: -Infinity, n: -1 };
    } else {
      this.lastRecall = { at: now, n };
    }
    return true;
  }

  private altHeld(): boolean {
    return this.keys.has('AltLeft') || this.keys.has('AltRight');
  }

  private ownLiving(id: number): boolean {
    const s = this.world.getSettler(id);
    return !!s && !this.world.dying.has(id) && s.owner === LOCAL_PLAYER;
  }
}

/**
 * What a selection box takes, as Settlers 4's `BoxSelection`: the highest category among the units in
 * it — fighters (every kind together) before specialists —, and of specialists one kind only (the
 * first found). At most `SELECTION_MAX`.
 */
function boxType(w: World, ids: number[]): number[] {
  const fighters = ids.filter((id) => isFighter(w.getSettler(id)!));
  if (fighters.length > 0) return fighters.slice(0, SELECTION_MAX);
  if (ids.length === 0) return ids;
  const kind = w.getSettler(ids[0])!.kind;
  return ids.filter((id) => w.getSettler(id)!.kind === kind).slice(0, SELECTION_MAX);
}
