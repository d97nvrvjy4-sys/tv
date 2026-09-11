const http = require('http');
const https = require('https');
const { URL } = require('url');

const PORT = process.env.PORT || 3000;

// User-Agent that mimics VLC, since the IPTV provider allows VLC-type clients
const UA = 'VLC/3.0.20 LibVLC/3.0.20';

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
      'Connection': 'keep-alive'
    }
  };

  const proxyReq = lib.request(options, (proxyRes) => {
    // Follow redirects manually, rewriting Location isn't needed since we just re-fetch
    if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode) && proxyRes.headers.location) {
      const nextUrl = new URL(proxyRes.headers.location, targetUrl);
      proxyRes.resume(); // discard body
      return proxyRequest(nextUrl, req, res, redirectCount + 1);
    }
    const headers = Object.assign({}, proxyRes.headers);
    delete headers['content-security-policy'];
    res.writeHead(proxyRes.statusCode, headers);
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { 'Content-Type': 'text/plain' });
    }
    res.end('Proxy error: ' + err.message);
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

server.listen(PORT, () => console.log('Proxy running on port', PORT));
