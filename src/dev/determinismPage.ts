/**
 * Dev page `determinism.html` (served by `npm run dev` only — the production build has a single entry,
 * `index.html`): plays the cross-engine scenarios of `determinism.ts` in this browser and shows every
 * checkpoint's checksum and the fingerprint over all of them; every line also goes to the console
 * (headless Firefox prints it to stdout). `?ref=<fingerprint>` marks a match or mismatch, `?only=`
 * picks scenarios. Not player-facing, so its few words are not in the dictionaries.
 */
import { fingerprint, lineOf, SCENARIOS, type Checkpoint } from './determinism';

const $ = (id: string) => document.getElementById(id)!;
const params = new URLSearchParams(location.search);
const only = (params.get('only') ?? '').split(',').filter(Boolean);
const ref = params.get('ref');

$('engine').textContent = navigator.userAgent;
console.log(`determinism: ${navigator.userAgent}`);

const all: Checkpoint[] = [];
const todo = SCENARIOS.filter((s) => only.length === 0 || only.some((o) => s.id.includes(o)));
const t0 = performance.now();

function row(c: Checkpoint): void {
  const tr = document.createElement('tr');
  for (const text of [c.scenario, c.at, c.checksum]) {
    const td = document.createElement('td');
    td.textContent = text;
    tr.append(td);
  }
  $('rows').append(tr);
}

/** One scenario per macrotask, so the page paints between them. */
function next(k: number): void {
  if (k >= todo.length) {
    const fp = fingerprint(all);
    const secs = ((performance.now() - t0) / 1000).toFixed(1);
    const status = $('status');
    status.textContent = `fingerprint: ${fp} · ${all.length} checkpoints · ${secs} s`;
    if (ref) {
      status.textContent += ref === fp ? ' · matches ?ref' : ` · DIFFERS from ?ref=${ref}`;
      status.className = ref === fp ? 'ok' : 'bad';
    }
    console.log(`determinism done: fingerprint ${fp} · ${all.length} checkpoints · ${secs} s`);
    (window as unknown as { determinism: unknown }).determinism = { fingerprint: fp, checkpoints: all };
    return;
  }
  $('status').textContent = `running ${todo[k].id}…`;
  setTimeout(() => {
    todo[k].run((at, checksum) => {
      const c = { scenario: todo[k].id, at, checksum };
      all.push(c);
      row(c);
      console.log(lineOf(c));
    });
    next(k + 1);
  }, 0);
}

next(0);
