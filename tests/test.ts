import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { StbVorbis } from "../src/index";

interface PackFile {
    readonly path: string;
}

interface PackResult {
    readonly filename: string;
    readonly files: PackFile[];
}

const execute = promisify(execFile);
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const wasmUrl = new URL("../dist/vorbis.wasm", import.meta.url);
const fixtureUrl = new URL("fixtures/tone.ogg", import.meta.url);
const wasmBytes = await readFile(wasmUrl);
const fixture = await readFile(fixtureUrl);
const npmCommand = process.platform === "win32" ? process.execPath : "npm";
const npmPrefix =
    process.platform === "win32"
        ? [
              path.join(
                  path.dirname(process.execPath),
                  "node_modules/npm/bin/npm-cli.js"
              )
          ]
        : [];

function isUnknownArray(value: unknown): value is unknown[] {
    return Array.isArray(value);
}

function isPackFile(value: unknown): value is PackFile {
    return (
        typeof value === "object" &&
        value !== null &&
        "path" in value &&
        typeof value.path === "string"
    );
}

function isPackResult(value: unknown): value is PackResult {
    return (
        typeof value === "object" &&
        value !== null &&
        "filename" in value &&
        typeof value.filename === "string" &&
        "files" in value &&
        isUnknownArray(value.files) &&
        value.files.every((file) => isPackFile(file))
    );
}

function parsePackResult(output: string): PackResult {
    const parsed: unknown = JSON.parse(output);
    if (
        !isUnknownArray(parsed) ||
        parsed.length !== 1 ||
        !isPackResult(parsed[0])
    ) {
        throw new Error("npm pack returned an unexpected result");
    }

    return parsed[0];
}

function assertDecodedAudio(audio: {
    readonly sampleRate: number;
    readonly channels: Float32Array[];
}): void {
    assert.equal(audio.sampleRate, 8000);
    assert.equal(audio.channels.length, 1);
    assert.ok(audio.channels[0]?.some((sample) => sample !== 0));
}

console.info("Testing explicit decoder initialization...");

class UninitializedDecoder extends StbVorbis {}
assert.throws(
    () => UninitializedDecoder.decode(fixture),
    /decoder is not initialized/
);

class BytesDecoder extends StbVorbis {}
const firstInitialization = BytesDecoder.initialize(wasmBytes);
const secondInitialization = BytesDecoder.initialize(wasmBytes);
assert.strictEqual(secondInitialization, firstInitialization);
await Promise.all([
    firstInitialization,
    secondInitialization,
    BytesDecoder.ready
]);
assertDecodedAudio(BytesDecoder.decode(fixture));
await BytesDecoder.initialize(new Uint8Array([0]));

class ModuleDecoder extends StbVorbis {}
const module = structuredClone(await WebAssembly.compile(wasmBytes));
const moduleInitialization = ModuleDecoder.initialize(module);
assertDecodedAudio(ModuleDecoder.decode(fixture));
await moduleInitialization;

class TransferredBytesDecoder extends StbVorbis {}
const transferableBytes = Uint8Array.from(wasmBytes).buffer;
const transferredBytes = structuredClone(transferableBytes, {
    transfer: [transferableBytes]
});
await TransferredBytesDecoder.initialize(transferredBytes);
assertDecodedAudio(TransferredBytesDecoder.decode(fixture));

class RetryDecoder extends StbVorbis {}
await assert.rejects(
    RetryDecoder.initialize(new Uint8Array([0, 1, 2, 3])),
    WebAssembly.CompileError
);
await RetryDecoder.initialize(wasmBytes);
assertDecodedAudio(RetryDecoder.decode(fixture));

const requestCount = { value: 0 };
const server = createServer((request, response) => {
    if (request.url === "/vorbis.wasm") {
        requestCount.value++;
        response.writeHead(200, { "Content-Type": "application/wasm" });
        response.end(wasmBytes);
        return;
    }
    response.writeHead(404);
    response.end();
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

try {
    const address = server.address();
    assert.ok(address && typeof address === "object");

    class UrlDecoder extends StbVorbis {}
    const firstUrlInitialization = UrlDecoder.initializeFromUrl(
        `http://127.0.0.1:${address.port}/vorbis.wasm`
    );
    const secondUrlInitialization = UrlDecoder.initializeFromUrl(
        `http://127.0.0.1:${address.port}/vorbis.wasm`
    );
    assert.strictEqual(secondUrlInitialization, firstUrlInitialization);
    await Promise.all([firstUrlInitialization, secondUrlInitialization]);
    assert.equal(requestCount.value, 1);
    assertDecodedAudio(UrlDecoder.decode(fixture));
} finally {
    server.close();
}

console.info("Testing packed package...");

const defaultEntry = await readFile(
    new URL("../dist/index.js", import.meta.url),
    "utf8"
);
assert.ok(defaultEntry.length < wasmBytes.byteLength / 10);
assert.equal(defaultEntry.includes(wasmBytes.toString("base64")), false);
assert.equal(defaultEntry.includes("ABCDEFGHIJKLMNOPQRSTUVWXYZ"), false);
assert.equal(defaultEntry.includes("atob("), false);
assert.match(defaultEntry, /vorbis\.wasm/);

const temporaryRoot = await mkdtemp(path.join(tmpdir(), "stb-vorbis-pack-"));

try {
    const packDirectory = path.join(temporaryRoot, "pack");
    const fixtureDirectory = path.join(temporaryRoot, "consumer");
    await mkdir(packDirectory);
    const { stdout } = await execute(
        npmCommand,
        [
            ...npmPrefix,
            "pack",
            "--json",
            "--ignore-scripts",
            "--pack-destination",
            packDirectory
        ],
        { cwd: projectRoot }
    );
    const packResult = parsePackResult(stdout);
    const packedFiles = new Set(packResult.files.map(({ path }) => path));

    assert.ok(packedFiles.has("dist/index.js"));
    assert.ok(packedFiles.has("dist/index.d.ts"));
    assert.ok(packedFiles.has("dist/vorbis.wasm"));
    assert.equal(
        [...packedFiles].some((file) => file.includes("inline")),
        false
    );

    await execute(
        npmCommand,
        [
            ...npmPrefix,
            "install",
            "--ignore-scripts",
            "--prefix",
            fixtureDirectory,
            path.join(packDirectory, packResult.filename)
        ],
        { cwd: temporaryRoot }
    );
    await copyFile(fixtureUrl, path.join(fixtureDirectory, "tone.ogg"));

    const smokeTest = String.raw`
        import assert from "node:assert/strict";
        import { readFile } from "node:fs/promises";
        import { StbVorbis } from "stb-vorbis";

        const wasmUrl = import.meta.resolve("stb-vorbis/vorbis.wasm");
        assert.match(wasmUrl, /dist\/vorbis\.wasm$/);
        await StbVorbis.initialize(await readFile(new URL(wasmUrl)));
        assert.throws(
            () => StbVorbis.decode(new Uint8Array()),
            /Failed to decode Ogg Vorbis stream/
        );
    `;
    await execute(
        process.execPath,
        ["--input-type=module", "--eval", smokeTest],
        {
            cwd: fixtureDirectory
        }
    );
} finally {
    await rm(temporaryRoot, { recursive: true, force: true });
}

console.info("All tests passed.");
