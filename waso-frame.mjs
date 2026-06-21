// Length-prefixed JSON framing for the two-process demo.
// Each frame: 4-byte big-endian payload length, then UTF-8 JSON.

export function writeFrame(stream, obj) {
  const payload = Buffer.from(JSON.stringify(obj), "utf8");
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(payload.length, 0);
  stream.write(header);
  stream.write(payload);
  return header.length + payload.length; // bytes actually put on the wire
}

// Calls onFrame(obj, payloadByteLength) for each complete frame on `stream`.
export function readFrames(stream, onFrame) {
  let buf = Buffer.alloc(0);
  stream.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    while (buf.length >= 4) {
      const len = buf.readUInt32BE(0);
      if (buf.length < 4 + len) break;
      const payload = buf.subarray(4, 4 + len);
      buf = buf.subarray(4 + len);
      onFrame(JSON.parse(payload.toString("utf8")), len);
    }
  });
}
