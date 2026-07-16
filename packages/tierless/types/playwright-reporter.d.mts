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
    private before;
    onBegin(config: FullConfigLike): void;
    onTestBegin(_test: TestCaseLike): Promise<void>;
    onTestEnd(test: TestCaseLike, result: TestResultLike): Promise<void>;
    printsToStdio(): boolean;
}
export {};
