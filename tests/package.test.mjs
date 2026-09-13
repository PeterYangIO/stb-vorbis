import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const npmCommand = process.platform === "win32" ? process.execPath : "npm";
const npmPrefix =
    process.platform === "win32"
        ? [join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js")]
        : [];
const wasm = await readFile(new URL("../dist/vorbis.wasm", import.meta.url));
const defaultEntry = await readFile(
    new URL("../dist/index.js", import.meta.url),
    "utf8"
);

test("default entry contains no encoded WASM payload", () => {
    assert.ok(defaultEntry.length < wasm.byteLength / 10);
    assert.equal(defaultEntry.includes(wasm.toString("base64")), false);
    assert.equal(defaultEntry.includes("ABCDEFGHIJKLMNOPQRSTUVWXYZ"), false);
    assert.equal(defaultEntry.includes("atob("), false);
    assert.match(defaultEntry, /vorbis\.wasm/);
});

test("packed package exposes and runs the external WASM artifact", async () => {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "stb-vorbis-pack-"));

    try {
        const packDirectory = join(temporaryRoot, "pack");
        const fixtureDirectory = join(temporaryRoot, "consumer");
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
        const [packResult] = JSON.parse(stdout);
        const packedFiles = new Set(packResult.files.map(({ path }) => path));

        assert.ok(packedFiles.has("dist/index.js"));
        assert.ok(packedFiles.has("dist/index.d.ts"));
        assert.ok(packedFiles.has("dist/inline.js"));
        assert.ok(packedFiles.has("dist/inline.d.ts"));
        assert.ok(packedFiles.has("dist/vorbis.wasm"));

        await execute(
            npmCommand,
            [
                ...npmPrefix,
                "install",
                "--ignore-scripts",
                "--prefix",
                fixtureDirectory,
                join(packDirectory, packResult.filename)
            ],
            { cwd: temporaryRoot }
        );
        await copyFile(
            new URL("fixtures/tone.ogg", import.meta.url),
            join(fixtureDirectory, "tone.ogg")
        );

        const smokeTest = `
            import assert from "node:assert/strict";
            import { readFile } from "node:fs/promises";
            import { StbVorbis } from "stb-vorbis";
            import { StbVorbis as InlineStbVorbis } from "stb-vorbis/inline";

            const wasmUrl = import.meta.resolve("stb-vorbis/vorbis.wasm");
            assert.match(wasmUrl, /dist\\/vorbis\\.wasm$/);
            await StbVorbis.initialize(await readFile(new URL(wasmUrl)));
            assert.throws(
                () => StbVorbis.decode(new Uint8Array()),
                /Failed to decode Ogg Vorbis stream/
            );

            await InlineStbVorbis.ready;
            const decoded = InlineStbVorbis.decode(await readFile("tone.ogg"));
            assert.equal(decoded.sampleRate, 8000);
            assert.equal(decoded.channels.length, 1);
        `;
        await execute("node", ["--input-type=module", "--eval", smokeTest], {
            cwd: fixtureDirectory
        });
    } finally {
        await rm(temporaryRoot, { recursive: true, force: true });
    }
});
