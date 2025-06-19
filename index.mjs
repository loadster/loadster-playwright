import {test as base} from 'playwright/test';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const browsers = require('./src/browsers.js');

export const test = base.extend({
    playwright: async ({ playwright }, use) => {
        playwright.chromium = browsers.wrapBrowserType(playwright.chromium);
        playwright.firefox = browsers.wrapBrowserType(playwright.firefox);
        playwright.webkit = browsers.wrapBrowserType(playwright.webkit);
        playwright.wrappedByLoadster = true;

        await use(playwright);
    }
});

export {default} from 'playwright/test';
export {program} from 'playwright/lib/program';
export * from 'playwright/test';
