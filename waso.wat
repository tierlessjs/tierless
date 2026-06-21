;; Waso interpreter — compiled to a real WebAssembly module.
;;
;; This is the same stack-machine IR as the JS spike, but now the interpreter
;; IS a wasm module and the program's entire live state lives in wasm LINEAR
;; MEMORY. That makes the design doc's three load-bearing reasons for wasm real,
;; not rhetorical (§4.2):
;;   1. capability boundary by construction — resources are the single imported
;;      function `env.resource`; a tier that lacks a resource simply throws from
;;      the host side, unwinding wasm to the host (§8.3.3 "suspend = clean
;;      unwind-to-host trigger"). The module physically cannot reach a resource
;;      it wasn't given.
;;   2. serializable execution state — ip / operand stack / locals / working
;;      heap are all at known offsets in linear memory, so a continuation is a
;;      byte-slice of memory (§4.2.2), not engine-internal stack we can't read.
;;   3. uniform semantics both sides — the SAME module bytes run on both tiers;
;;      a continuation references code by instruction offset (§4.4).
;;
;; Memory map (bytes):
;;   0   ip            (current instruction byte-offset into bytecode region)
;;   4   sp            (operand stack depth, in i32 slots)
;;   8   small_bump    (next free byte in the small working heap)
;;   12  result        (RET writes the return value here)
;;   64  LOCALS        (16 i32 locals: local k at 64 + 4*k)
;;   512 OPSTACK       (512 i32 slots: slot n at 512 + 4*n)
;;   4096  BYTECODE    (host loads the program here; each instr = [op,a,b] = 12B)
;;   65536 HEAP_SMALL  (working heap: `matched` grows here; travels in the cont)
;;   1048576 HEAP_BIG  (the dataset lives here; tier-local, NEVER in the cont)

(module
  ;; The ONE import. The host decides migrate-vs-run; on a tier without the
  ;; resource it throws, which unwinds this call without touching memory.
  (import "env" "resource" (func $resource (param i32 i32) (result i32)))

  (memory (export "memory") 256) ;; 16 MiB, enough for a multi-MiB dataset

  ;; --- tiny helpers over the in-memory operand stack / locals -------------
  (func $push (param $v i32)
    (local $sp i32)
    (local.set $sp (i32.load (i32.const 4)))
    (i32.store (i32.add (i32.const 512) (i32.mul (local.get $sp) (i32.const 4))) (local.get $v))
    (i32.store (i32.const 4) (i32.add (local.get $sp) (i32.const 1))))

  (func $pop (result i32)
    (local $sp i32)
    (local.set $sp (i32.sub (i32.load (i32.const 4)) (i32.const 1)))
    (i32.store (i32.const 4) (local.get $sp))
    (i32.load (i32.add (i32.const 512) (i32.mul (local.get $sp) (i32.const 4)))))

  (func $getlocal (param $i i32) (result i32)
    (i32.load (i32.add (i32.const 64) (i32.mul (local.get $i) (i32.const 4)))))

  (func $setlocal (param $i i32) (param $v i32)
    (i32.store (i32.add (i32.const 64) (i32.mul (local.get $i) (i32.const 4))) (local.get $v)))

  (func $advance
    (i32.store (i32.const 0) (i32.add (i32.load (i32.const 0)) (i32.const 12))))

  ;; --- the dispatch loop --------------------------------------------------
  ;; Returns 0 when the program runs to RET. May not return at all: if a RES
  ;; hits a resource this tier lacks, $resource throws and the call unwinds to
  ;; the host with linear memory intact (the continuation).
  (func $run (export "run") (result i32)
    (local $ip i32) (local $op i32) (local $a i32) (local $b i32)
    (local $x i32) (local $y i32) (local $p i32) (local $len i32) (local $t i32)
    (block $done
      (loop $L
        (local.set $ip (i32.load (i32.const 0)))
        (local.set $op (i32.load (i32.add (i32.const 4096) (local.get $ip))))
        (local.set $a  (i32.load (i32.add (i32.const 4096) (i32.add (local.get $ip) (i32.const 4)))))
        (local.set $b  (i32.load (i32.add (i32.const 4096) (i32.add (local.get $ip) (i32.const 8)))))

        ;; 1 PUSH a
        (if (i32.eq (local.get $op) (i32.const 1)) (then
          (call $push (local.get $a)) (call $advance) (br $L)))
        ;; 2 LOAD a
        (if (i32.eq (local.get $op) (i32.const 2)) (then
          (call $push (call $getlocal (local.get $a))) (call $advance) (br $L)))
        ;; 3 STORE a
        (if (i32.eq (local.get $op) (i32.const 3)) (then
          (call $setlocal (local.get $a) (call $pop)) (call $advance) (br $L)))
        ;; 4 LT
        (if (i32.eq (local.get $op) (i32.const 4)) (then
          (local.set $y (call $pop)) (local.set $x (call $pop))
          (call $push (i32.lt_s (local.get $x) (local.get $y))) (call $advance) (br $L)))
        ;; 5 GE
        (if (i32.eq (local.get $op) (i32.const 5)) (then
          (local.set $y (call $pop)) (local.set $x (call $pop))
          (call $push (i32.ge_s (local.get $x) (local.get $y))) (call $advance) (br $L)))
        ;; 6 ADD
        (if (i32.eq (local.get $op) (i32.const 6)) (then
          (local.set $y (call $pop)) (local.set $x (call $pop))
          (call $push (i32.add (local.get $x) (local.get $y))) (call $advance) (br $L)))
        ;; 7 JMP a
        (if (i32.eq (local.get $op) (i32.const 7)) (then
          (i32.store (i32.const 0) (local.get $a)) (br $L)))
        ;; 8 JMPF a
        (if (i32.eq (local.get $op) (i32.const 8)) (then
          (if (i32.eqz (call $pop))
            (then (i32.store (i32.const 0) (local.get $a)))
            (else (call $advance)))
          (br $L)))
        ;; 9 NEWARR  (allocate [len=0] in the small heap, push its pointer)
        (if (i32.eq (local.get $op) (i32.const 9)) (then
          (local.set $p (i32.load (i32.const 8)))
          (i32.store (local.get $p) (i32.const 0))
          (i32.store (i32.const 8) (i32.add (local.get $p) (i32.const 4)))
          (call $push (local.get $p)) (call $advance) (br $L)))
        ;; 10 ARRPUSH  (stack: [arr, val]) — append contiguously in the small heap
        (if (i32.eq (local.get $op) (i32.const 10)) (then
          (local.set $y (call $pop))                 ;; val
          (local.set $p (call $pop))                 ;; arr ptr
          (local.set $len (i32.load (local.get $p)))
          (local.set $t (i32.load (i32.const 8)))    ;; bump
          (i32.store (local.get $t) (local.get $y))
          (i32.store (i32.const 8) (i32.add (local.get $t) (i32.const 4)))
          (i32.store (local.get $p) (i32.add (local.get $len) (i32.const 1)))
          (call $advance) (br $L)))
        ;; 11 ARRLEN
        (if (i32.eq (local.get $op) (i32.const 11)) (then
          (local.set $p (call $pop))
          (call $push (i32.load (local.get $p))) (call $advance) (br $L)))
        ;; 12 ARRGET  (stack: [arr, idx])
        (if (i32.eq (local.get $op) (i32.const 12)) (then
          (local.set $y (call $pop)) (local.set $p (call $pop))
          (call $push (i32.load (i32.add (local.get $p)
            (i32.add (i32.const 4) (i32.mul (local.get $y) (i32.const 4))))))
          (call $advance) (br $L)))
        ;; 13 RES a=resid b=argc  — the migration point.
        ;; Call the resource WITHOUT popping its args first, so that if the host
        ;; throws (this tier lacks it) memory is left exactly "about to run RES":
        ;; re-running this same instruction on the other tier just succeeds.
        (if (i32.eq (local.get $op) (i32.const 13)) (then
          (local.set $x (call $resource (local.get $a) (local.get $b)))
          (i32.store (i32.const 4) (i32.sub (i32.load (i32.const 4)) (local.get $b))) ;; pop argc
          (call $push (local.get $x))
          (call $advance) (br $L)))
        ;; 14 RET
        (if (i32.eq (local.get $op) (i32.const 14)) (then
          (i32.store (i32.const 12) (call $pop)) (br $done)))
        ;; 15 POP
        (if (i32.eq (local.get $op) (i32.const 15)) (then
          (drop (call $pop)) (call $advance) (br $L)))

        (unreachable) ;; bad opcode
      )
    )
    (i32.const 0)))
