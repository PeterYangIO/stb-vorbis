declare module "*.wasm.js" {
    const wasmData: string;
    // This is needed for the first build where WASM is not generated yet
    // noinspection JSUnusedGlobalSymbols
    export default wasmData;
}
