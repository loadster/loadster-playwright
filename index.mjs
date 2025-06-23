import {test as base} from 'playwright/test';
import {program} from 'playwright/lib/program';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const browsers = require('./src/browsers.cjs');

export * from 'playwright/test';
export {program};
export {default} from 'playwright/test';

export const test = base.extend({
    playwright: async ({ playwright }, use) => {
        playwright.chromium = browsers.wrapBrowserType(playwright.chromium);
        playwright.firefox = browsers.wrapBrowserType(playwright.firefox);
        playwright.webkit = browsers.wrapBrowserType(playwright.webkit);
        playwright.__loadster = true;

        await use(playwright);
    }
});
