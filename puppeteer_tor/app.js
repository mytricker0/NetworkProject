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
function logResult(msg) {
  console.log(chalk.blue(`[RESULT] ${new Date().toLocaleTimeString()} --------- ${msg} ---------`));
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
async function runTorPuppeteer(urls) {
  puppeteer.use(StealthPlugin());
  const userAgent = randomUseragent.getRandom((ua) => parseFloat(ua.browserVersion) >= 100);

  logInfo(`Launching Tor browser with User-Agent: ${userAgent}`);
  let browser = null;
  let chromeTmpDataDir = null;
  const loadTimes = [];

  try {
    browser = await puppeteer.launch({
      headless: process.env.HEADLESS === 'true',
      executablePath: '/usr/bin/chromium',
      args: [
        `--proxy-server=socks5://${process.env.TOR_HOST}:${process.env.TOR_PORT}`,
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

    for (const url of urls) {
      logInfo(`Navigating to ${url}`);
      
      // Optional: Rotate circuit before each URL
      // await renewTorCircuit();
      // await wait(5000);

      const start = performance.now();
      try {
        await page.goto(url, { waitUntil: 'networkidle2' });
        const end = performance.now();
        const duration = end - start;
        loadTimes.push(duration);
        logResult(`✅ Loaded ${url} in ${duration.toFixed(2)} ms`);
        await wait(5000); // Wait a bit to ensure page is fully loaded
      } catch (err) {
        logWarning(`❌ Failed to load ${url}: ${err.message}`);
        loadTimes.push(null);
      }
    }

    const successfulLoads = loadTimes.filter(t => t !== null);
    if (successfulLoads.length > 0) {
      const average = successfulLoads.reduce((a, b) => a + b, 0) / successfulLoads.length;
      logResult(`📊 Average Tor load time: ${average.toFixed(2)} ms`);
    } else {
      logWarning("⚠ No successful loads to compute average time.");
    }
    await wait (500000); // Wait a bit before closing to ensure all resources are freed
  } catch (error) {
    logError(`Error running Tor Puppeteer: ${error}`);
  } finally {
    if (browser) await browser.close();
    logInfo('Browser closed.');
    if (chromeTmpDataDir) {
      await fs.remove(chromeTmpDataDir)
        .then(() => logInfo(`🧹 Deleted temporary user data dir: ${chromeTmpDataDir}`))
        .catch((err) => logError(`❌ Failed to delete temp user data dir: ${err.message}`));
    }
  }
}




async function runI2pPuppeteer(urls) {
  puppeteer.use(StealthPlugin());
  const userAgent = randomUseragent.getRandom((ua) => parseFloat(ua.browserVersion) >= 100);

  logInfo(`Launching I2P browser with User-Agent: ${userAgent}`);
  let browser = null;
  let chromeTmpDataDir = null;
  const loadTimes = [];

  try {
    browser = await puppeteer.launch({
      headless: process.env.HEADLESS === 'true',
      executablePath: '/usr/bin/chromium',
      args: [
        `--proxy-server=http://${process.env.I2P_HOST}:${process.env.I2P_PORT}`,
        '--no-sandbox',
        '--host-resolver-rules=MAP *.i2p ~NOTFOUND, EXCLUDE localhost',
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

    // ─── Reload I2P Subscriptions via HTTP POST ─────────────────────────────
try {
  const http = require('http');

  const subscriptions = [
    'http://i2p-projekt.i2p/hosts.txt',
    'http://notbob.i2p/hosts.txt',
    'http://scanner.linuxfarm.i2p/hosts.txt',
    'http://skank.i2p/hosts.txt',
  ];

  const postData = [
    `serial=${Date.now()}`,
    `content=${encodeURIComponent(subscriptions.join('\n'))}`,
    `action=Reload`
  ].join('&');

  const options = {
    hostname: 'localhost',
    port: 7657,
    path: '/susidns/subscriptions',
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      'Content-Length': Buffer.byteLength(postData),
    },
  };

  const req = http.request(options, (res) => {
    let data = '';
    res.on('data', chunk => data += chunk);
    res.on('end', () => {
      logInfo(`📡 I2P subscriptions reloaded (status ${res.statusCode})`);
      if (data.includes('Subscription')) {
        logInfo('🗂 Subscriptions page returned successfully');
      } else {
        logWarning('⚠ Subscriptions POST may not have been accepted');
      }
    });
  });

  req.on('error', (err) => {
    logError(`❌ Failed to POST subscriptions: ${err.message}`);
  });

  req.write(postData);
  req.end();
} catch (err) {
  logError(`❌ Exception during I2P reload POST: ${err.message}`);
}


    for (const url of urls) {
      logInfo(`Navigating to ${url}`);
      const start = performance.now();
      try {
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        const end = performance.now();
        const duration = end - start;
        loadTimes.push(duration);
        logResult(`✅ Loaded ${url} in ${duration.toFixed(2)} ms`);
        await wait(5000); // Wait a bit to ensure page is fully loaded
      } catch (err) {
        logWarning(`❌ Failed to load ${url}: ${err.message}`);
        loadTimes.push(null);
      }
    }

    const successfulLoads = loadTimes.filter(t => t !== null);
    if (successfulLoads.length > 0) {
      const average = successfulLoads.reduce((a, b) => a + b, 0) / successfulLoads.length;
      logResult(`📊 Average I2P load time: ${average.toFixed(2)} ms`);
    } else {
      logWarning("⚠ No successful loads to compute average time.");
    }
    await wait(500000); // Wait a bit before closing to ensure all resources are freed

  } catch (error) {
    logError(`Error running I2P Puppeteer: ${error}`);
  } finally {
    if (browser) await browser.close();
    if (chromeTmpDataDir) {
      await fs.remove(chromeTmpDataDir).catch((err) => logError(`Failed to delete temp dir: ${err.message}`));
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
    logInfo(JSON.stringify(process.env, null, 2));

    const torUrls = [
  'http://dreadytofatroptsdj6io7l3xptbet6onoyno2yv7jicoxknyazubrad.onion',
  'http://4pt4axjgzmm4ibmxplfiuvopxzf775e5bqseyllafcecryfthdupjwyd.onion',
  'http://exploitivzcm5dawzhe6c32bbylyggbjvh5dyvsvb5lkuz5ptmunkmqd.onion',
  'http://uicrmrl3i4r66c4fx4l5gv5hdb6jrzy72bitrk25w5dhv5o6sxmajxqd.onion',
  'https://www.bbcnewsd73hkzno2ini43t4gblxvycyac5aw4gnv7t2rccijh7745uqd.onion',
  'https://protonmailrmez3lotccipshtkleegetolb73fuirgj7r4o4vfu7ozyd.onion',
  'http://torbox36ijlcevujx7mjb4oiusvwgvmue7jfn2cvutwa6kl6to3uyqad.onion',
  'https://facebookwkhpilnemxj7asaniu7vnjjbiltxjqhye3mhbshg7kx5tfyd.onion',
  'http://darkfailenbsdla5mal2mxn2uz66od5vtzd5qozslagrfzachha3f3id.onion',
  'http://tortimeswqlzti2aqbjoieisne4ubyuoeiiugel2layyudcfrwln76qd.onion/'
];


    const i2pUrls = [
  'http://i2p-projekt.i2p',                        
  'http://identiguy.i2p',                           
  "http://paste.idk.i2p/",
  'http://bandura.i2p/',                              
  'http://i2pforum.i2p',                            
  'http://purokishi.i2p/',                         
  'http://stormycloud.i2p/',                             
  'http://stats.i2p',                            
  'http://r4sas.i2p/',                             
  'http://notbob.i2p',                             
  'http://opentracker.simp.i2p/',     
    ]                 



    await waitForTor();
    await renewTorCircuit();
    runTorPuppeteer(torUrls);

    await waitForI2p();
    await runI2pPuppeteer(i2pUrls);

  } catch (e) {
    logError(`Fatal error: ${e.message}`);
    process.exit(1);
  }
})();
