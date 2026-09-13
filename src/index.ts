const CHANNELS_OFFSET = 0;
const SAMPLE_RATE_OFFSET = 4;
const SAMPLES_OFFSET = 8;
const PCM_OFFSET = 12;

/**
 * Resolves the separately shipped WASM asset in URL-capable environments.
 */
export function getVorbisWasmUrl(): URL {
    return new URL("vorbis.wasm", import.meta.url);
}

/**
 * Decoded Ogg Vorbis audio.
 *
 * PCM samples are planar Float32 PCM.
 */
export interface DecodedAudio {
    /**
     * The audio sample rate in Hz.
     */
    readonly sampleRate: number;

    /**
     * One PCM array for each audio channel.
     *
     * All channel arrays contain the same number of samples.
     */
    readonly channels: Float32Array[];
}

interface VorbisExports {
    readonly memory: WebAssembly.Memory;

    readonly malloc: (size: number) => number;
    readonly free: (pointer: number) => void;

    /**
     * Decodes audio data encoded in the Ogg Vorbis format.
     *
     * @readonly
     * @param data - The encoded audio data to be decoded, pointer to the memory.
     * @param length - The length of the encoded data in bytes.
     * @returns The pointer to the decoded audio data, or 0 if decoding failed.
     */
    readonly vorbis_decode: (data: number, length: number) => number;

    readonly vorbis_free: (result: number) => void;
}

/*
 * STANDALONE_WASM still imports a few tiny runtime hooks. We do not use
 * Emscripten's filesystem or runtime, so these imports can be no-ops, but they are still required
 */
// noinspection JSUnusedGlobalSymbols
const imports = {
    env: {
        emscripten_notify_memory_growth: () => {
            /*
            Empty
            */
        }
    },
    wasi_snapshot_preview1: {
        fd_close: () => 0,
        fd_write: () => 0,
        fd_seek: () => 0
    }
};

function isVorbisExports(
    exports: WebAssembly.Exports
): exports is WebAssembly.Exports & VorbisExports {
    return (
        exports.memory instanceof WebAssembly.Memory &&
        typeof exports.malloc === "function" &&
        typeof exports.free === "function" &&
        typeof exports.vorbis_decode === "function" &&
        typeof exports.vorbis_free === "function"
    );
}

/**
 * Synchronous Ogg Vorbis decoder backed by stb_vorbis.
 */
export class StbVorbis {
    /**
     * The exports of the WebAssembly decoder.
     * @private
     */
    private static exports: VorbisExports | undefined;

    /**
     * The initialization currently in progress.
     * @private
     */
    private static initialization: Promise<void> | undefined;

    /**
     * Completes the readiness promise after the first successful initialization.
     * @private
     */
    private static resolveReady: (() => void) | undefined;

    /**
     * Resolves after the decoder is explicitly initialized.
     *
     * This promise does not start initialization or fetch the WASM asset.
     */
    // eslint-disable-next-line unicorn/consistent-function-scoping -- the resolver belongs to this class's readiness state
    public static readonly ready = new Promise<void>((resolve) => {
        StbVorbis.resolveReady = resolve;
    });

    /**
     * Initializes the decoder from a compiled module or raw WASM bytes.
     *
     * Concurrent and repeated calls share the first successful initialization.
     * A failed initialization may be retried.
     *
     * @param source A compiled module or the complete `vorbis.wasm` contents.
     */
    public static initialize(
        source: WebAssembly.Module | ArrayBuffer | Uint8Array<ArrayBufferLike>
    ): Promise<void> {
        if (this.exports !== undefined) {
            return Promise.resolve();
        }
        if (this.initialization !== undefined) {
            return this.initialization;
        }

        if (source instanceof WebAssembly.Module) {
            try {
                this.setInstance(new WebAssembly.Instance(source, imports));
                return Promise.resolve();
            } catch (error) {
                return Promise.reject(
                    error instanceof Error
                        ? error
                        : new Error("Failed to initialize Vorbis WASM", {
                              cause: error
                          })
                );
            }
        }

        const bytes =
            source instanceof Uint8Array
                ? Uint8Array.from(source)
                : Uint8Array.from(new Uint8Array(source));
        return this.trackInitialization(this.instantiateBytes(bytes));
    }

    /**
     * Fetches and initializes the decoder in environments that provide fetch.
     *
     * AudioWorklets should receive a compiled `WebAssembly.Module` through
     * `processorOptions`, or receive bytes through their `MessagePort`, and
     * call {@link initialize} instead.
     *
     * @param url The deployed `vorbis.wasm` URL.
     * @param requestInit Optional fetch settings.
     */
    public static initializeFromUrl(
        url: string | URL | Request,
        requestInit?: RequestInit
    ): Promise<void> {
        if (this.exports !== undefined) {
            return Promise.resolve();
        }
        if (this.initialization !== undefined) {
            return this.initialization;
        }

        return this.trackInitialization(
            this.fetchAndInstantiate(url, requestInit)
        );
    }

    private static async fetchAndInstantiate(
        url: string | URL | Request,
        requestInit?: RequestInit
    ): Promise<void> {
        const response = await fetch(url, requestInit);
        if (!response.ok) {
            throw new Error(
                `Failed to fetch Vorbis WASM: ${response.status} ${response.statusText}`
            );
        }
        await this.instantiateBytes(
            new Uint8Array(await response.arrayBuffer())
        );
    }

    private static trackInitialization(
        initialization: Promise<void>
    ): Promise<void> {
        this.initialization = initialization;
        void initialization.catch(() => {
            if (this.initialization === initialization) {
                this.initialization = undefined;
            }
        });
        return initialization;
    }

    private static async instantiateBytes(
        bytes: Uint8Array<ArrayBuffer>
    ): Promise<void> {
        const { instance } = await WebAssembly.instantiate(bytes, imports);
        this.setInstance(instance);
    }

    private static setInstance(instance: WebAssembly.Instance): void {
        if (!isVorbisExports(instance.exports)) {
            throw new Error("Vorbis WASM has an invalid export surface");
        }
        this.exports = instance.exports;
        this.initialization = undefined;
        this.resolveReady?.();
        this.resolveReady = undefined;
    }

    /**
     * Decodes an entire Ogg Vorbis stream synchronously.
     *
     * The returned PCM arrays are normal JavaScript-owned typed arrays.
     * No WASM memory is retained after this method returns.
     *
     * @param data The complete Ogg Vorbis stream.
     * @returns The decoded planar PCM audio.
     */
    public static decode(
        data: ArrayBufferLike | Uint8Array<ArrayBufferLike>
    ): DecodedAudio {
        if (!this.exports) {
            throw new Error(
                "Vorbis decoder is not initialized; call StbVorbis.initialize() first"
            );
        }

        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);

        const exports = this.exports;
        const memory = exports.memory;

        const inputPointer = exports.malloc(bytes.byteLength);

        if (inputPointer === 0) {
            throw new Error("Failed to allocate WASM memory for Vorbis input");
        }

        try {
            // Do not cache this view. WASM memory may grow during allocation,
            // Which replaces the ArrayBuffer exposed by memory.buffer

            new Uint8Array(memory.buffer, inputPointer, bytes.byteLength).set(
                bytes
            );

            const resultPointer = exports.vorbis_decode(
                inputPointer,
                bytes.byteLength
            );

            // Returned NULL, which means failure
            if (resultPointer === 0) {
                throw new Error("Failed to decode Ogg Vorbis stream");
            }

            try {
                // Read the result before freeing its WASM allocation.

                const view = new DataView(memory.buffer);

                const channels = view.getInt32(
                    resultPointer + CHANNELS_OFFSET,
                    true
                );

                const sampleRate = view.getInt32(
                    resultPointer + SAMPLE_RATE_OFFSET,
                    true
                );

                const samples = view.getInt32(
                    resultPointer + SAMPLES_OFFSET,
                    true
                );

                if (channels <= 0 || samples <= 0 || sampleRate <= 0) {
                    throw new Error("Invalid Vorbis decoder result");
                }

                /**
                 * Stb_vorbis returns interleaved floating-point PCM.
                 *
                 * Copy it into JS planar arrays while the WASM
                 * allocation is still present
                 */
                const pcm = new Float32Array(
                    memory.buffer,
                    resultPointer + PCM_OFFSET,
                    channels * samples
                );

                const output = new Array<Float32Array>(channels);

                for (let channel = 0; channel < channels; channel++) {
                    const channelData = new Float32Array(samples);

                    for (let sample = 0; sample < samples; sample++) {
                        channelData[sample] = pcm[sample * channels + channel];
                    }

                    output[channel] = channelData;
                }

                return {
                    sampleRate,
                    channels: output
                };
            } finally {
                exports.vorbis_free(resultPointer);
            }
        } finally {
            exports.free(inputPointer);
        }
    }
}
