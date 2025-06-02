// puppeteer_tor/app.js

const fs = require('fs-extra');
const puppeteer = require('puppeteer-extra');
const randomUseragent = require('random-useragent');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const chalk = require('chalk');            // chalk@4 (CommonJS)
const dotenv = require('dotenv');
const axios = require('axios');
const { SocksProxyAgent } = require('socks-proxy-agent');
const TorControl = require('tor-control'); // if you need ControlPort later

dotenv.config();



// ─── Pull environment variables ────────────────────────────────────────────────
const {
  TOR_HOST = 'tor',
  TOR_PORT = '9050',
  TOR_CONTROL_PORT = '9051',
  TOR_PASSWORD = '',               // only used if you do ControlPort commands
  TARGET_URL = 'https://check.torproject.org/',
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

// 5. UTILITIES
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

async function isTorReady() {
  const proxy = `socks5h://tor:${process.env.TOR_PORT}`;
  const agent = new SocksProxyAgent(proxy);
  while (true) {
    try {
      const response = await axios.get('https://check.torproject.org/', {
        httpsAgent: agent,
        timeout: 5000,
      });
      if (response.data.includes("Congratulations. This browser is configured to use Tor.")) {
        logInfo('Tor is ready and connected.');
        return true;
      } else {
        logInfo('Tor not ready yet, retrying...');
      }
    } catch (err) {
      logInfo('Tor not ready yet, retrying...');
    }
    await wait(5000);
  }
}

const controller = new TorControl({
  host: 'tor',
  port: `${process.env.TOR_CONTROL_PORT}`,
  password: `${process.env.TOR_PASSWORD}`
});

function renewTorCircuit() {
  return new Promise((resolve, reject) => {
    controller.signalNewnym((err) => {
      if (err) {
        logError('SIGNAL NEWNYM error: ' + err);
        return reject(err);
      }
      logInfo('SIGNAL NEWNYM accepted.');
      resolve();
    });
  });
}

function getDescriptorIP(fingerprint) {
  return new Promise((resolve, reject) => {
    controller.getInfo(`desc/id/${fingerprint}`, (err, info) => {
      if (err) return reject(err);
      const lines = info.split('\n');
      let ip = null;
      for (const line of lines) {
        if (line.startsWith('r ')) {
          const parts = line.split(' ');
          if (parts.length >= 3) {
            ip = parts[2];
            break;
          }
        }
      }
      resolve(ip);
    });
  });
}

function displayCircuit() {
  return new Promise((resolve, reject) => {
    controller.getInfo('circuit-status', (err, info) => {
      if (err) return reject(err);
      const circuitStatus = info.data;
      logInfo(`DisplayCircuit: Circuit status received. ${circuitStatus} bytes.`);
      const lines = circuitStatus.split('\n');
      let circuitLine = null;
      for (const line of lines) {
        if (/^\d+\s+BUILT\s+/.test(line)) {
          circuitLine = line;
          break;
        }
      }
      if (!circuitLine) {
        logInfo("DisplayCircuit: No built circuit found.");
        return resolve();
      }
      let pathPart = circuitLine.split("BUILT")[1].trim();
      if (pathPart.includes("BUILD_FLAGS")) {
        pathPart = pathPart.split("BUILD_FLAGS")[0].trim();
      }
      const hops = pathPart.split(",");
      const fingerprints = hops.map(hop => hop.split("~")[0].replace("$", "").trim());
      resolve();
    });
  });
}

async function waitForTor(interval = 5000) {
  logInfo('Waiting for Tor to be ready...');
  while (true) {
    const torReady = await isTorReady();
    if (torReady) {
      logInfo('Tor is fully bootstrapped and ready.');
      await renewTorCircuit();
      console.log('Renewed Tor circuit.');
      displayCircuit().catch(err => logError("DisplayCircuit error: " + err.message));
      return true;
    }
    logInfo('Tor not ready yet, retrying...');
    await wait(interval);
  }
}

// ─── Puppeteer routine, only invoked after Tor is confirmed ready ─────────────
async function runPuppeteer() {
  puppeteer.use(StealthPlugin());

  const userAgent = randomUseragent.getRandom((ua) => parseFloat(ua.browserVersion) >= 100);
  logInfo(`Launching browser with User-Agent: ${userAgent}`);

  let browser = null;
  let chromeTmpDataDir = null;

  try {
    browser = await puppeteer.launch({
      headless: HEADLESS === 'true',
      executablePath: '/usr/bin/chromium',   // ensure Dockerfile installed chromium
      args: [
        `--proxy-server=socks5h://${TOR_HOST}:${TOR_PORT}`,
        '--headless=new',                    // Chrome headless 
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',           // avoid /dev/shm issues
        '--disable-gpu',
        '--disable-features=WebRTC',
        '--disable-extensions',
        '--disable-default-apps',
        '--incognito',
        '--user-data-dir=/tmp/puppeteer_profile',
      ],
    });

    // Extract Puppeteer’s temporary profile directory to delete later
    const chromeSpawnArgs = browser.process().spawnargs;
    for (const arg of chromeSpawnArgs) {
      if (arg.startsWith('--user-data-dir=')) {
        chromeTmpDataDir = arg.replace('--user-data-dir=', '');
        break;
      }
    }

    const page = await browser.newPage();
    await page.setUserAgent(userAgent);

    logInfo('Verifying Tor connectivity via https://check.torproject.org/');
    await page.goto('https://check.torproject.org/', { waitUntil: 'networkidle2' });
    const torResultText = await page.$eval('body', (el) => el.innerText);
    if (torResultText.includes('Congratulations. This browser is configured to use Tor.')) {
      logInfo('✔︎ Browser is correctly using the Tor network.');
    } else {
      logWarning('⚠︎ Tor check did not confirm usage. Traffic may not be routed through Tor.');
    }

    // ─── Now navigate to your real target ─────────────────────────────────────
    

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

// ─── Main entrypoint: wait for Tor, then launch Puppeteer ─────────────────────
(async () => {
  try {
    // wait(10000); // Initial 1s delay before starting
    await waitForTor();      // Block up to 60s for Tor to be ready
    await renewTorCircuit(); // (Optional) rotate circuit once Tor’s ready
    await runPuppeteer();    // Then launch Puppeteer through Tor
  } catch (e) {
    logError(`Fatal error: ${e.message}`);
    process.exit(1);
  }
})();
