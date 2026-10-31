// Plays a sample like a record on a turntable. The page sends the speed
// (1 = as recorded, 0 = stopped, negative = backwards) and the read position
// follows it. Speed changes are eased so a flick does not click. Runs on the
// audio thread; plain JS, no imports.
const EASE = 0.03; // s; time constant of the speed following the turntable

class ScratchProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = null;
    this.position = 0;
    this.speed = 0;
    this.target = 0;
    this.port.onmessage = ({ data }) => {
      if (data.samples) {
        this.samples = data.samples;
        this.position = 0;
      }
      if (typeof data.speed === "number") this.target = data.speed;
    };
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!this.samples || !output.length) return true;
    const samples = this.samples;
    const length = samples.length;
    const ease = 1 - Math.exp(-1 / (sampleRate * EASE));
    const frames = output[0].length;
    for (let i = 0; i < frames; i++) {
      this.speed += (this.target - this.speed) * ease;
      this.position = (this.position + this.speed) % length;
      if (this.position < 0) this.position += length;
      const index = Math.floor(this.position);
      const fraction = this.position - index;
      const value = samples[index] * (1 - fraction) + samples[(index + 1) % length] * fraction;
      for (const channel of output) channel[i] = value;
    }
    return true;
  }
}

registerProcessor("scratch", ScratchProcessor);
