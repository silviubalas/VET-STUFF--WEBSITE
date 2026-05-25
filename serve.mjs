import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PORT = Number(process.env.PORT || 3000);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.xml': 'application/xml; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  if (url.pathname.startsWith('/api/')) {
    await handleApi(req, res, url);
    return;
  }

  let pathname = decodeURIComponent(url.pathname);
  if (pathname.endsWith('/')) pathname += 'index.html';

  const filePath = path.normalize(path.join(ROOT, pathname));
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
});

server.listen(PORT, () => {
  console.log(`VetStuff server pornit: http://localhost:${PORT}`);
});

async function handleApi(req, res, url) {
  decorateApiResponse(res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': url.origin,
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Internal-Token',
    });
    res.end();
    return;
  }

  const apiRoot = path.join(ROOT, 'api');
  const requestPath = decodeURIComponent(url.pathname);
  const relative = requestPath.replace(/^\/api\//, '');
  const apiFile = path.normalize(path.join(apiRoot, relative.endsWith('.js') ? relative : `${relative}.js`));
  if (!apiFile.startsWith(apiRoot) || !fs.existsSync(apiFile)) {
    res.status(404).json({ error: 'Not found' });
    return;
  }

  try {
    req.query = Object.fromEntries(url.searchParams.entries());
    req.body = await readBody(req);
    const moduleUrl = `${pathToFileURL(apiFile).href}?t=${Date.now()}`;
    const mod = await import(moduleUrl);
    const handler = mod.default;
    if (typeof handler !== 'function') {
      res.status(500).json({ error: 'API handler missing' });
      return;
    }
    await handler(req, res);
    if (!res.writableEnded) res.end();
  } catch (err) {
    console.error('[local-api]', err);
    if (!res.writableEnded) {
      res.status(500).json({ error: 'Local API error' });
    }
  }
}

function decorateApiResponse(res) {
  res.status = code => {
    res.statusCode = code;
    return res;
  };
  res.json = body => {
    if (!res.getHeader('Content-Type')) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
    }
    res.end(JSON.stringify(body));
    return res;
  };
  res.send = body => {
    if (typeof body === 'object' && body !== null && !Buffer.isBuffer(body)) {
      return res.json(body);
    }
    res.end(body);
    return res;
  };
}

function readBody(req) {
  if (req.method === 'GET' || req.method === 'HEAD') return Promise.resolve({});

  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > 1024 * 1024) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) {
        resolve({});
        return;
      }

      const type = String(req.headers['content-type'] || '').split(';')[0];
      try {
        if (type === 'application/json') {
          resolve(JSON.parse(raw));
          return;
        }
        if (type === 'application/x-www-form-urlencoded') {
          resolve(Object.fromEntries(new URLSearchParams(raw).entries()));
          return;
        }
        resolve({ raw });
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}
