interface TestLocation {
    file: string;
    line: number;
}
interface TestCaseLike {
    location: TestLocation;
    titlePath(): string[];
}
interface TestResultLike {
    status: string;
    retry: number;
    duration: number;
}
interface FullConfigLike {
    rootDir: string;
    projects?: {
        name: string;
    }[];
}
export default class TierlessMeasureReporter {
    private rootDir;
    private projectNames;
    /** The previous test's CLOSING snapshot — this test's opening one. null until the first
     *  read lands (or after a failed read), which flags rather than resets. */
    private last;
    /** Serializes counter reads and row appends: reporter hooks are not awaited, so without
     *  this two reads could interleave and the chain's ordering guarantee would be lost. */
    private chain;
    onBegin(config: FullConfigLike): void;
    onTestEnd(test: TestCaseLike, result: TestResultLike): void;
    private record;
    printsToStdio(): boolean;
}
export {};
