# stb-vorbis

A small synchronous Vorbis decoder for JavaScript using [`stb_vorbis`](https://github.com/nothings/stb) through WebAssembly.

The default package ships JavaScript and WebAssembly as separate, recognizable
artifacts. Applications initialize the decoder explicitly, then use its fully
synchronous decode method. This works in restricted environments such as an
`AudioWorklet` because a compiled `WebAssembly.Module` is structured-cloneable.

Made for use in [`spessasynth_core`](https://github.com/spessasus/spessasynth_core), but can be used separately.

## Installation

```bash
npm install stb-vorbis
```

## Example

```ts
import { getVorbisWasmUrl, StbVorbis } from "stb-vorbis";

await StbVorbis.initializeFromUrl(getVorbisWasmUrl());

const ogg = await fetch("/audio/example.ogg").then((response) =>
    response.arrayBuffer()
);

// Decode the audio data
const audio = StbVorbis.decode(ogg); // f32 by default

console.log(audio.sampleRate); // For example: 44100
console.log(audio.channels.length); // Number of channels
console.log(audio.channels[0]); // Float32Array containing channel 1
```

A proper example can be found in the `examples/` directory. It plays the specified Ogg Vorbis file through ffplay.
Run it using `tsx`.

## API reference

### initialize

```ts
await StbVorbis.initialize(module);
await StbVorbis.initialize(bytes);
```

Initializes the decoder from a compiled `WebAssembly.Module`, `ArrayBuffer`, or
`Uint8Array`. Concurrent and repeated calls share the first successful
initialization. Failed initialization can be retried.

`StbVorbis.ready` remains available as a readiness observer for integrations
such as SpessaSynth, but it does not start initialization. It resolves after the
first successful `initialize()` call.

Applications should compile the module on the main thread before constructing an
AudioWorklet:

```ts
import { getVorbisWasmUrl } from "stb-vorbis";

const module = await WebAssembly.compileStreaming(fetch(getVorbisWasmUrl()));
const node = new AudioWorkletNode(context, "my-processor", {
    processorOptions: { vorbisModule: module }
});
```

The processor can initialize synchronously from that module:

```ts
class MyProcessor extends AudioWorkletProcessor {
    constructor(options: AudioWorkletNodeOptions) {
        super();
        void StbVorbis.initialize(options.processorOptions.vorbisModule);
    }
}
```

If a target browser cannot clone a module in `processorOptions`, fetch the bytes
on the main thread and transfer the `ArrayBuffer` through the node's
`MessagePort`. The processor should not accept work that requires compressed
samples until initialization succeeds.

### initializeFromUrl

```ts
await StbVorbis.initializeFromUrl(getVorbisWasmUrl());
```

Fetches and initializes the decoder in ordinary browser contexts. This helper is
not suitable inside an `AudioWorkletGlobalScope`; use `initialize()` there.

### decode

```ts
StbVorbis.decode(data);
```

Synchronously decodes a complete Vorbis stream in an Ogg Container.

- `data` - `ArrayBufferLike` or `Uint8Array` - the binary Ogg Vorbis data.

Throws if the decoder has not been initialized, if the input cannot be decoded,
or if WASM memory allocation fails.

## Deploying the WASM asset

`vorbis.wasm` is available through the stable `stb-vorbis/vorbis.wasm` package
export. `getVorbisWasmUrl()` resolves to the copy next to the JavaScript entry
point without constructing a URL when the module is loaded in an AudioWorklet.
Bundlers should copy or emit that asset without inlining it. Node and offline
applications can read the exported file and pass its bytes to `initialize()`.

## Migrating from 0.x

Version 1.0 removes automatic initialization from an embedded base64 payload.
Applications must call `initialize()` or `initializeFromUrl()` before decoding.
The package no longer ships any entry point containing the WASM binary encoded
as JavaScript.

The returned object is described below.

### DecodedAudio

```ts
interface DecodedAudio {
    readonly sampleRate: number;
    readonly channels: Float32Array[];
}
```

- `sampleRate` - sample rate in Hz.
- `channels` - an array of `Float32Array` channel PCM data. All arrays have the same length.

## Building from source

The build requires Emscripten. The build script looks for `emcc` in this order:

1. The `EMCC` environment variable.
2. `$EMSDK/upstream/emscripten/emcc`.
3. `/usr/lib/emscripten/emcc`.
4. `~/emsdk/upstream/emscripten/emcc`.
5. `emcc` on `PATH` directly.

For a custom installation, either activate Emscripten in the shell or set `EMCC` explicitly:

```bash
EMCC=/path/to/emsdk/upstream/emscripten/emcc npm run build
```

To build from source,
run:

```
git clone https://github.com/spessasus/stb-vorbis
cd stb-vorbis
npm install
npm run build
```

The build emits `dist/index.js`, `dist/index.d.ts`, and `dist/vorbis.wasm`.

## License

Apache License 2.0.

The included `stb_vorbis.c` source retains its original public-domain dedication. See the bottom of the file for details.

## Special Thanks

- [nothings/stb](https://github.com/nothings/stb) - for the original C library.
- [emscripten](https://github.com/emscripten-core/emscripten) - for the WebAssembly compiler.
