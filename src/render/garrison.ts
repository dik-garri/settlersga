/**
 * The garrison on a military building's top, as in Settlers 4: the fighters inside stand on the
 * platform behind the parapet, looking out and now and then glancing round; garrison archers turn to
 * whoever they shoot at, draw and loose (`work:shoot`), and swordsmen brandish their swords while the
 * building is assaulted. Render-only: it reads `Building.garrison`, the fighters' `inside` and
 * `reload`, `World.shots` (`by`, `from`) and the attackers' `assault` tasks.
 *
 * Posts come from the art: `ART3D_POSTS` (recorded by Blender, with the parts before them drawn again
 * over the figures as `front:<type>`) or `GARRISON_POSTS` (classic art, where each figure is cut off
 * at its parapet line instead). Figures live in a layer of the building's body container, so they cull
 * with it; they are pooled, posed only while the building is on screen, and given back to the pool
 * when it is not. Nothing is allocated per frame.
 */
import { Container, Rectangle, Sprite, Texture } from 'pixi.js';
import { PROFESSIONS } from '../sim/config';
import type { Building, BuildingType, PlayerId, Settler } from '../sim/types';
import type { World } from '../sim/world';
import type { SettlerTextures } from './atlas';
import { dirTowards, FACES_AWAY, idleDir, MIRRORED, PAINTED_DIR, WALK_FRAMES, workFrame } from './anim';
import { ACTIONS, styleOf, type ActionId } from './animConfig';
import { ART3D_POSTS, SETTLER_3D_SCALE, type GarrisonPost } from './art3d';
import { holdFrames, setFrame, workFrames, type Settler3d } from './settler3d';
import { BODY_STAND, BODY_WORK } from './settlerArt';
import { GARRISON_POSTS } from './sprites';

/** Figures on a top are drawn a little smaller than on the ground, so a few fit on a small platform. */
const CREW_SCALE = 0.9;
/** How long after his shot an archer shows the loosed bow (ms). */
const LOOSE_MS = 260;
/** An archer who shot within this long stays at the ready, drawing for his next shot (ms). */
const READY_MS = 4000;
/** Height of the bow over a figure's feet at ground scale (px), where his arrows leave. */
const BOW_HEIGHT = 18;

interface Figure {
  root: Container;
  body: Sprite;
  tunic: Sprite;
  head: Sprite;
  hat: Sprite;
  arm: Sprite;
  /** Settler shown (0: none). */
  id: number;
  armBehind: boolean;
}

interface Crew {
  /** The building's body container; the crew layer is one of its children. */
  body: Container;
  layer: Container;
  /** What stands before the posts, drawn over the figures (3D art), shown once the building is done. */
  front: Sprite | null;
  posts: readonly GarrisonPost[];
  figures: Figure[];
}

/** When a garrison archer last shot (ms) and where his target stood (tiles). */
interface LastShot {
  ms: number;
  x: number;
  y: number;
}

export class GarrisonLayer {
  /**
   * Buildings under assault this frame → one attacker at them (filled by the renderer's pass over the
   * settlers, which runs before `sync`).
   */
  readonly assaulted = new Map<number, number>();
  private readonly crews = new Map<number, Crew>();
  private readonly pool: Figure[] = [];
  /** Settler id → his figure on a top now. */
  private readonly shown = new Map<number, Figure>();
  private readonly shots = new Map<number, LastShot>();
  private lastShotTick = -1;
  private lastPrune = 0;
  /** Classic art: textures cut off `cut` px above the feet, per cut. */
  private readonly crops = new Map<number, Map<Texture, Texture | null>>();
  private readonly members: Settler[] = [];
  private readonly hatTints = new Map<string, number>();

  constructor(
    private readonly sim: World,
    private readonly s3d: Settler3d | null,
    private readonly tex: SettlerTextures,
    private readonly playerTint: readonly number[],
    private readonly me: PlayerId,
    private readonly fogOn: boolean,
  ) {}

  /** Where a building type's garrison stands in the current art (null: none shown). */
  postsOf(type: BuildingType): readonly GarrisonPost[] | null {
    return (this.s3d ? ART3D_POSTS[type] : GARRISON_POSTS[type]) ?? null;
  }

  /**
   * Gives a new building view its crew layer (after whatever `body` holds so far) and, with the 3D art,
   * the overlay of what stands before the posts. Returns the layer — the banner goes in it, so figures
   * behind the pole stand behind its cloth — or null for a building without posts.
   */
  attach(b: Building, body: Container, front: Texture | null): Container | null {
    const posts = this.postsOf(b.type);
    if (!posts) return null;
    const layer = new Container();
    layer.sortableChildren = true;
    body.addChild(layer);
    let over: Sprite | null = null;
    if (front) {
      over = new Sprite(front);
      over.anchor.copyFrom(front.defaultAnchor!);
      over.visible = b.done;
      body.addChild(over);
    }
    this.crews.set(b.id, { body, layer, front: over, posts, figures: [] });
    return layer;
  }

  /** The building is gone: its figures go back to the pool. */
  detach(id: number): void {
    const crew = this.crews.get(id);
    if (!crew) return;
    while (crew.figures.length > 0) this.release(crew.figures.pop()!);
    this.crews.delete(id);
  }

  /** Where garrison archer `id`'s arrows leave his bow (world px), when his figure is drawn. */
  shooter(id: number, out: { x: number; y: number }): boolean {
    const fig = this.shown.get(id);
    if (!fig || !fig.root.parent) return false;
    const body = fig.root.parent.parent;
    if (!body) return false;
    out.x = body.x + fig.root.x;
    out.y = body.y + fig.root.y - BOW_HEIGHT * (this.s3d ? CREW_SCALE : 1);
    return true;
  }

  sync(timeMs: number): void {
    this.noteShots(timeMs);
    for (const [id, crew] of this.crews) {
      const b = this.sim.buildings.get(id);
      if (!b) continue;
      if (crew.front) crew.front.visible = b.done;
      // Only for buildings on screen (their body in the scene and explored), and someone else's only
      // while in sight.
      const show =
        b.done &&
        crew.body.parent !== null &&
        crew.body.visible &&
        (b.owner === this.me || !this.fogOn || this.sim.isVisible(b.door.x, b.door.y, this.me));
      const n = show ? this.collect(b, crew.posts.length) : 0;
      while (crew.figures.length > n) this.release(crew.figures.pop()!);
      while (crew.figures.length < n) {
        const fig = this.take();
        crew.layer.addChild(fig.root);
        crew.figures.push(fig);
      }
      for (let k = 0; k < n; k++) this.pose(crew.figures[k], this.members[k], crew.posts[k], b, timeMs);
    }
  }

  /** New shots from garrisons: the archer turns to his target and looses. */
  private noteShots(timeMs: number): void {
    let newest = this.lastShotTick;
    for (const shot of this.sim.shots) {
      if (shot.tick <= this.lastShotTick || shot.from === undefined) continue;
      newest = Math.max(newest, shot.tick);
      const last = this.shots.get(shot.by);
      if (last) {
        last.ms = timeMs;
        last.x = shot.x1;
        last.y = shot.y1;
      } else this.shots.set(shot.by, { ms: timeMs, x: shot.x1, y: shot.y1 });
    }
    this.lastShotTick = Math.max(this.lastShotTick, newest);
    if (timeMs - this.lastPrune > READY_MS) {
      this.lastPrune = timeMs;
      for (const [id, last] of this.shots) if (timeMs - last.ms > READY_MS) this.shots.delete(id);
    }
  }

  /** The fighters inside who show, archers first (they are the ones who act from the top), into `members`. */
  private collect(b: Building, max: number): number {
    const out = this.members;
    out.length = 0;
    for (let pass = 0; pass < 2; pass++) {
      for (const id of b.garrison) {
        if (out.length >= max) return out.length;
        const s = this.sim.getSettler(id);
        if (!s || s.inside !== b.id) continue;
        if (!!PROFESSIONS[s.kind].combat?.ranged === (pass === 0)) out.push(s);
      }
    }
    return out.length;
  }

  private take(): Figure {
    const fig = this.pool.pop();
    if (fig) return fig;
    const root = new Container();
    const body = new Sprite();
    const tunic = new Sprite();
    const head = new Sprite();
    const hat = new Sprite();
    const arm = new Sprite();
    root.addChild(body, tunic, head, hat, arm);
    return { root, body, tunic, head, hat, arm, id: 0, armBehind: false };
  }

  private release(fig: Figure): void {
    fig.root.removeFromParent();
    if (this.shown.get(fig.id) === fig) this.shown.delete(fig.id);
    fig.id = 0;
    this.pool.push(fig);
  }

  private pose(fig: Figure, s: Settler, post: GarrisonPost, b: Building, timeMs: number): void {
    if (fig.id !== s.id) {
      if (this.shown.get(fig.id) === fig) this.shown.delete(fig.id);
      fig.id = s.id;
    }
    this.shown.set(s.id, fig);
    fig.root.position.set(post.x, post.y);
    fig.root.zIndex = post.y;
    const style = styleOf(s.kind);
    const combat = PROFESSIONS[s.kind].combat;
    const cx = b.x + (b.w - 1) / 2;
    const cy = b.y + (b.h - 1) / 2;
    let dir = post.dir;
    let action: ActionId | null = null;
    let f = 0;
    const shot = combat?.ranged ? this.shots.get(s.id) : undefined;
    const foe = this.sim.getSettler(this.assaulted.get(b.id) ?? null);
    if (shot && timeMs - shot.ms < READY_MS) {
      // Turned to his target: the loosed bow just after a shot, then drawing again as he reloads.
      dir = dirTowards(cx, cy, shot.x, shot.y, dir);
      action = 'shoot';
      const left = s.reload / Math.max(1, combat!.every);
      f = timeMs - shot.ms < LOOSE_MS ? 3 : left > 0.6 ? 0 : left > 0.25 ? 1 : 2;
    } else if (foe) {
      // The building is assaulted: archers aim, swordsmen brandish their swords at the attackers.
      dir = dirTowards(cx, cy, foe.x, foe.y, dir);
      action = combat?.ranged ? 'shoot' : style.work;
      f = combat?.ranged ? 2 : workFrame(timeMs, s.id, ACTIONS[action].loopMs * 1.6);
    } else dir = idleDir(timeMs, s.id, post.dir);
    const tint = this.playerTint[(s.owner - 1) % this.playerTint.length];
    const hatStyle = style.levelHats?.[s.level] ?? style.hatStyle;
    const s3d = this.s3d;
    if (s3d) {
      const fr = action ? workFrames(s3d, action, style.outfit)[dir][f] : holdFrames(s3d, style.holds, style.outfit)[dir][WALK_FRAMES];
      setFrame(fig.body, fr.full);
      fig.tunic.visible = fr.tint !== null;
      if (fr.tint) setFrame(fig.tunic, fr.tint);
      fig.tunic.tint = tint;
      fig.head.visible = false;
      const hat = s3d.hats[hatStyle][dir];
      fig.hat.visible = hat !== null;
      if (hat) {
        setFrame(fig.hat, hat);
        fig.hat.position.set(fr.hatAt[0], fr.hatAt[1]);
      }
      fig.hat.tint = style.fighter ? 0xffffff : this.hatTint(style.hat);
      fig.arm.visible = fr.over !== null && hat !== null;
      if (fr.over && hat) setFrame(fig.arm, fr.over);
      fig.root.scale.set(SETTLER_3D_SCALE * CREW_SCALE);
      return;
    }
    // Classic layered figure, cut off where the parapet before him ends.
    const tex = this.tex;
    const pd = PAINTED_DIR[dir];
    const cut = post.cut ?? 0;
    this.put(fig.body, action ? tex.body[pd][BODY_WORK] : tex.body[pd][BODY_STAND], cut);
    this.put(fig.arm, action ? tex.workArm[action][pd][f] : tex.holdArm[style.holds][pd][WALK_FRAMES], cut);
    this.put(fig.tunic, tex.tunic[pd], cut);
    this.put(fig.head, tex.head[pd], cut);
    this.put(fig.hat, tex.hat[hatStyle][pd], cut);
    fig.tunic.tint = tint;
    fig.hat.tint = this.hatTint(style.hat);
    const behind = FACES_AWAY[pd];
    if (behind !== fig.armBehind) {
      fig.armBehind = behind;
      fig.root.setChildIndex(fig.arm, behind ? 0 : 4);
    }
    fig.root.scale.set(MIRRORED[dir] ? -1 : 1, 1);
  }

  private hatTint(hex: string): number {
    let t = this.hatTints.get(hex);
    if (t === undefined) {
      t = Number.parseInt(hex.slice(1), 16);
      this.hatTints.set(hex, t);
    }
    return t;
  }

  /** Shows `t` on a layer, cut off `cut` px above the feet (hidden when nothing of it is left). */
  private put(sprite: Sprite, t: Texture, cut: number): void {
    const c = cut > 0 ? this.crop(t, cut) : t;
    sprite.visible = c !== null;
    if (c) setFrame(sprite, c);
  }

  /** The part of a figure layer above the line `cut` px over its anchor (the feet); cached. */
  private crop(t: Texture, cut: number): Texture | null {
    let byTex = this.crops.get(cut);
    if (!byTex) {
      byTex = new Map();
      this.crops.set(cut, byTex);
    }
    const known = byTex.get(t);
    if (known !== undefined) return known;
    const f = t.frame;
    const anchor = t.defaultAnchor ?? { x: 0, y: 0 };
    const feet = anchor.y * f.height;
    const keep = feet - cut;
    const c =
      keep <= 0
        ? null
        : keep >= f.height
          ? t
          : new Texture({ source: t.source, frame: new Rectangle(f.x, f.y, f.width, keep), defaultAnchor: { x: anchor.x, y: feet / keep } });
    byTex.set(t, c);
    return c;
  }
}
