// tierless/content — content-addressed immutable subgraphs (ship once, then by hash).
export function hashOf(value: unknown): string;
export class ContentStore { register(root: object): string; resolve(hash: string): object | undefined; [key: string]: any }
export function newPeerView(store: ContentStore): any;
