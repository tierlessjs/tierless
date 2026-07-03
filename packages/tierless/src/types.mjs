// Shared vocabulary for the session host: what a compiled bundle looks like, what a
// continuation frame carries, what the pump yields, and the peer/host RPC shapes that tie
// a session together across the wire. Pure types, no runtime code — every module that
// needs them imports `type {...}` from here, so this file compiles to nothing and adds no
// runtime coupling. Not in the package's exports map; consumers get these re-exported from
// the modules that actually use them (tierless, tierless/runtime, tierless/browser, ...).
export {};
