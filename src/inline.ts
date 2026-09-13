import wasmData from "../out/vorbis.wasm.js";
import { StbVorbis as ExternalStbVorbis } from "./index.js";

export type { DecodedAudio } from "./index.js";

const BASE64_ALPHABET =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

function decodeBase64(input: string): Uint8Array<ArrayBuffer> {
    const normalized = input.replaceAll(/[\t\n\f\r ]/g, "");

    if (normalized.length % 4 === 1) {
        throw new Error("Invalid base64 string");
    }

    const output = new Uint8Array(
        Math.floor((normalized.length * 3) / 4) -
            (normalized.endsWith("==") ? 2 : normalized.endsWith("=") ? 1 : 0)
    );
    let outputOffset = 0;
    let buffer = 0;
    let bits = 0;

    for (const character of normalized) {
        if (character === "=") {
            break;
        }

        const value = BASE64_ALPHABET.indexOf(character);
        if (value === -1) {
            throw new Error("Invalid base64 character");
        }

        buffer = (buffer << 6) | value;
        bits += 6;

        if (bits >= 8) {
            bits -= 8;
            output[outputOffset] = (buffer >> bits) & 0xff;
            outputOffset++;
        }
    }

    return output;
}

/**
 * Backward-compatible single-file decoder with inline WebAssembly.
 *
 * Prefer the default `stb-vorbis` entry and explicit initialization in new
 * applications.
 */
class InlineStbVorbis extends ExternalStbVorbis {
    /**
     * Resolves when the embedded decoder has initialized.
     */
    public static readonly ready = InlineStbVorbis.initialize(
        decodeBase64(wasmData)
    );
}

export { InlineStbVorbis as StbVorbis };
