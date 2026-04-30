'use strict';
const https = require('https');
const http  = require('http');

function splunkLog(data) {
  const url = process.env.SPLUNK_HEC_URL;
  const token = process.env.SPLUNK_HEC_TOKEN;
  if (!url || !token) return;

  const payload = JSON.stringify({
    time: Math.floor(Date.now() / 1000),
    event: { ...data, timestamp: new Date().toISOString() }
  });

  try {
    const u = new URL(url);
    const lib = u.protocol === 'https:' ? https : http;
    const req = lib.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname,
      method: 'POST',
      headers: {
        'Authorization': `Splunk ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      },
      rejectUnauthorized: false
    }, () => {});
    req.on('error', () => {});
    req.write(payload);
    req.end();
  } catch(e) {}
}

module.exports = { splunkLog };
