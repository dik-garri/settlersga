/** Painters for live effects (particles, glints, glow). Each draws centred in its box. */
type Ctx = CanvasRenderingContext2D;

function radial(ctx: Ctx, size: number, stops: [number, string][]): void {
  const r = size / 2;
  const g = ctx.createRadialGradient(r, r, 0, r, r, r);
  for (const [at, color] of stops) g.addColorStop(at, color);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
}

/** Soft white puff, 32×32; tinted grey for smoke, brown for dust. */
export function paintPuff(ctx: Ctx): void {
  radial(ctx, 32, [
    [0, 'rgba(255,255,255,0.9)'],
    [0.45, 'rgba(255,255,255,0.55)'],
    [1, 'rgba(255,255,255,0)'],
  ]);
}

/** Tiny hot spark, 8×8. */
export function paintSpark(ctx: Ctx): void {
  radial(ctx, 8, [
    [0, 'rgba(255,255,230,1)'],
    [0.4, 'rgba(255,210,120,0.9)'],
    [1, 'rgba(255,140,40,0)'],
  ]);
}

/** Warm fire glow, 48×48, meant for additive blending. */
export function paintGlow(ctx: Ctx): void {
  radial(ctx, 48, [
    [0, 'rgba(255,200,110,0.95)'],
    [0.35, 'rgba(255,140,50,0.45)'],
    [1, 'rgba(255,90,20,0)'],
  ]);
}

/** Sun glint on water, 16×6: a soft horizontal streak. */
export function paintGlint(ctx: Ctx): void {
  const g = ctx.createLinearGradient(0, 0, 16, 0);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.95)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.ellipse(8, 3, 8, 1.3, 0, 0, Math.PI * 2);
  ctx.fill();
}

/** Hit flash star, 16×16. */
export function paintFlash(ctx: Ctx): void {
  ctx.translate(8, 8);
  ctx.fillStyle = 'rgba(255,255,255,0.95)';
  ctx.beginPath();
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2;
    const r = k % 2 ? 2.2 : 7.5;
    ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  ctx.closePath();
  ctx.fill();
}
