const { test: base } = require('playwright/test');
const browsers = require('./src/browsers.js');

const test = base.extend({
    playwright: async ({ playwright }, use) => {
        playwright.chromium = browsers.wrapBrowserType(playwright.chromium);
        playwright.firefox = browsers.wrapBrowserType(playwright.firefox);
        playwright.webkit = browsers.wrapBrowserType(playwright.webkit);
        playwright.wrappedByLoadster = true;

        await use(playwright);
    }
});

module.exports = {
    test,
    program: require('playwright/lib/program'),
    ...require('playwright/test')
}
