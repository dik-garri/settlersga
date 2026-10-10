/**
 * Player names (docs/NETWORK.md section 15). A name is what a person calls himself — set in the
 * settings or on the lobby screen, kept in this browser's preferences — and travels in the lobby
 * (`hello`, `name`), in the setup the host sends at «Start» (`SlotSetup.name`) and in network saves
 * (their setup), so a loaded game can seat its players by name. Names are never part of the
 * simulation: the world, its commands and its checksums know only player ids.
 *
 * Everything that comes from the network or storage goes through `cleanName`; names are shown with
 * `textContent` only (never as HTML).
 */

/** Longest name (characters, counted as code points). */
export const NAME_MAX = 16;

/**
 * Control and format characters (C0/C1 controls, zero-width marks, bidirectional overrides and
 * isolates): a name never carries them, so it cannot break a line, turn the text around it or hide
 * letters. Whitespace of any kind (line breaks, tabs, the line and paragraph separators) becomes one
 * space first.
 */
const HIDDEN = /[\p{Cc}\p{Cf}]/gu;

/** A name as typed or received: one line, no control characters, trimmed, at most `NAME_MAX` characters; empty → null. */
export function cleanName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.replace(/\s+/g, ' ').replace(HIDDEN, '').replace(/ {2,}/g, ' ').trim();
  const cut = Array.from(s).slice(0, NAME_MAX).join('').trim();
  return cut ? cut : null;
}

/** Two names are the same person's when they agree ignoring case and spacing (after `cleanName`). */
export function sameName(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = cleanName(a);
  const y = cleanName(b);
  return x !== null && y !== null && x.toLocaleLowerCase() === y.toLocaleLowerCase();
}

/**
 * A name nobody else in `taken` has: the name itself, else with « 2», « 3»… (cut to fit
 * `NAME_MAX`), so two players in one lobby never share a name — a loaded game seats them by it.
 */
export function uniqueName(name: string, taken: readonly string[]): string {
  if (!taken.some((t) => sameName(t, name))) return name;
  for (let n = 2; ; n++) {
    const suffix = ` ${n}`;
    const base = Array.from(name).slice(0, NAME_MAX - suffix.length).join('').trim();
    const candidate = `${base}${suffix}`;
    if (!taken.some((t) => sameName(t, candidate))) return candidate;
  }
}
