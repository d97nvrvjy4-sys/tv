const http = require('http');
const https = require('https');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;

// Mimic VLC's User-Agent, since the origin server allows VLC-type clients
const UA = 'VLC/3.0.20 LibVLC/3.0.20';

// Headers that must not be blindly forwarded (these are connection/framing
// specific and can conflict with how Node re-serializes the response,
// which was very likely the cause of streams cutting out mid-playback)
const STRIP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-length',
  'content-encoding',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'upgrade',
  'strict-transport-security',
  'content-security-policy'
]);

function proxyRequest(targetUrl, req, res, redirectCount) {
  redirectCount = redirectCount || 0;
  if (redirectCount > 5) {
    res.writeHead(508);
    return res.end('Too many redirects');
  }

  const lib = targetUrl.protocol === 'https:' ? https : http;

  const options = {
    protocol: targetUrl.protocol,
    hostname: targetUrl.hostname,
    port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
    path: targetUrl.pathname + targetUrl.search,
    method: 'GET',
    headers: {
      'User-Agent': UA,
      'Accept': '*/*',
      'Icy-MetaData': '1'
    }
  };

  const proxyReq = lib.request(options, (proxyRes) => {
    if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode) && proxyRes.headers.location) {
      const nextUrl = new URL(proxyRes.headers.location, targetUrl);
      proxyRes.resume();
      return proxyRequest(nextUrl, req, res, redirectCount + 1);
    }

    const headers = {};
    for (const [key, value] of Object.entries(proxyRes.headers)) {
      if (!STRIP_HEADERS.has(key.toLowerCase())) {
        headers[key] = value;
      }
    }
    if (!headers['content-type']) {
      headers['content-type'] = 'video/mp2t';
    }

    res.writeHead(proxyRes.statusCode, headers);
    proxyRes.pipe(res);

    proxyRes.on('error', () => {
      if (!res.writableEnded) res.end();
    });
  });

  // Do not let Node kill long-lived streaming connections
  proxyReq.setTimeout(0);

  proxyReq.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
    }
    if (!res.writableEnded) res.end('Proxy error: ' + err.message);
  });

  req.on('close', () => proxyReq.destroy());
  proxyReq.end();
}

const server = http.createServer((req, res) => {
  const reqUrl = new URL(req.url, `http://${req.headers.host}`);

  if (reqUrl.pathname === '/proxy') {
    const target = reqUrl.searchParams.get('u');
    if (!target) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      return res.end('Missing u param');
    }
    let targetUrl;
    try {
      targetUrl = new URL(target);
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      return res.end('Bad url');
    }
    proxyRequest(targetUrl, req, res, 0);
  } else if (reqUrl.pathname === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('IPTV proxy is running');
  } else {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  }
});

// Disable Node's default socket/header timeouts so long-running live
// streams are not cut off by the server itself
server.timeout = 0;
server.keepAliveTimeout = 0;
server.headersTimeout = 0;

server.listen(PORT, () => console.log('Proxy running on port', PORT));
