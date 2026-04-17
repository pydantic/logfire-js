export declare function aggregateAverage(cases: ReportCase[]): ReportCaseAggregate;

export declare function aggregateAverageFromAggregates(aggregates: ReportCaseAggregate[]): ReportCaseAggregate;

export declare type AttributeValue = boolean | number | readonly boolean[] | readonly number[] | readonly string[] | string;

export declare class CallbackSink implements EvaluationSink {
    private readonly callback;
    constructor(callback: SinkCallback);
    submit(params: {
        context: EvaluatorContext;
        failures: readonly EvaluatorFailure[];
        results: readonly EvaluationResult[];
        spanReference: null | SpanReference;
    }): Promise<void>;
}

export declare class Case<InputsT = unknown, OutputT = unknown, MetadataT = unknown> {
    evaluators: Evaluator<InputsT, OutputT, MetadataT>[];
    expectedOutput: null | OutputT;
    inputs: InputsT;
    metadata: MetadataT | null;
    name: null | string;
    constructor(params: CaseInit<InputsT, OutputT, MetadataT>);
}

export declare interface CaseInit<InputsT = unknown, OutputT = unknown, MetadataT = unknown> {
    evaluators?: Evaluator<InputsT, OutputT, MetadataT>[];
    expectedOutput?: null | OutputT;
    inputs: InputsT;
    metadata?: MetadataT | null;
    name?: null | string;
}

export declare abstract class CaseLifecycle<InputsT = unknown, OutputT = unknown, MetadataT = unknown> {
    readonly case: CaseLike<InputsT, OutputT, MetadataT>;
    constructor(caseObj: CaseLike<InputsT, OutputT, MetadataT>);
    prepareContext(ctx: EvaluatorContext<InputsT, OutputT, MetadataT>): Promise<EvaluatorContext<InputsT, OutputT, MetadataT>>;
    setup(): Promise<void>;
    teardown(_result: ReportCaseLike): Promise<void>;
}

export declare interface CaseLike<InputsT = unknown, OutputT = unknown, MetadataT = unknown> {
    evaluators: unknown[];
    expectedOutput: null | OutputT;
    inputs: InputsT;
    metadata: MetadataT | null;
    name: null | string;
}

export declare function configure(options: OnlineEvalConfigOptions): void;

export declare interface ConfusionMatrix {
    classLabels: string[];
    description?: null | string;
    matrix: number[][];
    title: string;
    type: 'confusion_matrix';
}

export declare class ConfusionMatrixEvaluator extends ReportEvaluator {
    readonly expectedFrom: 'expected_output' | 'labels' | 'metadata' | 'output';
    readonly expectedKey: null | string;
    readonly predictedFrom: 'expected_output' | 'labels' | 'metadata' | 'output';
    readonly predictedKey: null | string;
    readonly title: string;
    constructor(params?: ConfusionMatrixEvaluatorOptions);
    evaluate(ctx: ReportEvaluatorContext): ConfusionMatrix;
    private extract;
}

export declare interface ConfusionMatrixEvaluatorOptions {
    expectedFrom?: 'expected_output' | 'labels' | 'metadata' | 'output';
    expectedKey?: null | string;
    predictedFrom?: 'expected_output' | 'labels' | 'metadata' | 'output';
    predictedKey?: null | string;
    title?: string;
}

export declare class Contains extends Evaluator {
    readonly asStrings: boolean;
    readonly caseSensitive: boolean;
    readonly value: unknown;
    constructor(params: ContainsOptions);
    evaluate(ctx: EvaluatorContext): EvaluationReason<boolean>;
}

export declare interface ContainsOptions {
    asStrings?: boolean;
    caseSensitive?: boolean;
    evaluationName?: string;
    value: unknown;
}

export declare class Dataset<InputsT = unknown, OutputT = unknown, MetadataT = unknown> {
    cases: Case<InputsT, OutputT, MetadataT>[];
    evaluators: Evaluator<InputsT, OutputT, MetadataT>[];
    name: null | string;
    reportEvaluators: ReportEvaluator<InputsT, OutputT, MetadataT>[];
    constructor(params: DatasetInit<InputsT, OutputT, MetadataT>);
    static fromDict<I = unknown, O = unknown, M = unknown>(data: Record<string, unknown>, options?: {
        customEvaluatorTypes?: EvaluatorCtor<I, O, M>[];
        customReportEvaluatorTypes?: ReportEvaluatorCtor<I, O, M>[];
        defaultName?: null | string;
    }): Dataset<I, O, M>;
    static fromText<I = unknown, O = unknown, M = unknown>(content: string, options?: {
        customEvaluatorTypes?: EvaluatorCtor<I, O, M>[];
        customReportEvaluatorTypes?: ReportEvaluatorCtor<I, O, M>[];
        defaultName?: null | string;
        fmt?: 'json' | 'yaml';
    }): Dataset<I, O, M>;
    addCase(params: CaseInit<InputsT, OutputT, MetadataT>): void;
    addEvaluator(evaluator: Evaluator<InputsT, OutputT, MetadataT>, specificCase?: string): void;
    evaluate(task: (inputs: InputsT) => OutputT | Promise<OutputT>, options?: EvaluateOptions<InputsT, OutputT, MetadataT>): Promise<EvaluationReport<InputsT, OutputT, MetadataT>>;
    toDict(): Promise<Record<string, unknown>>;
    toJSON(): Promise<string>;
    toYAML(): Promise<string>;
    private buildTasksToRun;
}

export declare interface DatasetInit<InputsT = unknown, OutputT = unknown, MetadataT = unknown> {
    cases: Case<InputsT, OutputT, MetadataT>[];
    evaluators?: Evaluator<InputsT, OutputT, MetadataT>[];
    name?: null | string;
    reportEvaluators?: ReportEvaluator<InputsT, OutputT, MetadataT>[];
}

export declare const DEFAULT_CONFIG: OnlineEvalConfig;

export declare const DEFAULT_EVALUATORS: readonly [typeof Equals, typeof EqualsExpected, typeof Contains, typeof IsInstance, typeof MaxDuration, typeof LLMJudge, typeof HasMatchingSpan];

export declare const DEFAULT_REPORT_EVALUATORS: readonly [typeof ConfusionMatrixEvaluator, typeof KolmogorovSmirnovEvaluator, typeof PrecisionRecallEvaluator, typeof ROCAUCEvaluator];

export declare function defaultRenderDuration(seconds: number): string;

export declare function defaultRenderDurationDiff(oldVal: number, newVal: number): null | string;

export declare function defaultRenderNumber(value: number): string;

export declare function defaultRenderNumberDiff(oldVal: number, newVal: number): null | string;

export declare function defaultRenderPercentage(value: number): string;

export declare function disableEvaluation<T>(fn: () => Promise<T> | T): Promise<T> | T;

export declare function downcastEvaluationResult<T extends EvaluationScalar>(result: EvaluationResult, ...types: ('boolean' | 'number' | 'string')[]): EvaluationResult<T> | null;

export declare class Equals extends Evaluator {
    readonly value: unknown;
    constructor(params: {
        evaluationName?: string;
        value: unknown;
    });
    evaluate(ctx: EvaluatorContext): boolean;
}

export declare class EqualsExpected extends Evaluator {
    constructor(params?: {
        evaluationName?: string;
    });
    evaluate(ctx: EvaluatorContext): boolean | Record<string, boolean>;
}

export declare interface EvaluateOptions<InputsT = unknown, OutputT = unknown, MetadataT = unknown> {
    lifecycle?: new (caseObj: Case<InputsT, OutputT, MetadataT>) => CaseLifecycle<InputsT, OutputT, MetadataT>;
    maxConcurrency?: null | number;
    metadata?: null | Record<string, unknown>;
    name?: null | string;
    progress?: boolean;
    repeat?: number;
    taskName?: null | string;
}

export declare interface EvaluationReason<T extends EvaluationScalar = EvaluationScalar> {
    reason?: null | string;
    value: T;
}

export declare function evaluationReason<T extends EvaluationScalar>(value: T, reason?: null | string): EvaluationReason<T>;

export declare class EvaluationReport<InputsT = unknown, OutputT = unknown, MetadataT = unknown> {
    analyses: ReportAnalysis[];
    cases: ReportCase<InputsT, OutputT, MetadataT>[];
    experimentMetadata: null | Record<string, unknown>;
    failures: ReportCaseFailure<InputsT, OutputT, MetadataT>[];
    name: string;
    reportEvaluatorFailures: EvaluatorFailure[];
    spanId: null | string;
    traceId: null | string;
    constructor(params: {
        analyses?: ReportAnalysis[];
        cases: ReportCase<InputsT, OutputT, MetadataT>[];
        experimentMetadata?: null | Record<string, unknown>;
        failures?: ReportCaseFailure<InputsT, OutputT, MetadataT>[];
        name: string;
        reportEvaluatorFailures?: EvaluatorFailure[];
        spanId?: null | string;
        traceId?: null | string;
    });
    averages(): null | ReportCaseAggregate;
    caseGroups(): null | ReportCaseGroup<InputsT, OutputT, MetadataT>[];
    render(options?: RenderOptions): string;
    toString(): string;
}

export declare interface EvaluationResult<T extends EvaluationScalar = EvaluationScalar> {
    name: string;
    reason: null | string;
    source: EvaluatorSpec;
    value: T;
}

export declare type EvaluationScalar = boolean | number | string;

export declare interface EvaluationSink {
    submit: (params: {
        context: EvaluatorContext;
        failures: readonly EvaluatorFailure[];
        results: readonly EvaluationResult[];
        spanReference: null | SpanReference;
    }) => Promise<void>;
}

export declare abstract class Evaluator<InputsT = unknown, OutputT = unknown, MetadataT = unknown> {
    evaluationName?: string;
    asSpec(): EvaluatorSpec;
    buildSerializationArguments(): Record<string, unknown>;
    abstract evaluate(ctx: EvaluatorContext<InputsT, OutputT, MetadataT>): EvaluatorOutput | Promise<EvaluatorOutput>;
    evaluateAsync(ctx: EvaluatorContext<InputsT, OutputT, MetadataT>): Promise<EvaluatorOutput>;
    getDefaultEvaluationName(): string;
    getSerializationName(): string;
}

export declare class EvaluatorContext<InputsT = unknown, OutputT = unknown, MetadataT = unknown> {
    readonly attributes: Record<string, unknown>;
    readonly duration: number;
    readonly expectedOutput: null | OutputT;
    readonly inputs: InputsT;
    readonly metadata: MetadataT | null;
    readonly metrics: Record<string, number>;
    readonly name: null | string;
    readonly output: OutputT;
    get spanTree(): SpanTree;
    private readonly _spanTree;
    constructor(init: EvaluatorContextInit<InputsT, OutputT, MetadataT>);
}

declare interface EvaluatorContextInit<InputsT, OutputT, MetadataT> {
    attributes: Record<string, unknown>;
    duration: number;
    expectedOutput: null | OutputT;
    inputs: InputsT;
    metadata: MetadataT | null;
    metrics: Record<string, number>;
    name: null | string;
    output: OutputT;
    spanTree: SpanTree | SpanTreeRecordingError;
}

declare type EvaluatorCtor<I = unknown, O = unknown, M = unknown> = new (args: never) => Evaluator<I, O, M>;

export declare interface EvaluatorFailure {
    errorMessage: string;
    errorStacktrace: string;
    name: string;
    source: EvaluatorSpec;
}

export declare type EvaluatorOutput = EvaluationReason | EvaluationScalar | Record<string, EvaluationReason | EvaluationScalar>;

export declare type EvaluatorSerializedForm = Record<string, [unknown] | Record<string, unknown>> | string;

export declare interface EvaluatorSpec {
    arguments?: [unknown] | null | Record<string, unknown>;
    name: string;
}

export declare function generateDataset<InputsT = unknown, OutputT = unknown, MetadataT = unknown>(options: GenerateDatasetOptions<InputsT, OutputT, MetadataT>): Promise<Dataset<InputsT, OutputT, MetadataT>>;

export declare interface GenerateDatasetOptions<InputsT = unknown, OutputT = unknown, MetadataT = unknown> {
    extraInstructions?: string;
    generator: (params: {
        extraInstructions?: string;
        nExamples: number;
    }) => Promise<{
        cases: {
            expectedOutput?: null | OutputT;
            inputs: InputsT;
            metadata?: MetadataT | null;
            name?: null | string;
        }[];
    }>;
    name?: null | string;
    nExamples?: number;
}

export declare function getCurrentTaskRun(): null | TaskRun;

export declare function getDefaultJudgeFn(): JudgeFn | null;

/**
 * Install a user-provided span processor that forwards spans to the pydantic-evals
 * capture mechanism. Use this when configuring your TracerProvider in v2+ OTel,
 * where `addSpanProcessor` is not available on the provider after construction.
 *
 * Example:
 * ```ts
 * import { BasicTracerProvider } from '@opentelemetry/sdk-trace-base'
 * import { getSpanTreeProcessor } from '@pydantic/evals'
 * const provider = new BasicTracerProvider({ spanProcessors: [getSpanTreeProcessor()] })
 * ```
 */
export declare function getSpanTreeProcessor(): SpanProcessorLike;

export declare interface GradingOutput {
    pass_: boolean;
    reason: string;
    score: number;
}

export declare class HasMatchingSpan extends Evaluator {
    readonly query: SpanQuery;
    constructor(params: {
        evaluationName?: string;
        query: SpanQuery;
    });
    evaluate(ctx: EvaluatorContext): boolean;
}

declare interface HrTime {
    0: number;
    1: number;
}

export declare function incrementEvalMetric(name: string, amount: number): void;

export declare function isEvaluationReason(value: unknown): value is EvaluationReason;

export declare class IsInstance extends Evaluator {
    readonly typeName: string;
    constructor(params: {
        evaluationName?: string;
        typeName: string;
    });
    evaluate(ctx: EvaluatorContext): EvaluationReason<boolean>;
}

export declare type JudgeFn = (params: {
    expectedOutput?: unknown;
    inputs?: unknown;
    output: unknown;
    rubric: string;
}) => GradingOutput | Promise<GradingOutput>;

export declare class KolmogorovSmirnovEvaluator extends ReportEvaluator {
    readonly nThresholds: number;
    readonly positiveFrom: PositiveFrom;
    readonly positiveKey: null | string;
    readonly scoreFrom: ScoreFrom;
    readonly scoreKey: string;
    readonly title: string;
    constructor(params: KSEvaluatorOptions);
    evaluate(ctx: ReportEvaluatorContext): ReportAnalysis[];
}

export declare interface KSEvaluatorOptions {
    nThresholds?: number;
    positiveFrom: PositiveFrom;
    positiveKey?: null | string;
    scoreFrom?: ScoreFrom;
    scoreKey: string;
    title?: string;
}

export declare interface LinePlot {
    curves: LinePlotCurve[];
    description?: null | string;
    title: string;
    type: 'line_plot';
    x_label: string;
    x_range?: [number, number] | null;
    y_label: string;
    y_range?: [number, number] | null;
}

export declare interface LinePlotCurve {
    name: string;
    points: LinePlotPoint[];
    step?: 'end' | 'middle' | 'start' | null;
    style?: 'dashed' | 'solid';
}

export declare interface LinePlotPoint {
    x: number;
    y: number;
}

export declare class LLMJudge extends Evaluator {
    readonly assertion: false | OutputConfig;
    readonly includeExpectedOutput: boolean;
    readonly includeInput: boolean;
    readonly judge?: JudgeFn;
    readonly rubric: string;
    readonly score: false | OutputConfig;
    constructor(params: LLMJudgeOptions);
    evaluate(ctx: EvaluatorContext): Promise<EvaluatorOutput>;
    private applyOutput;
}

export declare interface LLMJudgeOptions {
    assertion?: false | OutputConfig;
    evaluationName?: string;
    includeExpectedOutput?: boolean;
    includeInput?: boolean;
    judge?: JudgeFn;
    rubric: string;
    score?: false | OutputConfig;
}

export declare class MaxDuration extends Evaluator {
    readonly seconds: number;
    constructor(params: {
        seconds: number;
    });
    evaluate(ctx: EvaluatorContext): boolean;
}

export declare type OnErrorCallback = (error: Error, ctx: EvaluatorContext, evaluator: Evaluator, location: OnErrorLocation) => Promise<void> | void;

export declare type OnErrorLocation = 'on_max_concurrency' | 'sink';

export declare class OnlineEvalConfig {
    defaultSampleRate: ((ctx: SamplingContext) => boolean | number) | number;
    defaultSink: EvaluationSink | EvaluationSink[] | null | SinkCallback | SinkCallback[];
    enabled: boolean;
    metadata: null | Record<string, unknown>;
    onError: null | OnErrorCallback;
    onMaxConcurrency: null | OnMaxConcurrencyCallback;
    onSamplingError: null | OnSamplingErrorCallback;
    samplingMode: SamplingMode;
    constructor(options?: OnlineEvalConfigOptions);
    evaluate<F extends (...args: never[]) => unknown>(...evaluators: (Evaluator | OnlineEvaluator)[]): (fn: F) => F;
    private dispatchEvaluator;
    private runWrapped;
    private shouldEvaluate;
}

export declare interface OnlineEvalConfigOptions {
    defaultSampleRate?: ((ctx: SamplingContext) => boolean | number) | number;
    defaultSink?: EvaluationSink | EvaluationSink[] | null | SinkCallback | SinkCallback[];
    enabled?: boolean;
    metadata?: null | Record<string, unknown>;
    onError?: null | OnErrorCallback;
    onMaxConcurrency?: null | OnMaxConcurrencyCallback;
    onSamplingError?: null | OnSamplingErrorCallback;
    samplingMode?: SamplingMode;
}

export declare function onlineEvaluate<F extends (...args: never[]) => unknown>(...evaluators: (Evaluator | OnlineEvaluator)[]): (fn: F) => F;

export declare class OnlineEvaluator {
    readonly evaluator: Evaluator;
    readonly maxConcurrency: number;
    readonly onError: null | OnErrorCallback;
    readonly onMaxConcurrency: null | OnMaxConcurrencyCallback;
    readonly onSamplingError: null | OnSamplingErrorCallback;
    readonly sampleRate: ((ctx: SamplingContext) => boolean | number) | null | number;
    readonly sink: EvaluationSink | EvaluationSink[] | null | SinkCallback | SinkCallback[];
    private currentCount;
    constructor(options: OnlineEvaluatorOptions);
    acquire(): boolean;
    release(): void;
}

export declare interface OnlineEvaluatorOptions {
    evaluator: Evaluator;
    maxConcurrency?: number;
    onError?: null | OnErrorCallback;
    onMaxConcurrency?: null | OnMaxConcurrencyCallback;
    onSamplingError?: null | OnSamplingErrorCallback;
    sampleRate?: ((ctx: SamplingContext) => boolean | number) | null | number;
    sink?: EvaluationSink | EvaluationSink[] | null | SinkCallback | SinkCallback[];
}

export declare type OnMaxConcurrencyCallback = (ctx: EvaluatorContext) => Promise<void> | void;

export declare type OnSamplingErrorCallback = (error: Error, evaluator: Evaluator) => void;

export declare interface OutputConfig {
    evaluationName?: string;
    includeReason?: boolean;
}

export declare function parseEvaluatorSpec(value: EvaluatorSerializedForm): EvaluatorSpec;

declare type PositiveFrom = 'assertions' | 'expected_output' | 'labels';

export declare interface PrecisionRecall {
    curves: PrecisionRecallCurve[];
    description?: null | string;
    title: string;
    type: 'precision_recall';
}

export declare interface PrecisionRecallCurve {
    auc?: null | number;
    name: string;
    points: PrecisionRecallPoint[];
}

export declare class PrecisionRecallEvaluator extends ReportEvaluator {
    readonly nThresholds: number;
    readonly positiveFrom: PositiveFrom;
    readonly positiveKey: null | string;
    readonly scoreFrom: ScoreFrom;
    readonly scoreKey: string;
    readonly title: string;
    constructor(params: PrecisionRecallEvaluatorOptions);
    evaluate(ctx: ReportEvaluatorContext): ReportAnalysis[];
}

export declare interface PrecisionRecallEvaluatorOptions {
    nThresholds?: number;
    positiveFrom: PositiveFrom;
    positiveKey?: null | string;
    scoreFrom?: ScoreFrom;
    scoreKey: string;
    title?: string;
}

export declare interface PrecisionRecallPoint {
    precision: number;
    recall: number;
    threshold: number;
}

export declare class PydanticEvalsDeprecationWarning {
    readonly message: string;
    readonly name = "PydanticEvalsDeprecationWarning";
    constructor(message: string);
}

declare interface ReadableSpanLike {
    attributes?: Record<string, unknown>;
    endTime?: HrTime;
    name: string;
    parentSpanContext?: null | {
        spanId: string;
    };
    parentSpanId?: string;
    spanContext: () => {
        spanId: string;
        traceId: string;
    };
    startTime?: HrTime;
}

export declare interface RenderOptions {
    baseline?: EvaluationReport | null;
    includeAnalyses?: boolean;
    includeAverages?: boolean;
    includeDurations?: boolean;
    includeErrors?: boolean;
    includeEvaluatorFailures?: boolean;
    includeExpectedOutput?: boolean;
    includeInput?: boolean;
    includeMetadata?: boolean;
    includeOutput?: boolean;
    includeReasons?: boolean;
    includeTotalDuration?: boolean;
}

export declare type ReportAnalysis = ConfusionMatrix | LinePlot | PrecisionRecall | ScalarResult | TableResult;

export declare interface ReportCase<InputsT = unknown, OutputT = unknown, MetadataT = unknown> {
    assertions: Record<string, EvaluationResult<boolean>>;
    attributes: Record<string, unknown>;
    evaluatorFailures: EvaluatorFailure[];
    expectedOutput: null | OutputT;
    inputs: InputsT;
    labels: Record<string, EvaluationResult<string>>;
    metadata: MetadataT | null;
    metrics: Record<string, number>;
    name: string;
    output: OutputT;
    scores: Record<string, EvaluationResult<number>>;
    sourceCaseName: null | string;
    spanId: null | string;
    taskDuration: number;
    totalDuration: number;
    traceId: null | string;
}

export declare interface ReportCaseAggregate {
    assertions: null | number;
    labels: Record<string, Record<string, number>>;
    metrics: Record<string, number>;
    name: string;
    scores: Record<string, number>;
    taskDuration: number;
    totalDuration: number;
}

export declare interface ReportCaseFailure<InputsT = unknown, OutputT = unknown, MetadataT = unknown> {
    errorMessage: string;
    errorStacktrace: string;
    expectedOutput: null | OutputT;
    inputs: InputsT;
    metadata: MetadataT | null;
    name: string;
    sourceCaseName: null | string;
    spanId: null | string;
    traceId: null | string;
}

export declare interface ReportCaseGroup<InputsT = unknown, OutputT = unknown, MetadataT = unknown> {
    expectedOutput: null | OutputT;
    failures: ReportCaseFailure<InputsT, OutputT, MetadataT>[];
    inputs: InputsT;
    metadata: MetadataT | null;
    name: string;
    runs: ReportCase<InputsT, OutputT, MetadataT>[];
    summary: ReportCaseAggregate;
}

export declare interface ReportCaseLike {
    name: string;
}

export declare abstract class ReportEvaluator<InputsT = unknown, OutputT = unknown, MetadataT = unknown> {
    asSpec(): EvaluatorSpec;
    buildSerializationArguments(): Record<string, unknown>;
    abstract evaluate(ctx: ReportEvaluatorContext<InputsT, OutputT, MetadataT>): Promise<ReportAnalysis | ReportAnalysis[]> | ReportAnalysis | ReportAnalysis[];
    evaluateAsync(ctx: ReportEvaluatorContext<InputsT, OutputT, MetadataT>): Promise<ReportAnalysis | ReportAnalysis[]>;
    getSerializationName(): string;
}

export declare interface ReportEvaluatorContext<InputsT = unknown, OutputT = unknown, MetadataT = unknown> {
    experimentMetadata: null | Record<string, unknown>;
    name: string;
    report: {
        cases: {
            assertions: Record<string, {
                reason: null | string;
                value: boolean;
            }>;
            expectedOutput: null | OutputT;
            inputs: InputsT;
            labels: Record<string, {
                reason: null | string;
                value: string;
            }>;
            metadata: MetadataT | null;
            metrics: Record<string, number>;
            name: string;
            output: OutputT;
            scores: Record<string, {
                reason: null | string;
                value: number;
            }>;
        }[];
    };
}

declare type ReportEvaluatorCtor<I = unknown, O = unknown, M = unknown> = new (args: never) => ReportEvaluator<I, O, M>;

export declare class ROCAUCEvaluator extends ReportEvaluator {
    readonly nThresholds: number;
    readonly positiveFrom: PositiveFrom;
    readonly positiveKey: null | string;
    readonly scoreFrom: ScoreFrom;
    readonly scoreKey: string;
    readonly title: string;
    constructor(params: ROCAUCEvaluatorOptions);
    evaluate(ctx: ReportEvaluatorContext): ReportAnalysis[];
}

export declare interface ROCAUCEvaluatorOptions {
    nThresholds?: number;
    positiveFrom: PositiveFrom;
    positiveKey?: null | string;
    scoreFrom?: ScoreFrom;
    scoreKey: string;
    title?: string;
}

export declare function runEvaluator(evaluator: Evaluator, ctx: EvaluatorContext): Promise<EvaluationResult[] | EvaluatorFailure>;

export declare function runEvaluators(evaluators: Evaluator[], context: EvaluatorContext): Promise<{
    failures: EvaluatorFailure[];
    results: EvaluationResult[];
}>;

export declare interface SamplingContext {
    callSeed: number;
    evaluator: Evaluator;
    inputs: unknown;
    metadata: null | Record<string, unknown>;
}

export declare type SamplingMode = 'correlated' | 'independent';

export declare interface ScalarResult {
    description?: null | string;
    title: string;
    type: 'scalar';
    unit?: null | string;
    value: number;
}

declare type ScoreFrom = 'metrics' | 'scores';

export declare function serializeEvaluatorSpec(spec: EvaluatorSpec): EvaluatorSerializedForm;

export declare function setDefaultJudgeFn(fn: JudgeFn | null): void;

export declare function setEvalAttribute(name: string, value: unknown): void;

export declare type SinkCallback = (results: readonly EvaluationResult[], failures: readonly EvaluatorFailure[], context: EvaluatorContext) => Promise<void> | void;

export declare type SpanAttributes = Readonly<Record<string, AttributeValue | undefined>>;

export declare class SpanNode {
    readonly attributes: SpanAttributes;
    readonly childrenById: Map<string, SpanNode>;
    readonly endTimestamp: Date;
    readonly name: string;
    parent: null | SpanNode;
    readonly parentSpanId: null | string;
    readonly spanId: string;
    readonly startTimestamp: Date;
    readonly traceId: string;
    get ancestors(): SpanNode[];
    get children(): SpanNode[];
    get descendants(): SpanNode[];
    get duration(): number;
    get nodeKey(): string;
    get parentNodeKey(): null | string;
    constructor(init: SpanNodeInit);
    addChild(child: SpanNode): void;
    anyAncestor(predicate: SpanPredicate | SpanQuery, stopRecursingWhen?: SpanPredicate | SpanQuery): boolean;
    anyChild(predicate: SpanPredicate | SpanQuery): boolean;
    anyDescendant(predicate: SpanPredicate | SpanQuery, stopRecursingWhen?: SpanPredicate | SpanQuery): boolean;
    findAncestors(predicate: SpanPredicate | SpanQuery, stopRecursingWhen?: SpanPredicate | SpanQuery): SpanNode[];
    findChildren(predicate: SpanPredicate | SpanQuery): SpanNode[];
    findDescendants(predicate: SpanPredicate | SpanQuery, stopRecursingWhen?: SpanPredicate | SpanQuery): SpanNode[];
    firstAncestor(predicate: SpanPredicate | SpanQuery, stopRecursingWhen?: SpanPredicate | SpanQuery): null | SpanNode;
    firstChild(predicate: SpanPredicate | SpanQuery): null | SpanNode;
    firstDescendant(predicate: SpanPredicate | SpanQuery, stopRecursingWhen?: SpanPredicate | SpanQuery): null | SpanNode;
    matches(query: SpanPredicate | SpanQuery): boolean;
    toString(): string;
    private matchesQuery;
}

declare interface SpanNodeInit {
    attributes?: SpanAttributes;
    endTimestamp: Date;
    name: string;
    parentSpanId?: null | string;
    spanId: string;
    startTimestamp: Date;
    traceId: string;
}

export declare type SpanPredicate = (node: SpanNode) => boolean;

declare interface SpanProcessorLike {
    forceFlush: () => Promise<void>;
    onEnd: (span: ReadableSpanLike) => void;
    onStart: () => void;
    shutdown: () => Promise<void>;
}

export declare interface SpanQuery {
    all_ancestors_have?: SpanQuery;
    all_children_have?: SpanQuery;
    all_descendants_have?: SpanQuery;
    and_?: SpanQuery[];
    has_attribute_keys?: string[];
    has_attributes?: Record<string, unknown>;
    max_child_count?: number;
    max_depth?: number;
    max_descendant_count?: number;
    max_duration?: number;
    min_child_count?: number;
    min_depth?: number;
    min_descendant_count?: number;
    min_duration?: number;
    name_contains?: string;
    name_equals?: string;
    name_matches_regex?: string;
    no_ancestor_has?: SpanQuery;
    no_child_has?: SpanQuery;
    no_descendant_has?: SpanQuery;
    not_?: SpanQuery;
    or_?: SpanQuery[];
    some_ancestor_has?: SpanQuery;
    some_child_has?: SpanQuery;
    some_descendant_has?: SpanQuery;
    stop_recursing_when?: SpanQuery;
}

export declare interface SpanReference {
    spanId: string;
    traceId: string;
}

export declare class SpanTree {
    nodesById: Map<string, SpanNode>;
    roots: SpanNode[];
    constructor(spans?: SpanNode[]);
    addSpans(spans: SpanNode[]): void;
    any(predicate: SpanPredicate | SpanQuery): boolean;
    find(predicate: SpanPredicate | SpanQuery): SpanNode[];
    first(predicate: SpanPredicate | SpanQuery): null | SpanNode;
    [Symbol.iterator](): IterableIterator<SpanNode>;
    toString(): string;
    private rebuild;
}

export declare class SpanTreeRecordingError extends Error {
    constructor(message: string);
}

export declare interface TableResult {
    columns: string[];
    description?: null | string;
    rows: (boolean | null | number | string)[][];
    title: string;
    type: 'table';
}

declare class TaskRun {
    attributes: Record<string, unknown>;
    metrics: Record<string, number>;
    incrementMetric(name: string, amount: number): void;
    recordAttribute(name: string, value: unknown): void;
    recordMetric(name: string, value: number): void;
}

export declare function waitForEvaluations(): Promise<void>;

export { }
