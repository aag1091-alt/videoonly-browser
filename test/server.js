'use strict';
// Tiny static server for the e2e test. Serves test/www with __EXT__/__EMBED__ placeholders
// filled in so that the page (on 127.0.0.1) embeds a player from a different origin (localhost).
const http = require('http');
const fs = require('fs');
const path = require('path');

function startServer({ mp4Path } = {}) {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const port = server.address().port;
      const EXT = `http://localhost:${port}`;
      const url = new URL(req.url, 'http://x');
      if (url.pathname === '/test.mp4' && mp4Path) {
        res.writeHead(200, { 'Content-Type': 'video/mp4' });
        fs.createReadStream(mp4Path).pipe(res);
        return;
      }
      if (url.pathname === '/file.bin') {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="installer.exe"' });
        res.end(Buffer.alloc(1024, 1));
        return;
      }
      const file = path.join(__dirname, 'www', url.pathname === '/' ? 'page.html' : url.pathname);
      if (!file.startsWith(path.join(__dirname, 'www')) || !fs.existsSync(file)) {
        res.writeHead(404);
        res.end('not found');
        return;
      }
      let body = fs.readFileSync(file, 'utf8');
      body = body.replace(/__EXT__/g, EXT).replace(/__EMBED__/g, `${EXT}/embed.html`);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(body);
    });
    server.listen(0, '127.0.0.1', () => resolve({ port: server.address().port, close: () => server.close() }));
  });
}

module.exports = { startServer };
if (require.main === module) startServer({ mp4Path: process.argv[2] }).then(({ port }) => console.log(`http://127.0.0.1:${port}/page.html`));
