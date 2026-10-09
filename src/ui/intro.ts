import type { AudioEngine } from '../audio/audio';
import { el } from './dom';
import { t, type Key } from './i18n';
import type { TitleScene } from './titleScene';

/**
 * The intro, made in the engine (our own, nothing from the original's video): night lifts into
 * dawn over the live title scene while the camera flies in over the settlement, two lines of text,
 * then the title. The title theme plays with it (`AudioEngine.theme`). A click or any key skips it.
 * Browsers start sound only after a gesture, so it opens with a «click to begin» gate that also
 * waits for the scene to be ready.
 */
const LENGTH_MS = 15500;
const CAPTIONS: [number, number, Key][] = [
  [1600, 5200, 'intro.caption1'],
  [5800, 9400, 'intro.caption2'],
];
const TITLE_AT = 9800;

export class Intro {
  readonly el = el('div', 'intro');

  constructor(
    private readonly scene: TitleScene,
    private readonly audio: AudioEngine,
  ) {}

  /** Shows the gate, then the intro; resolves when it ends or is skipped. */
  async play(parent: HTMLElement): Promise<void> {
    parent.append(this.el);
    this.el.className = 'intro';
    this.el.innerHTML = '';
    if (!this.audio.started || this.scene.progress < 1) await this.gate();
    await this.run();
    this.el.remove();
  }

  /** «Щёлкните, чтобы начать», with the scene's preparation as a bar; the click unlocks the sound. */
  private gate(): Promise<void> {
    const gate = el('div', 'intro-gate');
    const bar = el('div', 'gate-bar');
    const fill = el('div', 'gate-fill');
    bar.append(fill);
    const text = el('p', 'gate-text', t('intro.preparing'));
    gate.append(text, bar);
    this.el.append(gate);
    return new Promise((resolve) => {
      let clicked = false;
      const poll = () => {
        fill.style.width = `${Math.round(this.scene.progress * 100)}%`;
        const ready = this.scene.progress >= 1;
        if (ready && clicked) {
          gate.remove();
          resolve();
          return;
        }
        if (ready) {
          text.textContent = t('intro.clickToBegin');
          bar.hidden = true;
        }
        requestAnimationFrame(poll);
      };
      const go = () => {
        this.audio.unlock();
        clicked = true;
        if (this.scene.progress < 1) text.textContent = t('intro.moment');
        window.removeEventListener('pointerdown', go);
        window.removeEventListener('keydown', go);
      };
      window.addEventListener('pointerdown', go);
      window.addEventListener('keydown', go);
      poll();
    });
  }

  private run(): Promise<void> {
    const night = el('div', 'intro-night');
    const dawn = el('div', 'intro-dawn');
    const lines = CAPTIONS.map(([, , key]) => el('p', 'intro-caption', t(key)));
    const title = el('div', 'intro-title');
    title.append(el('span', 'wm-title', t('app.title')), el('span', 'wm-sub', t('app.subtitle')));
    const skip = el('p', 'intro-skip', t('intro.skip'));
    this.el.append(dawn, night, ...lines, title, skip);
    this.scene.flyIn(LENGTH_MS - 2500);
    this.audio.theme();
    const start = performance.now();
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        window.removeEventListener('pointerdown', finish, true);
        window.removeEventListener('keydown', finish, true);
        this.el.classList.add('fade');
        setTimeout(resolve, 600);
      };
      const step = () => {
        if (done) return;
        const t = performance.now() - start;
        CAPTIONS.forEach(([from, to], k) => lines[k].classList.toggle('on', t >= from && t < to));
        title.classList.toggle('on', t >= TITLE_AT);
        if (t >= LENGTH_MS) finish();
        else requestAnimationFrame(step);
      };
      // Skipping waits a moment, so the click that opened the gate does not skip at once.
      setTimeout(() => {
        window.addEventListener('pointerdown', finish, true);
        window.addEventListener('keydown', finish, true);
      }, 400);
      step();
    });
  }
}
