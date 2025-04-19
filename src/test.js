import * as baseTest from '@playwright/test';
import { chromium, firefox, webkit } from './index.js';

export const test = baseTest.test;
export const expect = baseTest.expect;

test.use({
  browserName: 'chromium',
  launchOptions: async () => ({
    browser: await chromium.launch(),
  }),
});

export { chromium, firefox, webkit };

