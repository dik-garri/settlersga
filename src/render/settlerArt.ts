/**
 * Layered, direction-aware settler art. A settler on screen is a stack of small sprites — body
 * (legs, far arm, shadow), tunic, head, hat, near arm with tool — drawn for five painted
 * directions (the three westward ones are mirrors). Tunic and hat are painted in greys and tinted
 * per profession or player at runtime, so professions and players add no textures.
 *
 * Geometry: a figure faces ground direction f = (cos θ, sin θ) with lateral p = (−sin θ, cos θ);
 * a ground offset (gx, gy) at height z projects to screen (gx, gy / 2 − z). Feet at the origin.
 */
import { PAINTED_ANGLE, FACES_AWAY, WALK_FRAMES, WORK_FRAMES } from './anim';
import { ACTIONS, type ActionId, type HatStyle, type ToolShape } from './animConfig';

type Ctx = CanvasRenderingContext2D;

/** Sprite box of every settler layer and its anchor (the feet). */
export const SETTLER_W = 26;
export const SETTLER_H = 38;
export const SETTLER_AX = 13;
export const SETTLER_AY = 34;

/** Body frames: walk 0..3, then stand, then a braced work stance. */
export const BODY_STAND = WALK_FRAMES;
export const BODY_WORK = WALK_FRAMES + 1;
export const BODY_FRAMES = WALK_FRAMES + 2;

const SKIN = '#efc49c';
const SKIN_DARK = '#d9a77c';
const TROUSERS = '#3b3128';
const BOOTS = '#2a221c';

interface Frame {
  f: [number, number];
  p: [number, number];
}

function frameOf(pd: number): Frame {
  const t = PAINTED_ANGLE[pd];
  return { f: [Math.cos(t), Math.sin(t)], p: [-Math.sin(t), Math.cos(t)] };
}

function proj(gx: number, gy: number, z: number): [number, number] {
  return [gx, gy / 2 - z];
}

/** Lateral side (+1/−1) of the arm and leg nearer to the camera. */
function nearSide(fr: Frame): number {
  return fr.p[1] >= 0 ? 1 : -1;
}

const SHOULDER_Z = 16;
const ARM_LENGTH = 6.4;

/** Near shoulder on screen, relative to the settler's anchor (feet). */
function shoulderPoint(pd: number): [number, number] {
  const fr = frameOf(pd);
  const sn = nearSide(fr);
  return proj(sn * fr.p[0] * 3, sn * fr.p[1] * 3, SHOULDER_Z);
}

/** Near hand on screen, relative to the anchor, for an arm angle in turns of π (see `ActionDef.arm`). */
export function handPoint(pd: number, armTurns: number): [number, number] {
  const fr = frameOf(pd);
  const sn = nearSide(fr);
  const a = armTurns * Math.PI;
  return proj(
    sn * fr.p[0] * 3 + fr.f[0] * Math.sin(a) * ARM_LENGTH,
    sn * fr.p[1] * 3 + fr.f[1] * Math.sin(a) * ARM_LENGTH,
    SHOULDER_Z - Math.cos(a) * ARM_LENGTH,
  );
}

/** Arm angle of a carrier: forearm forward, goods held in front of the chest. */
export const CARRY_TURNS = 0.42;

/**
 * Where carried goods sit, per painted direction, relative to the anchor: in front of the body
 * between both hands, so they hide behind it when the settler walks away from the camera.
 */
export const CARRY_AT: readonly [number, number][] = PAINTED_ANGLE.map((_, pd) => {
  const fr = frameOf(pd);
  return proj(fr.f[0] * 4.5, fr.f[1] * 4.5, 12);
});

function stroke(ctx: Ctx, a: [number, number], b: [number, number], color: string, width: number): void {
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(a[0], a[1]);
  ctx.lineTo(b[0], b[1]);
  ctx.stroke();
}

// Walk cycle: leg swing along the facing (ground units) and foot lift, for the near leg; the far
// leg is half a cycle apart.
const SWING = [2.6, 0, -2.6, 0];
const LIFT = [0, 0, 0, 1.6];

function legPose(frame: number, near: boolean): { swing: number; lift: number } {
  if (frame >= WALK_FRAMES) {
    const apart = frame === BODY_WORK ? 1.4 : 0.4;
    return { swing: near ? apart : -apart, lift: 0 };
  }
  const k = near ? frame : (frame + 2) % WALK_FRAMES;
  return { swing: SWING[k], lift: LIFT[k] };
}

/** Near-arm angle (turns of π) while walking or standing with nothing in particular to do. */
export function walkArm(frame: number): number {
  if (frame >= WALK_FRAMES) return 0.04;
  return [-0.2, 0, 0.2, 0][frame];
}

/** Shadow, legs and the far arm. */
export function paintBody(ctx: Ctx, pd: number, frame: number): void {
  const fr = frameOf(pd);
  const sn = nearSide(fr);
  ctx.translate(SETTLER_AX, SETTLER_AY);
  ctx.beginPath();
  ctx.ellipse(1, 0, 6.5, 2.4, 0, 0, Math.PI * 2);
  ctx.fillStyle = 'rgba(0,0,0,0.26)';
  ctx.fill();

  // Far arm first: it is behind the torso.
  const farA = (frame < WALK_FRAMES ? -walkArm(frame) : 0.06) * Math.PI;
  const shoulder: [number, number] = [-sn * fr.p[0] * 3, -sn * fr.p[1] * 3];
  const s0 = proj(shoulder[0], shoulder[1], 16);
  const handG: [number, number] = [shoulder[0] + fr.f[0] * Math.sin(farA) * 6.2, shoulder[1] + fr.f[1] * Math.sin(farA) * 6.2];
  const s1 = proj(handG[0], handG[1], 16 - Math.cos(farA) * 6.2);
  stroke(ctx, s0, s1, SKIN_DARK, 2.1);

  // Legs, farther one first.
  const legs = [-sn, sn].map((side) => {
    const near = side === sn;
    const { swing, lift } = legPose(frame, near);
    const hip: [number, number] = [side * fr.p[0] * 1.7, side * fr.p[1] * 1.7];
    const foot: [number, number] = [hip[0] + fr.f[0] * swing, hip[1] + fr.f[1] * swing];
    return { hip, foot, lift, depth: foot[1] };
  });
  legs.sort((a, b) => a.depth - b.depth);
  for (const l of legs) {
    const h = proj(l.hip[0], l.hip[1], 9);
    const ft = proj(l.foot[0], l.foot[1], l.lift);
    stroke(ctx, h, ft, TROUSERS, 2.5);
    // Boot pointing along the facing.
    const toe = proj(l.foot[0] + fr.f[0] * 1.4, l.foot[1] + fr.f[1] * 1.4, l.lift);
    stroke(ctx, ft, toe, BOOTS, 2.2);
  }
}

/** Tunic, painted in greys for tinting. */
export function paintTunic(ctx: Ctx, pd: number): void {
  const fr = frameOf(pd);
  ctx.translate(SETTLER_AX, SETTLER_AY);
  const half = 2.4 + 1.5 * Math.abs(fr.p[0]);
  const hem = half + 0.9;
  const lean = fr.f[0] * 0.4;
  ctx.beginPath();
  ctx.moveTo(-hem, -7.6);
  ctx.lineTo(hem, -7.6);
  ctx.lineTo(half + lean, -17.2);
  ctx.lineTo(-half + lean, -17.2);
  ctx.closePath();
  ctx.fillStyle = '#d6d6d6';
  ctx.fill();
  // Light from the top-left: the left half is brighter.
  ctx.beginPath();
  ctx.moveTo(0, -7.6);
  ctx.lineTo(hem, -7.6);
  ctx.lineTo(half + lean, -17.2);
  ctx.lineTo(lean, -17.2);
  ctx.closePath();
  ctx.fillStyle = '#b4b4b4';
  ctx.fill();
  // Belt and collar.
  ctx.fillStyle = '#6e6e6e';
  ctx.fillRect(-hem + 0.4, -10.4, (hem - 0.4) * 2, 1.4);
  ctx.fillStyle = '#ffffff';
  ctx.globalAlpha = 0.5;
  ctx.fillRect(-half + lean + 0.5, -16.8, half * 0.7, 1.1);
  ctx.globalAlpha = 1;
}

/** Head with a face where the figure looks towards the camera. */
export function paintHead(ctx: Ctx, pd: number): void {
  const fr = frameOf(pd);
  ctx.translate(SETTLER_AX, SETTLER_AY);
  ctx.fillStyle = SKIN;
  ctx.fillRect(-1.1, -18.6, 2.2, 1.6); // neck
  ctx.beginPath();
  ctx.arc(fr.f[0] * 0.4, -20.8, 3.5, 0, Math.PI * 2);
  ctx.fill();
  const facing = fr.f[1] > -0.2;
  if (!facing) {
    // Back of the head: hair.
    ctx.fillStyle = '#5a3d22';
    ctx.beginPath();
    ctx.arc(fr.f[0] * 0.4, -20.6, 3.3, 0, Math.PI);
    ctx.fill();
    return;
  }
  ctx.fillStyle = '#2a1e16';
  for (const side of [-1, 1]) {
    const gx = fr.f[0] * 2.4 + side * fr.p[0] * 1.3;
    // An eye on the far side of a profile is hidden.
    if (Math.abs(fr.p[0]) < 0.3 && side !== 1) continue;
    ctx.fillRect(gx + fr.f[0] * 0.4 - 0.5, -21.4, 1, 1.1);
  }
  // Nose and cheeks.
  ctx.fillStyle = SKIN_DARK;
  ctx.fillRect(fr.f[0] * 3.1 + fr.f[0] * 0.4 - 0.4, -20.5, 0.9, 1);
}

/** Headwear, painted in greys for tinting (except the bare-headed hair). */
export function paintHat(ctx: Ctx, pd: number, style: HatStyle): void {
  const fr = frameOf(pd);
  ctx.translate(SETTLER_AX, SETTLER_AY);
  const cx = fr.f[0] * 0.4;
  const brim = (len: number, w: number, color: string) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.ellipse(cx + fr.f[0] * len * 0.5, -22.2 + fr.f[1] * 0.4, w, w * 0.32 + Math.abs(fr.f[1]) * 0.6, 0, 0, Math.PI * 2);
    ctx.fill();
  };
  switch (style) {
    case 'cap':
      ctx.fillStyle = '#c8c8c8';
      ctx.beginPath();
      ctx.arc(cx, -21.6, 3.7, Math.PI, 0);
      ctx.fill();
      brim(3, 2.6, '#a8a8a8');
      return;
    case 'straw':
      brim(0, 6, '#d2d2d2');
      ctx.fillStyle = '#bcbcbc';
      ctx.beginPath();
      ctx.arc(cx, -22.2, 3, Math.PI, 0);
      ctx.fill();
      ctx.fillStyle = '#8a8a8a';
      ctx.fillRect(cx - 3, -22.6, 6, 0.8);
      return;
    case 'galea2':
    case 'galea3': {
      // A fighter's helmet with a crest front to back: small at level 2, tall at level 3.
      const tall = style === 'galea3';
      ctx.fillStyle = '#f2f2f2';
      ctx.beginPath();
      ctx.ellipse(cx - fr.f[0] * 0.4, tall ? -26.2 : -25, 1 + Math.abs(fr.f[0]) * (tall ? 2.6 : 1.6), tall ? 2.6 : 1.4, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    // falls through: the helmet itself
    case 'galea1':
    case 'helmet':
      ctx.fillStyle = '#d0d0d0';
      ctx.beginPath();
      ctx.arc(cx, -21.4, 4, Math.PI, 0);
      ctx.fill();
      ctx.fillStyle = '#9a9a9a';
      ctx.fillRect(cx - 4.3, -21.6, 8.6, 1.2);
      if (fr.f[1] > -0.2) ctx.fillRect(cx + fr.f[0] * 2.6 - 0.4, -21.4, 0.8, 2.6); // nose guard
      ctx.fillStyle = '#f2f2f2';
      ctx.fillRect(cx - 2, -24.6, 1.4, 1.2);
      return;
    case 'plume':
      ctx.fillStyle = '#d0d0d0';
      ctx.beginPath();
      ctx.arc(cx, -21.4, 4, Math.PI, 0);
      ctx.fill();
      ctx.fillStyle = '#9a9a9a';
      ctx.fillRect(cx - 4.3, -21.6, 8.6, 1.2);
      // Crest and plume (tinted with the hat colour).
      ctx.fillStyle = '#f2f2f2';
      ctx.beginPath();
      ctx.ellipse(cx - fr.f[0] * 0.6, -26.6, 1.6 + Math.abs(fr.f[0]) * 2.2, 2.4, 0, 0, Math.PI * 2);
      ctx.fill();
      return;
    case 'hood':
      ctx.fillStyle = '#c4c4c4';
      ctx.beginPath();
      ctx.arc(cx - fr.f[0] * 0.6, -21, 4.2, Math.PI * 0.95, Math.PI * 2.05);
      ctx.fill();
      ctx.beginPath();
      ctx.moveTo(cx - fr.f[0] * 3.6 - 1, -21);
      ctx.lineTo(cx - fr.f[0] * 4.4, -16.8);
      ctx.lineTo(cx - fr.f[0] * 2 + 1.5, -18.6);
      ctx.closePath();
      ctx.fill();
      return;
    case 'chef':
      ctx.fillStyle = '#e8e8e8';
      ctx.fillRect(cx - 2.8, -28, 5.6, 6);
      ctx.beginPath();
      ctx.arc(cx, -28, 3.2, Math.PI, 0);
      ctx.fill();
      ctx.fillStyle = '#c8c8c8';
      ctx.fillRect(cx - 3.2, -22.8, 6.4, 1.2);
      return;
    case 'bare':
      ctx.fillStyle = '#6b4423';
      ctx.beginPath();
      ctx.arc(cx, -21.4, 3.6, Math.PI, 0);
      ctx.fill();
      return;
  }
}

const STEEL = '#c9ced4';
const STEEL_DARK = '#7d838a';
const WOOD = '#7a5530';

/**
 * Near arm and its tool. `armTurns` is the arm angle in turns of π (0 down, 0.5 forward, 1 up),
 * `pull` the bow draw (0..1).
 */
export function paintArm(ctx: Ctx, pd: number, armTurns: number, tool: ToolShape, pull = 0): void {
  const fr = frameOf(pd);
  ctx.translate(SETTLER_AX, SETTLER_AY);
  const s0 = shoulderPoint(pd);
  const h = handPoint(pd, armTurns);
  // Screen direction of the arm (shoulder → hand) and its perpendicular towards the facing.
  let dx = h[0] - s0[0];
  let dy = h[1] - s0[1];
  const len = Math.hypot(dx, dy) || 1;
  dx /= len;
  dy /= len;
  const fx = fr.f[0];
  const fy = fr.f[1] / 2;
  // Perpendicular to the arm, picked to point roughly along the facing on screen.
  let nx = -dy;
  let ny = dx;
  if (nx * fx + ny * fy < 0) {
    nx = -nx;
    ny = -ny;
  }
  const at = (k: number, m = 0): [number, number] => [h[0] + dx * k + nx * m, h[1] + dy * k + ny * m];

  const drawTool = () => {
    switch (tool) {
      case 'axe':
        stroke(ctx, at(-2), at(5), WOOD, 1.4);
        ctx.fillStyle = STEEL;
        poly(ctx, [at(3.2, 0.3), at(5.4, 0.3), at(5.8, 3.4), at(2.8, 3.2)]);
        return;
      case 'hammer':
        stroke(ctx, at(-1.5), at(4), WOOD, 1.4);
        ctx.fillStyle = STEEL_DARK;
        poly(ctx, [at(3.2, -1.6), at(5.2, -1.6), at(5.2, 2.2), at(3.2, 2.2)]);
        return;
      case 'pick':
        stroke(ctx, at(-2), at(5.5), WOOD, 1.4);
        ctx.strokeStyle = STEEL;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(...at(4.2, -4));
        ctx.quadraticCurveTo(...at(6.4, 0), ...at(4.2, 4));
        ctx.stroke();
        return;
      case 'shovel':
        stroke(ctx, at(-4), at(6), WOOD, 1.3);
        ctx.fillStyle = STEEL;
        ctx.beginPath();
        ctx.ellipse(...at(7.6), 1.8, 2.4, Math.atan2(dy, dx), 0, Math.PI * 2);
        ctx.fill();
        return;
      case 'scythe':
        stroke(ctx, at(-5), at(6.5), WOOD, 1.3);
        ctx.strokeStyle = STEEL;
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        ctx.moveTo(...at(6.5));
        ctx.quadraticCurveTo(...at(7.5, 4.5), ...at(4, 7));
        ctx.stroke();
        return;
      case 'rod': {
        const tip = at(11, 2);
        stroke(ctx, at(-1.5), tip, '#8a6a3c', 1);
        ctx.strokeStyle = 'rgba(240,236,220,0.85)';
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(tip[0], tip[1]);
        ctx.lineTo(tip[0] + 0.6, tip[1] + 10);
        ctx.stroke();
        return;
      }
      case 'bucket':
        ctx.fillStyle = '#7a8a96';
        ctx.fillRect(h[0] - 2.4, h[1] + 0.6, 4.8, 4.2);
        ctx.fillStyle = '#4f8fbd';
        ctx.fillRect(h[0] - 2, h[1] + 0.6, 4, 1.2);
        stroke(ctx, [h[0] - 2.4, h[1] + 0.8], [h[0], h[1] - 1], '#4a4f55', 0.6);
        stroke(ctx, [h[0] + 2.4, h[1] + 0.8], [h[0], h[1] - 1], '#4a4f55', 0.6);
        return;
      case 'sword':
        stroke(ctx, at(-1.2), at(0.8), '#6b4a26', 1.6);
        stroke(ctx, at(0.2, -1.8), at(0.2, 1.8), '#b08a3c', 1.2);
        stroke(ctx, at(0.8), at(9), STEEL, 1.4);
        stroke(ctx, at(1), at(8.6), '#ffffff', 0.5);
        return;
      case 'bow': {
        // Bow held across the hand, opening towards the body; the string is drawn back by `pull`.
        const top = at(0, -5.5);
        const bottom = at(0, 5.5);
        const belly = at(2.6, 0);
        ctx.strokeStyle = '#7a4a22';
        ctx.lineWidth = 1.3;
        ctx.beginPath();
        ctx.moveTo(top[0], top[1]);
        ctx.quadraticCurveTo(belly[0], belly[1], bottom[0], bottom[1]);
        ctx.stroke();
        const nock = at(-1 - pull * 4.5, 0);
        ctx.strokeStyle = '#ece6d4';
        ctx.lineWidth = 0.5;
        ctx.beginPath();
        ctx.moveTo(top[0], top[1]);
        ctx.lineTo(nock[0], nock[1]);
        ctx.lineTo(bottom[0], bottom[1]);
        ctx.stroke();
        if (pull > 0) stroke(ctx, nock, at(5.5, 0), '#d9c39a', 0.8);
        return;
      }
      case 'carry':
      case 'none':
        return;
    }
  };

  // Tools that hang below the hand are drawn after the arm; the rest before, so the fist covers the grip.
  const toolFirst = tool !== 'bucket' && tool !== 'bow';
  if (toolFirst) drawTool();
  stroke(ctx, s0, h, SKIN, 2.2);
  ctx.fillStyle = SKIN_DARK;
  ctx.beginPath();
  ctx.arc(h[0], h[1], 1.15, 0, Math.PI * 2);
  ctx.fill();
  if (!toolFirst) drawTool();
}

function poly(ctx: Ctx, pts: [number, number][]): void {
  ctx.beginPath();
  pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
  ctx.closePath();
  ctx.fill();
}

/** Arm angle (turns) and bow pull for a work action frame. */
export function actionPose(action: ActionId, frame: number): { arm: number; pull: number } {
  const def = ACTIONS[action];
  const pull = 'pull' in def && def.pull ? def.pull[frame % WORK_FRAMES] : 0;
  return { arm: def.arm[frame % WORK_FRAMES], pull };
}

/** Arm angle (turns) while walking or standing with a tool: carriers hold their load overhead. */
export function holdPose(tool: ToolShape, frame: number): number {
  if (tool === 'carry') return CARRY_TURNS;
  if (tool === 'bow') return 0.3 + (frame < WALK_FRAMES ? walkArm(frame) * 0.3 : 0);
  if (tool === 'rod' || tool === 'scythe' || tool === 'pick' || tool === 'axe' || tool === 'shovel') {
    // Long tools rest on the shoulder.
    return 0.82;
  }
  return walkArm(frame);
}

/** Whether the near arm and tool go behind the body in this painted direction. */
export function armBehind(pd: number): boolean {
  return FACES_AWAY[pd];
}

/**
 * A whole settler in its colours, for UI portraits: the same layers as on the map, with tunic and
 * hat multiplied by their colours. `ctx` must have its origin at the top-left of a settler box.
 */
export function paintSettlerPortrait(
  ctx: Ctx,
  pd: number,
  tunic: string,
  hat: string,
  hatStyle: HatStyle,
  action: ActionId,
  frame: number,
): void {
  const { arm, pull } = actionPose(action, frame);
  const tool = ACTIONS[action].tool;
  const plain = (paint: (c: Ctx) => void) => {
    ctx.save();
    paint(ctx);
    ctx.restore();
  };
  if (armBehind(pd)) plain((c) => paintArm(c, pd, arm, tool, pull));
  plain((c) => paintBody(c, pd, BODY_WORK));
  tinted(ctx, tunic, (c) => paintTunic(c, pd));
  plain((c) => paintHead(c, pd));
  if (hatStyle === 'bare') plain((c) => paintHat(c, pd, hatStyle));
  else tinted(ctx, hat, (c) => paintHat(c, pd, hatStyle));
  if (!armBehind(pd)) plain((c) => paintArm(c, pd, arm, tool, pull));
}

/** Paints a grey layer offscreen with the same transform, multiplies it by `color`, draws it back. */
function tinted(ctx: Ctx, color: string, paint: (c: Ctx) => void): void {
  const off = document.createElement('canvas');
  off.width = ctx.canvas.width;
  off.height = ctx.canvas.height;
  const o = off.getContext('2d')!;
  const layer = () => {
    o.save();
    o.setTransform(ctx.getTransform());
    paint(o);
    o.restore();
  };
  layer();
  o.globalCompositeOperation = 'multiply';
  o.fillStyle = color;
  o.fillRect(0, 0, off.width, off.height);
  // Keep only the layer's own pixels (multiply also coloured the transparent background).
  o.globalCompositeOperation = 'destination-in';
  layer();
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.drawImage(off, 0, 0);
  ctx.restore();
}
