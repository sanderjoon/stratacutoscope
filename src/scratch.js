// Turntable sound: a track that plays at the specimen's spin, forwards,
// backwards, fast or slow, like a record under a stylus. The audio runs in
// scratch-worklet.js; this side loads the track and relays the speed.
const VOLUME = 0.8;
const FADE = 0.3; // s; the sound eases in and out when switched

export function createScratch(url) {
  let context = null;
  let node = null;
  let gain = null;
  let ready = null;
  let wanted = false;
  let suspendTimer = null;

  async function load() {
    // Worklets only exist on a secure page (https or localhost).
    if (!context.audioWorklet) throw new Error("the sound needs HTTPS");
    await context.audioWorklet.addModule(new URL("./scratch-worklet.js", import.meta.url));
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${response.status} fetching the track`);
    const buffer = await context.decodeAudioData(await response.arrayBuffer());
    // Mono: the channels are averaged. The samples are handed to the audio thread.
    const samples = new Float32Array(buffer.length);
    for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
      const data = buffer.getChannelData(channel);
      for (let i = 0; i < samples.length; i++) samples[i] += data[i] / buffer.numberOfChannels;
    }
    node = new AudioWorkletNode(context, "scratch", { numberOfInputs: 0, outputChannelCount: [2] });
    gain = context.createGain();
    gain.gain.value = 0;
    node.connect(gain).connect(context.destination);
    node.port.postMessage({ samples }, [samples.buffer]);
  }

  function fadeTo(volume) {
    const now = context.currentTime;
    gain.gain.cancelScheduledValues(now);
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(volume, now + FADE);
  }

  // Fetches and decodes the track ahead of time. The context can be made
  // before any gesture; it only stays suspended until start() resumes it.
  function preload() {
    if (!context) {
      context = new AudioContext();
      ready = load();
    }
    return ready;
  }

  // Call from a user gesture: browsers only let audio start from one.
  async function start() {
    wanted = true;
    clearTimeout(suspendTimer);
    preload();
    await context.resume();
    await ready;
    if (wanted) fadeTo(VOLUME);
  }

  // Fades out, then stops the clock so nothing runs while silent.
  function stop() {
    wanted = false;
    if (!gain) return;
    fadeTo(0);
    clearTimeout(suspendTimer);
    suspendTimer = setTimeout(() => context.suspend(), FADE * 1000 + 50);
  }

  // 1 is the track as recorded; the turntable's motor speed maps to it.
  function setSpeed(speed) {
    node?.port.postMessage({ speed });
  }

  return { preload, start, stop, setSpeed };
}
