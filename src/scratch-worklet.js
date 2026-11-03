// Plays a sample like a record on a turntable. The page sends the speed
// (1 = as recorded, 0 = stopped, negative = backwards) and the read position
// follows it. Speed changes are eased so a flick does not click, and a change
// of track crossfades. Runs on the audio thread; plain JS, no imports.
const EASE = 0.03; // s; time constant of the speed following the turntable
const CROSSFADE = 0.15; // s

function advance(voice, speed) {
  const length = voice.samples.length;
  voice.position = (voice.position + speed) % length;
  if (voice.position < 0) voice.position += length;
  const index = Math.floor(voice.position);
  const fraction = voice.position - index;
  return voice.samples[index] * (1 - fraction) + voice.samples[(index + 1) % length] * fraction;
}

class ScratchProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.tracks = new Map(); // samples by URL, kept for the next visit
    this.voice = null;
    this.outgoing = null; // the track being faded out
    this.fade = 1; // 0: all outgoing, 1: all voice
    this.speed = 0;
    this.target = 0;
    this.port.onmessage = ({ data }) => {
      if (data.samples) this.tracks.set(data.url, data.samples);
      if (data.play) this.play(data.play);
      if (typeof data.speed === "number") this.target = data.speed;
    };
  }

  // Models sharing a track keep it going across a switch.
  play(url) {
    const samples = this.tracks.get(url);
    if (!samples || this.voice?.samples === samples) return;
    this.outgoing = this.voice;
    this.fade = this.outgoing ? 0 : 1;
    this.voice = { samples, position: 0 };
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!this.voice || !output.length) return true;
    const ease = 1 - Math.exp(-1 / (sampleRate * EASE));
    const fadeStep = 1 / (sampleRate * CROSSFADE);
    const frames = output[0].length;
    for (let i = 0; i < frames; i++) {
      this.speed += (this.target - this.speed) * ease;
      let value = advance(this.voice, this.speed);
      if (this.outgoing) {
        this.fade = Math.min(this.fade + fadeStep, 1);
        value = value * this.fade + advance(this.outgoing, this.speed) * (1 - this.fade);
        if (this.fade === 1) this.outgoing = null;
      }
      for (const channel of output) channel[i] = value;
    }
    return true;
  }
}

registerProcessor("scratch", ScratchProcessor);
