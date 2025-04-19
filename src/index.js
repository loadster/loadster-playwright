import * as playwright from 'playwright';
import Logger from 'simple-node-logger';
import {Buffer} from 'buffer';
import {createProxy} from './proxy.js';

const logger = Logger.createSimpleLogger({ timestampFormat: 'YYYY-MM-DD HH:mm:ss.SSS' });

export const chromium = wrapBrowserType(playwright.chromium);
export const firefox = wrapBrowserType(playwright.firefox);
export const webkit = wrapBrowserType(playwright.webkit);

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

function wrapBrowserType (browserType) {
    return {
        ...browserType,
        __wrappedByLoadster: true,
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

            const metrics = {
                navigations: [],
                console: [],
                uploadBytes: 0,
                downloadBytes: 0,
                requests: 0,
                samples: []
            };

            function emitEvent (event) {
                if (process.send) {
                    process.send({ type: 'event', event });
                }

                if (event.type === 'console') {
                    metrics.console = metrics.console.filter(e => e !== event);
                } else if (event.type === 'navigation') {
                    metrics.navigations = metrics.navigations.filter(e => e !== event);
                } else if (event.type === 'sample') {
                    metrics.samples = metrics.samples.filter(e => e !== event);
                }
            }

            const browser = await browserType.launch(launchOptions);
            const originalNewContext = browser.newContext.bind(browser);

            browser.newContext = async function (options = {}) {
                const context = await originalNewContext.call(this, { ...contextOptions, ...options });

                context.on('page', async page => {
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

                    page.on('console', async msg => {
                        try {
                            const entry = {
                                type: 'console',
                                timestamp: Date.now(),
                                location: await page.url(),
                                level: msg.type(),
                                text: msg.text()
                            };

                            metrics.console.push(entry);

                            emitEvent(entry);

                            if (metrics.console.length > config.maxConsoleMessages) {
                                metrics.console.splice(0, metrics.console.length - config.maxConsoleMessages);
                            }
                        } catch (err) {
                            logger.error('Error in console listener', err);
                        }
                    });

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
                                const nav = { type: 'navigation', url, startTime, endTime, timestamp: Date.now() };

                                metrics.navigations.push(nav);

                                emitEvent(nav);
                            }
                        } catch (err) {
                            logger.error('Error in framenavigated listener', err);
                        }
                    });

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
                                const sample = {
                                    type: 'sample',
                                    method: request.method(),
                                    url,
                                    startTime,
                                    endTime,
                                    timestamp: Date.now()
                                };

                                metrics.samples.push(sample);

                                emitEvent(sample);
                            }
                        } catch (err) {
                            logger.error(`Error in response listener for ${url}`, err);
                        }
                    });

                    page.on('request', () => {
                        metrics.requests++;
                    });

                    // Screenshot override
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
                });

                return context;
            }

            let intervalId = null;

            intervalId = setInterval(() => {
                metrics.uploadBytes = proxy.getUploadBytes();
                metrics.downloadBytes = proxy.getDownloadBytes();
                if (process.send) {
                    process.send({ type: 'metrics', metrics });
                }
            }, config.metricsInterval);

            const originalClose = browser.close.bind(browser);

            browser.close = async function () {
                if (intervalId) {
                    await new Promise(resolve => setTimeout(resolve, config.metricsInterval));
                    clearInterval(intervalId);
                }
                if (proxy) {
                    await proxy.close();
                }
                if (process.send) {
                    process.send({ type: 'metrics', metrics });
                }
                return originalClose();
            };

            browser.__loadsterMetrics = metrics;

            return browser;
        }
    };
}
