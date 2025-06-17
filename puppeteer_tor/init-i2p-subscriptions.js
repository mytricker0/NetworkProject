// puppeteer_tor/init-i2p-subscriptions.js

const fs = require('fs');
const path = require('path');

const subsFile = '/i2p/.i2p/addressbook/subscriptions.txt';
const subscriptions = [
  'http://i2p-projekt.i2p/hosts.txt',
  'http://notbob.i2p/hosts.txt',
  'http://scanner.linuxfarm.i2p/hosts.txt',
  'http://skank.i2p/hosts.txt',
];

// Wait until file exists
function waitForFile(file, timeout = 90000) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const interval = setInterval(() => {
      if (fs.existsSync(file)) {
        clearInterval(interval);
        return resolve();
      }
      if (Date.now() - start > timeout) {
        clearInterval(interval);
        return reject(new Error('Timeout waiting for subscriptions.txt'));
      }
    }, 1000);
  });
}

(async () => {
  try {
    console.log('[init] Waiting for subscriptions.txt...');
    await waitForFile(subsFile);

    let existing = fs.readFileSync(subsFile, 'utf-8').split('\n').map(s => s.trim());
    let toAdd = subscriptions.filter(url => !existing.includes(url));

    if (toAdd.length > 0) {
      fs.appendFileSync(subsFile, '\n' + toAdd.join('\n') + '\n');
      console.log('[init] Subscriptions added:', toAdd);
    } else {
      console.log('[init] All subscriptions already present.');
    }
  } catch (err) {
    console.error('[init] Failed to configure I2P subscriptions:', err.message);
    process.exit(1);
  }
})();
