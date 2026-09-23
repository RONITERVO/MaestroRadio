import '@soundtouchjs/interpolation-strategy-lanczos';
import { SoundTouchProcessorBase, STANDARD_PARAMETER_DESCRIPTORS, type ProcessCoreResult } from '@soundtouchjs/worklet-base';

/** Measure inserted DSP delay so the transcript clock follows the processed sound, not its input. */
class RadioPitchProcessor extends SoundTouchProcessorBase {
  static get parameterDescriptors() { return STANDARD_PARAMETER_DESCRIPTORS; }
  private delayFrames = 0;
  constructor() { super('[MaestroRadio]', { sampleRate, sampleBufferType: 'circular', interpolationStrategy: 'lanczos' }); }
  protected onProcessComplete(result: ProcessCoreResult) {
    const missing = result.frameCount - result.toExtract;
    this.delayFrames += missing;
    if (missing || this._blockCount % 50 === 0) this.port.postMessage({ delaySeconds: this.delayFrames / sampleRate });
  }
}
registerProcessor('maestro-radio-pitch', RadioPitchProcessor);
