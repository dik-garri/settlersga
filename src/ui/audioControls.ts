import type { AudioEngine } from '../audio/audio';

/**
 * Sound controls for the top-right panel: mute, master volume and music on/off. Returns the
 * elements to append; they keep themselves in sync with the engine's settings.
 */
export function audioControls(audio: AudioEngine): HTMLElement {
  const box = document.createElement('span');
  box.className = 'audio-controls';

  const mute = document.createElement('button');
  mute.className = 'sep';
  const volume = document.createElement('input');
  volume.type = 'range';
  volume.min = '0';
  volume.max = '100';
  volume.className = 'volume';
  volume.title = 'Громкость';
  const music = document.createElement('button');
  music.textContent = '♫';
  music.title = 'Музыка';

  const refresh = () => {
    const s = audio.settings;
    mute.textContent = s.muted || s.volume === 0 ? '🔇' : '🔊';
    mute.title = s.muted ? 'Включить звук (M)' : 'Выключить звук (M)';
    mute.classList.toggle('active', s.muted);
    volume.value = String(Math.round(s.volume * 100));
    music.classList.toggle('active', s.music);
  };
  mute.onclick = () => {
    audio.setMuted(!audio.settings.muted);
    refresh();
    mute.blur();
  };
  volume.oninput = () => {
    audio.setVolume(Number(volume.value) / 100);
    if (audio.settings.muted && audio.settings.volume > 0) audio.setMuted(false);
    refresh();
  };
  volume.onchange = () => volume.blur();
  music.onclick = () => {
    audio.setMusic(!audio.settings.music);
    refresh();
    music.blur();
  };
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'KeyM' || e.repeat || e.target instanceof HTMLInputElement) return;
    audio.setMuted(!audio.settings.muted);
    refresh();
  });
  refresh();
  box.append(mute, volume, music);
  return box;
}
