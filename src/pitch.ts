import processorUrl from './pitch-processor.ts?worker&url';

export async function createPitch(context: BaseAudioContext) {
  await context.audioWorklet.addModule(processorUrl);
  const input = new AudioWorkletNode(context, 'maestro-radio-pitch', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2] });
  // Keep the processor warm and flush its tail even between source nodes.
  const silence = context.createConstantSource(); silence.offset.value = 0; silence.connect(input); silence.start();
  let delaySeconds = 0;
  input.port.onmessage = event => { if (typeof event.data?.delaySeconds === 'number') delaySeconds = event.data.delaySeconds; };
  return { input, get delaySeconds() { return delaySeconds; },
    setRate(rate: number, when: number) { input.parameters.get('playbackRate')!.setValueAtTime(rate, when); },
    stop() { silence.stop(); silence.disconnect(); input.disconnect(); input.port.close(); },
  };
}
