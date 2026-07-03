import type { Api, ApiDef, HandleResult } from "./api.mjs";
export interface SidecarClient {
    ready(): Promise<void>;
    call(name: string, args?: unknown[], token?: string | null): Promise<HandleResult>;
    close(): void;
}
export declare function serve(api: Api): void;
export declare function startSidecar(entryUrl: URL | string, env?: Record<string, string>): SidecarClient;
export declare function sidecarMain(apiDef: ApiDef | ((secret: string | Uint8Array) => Api), { init }?: {
    init?: () => void;
}): boolean;
export declare function makeApiExec(client: SidecarClient | {
    call: SidecarClient["call"];
}, token?: string | null): (req: {
    name: string;
    args: unknown[];
}) => Promise<unknown>;
