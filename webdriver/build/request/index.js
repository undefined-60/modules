import path from 'node:path';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import logger from '@wdio/logger';
import { transformCommandLogResult } from '@wdio/utils';
import { URLFactory } from './factory.js';
import { isSuccessfulResponse, getErrorFromResponseBody, getTimeoutError } from '../utils.js';
const require = createRequire(import.meta.url);
const pkg = require('../../package.json');
export class RequestLibError extends Error {
    statusCode;
    body;
    code;
}
const DEFAULT_HEADERS = {
    'Content-Type': 'application/json; charset=utf-8',
    'Connection': 'keep-alive',
    'Accept': 'application/json',
    'User-Agent': 'webdriver/' + pkg.version
};
const log = logger('webdriver');
export default class WebDriverRequest extends EventEmitter {
    body;
    method;
    endpoint;
    isHubCommand;
    requiresSessionId;
    defaultAgents;
    defaultOptions = {
        retry: { limit: 0 },
        followRedirect: true,
        responseType: 'json',
        throwHttpErrors: false
    };
    constructor(method, endpoint, body, isHubCommand = false) {
        super();
        this.body = body;
        this.method = method;
        this.endpoint = endpoint;
        this.isHubCommand = isHubCommand;
        this.defaultAgents = null;
        this.requiresSessionId = Boolean(this.endpoint.match(/:sessionId/));
    }
    async makeRequest(options, sessionId) {
        let fullRequestOptions = Object.assign({ method: this.method }, this.defaultOptions, await this._createOptions(options, sessionId));
        if (typeof options.transformRequest === 'function') {
            fullRequestOptions = options.transformRequest(fullRequestOptions);
        }
        this.emit('request', fullRequestOptions);
        return this._request(fullRequestOptions, options.transformResponse, options.connectionRetryCount, 0);
    }
    async _createOptions(options, sessionId, isBrowser = false) {
        const agent = isBrowser ? undefined : (options.agent || this.defaultAgents);
        const searchParams = isBrowser ?
            undefined :
            (typeof options.queryParams === 'object' ? options.queryParams : {});
        const requestOptions = {
            https: {},
            agent,
            headers: {
                ...DEFAULT_HEADERS,
                ...(typeof options.headers === 'object' ? options.headers : {})
            },
            searchParams,
            timeout: { response: options.connectionRetryTimeout }
        };
        /**
         * only apply body property if existing
         */
        if (this.body && (Object.keys(this.body).length || this.method === 'POST')) {
            const contentLength = Buffer.byteLength(JSON.stringify(this.body), 'utf8');
            requestOptions.json = this.body;
            requestOptions.headers['Content-Length'] = `${contentLength}`;
        }
        /**
         * if we don't have a session id we set it here, unless we call commands that don't require session ids, for
         * example /sessions. The call to /sessions is not connected to a session itself and it therefore doesn't
         * require it
         */
        let endpoint = this.endpoint;
        if (this.requiresSessionId) {
            if (!sessionId) {
                throw new Error('A sessionId is required for this command');
            }
            endpoint = endpoint.replace(':sessionId', sessionId);
        }
        requestOptions.url = await URLFactory.getInstance(`${options.protocol}://` +
            `${options.hostname}:${options.port}` +
            (this.isHubCommand ? this.endpoint : path.join(options.path || '', endpoint)));
        /**
         * send authentication credentials only when creating new session
         */
        if (this.endpoint === '/session' && options.user && options.key) {
            requestOptions.username = options.user;
            requestOptions.password = options.key;
        }
        /**
         * if the environment variable "STRICT_SSL" is defined as "false", it doesn't require SSL certificates to be valid.
         * Or the requestOptions has strictSSL for an environment which cannot get the environment variable correctly like on an Electron app.
         */
        requestOptions.https.rejectUnauthorized = !(options.strictSSL === false ||
            process.env.STRICT_SSL === 'false' ||
            process.env.strict_ssl === 'false');
        return requestOptions;
    }
    async _libRequest(url, options) {
        throw new Error('This function must be implemented');
    }
    _libPerformanceNow() {
        throw new Error('This function must be implemented');
    }
    async _request(fullRequestOptions, transformResponse, totalRetryCount = 0, retryCount = 0) {
        log.info(`[${fullRequestOptions.method}] ${fullRequestOptions.url.href}`);
        if (fullRequestOptions.json && Object.keys(fullRequestOptions.json).length) {
            log.info('DATA', transformCommandLogResult(fullRequestOptions.json));
        }
        const { url, ...requestLibOptions } = fullRequestOptions;
        const startTime = this._libPerformanceNow();
        let response = await this._libRequest(url, requestLibOptions)
            // @ts-ignore
            .catch((err) => {
            return err;
        });
        const durationMillisecond = this._libPerformanceNow() - startTime;
        /**
         * handle retries for requests
         * @param {Error} error  error object that causes the retry
         * @param {String} msg   message that is being shown as warning to user
         */
        const retry = (error, msg) => {
            /**
             * stop retrying if totalRetryCount was exceeded or there is no reason to
             * retry, e.g. if sessionId is invalid
             */
            if (retryCount >= totalRetryCount || error.message.includes('invalid session id')) {
                log.error(`Request failed with status ${response.statusCode} due to ${error}`);
                this.emit('response', { error });
                this.emit('performance', { request: fullRequestOptions, durationMillisecond, success: false, error, retryCount });
                throw error;
            }
            ++retryCount;
            this.emit('retry', { error, retryCount });
            this.emit('performance', { request: fullRequestOptions, durationMillisecond, success: false, error, retryCount });
            log.warn(msg);
            log.info(`Retrying ${retryCount}/${totalRetryCount}`);
            return this._request(fullRequestOptions, transformResponse, totalRetryCount, retryCount);
        };
        /**
         * handle request errors
         */
        if (response instanceof Error) {
            /**
             * handle timeouts
             */
            if (response.code === 'ETIMEDOUT') {
                const error = getTimeoutError(response, fullRequestOptions);
                return retry(error, 'Request timed out! Consider increasing the "connectionRetryTimeout" option.');
            }
            /**
             * throw if request error is unknown
             */
            this.emit('performance', { request: fullRequestOptions, durationMillisecond, success: false, error: response, retryCount });
            throw response;
        }
        if (typeof transformResponse === 'function') {
            response = transformResponse(response, fullRequestOptions);
        }
        const error = getErrorFromResponseBody(response.body, fullRequestOptions.json);
        /**
         * retry connection refused errors
         */
        if (error.message === 'java.net.ConnectException: Connection refused: connect') {
            return retry(error, 'Connection to Selenium Standalone server was refused.');
        }
        /**
         * hub commands don't follow standard response formats
         * and can have empty bodies
         */
        if (this.isHubCommand) {
            /**
             * if body contains HTML the command was called on a node
             * directly without using a hub, therefore throw
             */
            if (typeof response.body === 'string' && response.body.startsWith('<!DOCTYPE html>')) {
                this.emit('performance', { request: fullRequestOptions, durationMillisecond, success: false, error, retryCount });
                return Promise.reject(new Error('Command can only be called to a Selenium Hub'));
            }
            return { value: response.body || null };
        }
        /**
         * Resolve only if successful response
         */
        if (isSuccessfulResponse(response.statusCode, response.body)) {
            this.emit('response', { result: response.body });
            this.emit('performance', { request: fullRequestOptions, durationMillisecond, success: true, retryCount });
            return response.body;
        }
        /**
         *  stop retrying as this will never be successful.
         *  we will handle this at the elementErrorHandler
         */
        if (error.name === 'stale element reference') {
            log.warn('Request encountered a stale element - terminating request');
            this.emit('response', { error });
            this.emit('performance', { request: fullRequestOptions, durationMillisecond, success: false, error, retryCount });
            throw error;
        }
        return retry(error, `Request failed with status ${response.statusCode} due to ${error.message}`);
    }
}
