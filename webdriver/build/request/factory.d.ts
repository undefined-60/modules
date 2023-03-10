/// <reference types="node" />
import type { URL as URLType } from 'node:url';
import type WebDriverRequest from './index.js';
export default class RequestFactory {
    static getInstance(method: string, endpoint: string, body?: Record<string, unknown>, isHubCommand?: boolean): Promise<WebDriverRequest>;
}
export declare class URLFactory {
    static getInstance(uri: string): Promise<URLType>;
}
//# sourceMappingURL=factory.d.ts.map