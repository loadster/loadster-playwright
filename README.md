This is a simple wrapper for the `@playwright/test` package. It augments the standard Playwright browser types
with additional metrics gathering and tooling to support running browsers in a Loadster load test environment.

The goal is to be as transparent and minimal as possible so that you can import this module in place of the standard
Playwright Test when running in Loadster.

This wrapper retains the Apache Standard License 2.0 just like Playwright. All the Playwright code, of course,
remains the property of Microsoft and is used under license.
