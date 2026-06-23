// Length-prefixed framing for the stdio pipe demos (wasm-two-process, hn-thread).
// The WebSocket transport (wss.mjs) has its own browser-safe per-message codec.
// Each frame carries a JSON
// header and an optional raw binary attachment (used to ship a wasm
// linear-memory slice without base64 inflation).
//
//   frame = [u32 jsonLen][u32 binLen][json bytes][bin bytes]

const EMPTY = Buffer.alloc(0);

export function writeFrame(stream, obj, bin = EMPTY) {
  const json = Buffer.from(JSON.stringify(obj), "utf8");
  const header = Buffer.allocUnsafe(8);
  header.writeUInt32BE(json.length, 0);
  header.writeUInt32BE(bin.length, 4);
  stream.write(header);
  stream.write(json);
  if (bin.length) stream.write(bin);
  return header.length + json.length + bin.length; // bytes actually on the wire
}

// Calls onFrame(obj, bin, totalByteLength) for each complete frame.
//
// Chunks accumulate in a list and are concatenated only once a whole frame has arrived
// (and only across the chunks that hold it), so a large continuation streamed over many
// small reads costs O(n), not the O(n²) of re-concatenating the whole buffer per chunk.
export function readFrames(stream, onFrame) {
  let chunks = [];  // unconsumed chunks
  let buffered = 0; // total bytes across `chunks`
  let need = 8;     // bytes required before the next frame can be parsed: the 8-byte header, then the full frame
  const byteAt = (i) => { let p = i; for (const c of chunks) { if (p < c.length) return c[p]; p -= c.length; } return 0; }; // peek a header byte without concatenating
  const u32 = (o) => ((byteAt(o) << 24) | (byteAt(o + 1) << 16) | (byteAt(o + 2) << 8) | byteAt(o + 3)) >>> 0;
  stream.on("data", (chunk) => {
    chunks.push(chunk); buffered += chunk.length;
    while (buffered >= need) {
      const jsonLen = u32(0);
      const binLen = u32(4);
      const total = 8 + jsonLen + binLen;
      if (buffered < total) { need = total; break; } // wait for the rest of this frame — no copy yet
      const buf = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, buffered); // single copy, only once the whole frame is here
      const obj = JSON.parse(buf.subarray(8, 8 + jsonLen).toString("utf8"));
      const bin = binLen ? Buffer.from(buf.subarray(8 + jsonLen, total)) : EMPTY;
      const rem = buf.subarray(total);
      chunks = rem.length ? [rem] : []; buffered = rem.length; need = 8;
      onFrame(obj, bin, total);
    }
  });
}
