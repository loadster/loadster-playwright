const { test: base } = require('playwright/test');
const browsers = require('./src/browsers.cjs');
const { program } = require('playwright/lib/program');

const test = base.extend({
    playwright: async ({ playwright }, use) => {
        playwright.chromium = browsers.wrapBrowserType(playwright.chromium);
        playwright.firefox = browsers.wrapBrowserType(playwright.firefox);
        playwright.webkit = browsers.wrapBrowserType(playwright.webkit);
        playwright.__loadster = true;

        await use(playwright);
    }
});

module.exports = {
    ...require('playwright/test'),
    program,
    test
}
