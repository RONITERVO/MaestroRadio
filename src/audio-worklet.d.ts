/// <reference types="vite/client" />
declare class AudioWorkletProcessor { readonly port: MessagePort; constructor(options?: unknown); }
declare const sampleRate: number;
declare function registerProcessor(name: string, processor: typeof AudioWorkletProcessor): void;
