// tierless/api — everything a trusted service and its (untrusted) host need:
//   defineApi / Api / JwtApi / PUBLIC / DENY   define the monitor (service side)
//   sidecarMain                                the fork entry (tail-call it in the service module)
//   startSidecar / makeApiExec / serve         fork + reach it (host side)
export { Api, JwtApi, PUBLIC, DENY, defineApi } from "./api.mjs";
export type { Principal, Authorize, FnDef, ApiOptions, ApiCall, HandleResult, ApiDef } from "./api.mjs";
export { serve, startSidecar, makeApiExec, sidecarMain } from "./sidecar.mjs";
export type { SidecarClient } from "./sidecar.mjs";
