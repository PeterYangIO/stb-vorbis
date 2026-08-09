import wasmData from "../out/vorbis.wasm.js";

const CHANNELS_OFFSET = 0;
const SAMPLE_RATE_OFFSET = 4;
const SAMPLES_OFFSET = 8;
const PCM_OFFSET = 12;
const BASE64_ALPHABET =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

// AudioWorklet does not have atob
function atobPolyfill(input: string) {
    input = input.replaceAll(/[\t\n\f\r ]/g, "");

    if (input.length % 4 === 1) {
        throw new Error("Invalid base64 string");
    }

    let output = "";
    let buffer = 0;
    let bits = 0;

    for (const char of input) {
        if (char === "=") break;

        const value = BASE64_ALPHABET.indexOf(char);
        if (value === -1) {
            throw new Error("Invalid base64 character");
        }

        buffer = (buffer << 6) | value;
        bits += 6;

        if (bits >= 8) {
            bits -= 8;
            // eslint-disable-next-line unicorn/prefer-code-point
            output += String.fromCharCode((buffer >> bits) & 0xff);
        }
    }

    return output;
}

/**
 * The sample format returned by the decoder.
 */
export type SampleType = "s16" | "f32";

/**
 * Options for decoding an Ogg Vorbis stream.
 */
export interface DecodeOptions {
    /**
     * Return signed 16-bit PCM or normalized 32-bit floating-point PCM.
     */
    readonly sampleType?: SampleType;
}

/**
 * Decoded Ogg Vorbis audio.
 *
 * PCM samples are planar. The sample array type is selected with
 * `DecodeOptions.sampleType`.
 */
export interface DecodedAudio<
    T extends Float32Array | Int16Array = Float32Array
> {
    /**
     * The audio sample rate in Hz.
     */
    readonly sampleRate: number;

    /**
     * One PCM array for each audio channel.
     *
     * All channel arrays contain the same number of samples.
     */
    readonly channels: readonly T[];
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
     * Resolves when the underlying WebAssembly decoder is initialized.
     */
    // eslint-disable-next-line unicorn/consistent-function-scoping
    public static readonly ready: Promise<void> = (async () => {
        // WasmData is base64 encoded wasm binary,
        // As we don't want fetch because this is a decoder made for audioWorklet
        const binary =
            "atob" in globalThis ? atob(wasmData) : atobPolyfill(wasmData);
        const bytes = Uint8Array.from(binary, (character) =>
            // eslint-disable-next-line unicorn/prefer-code-point
            character.charCodeAt(0)
        );

        const { instance } = await WebAssembly.instantiate(bytes, imports);

        StbVorbis.exports = instance.exports as unknown as VorbisExports;
    })();

    /**
     * Decodes an entire Ogg Vorbis stream synchronously.
     *
     * The returned PCM arrays are normal JavaScript-owned typed arrays.
     * No WASM memory is retained after this method returns.
     *
     * @param data The complete Ogg Vorbis stream.
     * @param options
     * @returns The decoded planar PCM audio.
     */
    public static decode(
        data: ArrayBuffer | Uint8Array,
        options: { readonly sampleType: "s16" }
    ): DecodedAudio<Int16Array>;
    public static decode(
        data: ArrayBuffer | Uint8Array,
        options?: { readonly sampleType?: "f32" }
    ): DecodedAudio;
    public static decode(
        data: ArrayBuffer | Uint8Array,
        options: DecodeOptions
    ): DecodedAudio | DecodedAudio<Int16Array>;
    public static decode(
        data: ArrayBuffer | Uint8Array,
        options: DecodeOptions = {}
    ): DecodedAudio | DecodedAudio<Int16Array> {
        if (!this.exports) {
            throw new Error("Vorbis decoder not ready");
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
                 * Stb_vorbis returns interleaved signed 16-bit PCM.
                 *
                 * Copy it into JS-owned memory while the WASM allocation
                 * is still alive, then immediately free the WASM result.
                 */
                const pcm = new Int16Array(
                    memory.buffer,
                    resultPointer + PCM_OFFSET,
                    channels * samples
                );

                // S16 is the raw format, convert to JS-owned typed arrays
                if (options?.sampleType === "s16") {
                    const output = new Array<Int16Array>(channels);

                    for (let channel = 0; channel < channels; channel++) {
                        const channelData = new Int16Array(samples);

                        for (let sample = 0; sample < samples; sample++) {
                            channelData[sample] =
                                pcm[sample * channels + channel];
                        }

                        output[channel] = channelData;
                    }

                    return {
                        sampleRate,
                        channels: output
                    };
                }

                // F32 requested, convert it here
                const output = new Array<Float32Array>(channels);

                for (let channel = 0; channel < channels; channel++) {
                    const channelData = new Float32Array(samples);

                    for (let sample = 0; sample < samples; sample++) {
                        const value = pcm[sample * channels + channel];

                        channelData[sample] = value / 32_768;
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
