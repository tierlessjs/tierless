// Length-prefixed framing for the two-process demos. Each frame carries a JSON
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
export function readFrames(stream, onFrame) {
  let buf = Buffer.alloc(0);
  stream.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 8) {
      const jsonLen = buf.readUInt32BE(0);
      const binLen = buf.readUInt32BE(4);
      const total = 8 + jsonLen + binLen;
      if (buf.length < total) break;
      const obj = JSON.parse(buf.subarray(8, 8 + jsonLen).toString("utf8"));
      const bin = binLen ? Buffer.from(buf.subarray(8 + jsonLen, total)) : EMPTY;
      buf = buf.subarray(total);
      onFrame(obj, bin, total);
    }
  });
}
