import { StbVorbis } from "../dist/index.js";

class VorbisInitializationProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();

        const module = options.processorOptions?.vorbisModule;
        const audio = options.processorOptions?.vorbisAudio;
        if (module instanceof WebAssembly.Module) {
            void this.initialize(module, audio);
        } else {
            this.port.addEventListener("message", (event) => {
                if (
                    event.data.wasm instanceof ArrayBuffer &&
                    event.data.audio instanceof ArrayBuffer
                ) {
                    void this.initialize(event.data.wasm, event.data.audio);
                }
            });
            this.port.start();
        }
    }

    async initialize(source, audio) {
        try {
            await StbVorbis.initialize(source);
            const decoded = StbVorbis.decode(audio);
            this.port.postMessage({
                type: "ready",
                sampleRate: decoded.sampleRate,
                channels: decoded.channels.length,
                samples: decoded.channels[0]?.length ?? 0
            });
        } catch (error) {
            this.port.postMessage({
                type: "error",
                message: error instanceof Error ? error.message : String(error)
            });
        }
    }

    process() {
        return true;
    }
}

registerProcessor("vorbis-initialization", VorbisInitializationProcessor);
