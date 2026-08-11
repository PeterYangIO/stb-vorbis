import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import { StbVorbis } from "../src";

const [fileName] = process.argv.slice(2);

if (fileName === undefined) {
    console.info("Usage: tsx examples/decode_and_play.ts <ogg file>");
    process.exit();
}
console.info("This example requires ffplay to be installed.");

// Read the file
const file = await readFile(fileName);

await StbVorbis.ready;

// Decode the file
const audio = StbVorbis.decode(file);
const channelCount = audio.channels.length;
const sampleCount = audio.channels[0]?.length ?? 0;

if (channelCount === 0 || sampleCount === 0) {
    throw new Error("The decoded file contains no audio samples");
}

for (const channel of audio.channels) {
    if (channel.length !== sampleCount) {
        throw new Error("Decoded channels have different lengths");
    }
}

// Stream the audio to speakers using ffplay
const framesPerChunk = 4096;
let frame = 0;

// Ffplay expects interleaved PCM audio, interleave it here
const audioStream = new Readable({
    read() {
        if (frame >= sampleCount) {
            this.push(null);
            return;
        }

        const frameCount = Math.min(framesPerChunk, sampleCount - frame);
        const interleaved = new Float32Array(frameCount * channelCount);

        for (let sample = 0; sample < frameCount; sample++) {
            for (let channel = 0; channel < channelCount; channel++) {
                interleaved[sample * channelCount + channel] =
                    audio.channels[channel][frame + sample];
            }
        }

        frame += frameCount;
        this.push(
            Buffer.from(
                interleaved.buffer,
                interleaved.byteOffset,
                interleaved.byteLength
            )
        );
    }
});

const speakers = spawn(
    "ffplay",
    [
        "-f",
        "f32le",
        "-sample_rate",
        audio.sampleRate.toString(),
        "-ch_layout",
        `${channelCount}c`,
        "-nodisp",
        "-autoexit",
        "-"
    ],
    { stdio: ["pipe"] }
);

// Handle errors
speakers.once("error", (error) => {
    console.error("Could not start ffplay:", error.message);
    process.exitCode = 1;
});
if (speakers.stdin === null) {
    throw new Error("Could not open ffplay stdin");
}

audioStream.pipe(speakers.stdin);
console.info(
    `Playing ${fileName} (${audio.sampleRate} Hz, ${channelCount} channels, ${sampleCount} samples) in ffplay...`
);
