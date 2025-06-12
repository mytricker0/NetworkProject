// puppeteer_i2p/app.js

const fs = require('fs-extra');
const puppeteer = require('puppeteer-extra');
const randomUseragent = require('random-useragent');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const chalk = require('chalk');
const dotenv = require('dotenv');
const axios = require('axios');
const { HttpProxyAgent } = require('http-proxy-agent'); // for I2P

dotenv.config();

// ─── Pull environment variables ────────────────────────────────────────────────
const {
  I2P_HOST = 'i2p_router',
  I2P_PORT = '4444',
  TARGET_URL = 'http://identiguy.i2p',
  HEADLESS = 'true',
} = process.env;

// ─── Logging helpers ───────────────────────────────────────────────────────────
function logInfo(msg) {
  console.log(chalk.green(`[INFO] ${new Date().toLocaleTimeString()} - ${msg}`));
}
function logError(msg) {
  console.log(chalk.red(`[ERROR] ${new Date().toLocaleTimeString()} - ${msg}`));
}
function logWarning(msg) {
  console.log(chalk.yellow(`[WARN] ${new Date().toLocaleTimeString()} - ${msg}`));
}

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    if (signal) {
      signal.addEventListener('abort', () => {
        clearTimeout(timeout);
        reject(new Error('AbortError'));
      }, { once: true });
    }
  });
}

async function isI2PReady() {
  const proxy = `http://${I2P_HOST}:${I2P_PORT}`;
  const agent = new HttpProxyAgent(proxy);
  const urlsToTry = [
    'http://identiguy.i2p',
    'http://zzz.i2p',
    'http://forum.i2p',
    'http://stats.i2p',
  ]
   while (true) {
    for (const url of urlsToTry) {
      try {
        logInfo(`Trying I2P URL: ${url}`);
        const response = await axios.get(url, {
          httpAgent: agent,
          timeout: 120000,
        });

        if (response.status === 200 && response.data) {
          logInfo(`I2P is ready and connected via ${url}`);
          return url;
        } else {
          logInfo(`${url} responded, but not valid content. Retrying...`);
        }
      } catch (err) {
        logInfo(`${url} failed: ${err.message}`);
      }
    }

    logInfo('No I2P URLs responded successfully. Retrying in 90s...');
    await wait(90000); // Wait before the next loop
  }
}

async function runPuppeteer(targetURL) {
  puppeteer.use(StealthPlugin());

  const userAgent = randomUseragent.getRandom((ua) => parseFloat(ua.browserVersion) >= 100);
  logInfo(`Launching browser with User-Agent: ${userAgent}`);

  let browser = null;
  let chromeTmpDataDir = null;

  try {
    browser = await puppeteer.launch({
      headless: HEADLESS === 'true',
      executablePath: '/usr/bin/chromium',
      args: [
        `--proxy-server=http://${I2P_HOST}:${I2P_PORT}`,
        '--headless=new',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-features=WebRTC',
        '--disable-extensions',
        '--disable-default-apps',
        '--incognito',
        '--user-data-dir=/tmp/puppeteer_profile',
      ],
    });

    const chromeSpawnArgs = browser.process().spawnargs;
    for (const arg of chromeSpawnArgs) {
      if (arg.startsWith('--user-data-dir=')) {
        chromeTmpDataDir = arg.replace('--user-data-dir=', '');
        break;
      }
    }

    const page = await browser.newPage();
    await page.setUserAgent(userAgent);
    logInfo(`Verifying I2P connectivity via ${TARGET_URL}`);
    await page.goto(targetURL, { waitUntil: 'networkidle2', timeout: 120000 });

    const pageContent = await page.content();
    if (pageContent.toLowerCase().includes("i2p")) {
      logInfo('✔︎ Browser is correctly using the I2P network.');
    } else {
      logWarning('⚠︎ I2P check did not confirm usage. Traffic may not be routed through I2P.');
    }

  } catch (error) {
    logError(`Error running Puppeteer: ${error}`);
  } finally {
    if (browser) {
      await browser.close();
      logInfo('Browser closed.');
    }
    if (chromeTmpDataDir) {
      fs
        .remove(chromeTmpDataDir)
        .then(() => logInfo(`🧹 Deleted temporary user data dir: ${chromeTmpDataDir}`))
        .catch((err) => logError(`❌ Failed to delete temp user data dir: ${err.message}`));
    }
  }
}

// ─── Entrypoint ────────────────────────────────────────────────────────────────
(async () => {
  try {
    const workingI2PURL = await isI2PReady();
    await wait(120000);
    await runPuppeteer(workingI2PURL);
  } catch (e) {
    logError(`Fatal error: ${e.message}`);
    process.exit(1);
  }
})();
