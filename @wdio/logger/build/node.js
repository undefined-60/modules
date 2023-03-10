import fs from 'node:fs';
import util from 'node:util';
import log from 'loglevel';
import chalk from 'chalk';
import prefix from 'loglevel-plugin-prefix';
import ansiStrip from 'strip-ansi';
prefix.reg(log);
const DEFAULT_LEVEL = process.env.WDIO_DEBUG
    ? 'trace'
    : 'info';
const COLORS = {
    error: 'red',
    warn: 'yellow',
    info: 'cyanBright',
    debug: 'green',
    trace: 'cyan'
};
const matches = {
    COMMAND: 'COMMAND',
    DATA: 'DATA',
    RESULT: 'RESULT'
};
const SERIALIZERS = [{
        /**
         * display error stack
         */
        matches: (err) => err instanceof Error,
        serialize: (err) => err.stack
    }, {
        /**
         * color commands blue
         */
        matches: (log) => log === matches.COMMAND,
        serialize: (log) => chalk.magenta(log)
    }, {
        /**
         * color data yellow
         */
        matches: (log) => log === matches.DATA,
        serialize: (log) => chalk.yellow(log)
    }, {
        /**
         * color result cyan
         */
        matches: (log) => log === matches.RESULT,
        serialize: (log) => chalk.cyan(log)
    }];
const loggers = log.getLoggers();
let logLevelsConfig = {};
const logCache = new Set();
let logFile;
const originalFactory = log.methodFactory;
const wdioLoggerMethodFactory = function (methodName, logLevel, loggerName) {
    const rawMethod = originalFactory(methodName, logLevel, loggerName);
    return (...args) => {
        /**
         * create logFile lazily
         */
        if (!logFile && process.env.WDIO_LOG_PATH) {
            logFile = fs.createWriteStream(process.env.WDIO_LOG_PATH);
        }
        /**
         * split `prefixer: value` sting to `prefixer: ` and `value`
         * so that SERIALIZERS can match certain string
         */
        const match = Object.values(matches).filter(x => args[0].endsWith(`: ${x}`))[0];
        if (match) {
            const prefixStr = args.shift().slice(0, -match.length - 1);
            args.unshift(prefixStr, match);
        }
        args = args.map((arg) => {
            for (const s of SERIALIZERS) {
                if (s.matches(arg)) {
                    return s.serialize(arg);
                }
            }
            return arg;
        });
        const logText = ansiStrip(`${util.format.apply(this, args)}\n`);
        if (logFile && logFile.writable) {
            /**
             * empty logging cache if stuff got logged before
             */
            if (logCache.size) {
                logCache.forEach((log) => {
                    if (logFile) {
                        logFile.write(log);
                    }
                });
                logCache.clear();
            }
            return logFile.write(logText);
        }
        logCache.add(logText);
        rawMethod(...args);
    };
};
export default function getLogger(name) {
    /**
     * check if logger was already initiated
     */
    if (loggers[name]) {
        return loggers[name];
    }
    let logLevel = (process.env.WDIO_LOG_LEVEL || DEFAULT_LEVEL);
    const logLevelName = getLogLevelName(name);
    if (logLevelsConfig[logLevelName]) {
        logLevel = logLevelsConfig[logLevelName];
    }
    loggers[name] = log.getLogger(name);
    loggers[name].setLevel(logLevel);
    loggers[name].methodFactory = wdioLoggerMethodFactory;
    prefix.apply(loggers[name], {
        template: '%t %l %n:',
        timestampFormatter: (date) => chalk.gray(date.toISOString()),
        levelFormatter: (level) => chalk[COLORS[level]](level.toUpperCase()),
        nameFormatter: (name) => chalk.whiteBright(name)
    });
    return loggers[name];
}
/**
 * Wait for writable stream to be flushed.
 * Calling this prevents part of the logs in the very env to be lost.
 */
getLogger.waitForBuffer = async () => new Promise(resolve => {
    // @ts-ignore
    if (logFile && Array.isArray(logFile.writableBuffer) && logFile.writableBuffer.length !== 0) {
        return setTimeout(async () => {
            await getLogger.waitForBuffer();
            resolve();
        }, 20);
    }
    resolve();
});
getLogger.setLevel = (name, level) => loggers[name].setLevel(level);
getLogger.clearLogger = () => {
    if (logFile) {
        logFile.end();
    }
    logFile = null;
};
getLogger.setLogLevelsConfig = (logLevels = {}, wdioLogLevel = DEFAULT_LEVEL) => {
    /**
     * set log level
     */
    if (process.env.WDIO_LOG_LEVEL === undefined) {
        process.env.WDIO_LOG_LEVEL = wdioLogLevel;
    }
    logLevelsConfig = {};
    /**
     * build logLevelsConfig object
     */
    Object.entries(logLevels).forEach(([logName, logLevel]) => {
        const logLevelName = getLogLevelName(logName);
        logLevelsConfig[logLevelName] = logLevel;
    });
    /**
     * set log level for each logger
     */
    Object.keys(loggers).forEach(logName => {
        const logLevelName = getLogLevelName(logName);
        /**
         * either apply log level from logLevels object or use global logLevel
         */
        const logLevel = typeof logLevelsConfig[logLevelName] !== 'undefined' ? logLevelsConfig[logLevelName] : process.env.WDIO_LOG_LEVEL;
        loggers[logName].setLevel(logLevel);
    });
};
const getLogLevelName = (logName) => logName.split(':').shift();
