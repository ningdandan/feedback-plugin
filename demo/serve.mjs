// Tiny static server for trying the widget from a different origin than the Pinpoint server.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const port = Number(process.env.PORT ?? 4000);
http.createServer((req, res) => {
  const name = req.url === '/' ? 'index.html' : path.basename(req.url.split('?')[0]);
  fs.readFile(path.join(dir, name), (e, data) => {
    if (e) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': name.endsWith('.html') ? 'text/html' : 'text/plain' });
    res.end(data);
  });
}).listen(port, () => console.log(`demo on http://localhost:${port}`));
