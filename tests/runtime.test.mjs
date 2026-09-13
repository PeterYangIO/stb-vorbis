import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import test from "node:test";

const wasmUrl = new URL("../dist/vorbis.wasm", import.meta.url);
const fixtureUrl = new URL("fixtures/tone.ogg", import.meta.url);
const wasmBytes = await readFile(wasmUrl);
const fixture = await readFile(fixtureUrl);

async function loadFresh(label) {
    return import(new URL(`../dist/index.js?test=${label}`, import.meta.url));
}

function assertDecodedAudio(audio) {
    assert.equal(audio.sampleRate, 8000);
    assert.equal(audio.channels.length, 1);
    assert.ok(audio.channels[0].length > 0);
    assert.ok(audio.channels[0].some((sample) => sample !== 0));
}

test("decode fails explicitly before initialization", async () => {
    const { StbVorbis } = await loadFresh("uninitialized");

    assert.throws(
        () => StbVorbis.decode(fixture),
        /decoder is not initialized/
    );
});

test("initializes from raw bytes and shares concurrent initialization", async () => {
    const { StbVorbis } = await loadFresh("bytes");
    let ready = false;
    void StbVorbis.ready.then(() => {
        ready = true;
    });
    await Promise.resolve();
    assert.equal(ready, false);

    const first = StbVorbis.initialize(wasmBytes);
    const second = StbVorbis.initialize(wasmBytes);

    assert.strictEqual(second, first);
    await Promise.all([first, second, StbVorbis.ready]);
    assert.equal(ready, true);
    assertDecodedAudio(StbVorbis.decode(fixture));

    await StbVorbis.initialize(new Uint8Array([0]));
    assertDecodedAudio(StbVorbis.decode(fixture));
});

test("initializes synchronously from a structured-cloned module", async () => {
    const { StbVorbis } = await loadFresh("module");
    const module = structuredClone(await WebAssembly.compile(wasmBytes));
    const initialization = StbVorbis.initialize(module);

    assertDecodedAudio(StbVorbis.decode(fixture));
    await initialization;
});

test("surfaces invalid WASM and permits a retry", async () => {
    const { StbVorbis } = await loadFresh("retry");

    await assert.rejects(
        StbVorbis.initialize(new Uint8Array([0, 1, 2, 3])),
        WebAssembly.CompileError
    );
    await StbVorbis.initialize(wasmBytes);
    assertDecodedAudio(StbVorbis.decode(fixture));
});

test("initializes from a URL in fetch-capable contexts", async (context) => {
    let requestCount = 0;
    const server = createServer((request, response) => {
        if (request.url === "/vorbis.wasm") {
            requestCount++;
            response.writeHead(200, { "Content-Type": "application/wasm" });
            response.end(wasmBytes);
            return;
        }
        response.writeHead(404);
        response.end();
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    context.after(() => server.close());

    const address = server.address();
    assert.notEqual(address, null);
    assert.equal(typeof address, "object");

    const { StbVorbis } = await loadFresh("url");
    const first = StbVorbis.initializeFromUrl(
        `http://127.0.0.1:${address.port}/vorbis.wasm`
    );
    const second = StbVorbis.initializeFromUrl(
        `http://127.0.0.1:${address.port}/vorbis.wasm`
    );
    assert.strictEqual(second, first);
    await Promise.all([first, second]);
    assert.equal(requestCount, 1);

    await StbVorbis.initializeFromUrl(
        `http://127.0.0.1:${address.port}/missing.wasm`
    );
    assert.equal(requestCount, 1);
    assertDecodedAudio(StbVorbis.decode(fixture));
});

test("keeps the inline entry as an explicit compatibility path", async () => {
    const { StbVorbis } = await import("../dist/inline.js");

    await StbVorbis.ready;
    assertDecodedAudio(StbVorbis.decode(fixture));
});
