import { Sidechain, limitMix } from '../shared/sidechain.ts';
class RadioMix extends AudioWorkletProcessor {
  static get parameterDescriptors() { return [{ name: 'musicVolume', defaultValue: 0.6, minValue: 0, maxValue: 1, automationRate: 'k-rate' }]; }
  private duck = new Sidechain(sampleRate);
  private fade = 0;
  process(inputs: Float32Array[][], outputs: Float32Array[][], parameters: Record<string, Float32Array>) {
    const output = outputs[0];
    if (!output?.length) return true;
    for (let i = 0; i < output[0].length; i++) {
      const voice = inputs[0]?.[0]?.[i] ?? 0;
      const duck = this.duck.next(voice);
      if (inputs[1]?.[0]?.length) this.fade = Math.min(1, this.fade + 1 / (sampleRate * 2.5));
      for (let channel = 0; channel < output.length; channel++) {
        const music = inputs[1]?.[channel]?.[i] ?? 0;
        output[channel][i] = limitMix(voice * 0.92 + music * 0.34 * parameters.musicVolume[0] * duck * this.fade);
      }
    }
    return true;
  }
}
registerProcessor('maestro-radio-mix', RadioMix);
