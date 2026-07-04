export type ActionStatus = "idle" | "running" | "done" | "error";
export interface ActionState<A extends unknown[], R> {
    run: (...args: A) => Promise<R>;
    status: ActionStatus;
    running: boolean;
    result: R | undefined;
    error: unknown;
}
export declare function useAction<A extends unknown[], R>(action: (...args: A) => Promise<R> | R): ActionState<A, R>;
