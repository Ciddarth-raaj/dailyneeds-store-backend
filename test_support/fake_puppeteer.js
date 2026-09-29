/**
 * A stand-in for puppeteer.launch() that records every lifecycle call, for
 * services/pdf_browser.test.js and the stock-checker report tests.
 *
 *   const fake = createFakeLauncher({ pdf: () => { throw new Error("boom"); } });
 *   await withBrowser(fn, { launcher: fake });
 *   fake.browsers[0].closed  // true
 *
 * Each hook in `behaviour` replaces the matching method; return a promise
 * that never settles (`hang()`) to simulate Chrome stopping responding.
 */
const { EventEmitter } = require("events");

const hang = () => new Promise(() => {});

function createFakeLauncher(behaviour = {}) {
  const launcher = {
    launchCalls: [],
    browsers: [],
    pages: [],
    async launch(options) {
      launcher.launchCalls.push(options);
      if (behaviour.launch) return behaviour.launch(options, makeBrowser);
      return makeBrowser();
    },
  };

  function makeBrowser() {
    const browser = new EventEmitter();
    browser.closed = false;
    browser.closeCalls = 0;
    browser.newPage = async () => {
      if (behaviour.newPage) await behaviour.newPage(browser);
      const page = makePage(browser);
      launcher.pages.push(page);
      return page;
    };
    browser.close = async () => {
      browser.closeCalls += 1;
      if (behaviour.browserClose) await behaviour.browserClose(browser);
      browser.closed = true;
      browser.emit("disconnected");
    };
    browser.process = () => null;
    launcher.browsers.push(browser);
    return browser;
  }

  function makePage(browser) {
    const page = {
      browser,
      closed: false,
      contents: [],
      setDefaultTimeout() {},
      setDefaultNavigationTimeout() {},
      async setContent(html, opts) {
        page.contents.push({ html, opts });
        if (behaviour.setContent) return behaviour.setContent(page, html, opts);
      },
      async evaluate() {
        if (behaviour.evaluate) return behaviour.evaluate(page);
        return true;
      },
      async pdf(opts) {
        page.pdfOptions = opts;
        if (behaviour.pdf) return behaviour.pdf(page, opts);
        return Buffer.from("%PDF-1.4 fake");
      },
      async close() {
        if (behaviour.pageClose) await behaviour.pageClose(page);
        page.closed = true;
      },
    };
    return page;
  }

  return launcher;
}

module.exports = { createFakeLauncher, hang };
