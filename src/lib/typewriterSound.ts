// Procedural "aural feedback" click for Settings > Editor > Aural Feedback
// (see SettingsPage.tsx, Editor.tsx). Synthesized with the Web Audio API
// rather than shipping a sample — a single filtered noise burst is enough
// to read as a soft typewriter key, and it means no audio asset to bundle
// or license.

let ctx: AudioContext | null = null;

function getContext(): AudioContext | null {
  if (typeof window === "undefined" || !("AudioContext" in window || "webkitAudioContext" in window)) return null;
  if (!ctx) {
    const AudioContextCtor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    ctx = new AudioContextCtor();
  }
  // Browsers create contexts "suspended" until a user gesture; a keydown
  // is one, so resuming here (rather than waiting on some other prompt)
  // is enough to unlock it on the very first keystroke.
  if (ctx.state === "suspended") void ctx.resume();
  return ctx;
}

const CLICK_DURATION_S = 0.03;

/** Plays one soft typewriter-key click. Cheap enough to call on every
 * keystroke — each call builds and discards its own tiny buffer/filter/gain
 * graph, so overlapping presses (fast typing) layer naturally instead of
 * cutting each other off. */
export function playTypewriterClick(): void {
  const audioCtx = getContext();
  if (!audioCtx) return;

  const now = audioCtx.currentTime;
  const sampleCount = Math.floor(audioCtx.sampleRate * CLICK_DURATION_S);
  const buffer = audioCtx.createBuffer(1, sampleCount, audioCtx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < sampleCount; i++) {
    // White noise shaped by a steep decay envelope — the "clack" of a key
    // strike is mostly a transient, not a tone.
    data[i] = (Math.random() * 2 - 1) * (1 - i / sampleCount) ** 3;
  }

  const noise = audioCtx.createBufferSource();
  noise.buffer = buffer;

  // A little pitch variance per keystroke keeps rapid typing from sounding
  // like a mechanical loop.
  const bandpass = audioCtx.createBiquadFilter();
  bandpass.type = "bandpass";
  bandpass.frequency.value = 2000 + Math.random() * 1000;
  bandpass.Q.value = 1.1;

  const gain = audioCtx.createGain();
  gain.gain.setValueAtTime(0.15, now);
  gain.gain.exponentialRampToValueAtTime(0.0001, now + CLICK_DURATION_S);

  noise.connect(bandpass).connect(gain).connect(audioCtx.destination);
  noise.start(now);
  noise.stop(now + CLICK_DURATION_S);
}
