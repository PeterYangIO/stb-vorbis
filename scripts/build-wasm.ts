import esbuild from "esbuild";
import child_process from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binaryOutput = path.resolve(root, "out");
const wasmOutput = path.resolve(binaryOutput, "vorbis.wasm");
const distributionOutput = path.resolve(root, "dist");

// eslint-disable-next-line unicorn/consistent-boolean-name
async function fileExists(path: string) {
    try {
        await fs.access(path);
        return true;
    } catch {
        return false;
    }
}

async function findEmcc() {
    // Attempt to find emcc
    const candidates = [
        process.env.EMCC,
        process.env.EMSDK === undefined
            ? undefined
            : path.resolve(process.env.EMSDK, "upstream/emscripten/emcc"),
        "/usr/lib/emscripten/emcc",
        path.resolve(homedir(), "emsdk/upstream/emscripten/emcc"),
        "emcc"
    ];

    for (const candidate of candidates) {
        if (
            candidate !== undefined &&
            (candidate === "emcc" || (await fileExists(candidate)))
        ) {
            return candidate;
        }
    }

    throw new Error("Could not find emcc!");
}

// Remove dist if exists
await fs.rm(distributionOutput, { recursive: true, force: true });
await fs.rm(binaryOutput, { recursive: true, force: true });
await fs.mkdir(distributionOutput, { recursive: true });
await fs.mkdir(binaryOutput, { recursive: true });

const emcc = await findEmcc();
console.info(`EMCC Found: ${emcc}`);
child_process.execFileSync(
    emcc,
    [
        path.resolve(root, "wasm/vorbis_wrapper.c"),

        "-O3",
        "-flto",
        "--no-entry",
        "-sSTANDALONE_WASM=1",
        "-sALLOW_MEMORY_GROWTH=1",
        "-sFILESYSTEM=0",
        "-sEXPORTED_RUNTIME_METHODS=[]",
        "-sEXPORTED_FUNCTIONS=_vorbis_decode,_vorbis_free,_malloc,_free",

        "-o",
        wasmOutput
    ],
    {
        cwd: root,
        stdio: "inherit"
    }
);

await fs.copyFile(wasmOutput, path.resolve(distributionOutput, "vorbis.wasm"));

// Build the JavaScript loader without embedding the WASM binary.
await esbuild.build({
    entryPoints: [path.resolve(root, "src/index.ts")],
    bundle: true,
    minify: true,
    treeShaking: true,
    outfile: path.resolve(distributionOutput, "index.js"),
    format: "esm",
    platform: "neutral",
    target: "es2022",
    tsconfig: path.resolve(root, "tsconfig.json"),
    logLevel: "info"
});

// Emit type declarations
child_process.execFileSync(
    "tsc",
    ["-p", path.resolve(root, "tsconfig.build.json")],
    {
        cwd: root,
        stdio: "inherit"
    }
);
