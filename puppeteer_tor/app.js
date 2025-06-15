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
  const proxy = `socks5h://${process.env.TOR_HOST}:${process.env.TOR_PORT}`;

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
  host: process.env.TOR_HOST,
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
    controller.getInfo('circuit-status', async (err, info) => {
      if (err) return reject(err);
      const circuitStatus = info.data;
      logInfo(`DisplayCircuit: Circuit status received. ${circuitStatus.length} bytes.`);

      const lines = circuitStatus.split('\n');
      let circuitLine = null;
      for (const line of lines) {
        if (/^\d+\s+BUILT\s+/.test(line)) {
          circuitLine = line;
          break;
        }
      }

      if (!circuitLine) {
        logInfo('DisplayCircuit: No built circuit found.');
        return resolve();
      }

      let pathPart = circuitLine.split('BUILT')[1].trim();
      if (pathPart.includes('BUILD_FLAGS')) {
        pathPart = pathPart.split('BUILD_FLAGS')[0].trim();
      }

      const hops = pathPart.split(',');
      const fingerprints = hops.map(hop => hop.split('~')[0].replace('$', '').trim());

      for (const [idx, fp] of fingerprints.entries()) {
        try {
          const ip = await getDescriptorIP(fp);
          if (ip) {
            logInfo(`Hop ${idx + 1}: ${fp} (${ip})`);
          } else {
            logInfo(`Hop ${idx + 1}: ${fp} (IP unknown)`);
          }
        } catch (e) {
          logError('Failed to resolve fingerprint ' + fp + ': ' + e.message);
        }
      }

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
async function runTorPuppeteer() {
  puppeteer.use(StealthPlugin());

  const userAgent = randomUseragent.getRandom((ua) => parseFloat(ua.browserVersion) >= 100);
  logInfo(`Launching browser with User-Agent: ${userAgent}`);

  let browser = null;
  let chromeTmpDataDir = null;

  try {
    browser = await puppeteer.launch({
      headless: process.env.HEADLESS === 'true',
      executablePath: '/usr/bin/chromium',   // ensure Dockerfile installed chromium
      args: [
        `--proxy-server=socks5://${process.env.TOR_HOST}:${process.env.TOR_PORT}`,
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
    await page.goto("https://www.google.com", { waitUntil: 'networkidle2' });

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



async function runI2pPuppeteer() {
  puppeteer.use(StealthPlugin());

  const userAgent = randomUseragent.getRandom((ua) => parseFloat(ua.browserVersion) >= 100);
  logInfo(`Launching browser with User-Agent: ${userAgent}`);

  let browser = null;
  let chromeTmpDataDir = null;

  try {
    browser = await puppeteer.launch({
      headless: process.env.HEADLESS === 'true',
      executablePath: '/usr/bin/chromium',   // ensure Dockerfile installed chromium
      args: [
        `--proxy-server=http://${process.env.I2P_HOST}:${process.env.I2P_PORT}`,
        '--no-sandbox',
        '--host-resolver-rules=MAP *.i2p ~NOTFOUND, EXCLUDE localhost',
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

    logInfo('Verifying Tor connectivity via http://i2p-projekt.i2p');
    await page.goto('http://i2p-projekt.i2p', { waitUntil: 'domcontentloaded' });
    const torResultText = await page.$eval('body', (el) => el.innerText);
    if (torResultText.includes('The Invisible Internet Project')) {
      logInfo('✔︎ Browser is correctly using the I2p network.');
    } else {
      logWarning('⚠︎ I2p check did not confirm usage. Traffic may not be routed through I2p.');
    }
    await page.goto("http://identiguy.i2p", { waitUntil: 'networkidle2' });

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
async function waitForI2p(interval = 5000) {
  logInfo('Waiting for I2P proxy to be ready...');

  const host = process.env.I2P_HOST;
  const port = parseInt(process.env.I2P_PORT, 10);

  while (true) {
    try {
      const response = await axios.get('http://i2p-projekt.i2p', {
        proxy: {
          host,
          port,
          protocol: 'http',
        },
        timeout: 5000,
      });
      logInfo(`I2P router responded with status ${response.status}. Checking content...`);
      if (response.data.includes('Invisible Internet Project')) {
        logInfo('✔︎ I2P proxy is ready and functional.');
        return true;
      } else {
        logWarning('⚠︎ I2P router responded, but did not match expected content.');
      }
    } catch (err) {
      logInfo('I2P proxy not ready yet, retrying...');
      logInfo(`Error: ${err.message}`);
    }

    await wait(interval);
  }
}





// ─── Main entrypoint: wait for Tor, then launch Puppeteer ─────────────────────
(async () => {
  try {
    // log the process.env

    logInfo(JSON.stringify(process.env, null, 2));
    // wait(10000); // Initial 1s delay before starting
    // await waitForTor();      // Block up to 60s for Tor to be ready
    // await wait(30000); // wait 30 seconds before starting I2P connectivity check
    await waitForI2p();      // Block up to 60s for I2P to be ready
    await renewTorCircuit(); // (Optional) rotate circuit once Tor’s ready
    runI2pPuppeteer();
    // runTorPuppeteer();    // Then launch Puppeteer through Tor

  } catch (e) {
    logError(`Fatal error: ${e.message}`);
    process.exit(1);
  }
})();
