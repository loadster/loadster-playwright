const Logger = require('simple-node-logger');
const { Buffer } = require('buffer');
const { createProxy } = require('./proxy.cjs');

const logger = Logger.createSimpleLogger({ timestampFormat: 'YYYY-MM-DD HH:mm:ss.SSS' });

const metrics = {
    requests: 0,
    uploadBytes: 0,
    downloadBytes: 0,
    consoleMessages: 0
};

function emitEvent (event) {
    if (process.send) {
        process.send({ type: 'event', event });
    }
}

function waitForConfig () {
    return new Promise(resolve => {
        process && process.once && process.once('message', msg => {
            if (msg.type === 'config') {
                resolve(msg.config);
            }
        });

        setTimeout(() => {
            resolve({});
        }, 3000);
    });
}

function attachPageConsoleListener (page, config) {
    page.on('console', async msg => {
        try {
            if (metrics.consoleMessages < config.maxConsoleMessages) {
                emitEvent({
                    type: 'console',
                    timestamp: Date.now(),
                    location: await page.url(),
                    level: msg.type(),
                    text: msg.text()
                });
            }

            metrics.consoleMessages++;
        } catch (err) {
            logger.error('Error in console listener', err);
        }
    });
}

function attachPageNavigationListener (page) {
    page.on('framenavigated', async frame => {
        try {
            if (frame.parentFrame() == null) {
                const startTime = Date.now();
                const url = frame.url();

                try {
                    await frame.waitForLoadState();
                } catch (err) {
                    logger.debug('Error waiting for frame load state', err);
                }

                const endTime = Date.now();

                emitEvent({ type: 'navigation', url, startTime, endTime, timestamp: endTime });
            }
        } catch (err) {
            logger.error('Error in framenavigated listener', err);
        }
    });
}

function attachPageRequestListener (page) {
    page.on('request', () => {
        metrics.requests++;
    });
}

function attachPageResponseListener (page, config) {
    page.on('response', async response => {
        const request = response.request();
        const url = request.url();

        try {
            const match = config.instrumentedUrlFragments.some(fragment => url.includes(fragment));

            if (match) {
                await response.finished();

                const timing = request.timing();
                const endTime = Date.now();
                const startTime = endTime - timing.responseEnd;

                emitEvent({
                    type: 'sample',
                    method: request.method(),
                    url,
                    startTime,
                    endTime,
                    timestamp: endTime
                });
            }
        } catch (err) {
            logger.error(`Error in response listener for ${url}`, err);
        }
    })
}

/**
 * Emulates network conditions, if configured.
 */
async function emulateNetworkConditions (page, config) {
    if (config.connectionBps) {
        const client = await context.newCDPSession(page);

        await client.send('Network.enable');
        await client.send('Network.emulateNetworkConditions', {
            downloadThroughput: config.connectionBps,
            uploadThroughput: config.connectionBps,
            latency: 20,
            offline: false
        });
    }
}

/**
 * Wraps Playwright's Page screenshot method to emit events when a screenshot
 * is taken.
 */
function wrapPageScreenshot (page, config) {
    const originalScreenshot = page.screenshot.bind(page);

    page.screenshot = async (opts = {}) => {
        try {
            const fullPage = opts.fullPage || false;
            const viewport = page.viewportSize();

            let scrollX = 0;
            let scrollY = 0;
            let width = viewport?.width || 0;
            let height = viewport?.height || 0;

            const options = {
                fullPage,
                type: 'jpeg',
                quality: 70,
                caret: 'initial',
                animations: 'allow',
                ...opts
            };

            if (fullPage) {
                const dimensions = await page.evaluate(() => {
                    const body = document.body, html = document.documentElement;

                    return {
                        width: Math.max(body.scrollWidth, body.offsetWidth, html.clientWidth, html.scrollWidth, html.offsetWidth),
                        height: Math.max(body.scrollHeight, body.offsetHeight, html.clientHeight, html.scrollHeight, html.offsetHeight),
                        scrollX: window.scrollX,
                        scrollY: window.scrollY
                    };
                });

                scrollX = dimensions.scrollX;
                scrollY = dimensions.scrollY;
                width = dimensions.width;
                height = dimensions.height;

                const totalPixels = width * height;

                if (totalPixels > config.maxScreenshotPixels) {
                    options.clip = {
                        x: 0,
                        y: 0,
                        width,
                        height: Math.floor(config.maxScreenshotPixels / width)
                    };
                    options.fullPage = false;
                    height = options.clip.height;
                }
            } else {
                const totalPixels = width * height;

                if (totalPixels > config.maxScreenshotPixels) {
                    height = Math.floor(config.maxScreenshotPixels / width);
                    options.clip = { x: 0, y: 0, width, height };
                }
            }

            const imageBuffer = await originalScreenshot(options);
            const screenshotEvent = {
                type: 'screenshot',
                timestamp: Date.now(),
                contentType: 'image/jpeg',
                content: imageBuffer.toString('base64'),
                width,
                height,
                scrollX,
                scrollY
            };

            emitEvent(screenshotEvent);

            return imageBuffer;
        } catch (err) {
            logger.warn(`Failed to take screenshot:`, err);

            return Buffer.alloc(0);
        }
    };
}

/**
 * Wraps Playwright's Browser.close() method.
 */
function wrapBrowserClose (browser, config, proxy) {
    const originalClose = browser.close.bind(browser);

    browser.close = async function () {
        if (proxy) {
            await proxy.close();
        }

        if (browser.__loadsterMetricsIntervalId) {
            setTimeout(() => {
                clearInterval(browser.__loadsterMetricsIntervalId);

                delete browser.__loadsterMetricsIntervalId;
            }, config.metricsInterval);
        }

        emitEvent({ type: 'metrics', ...metrics });

        return originalClose();
    };
}

/**
 * Wraps Playwright's BrowserType so that it launches wrapped browsers.
 */
function wrapBrowserType (browserType) {
    return {
        ...browserType,
        launch: async function (options = {}) {
            const config = Object.assign({
                proxyPort: 8111,
                metricsInterval: 1000,
                maxConsoleMessages: 1000,
                instrumentedUrlFragments: [],
                maxTraceHtmlLength: 1024 * 1024,
                maxScreenshotPixels: 1280 * 20000,
                defaultTimeout: 15000,
                browserArgs: [],
                browserPermissions: [],
                connectionBps: null,
                httpsTrustAll: false,
                geoDisabled: false,
                geoLatitude: null,
                geoLongitude: null,
                viewportWidth: null,
                viewportHeight: null,
                userAgent: null
            }, await waitForConfig());

            if (!config.proxyPort) {
                throw new Error('proxyPort is required in the config');
            }

            const proxy = createProxy(config.proxyPort, logger);
            await proxy.open();

            const launchOptions = {
                args: config.browserArgs,
                proxy: { server: `socks5://localhost:${config.proxyPort}` },
                ...options
            };

            const contextOptions = {
                ignoreHTTPSErrors: config.httpsTrustAll,
                ...(config.browserPermissions.length > 0 && { permissions: config.browserPermissions }),
                ...(config.viewportWidth && config.viewportHeight && {
                    viewport: {
                        width: config.viewportWidth,
                        height: config.viewportHeight
                    }
                }),
                ...((config.geoLatitude != null && config.geoLongitude != null && !config.geoDisabled) && {
                    geolocation: { latitude: config.geoLatitude, longitude: config.geoLongitude }
                }),
                ...(config.userAgent && { userAgent: config.userAgent })
            };

            const browser = await browserType.launch(launchOptions);
            const originalNewContext = browser.newContext.bind(browser);

            browser.newContext = async function (options = {}) {
                const context = await originalNewContext.call(this, { ...contextOptions, ...options });

                context.on('page', async page => {
                    page.__loadster = true;

                    await emulateNetworkConditions(page, config);

                    attachPageRequestListener(page);
                    attachPageResponseListener(page, config);
                    attachPageConsoleListener(page, config);
                    attachPageNavigationListener(page);

                    wrapPageScreenshot(page, config);
                });

                return context;
            }

            browser.__loadsterMetricsIntervalId = setInterval(() => {
                metrics.uploadBytes = proxy.getUploadBytes();
                metrics.downloadBytes = proxy.getDownloadBytes();

                emitEvent({ type: 'metrics', ...metrics });
            }, config.metricsInterval);

            wrapBrowserClose(browser, config, proxy);

            return browser;
        }
    };
}

module.exports = {
    wrapBrowserType
};

