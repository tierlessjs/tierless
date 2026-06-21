// Compile waso.wat -> waso.wasm using wabt. The .wat is the source of truth;
// the .wasm is a build artifact.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import wabtInit from "wabt";

const wat = fileURLToPath(new URL("./waso.wat", import.meta.url));
const out = fileURLToPath(new URL("./waso.wasm", import.meta.url));

const wabt = await wabtInit();
const mod = wabt.parseWat("waso.wat", readFileSync(wat, "utf8"));
const { buffer } = mod.toBinary({ write_debug_names: true });
mod.destroy();

writeFileSync(out, Buffer.from(buffer));
console.log(`built waso.wasm (${buffer.length} bytes)`);
