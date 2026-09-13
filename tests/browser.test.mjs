import assert from "node:assert/strict";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("../", import.meta.url));
const contentTypes = new Map([
    [".js", "text/javascript"],
    [".wasm", "application/wasm"],
    [".ogg", "audio/ogg"]
]);

test("browser and AudioWorklet initialization paths work", async (context) => {
    const serverRequests = [];
    const server = createServer(async (request, response) => {
        serverRequests.push(request.url);
        if (request.url === "/") {
            response.writeHead(200, { "Content-Type": "text/html" });
            response.end("<!doctype html><title>stb-vorbis test</title>");
            return;
        }
        if (request.url === "/favicon.ico") {
            response.writeHead(204);
            response.end();
            return;
        }

        const requestedPath = normalize(request.url ?? "").replace(
            /^[/\\]+/,
            ""
        );
        const filePath = join(root, requestedPath);
        if (!filePath.startsWith(root)) {
            response.writeHead(403);
            response.end();
            return;
        }

        try {
            await stat(filePath);
            response.writeHead(200, {
                "Content-Type":
                    contentTypes.get(extname(filePath)) ??
                    "application/octet-stream"
            });
            createReadStream(filePath).pipe(response);
        } catch {
            response.writeHead(404);
            response.end();
        }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    context.after(() => server.close());

    const address = server.address();
    assert.notEqual(address, null);
    assert.equal(typeof address, "object");

    const browser = await chromium.launch({
        headless: true,
        args: [
            "--autoplay-policy=no-user-gesture-required",
            "--use-fake-device-for-media-stream",
            "--use-fake-ui-for-media-stream"
        ]
    });
    context.after(() => browser.close());
    const page = await browser.newPage();
    const browserErrors = [];
    const responses = [];
    page.on("response", (response) => {
        responses.push(`${response.status()} ${response.url()}`);
    });
    page.on("console", (message) => {
        if (message.type() === "error") {
            browserErrors.push(message.text());
        }
    });
    page.on("pageerror", (error) => browserErrors.push(error.message));
    await page.goto(`http://127.0.0.1:${address.port}/`);

    const evaluateBrowserPaths = () =>
        page.evaluate(async () => {
            const waitForProcessor = (node) =>
                new Promise((resolve, reject) => {
                    const timeout = setTimeout(
                        () =>
                            reject(
                                new Error(
                                    "AudioWorklet initialization timed out"
                                )
                            ),
                        5000
                    );
                    node.port.addEventListener(
                        "message",
                        (event) => {
                            clearTimeout(timeout);
                            if (event.data.type === "ready") {
                                resolve(event.data);
                            } else {
                                reject(new Error(event.data.message));
                            }
                        },
                        { once: true }
                    );
                    node.port.start();
                });
            const { getVorbisWasmUrl, StbVorbis } =
                await import("/dist/index.js");
            await StbVorbis.initializeFromUrl(getVorbisWasmUrl());
            const ogg = await fetch("/tests/fixtures/tone.ogg").then(
                (response) => response.arrayBuffer()
            );
            const decoded = StbVorbis.decode(ogg);

            const moduleContext = new AudioContext();
            await moduleContext.resume();
            await moduleContext.audioWorklet.addModule(
                "/tests/audio-worklet-processor.js"
            );
            const module = await WebAssembly.compileStreaming(
                fetch("/dist/vorbis.wasm")
            );
            const moduleNode = new AudioWorkletNode(
                moduleContext,
                "vorbis-initialization",
                {
                    processorOptions: {
                        vorbisModule: module,
                        vorbisAudio: ogg
                    }
                }
            );
            const moduleResult = await waitForProcessor(moduleNode);
            await moduleContext.close();

            const bytesContext = new AudioContext();
            await bytesContext.resume();
            await bytesContext.audioWorklet.addModule(
                "/tests/audio-worklet-processor.js"
            );
            const bytesNode = new AudioWorkletNode(
                bytesContext,
                "vorbis-initialization"
            );
            const bytes = await fetch("/dist/vorbis.wasm").then((response) =>
                response.arrayBuffer()
            );
            const fallbackAudio = await fetch("/tests/fixtures/tone.ogg").then(
                (response) => response.arrayBuffer()
            );
            const bytesReady = waitForProcessor(bytesNode);
            bytesNode.port.postMessage({ wasm: bytes, audio: fallbackAudio }, [
                bytes,
                fallbackAudio
            ]);
            const bytesResult = await bytesReady;
            await bytesContext.close();

            return {
                sampleRate: decoded.sampleRate,
                channels: decoded.channels.length,
                samples: decoded.channels[0]?.length ?? 0,
                moduleResult,
                bytesResult
            };
        });
    const result = await evaluateBrowserPaths().catch((error) => {
        throw new Error(
            `${error instanceof Error ? error.message : String(error)}\n${browserErrors.join("\n")}\n${responses.join("\n")}\nServer: ${serverRequests.join(", ")}`,
            { cause: error }
        );
    });

    assert.deepEqual(browserErrors, []);
    assert.equal(result.sampleRate, 8000);
    assert.equal(result.channels, 1);
    assert.ok(result.samples > 0);
    assert.deepEqual(result.moduleResult, {
        type: "ready",
        sampleRate: 8000,
        channels: 1,
        samples: result.samples
    });
    assert.deepEqual(result.bytesResult, result.moduleResult);
});
