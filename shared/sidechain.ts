/** The DrawnExplainers mix, adapted to causal live DSP (no offline loudness pass). */
export class Sidechain {
  envelope = 0;
  gain = 1;
  private attack: number;
  private release: number;
  constructor(rate: number) { this.attack = Math.exp(-1 / (rate * 0.012)); this.release = Math.exp(-1 / (rate * 0.42)); }
  next(voice: number) {
    const level = Math.abs(voice);
    const coefficient = level > this.envelope ? this.attack : this.release;
    this.envelope = coefficient * this.envelope + (1 - coefficient) * level;
    const desired = this.envelope <= 0.06 ? 1 : (0.06 / this.envelope) ** (1 - 1 / 9);
    const smoothing = desired < this.gain ? this.attack : this.release;
    this.gain = smoothing * this.gain + (1 - smoothing) * desired;
    return this.gain;
  }
}
export function limitMix(value: number) {
  const magnitude = Math.abs(value);
  return magnitude <= 0.85 ? value : Math.sign(value) * (0.85 + 0.12 * Math.tanh((magnitude - 0.85) / 0.12));
}
