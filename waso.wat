;; Waso interpreter — compiled to a real WebAssembly module.
;;
;; The stack-machine IR runs as a wasm module; the program's entire live state
;; lives in wasm LINEAR MEMORY, so a continuation is a byte-slice of memory
;; (§4.2.2) rather than engine-internal stack we can't read. Resources are the
;; single import `env.resource`; a tier that lacks one throws from the host,
;; unwinding wasm to the host (§8.3.3) without touching memory.
;;
;; This version has a real CALL STACK in linear memory, so a continuation can
;; span multiple frames (§4.4 "enough call-stack frame info to resume"): if a
;; resource boundary fires inside a nested function call, every live frame
;; migrates.
;;
;; Memory map (bytes):
;;   0   ip            (instruction byte-offset into the bytecode region)
;;   4   sp            (operand stack depth, in i32 slots)
;;   8   small_bump    (next free byte in the small working heap)
;;   12  result        (RET from the top frame writes the return value here)
;;   16  fp            (frame pointer: byte address of the current call frame)
;;   512   OPSTACK     (512 i32 slots: slot n at 512 + 4*n)
;;   4096  BYTECODE    (host loads the program here; instr = [op,a,b] = 12 B)
;;   16384 CALL_STACK  (call frames; each frame = 72 B:
;;                        +0 retIP, +4 prevFP, +8.. 16 i32 locals)
;;   65536 HEAP_SMALL  (working heap: `matched` grows here; travels in the cont)
;;   1048576 HEAP_BIG  (the dataset lives here; tier-local, NEVER in the cont)

(module
  (import "env" "resource" (func $resource (param i32 i32) (result i32)))
  (memory (export "memory") 256) ;; 16 MiB

  ;; operand stack -----------------------------------------------------------
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

  ;; locals are frame-relative: at fp + 8 + 4*i ------------------------------
  (func $getlocal (param $i i32) (result i32)
    (i32.load (i32.add (i32.load (i32.const 16))
      (i32.add (i32.const 8) (i32.mul (local.get $i) (i32.const 4))))))
  (func $setlocal (param $i i32) (param $v i32)
    (i32.store (i32.add (i32.load (i32.const 16))
      (i32.add (i32.const 8) (i32.mul (local.get $i) (i32.const 4)))) (local.get $v)))

  (func $advance
    (i32.store (i32.const 0) (i32.add (i32.load (i32.const 0)) (i32.const 12))))

  ;; dispatch loop -----------------------------------------------------------
  (func $run (export "run") (result i32)
    (local $ip i32) (local $op i32) (local $a i32) (local $b i32)
    (local $x i32) (local $y i32) (local $p i32) (local $len i32) (local $t i32) (local $k i32)
    (block $done
      (loop $L
        (local.set $ip (i32.load (i32.const 0)))
        (local.set $op (i32.load (i32.add (i32.const 4096) (local.get $ip))))
        (local.set $a  (i32.load (i32.add (i32.const 4096) (i32.add (local.get $ip) (i32.const 4)))))
        (local.set $b  (i32.load (i32.add (i32.const 4096) (i32.add (local.get $ip) (i32.const 8)))))

        (if (i32.eq (local.get $op) (i32.const 1)) (then     ;; PUSH a
          (call $push (local.get $a)) (call $advance) (br $L)))
        (if (i32.eq (local.get $op) (i32.const 2)) (then     ;; LOAD a
          (call $push (call $getlocal (local.get $a))) (call $advance) (br $L)))
        (if (i32.eq (local.get $op) (i32.const 3)) (then     ;; STORE a
          (call $setlocal (local.get $a) (call $pop)) (call $advance) (br $L)))
        (if (i32.eq (local.get $op) (i32.const 4)) (then     ;; LT
          (local.set $y (call $pop)) (local.set $x (call $pop))
          (call $push (i32.lt_s (local.get $x) (local.get $y))) (call $advance) (br $L)))
        (if (i32.eq (local.get $op) (i32.const 5)) (then     ;; GE
          (local.set $y (call $pop)) (local.set $x (call $pop))
          (call $push (i32.ge_s (local.get $x) (local.get $y))) (call $advance) (br $L)))
        (if (i32.eq (local.get $op) (i32.const 6)) (then     ;; ADD
          (local.set $y (call $pop)) (local.set $x (call $pop))
          (call $push (i32.add (local.get $x) (local.get $y))) (call $advance) (br $L)))
        (if (i32.eq (local.get $op) (i32.const 7)) (then     ;; JMP a
          (i32.store (i32.const 0) (local.get $a)) (br $L)))
        (if (i32.eq (local.get $op) (i32.const 8)) (then     ;; JMPF a
          (if (i32.eqz (call $pop))
            (then (i32.store (i32.const 0) (local.get $a)))
            (else (call $advance)))
          (br $L)))
        (if (i32.eq (local.get $op) (i32.const 9)) (then     ;; NEWARR
          (local.set $p (i32.load (i32.const 8)))
          (i32.store (local.get $p) (i32.const 0))
          (i32.store (i32.const 8) (i32.add (local.get $p) (i32.const 4)))
          (call $push (local.get $p)) (call $advance) (br $L)))
        (if (i32.eq (local.get $op) (i32.const 10)) (then    ;; ARRPUSH [arr,val]
          (local.set $y (call $pop)) (local.set $p (call $pop))
          (local.set $len (i32.load (local.get $p)))
          (local.set $t (i32.load (i32.const 8)))
          (i32.store (local.get $t) (local.get $y))
          (i32.store (i32.const 8) (i32.add (local.get $t) (i32.const 4)))
          (i32.store (local.get $p) (i32.add (local.get $len) (i32.const 1)))
          (call $advance) (br $L)))
        (if (i32.eq (local.get $op) (i32.const 11)) (then    ;; ARRLEN
          (local.set $p (call $pop))
          (call $push (i32.load (local.get $p))) (call $advance) (br $L)))
        (if (i32.eq (local.get $op) (i32.const 12)) (then    ;; ARRGET [arr,idx]
          (local.set $y (call $pop)) (local.set $p (call $pop))
          (call $push (i32.load (i32.add (local.get $p)
            (i32.add (i32.const 4) (i32.mul (local.get $y) (i32.const 4))))))
          (call $advance) (br $L)))
        (if (i32.eq (local.get $op) (i32.const 13)) (then    ;; RES a=resid b=argc (migration point)
          (local.set $x (call $resource (local.get $a) (local.get $b)))
          (i32.store (i32.const 4) (i32.sub (i32.load (i32.const 4)) (local.get $b)))
          (call $push (local.get $x))
          (call $advance) (br $L)))
        (if (i32.eq (local.get $op) (i32.const 14)) (then    ;; RET
          (local.set $x (call $pop))                          ;; return value
          (local.set $p (i32.load (i32.const 16)))            ;; current fp
          (if (i32.eq (i32.load (i32.add (local.get $p) (i32.const 4))) (i32.const -1))
            (then                                             ;; top frame: program done
              (i32.store (i32.const 12) (local.get $x))
              (br $done))
            (else                                             ;; return into caller
              (i32.store (i32.const 0) (i32.load (local.get $p)))                       ;; ip = retIP
              (i32.store (i32.const 16) (i32.load (i32.add (local.get $p) (i32.const 4)))) ;; fp = prevFP
              (call $push (local.get $x))
              (br $L)))))
        (if (i32.eq (local.get $op) (i32.const 15)) (then    ;; POP
          (drop (call $pop)) (call $advance) (br $L)))
        (if (i32.eq (local.get $op) (i32.const 16)) (then    ;; CALL a=addr b=argc
          (local.set $t (i32.add (i32.load (i32.const 16)) (i32.const 72)))   ;; newFP = fp + frame size
          (local.set $k (local.get $b))                                       ;; move argc args into new frame
          (block $eargs (loop $largs
            (br_if $eargs (i32.eqz (local.get $k)))
            (local.set $k (i32.sub (local.get $k) (i32.const 1)))
            (i32.store (i32.add (local.get $t) (i32.add (i32.const 8) (i32.mul (local.get $k) (i32.const 4)))) (call $pop))
            (br $largs)))
          (i32.store (local.get $t) (i32.add (local.get $ip) (i32.const 12)))           ;; retIP = after CALL
          (i32.store (i32.add (local.get $t) (i32.const 4)) (i32.load (i32.const 16)))  ;; prevFP
          (i32.store (i32.const 16) (local.get $t))                                     ;; fp = newFP
          (i32.store (i32.const 0) (local.get $a))                                      ;; ip = addr
          (br $L)))

        (unreachable) ;; bad opcode
      )
    )
    (i32.const 0)))
