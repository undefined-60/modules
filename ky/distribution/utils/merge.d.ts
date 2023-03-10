import type { KyHeadersInit, Options } from '../types/options.js';
export declare const validateAndMerge: (...sources: Array<Partial<Options> | undefined>) => Partial<Options>;
export declare const mergeHeaders: (source1?: KyHeadersInit, source2?: KyHeadersInit) => Headers;
export declare const deepMerge: <T>(...sources: (Partial<T> | undefined)[]) => T;
