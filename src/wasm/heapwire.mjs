// Stackmix — §5 in linear memory: split a captured continuation into what travels
// inline vs. what stays a handle. Built on the AOT compiler's tagged,
// self-describing heap (src/wasm/aot.mjs).
//
// Roots are found by a conservative scan: tagged ints have bit 0 = 0, so only
// real pointers into [HEAP_BASE, bump) are picked up, and Asyncify's own
// bookkeeping lives at >= STACK_BASE, outside the heap range — no false
// positives. From the roots we walk the heap; an object bigger than the
// threshold becomes a §5 handle (its bytes do NOT ship, and every pointer to it
// is remote-tagged addr|3), while small objects travel inline at their original
// addresses, so no pointer relocation is needed on the receiver.

import { BUMP_ADDR, HEAP_BASE, isPointer, pointerAddr, makeHandle } from "./aot.mjs";

// Linear-memory layout shared with the wasm probes (Asyncify control + stack).
export const DATA_PTR = 16, STACK_BASE = 1024, STACK_END = 8192;
export const HANDLE_THRESHOLD = 64; // bytes; an object bigger than this stays home

const get = (dv, a) => dv.getInt32(a, true);
const objSize = (dv, addr) => 4 + get(dv, addr) * 4; // length header + fields
const inHeap = (a, bump) => a >= HEAP_BASE && a < bump;

// Byte offsets in the asyncify stack [STACK_BASE, stackTop) that hold a heap pointer.
export function findRoots(mem, bump, stackTop) {
  const dv = new DataView(mem.buffer);
  const roots = [];
  for (let o = STACK_BASE; o < stackTop; o += 4) { const w = get(dv, o); if (isPointer(w) && inHeap(pointerAddr(w), bump)) roots.push(o); }
  return roots;
}

// Walk the heap from the roots; classify each object small (ships) vs big
// (handle). First cut: "big" is by an object's own size, and big objects are
// treated as leaves (nested big subgraphs are a later refinement).
export function classify(mem, bump, stackTop, threshold = HANDLE_THRESHOLD) {
  const dv = new DataView(mem.buffer);
  const small = new Set(), big = new Set(), seen = new Set();
  const queue = findRoots(mem, bump, stackTop).map((o) => pointerAddr(get(dv, o)));
  while (queue.length) {
    const addr = queue.shift();
    if (seen.has(addr)) continue; seen.add(addr);
    if (objSize(dv, addr) > threshold) { big.add(addr); continue; }
    small.add(addr);
    const len = get(dv, addr);
    for (let i = 0; i < len; i++) { const f = get(dv, addr + 4 + i * 4); if (isPointer(f) && inHeap(pointerAddr(f), bump)) queue.push(pointerAddr(f)); }
  }
  return { small, big };
}

// Encode: ship ctrl + asyncify stack + small objects, all at their original
// addresses, with pointers to big objects remote-tagged. Big objects' bytes do
// not travel.
export function encodeContinuation(mem, threshold = HANDLE_THRESHOLD) {
  const dv = new DataView(mem.buffer);
  const bump = get(dv, BUMP_ADDR), stackTop = get(dv, DATA_PTR);
  const { small, big } = classify(mem, bump, stackTop, threshold);
  const remap = (w) => (isPointer(w) && big.has(pointerAddr(w)) ? makeHandle(pointerAddr(w)) : w);
  const ctrl = []; for (let o = 0; o < HEAP_BASE; o += 4) ctrl.push(get(dv, o));
  const stack = []; for (let o = STACK_BASE; o < stackTop; o += 4) stack.push(remap(get(dv, o)));
  const objs = [...small].map((addr) => {
    const len = get(dv, addr), words = [len];
    for (let i = 0; i < len; i++) words.push(remap(get(dv, addr + 4 + i * 4)));
    return { addr, words };
  });
  const handles = [...big].map((addr) => ({ addr, size: objSize(dv, addr) }));
  return { ctrl, stack, objs, handles };
}

// Decode into a fresh instance's linear memory at the original addresses. Big
// objects are absent (their pointers are remote handles, fetched on deref).
export function decodeContinuation(mem, wire) {
  const dv = new DataView(mem.buffer);
  wire.ctrl.forEach((w, i) => dv.setInt32(i * 4, w, true));
  wire.stack.forEach((w, i) => dv.setInt32(STACK_BASE + i * 4, w, true));
  for (const { addr, words } of wire.objs) words.forEach((w, i) => dv.setInt32(addr + i * 4, w, true));
}

// Bytes that actually crossed (the §5 measure).
export const wireBytes = (wire) => (wire.ctrl.length + wire.stack.length + wire.objs.reduce((s, o) => s + o.words.length, 0)) * 4;
