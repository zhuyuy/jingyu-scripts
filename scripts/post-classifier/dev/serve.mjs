import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
const routes = { '/post-classifier.user.js': ['dist/post-classifier.user.js', 'text/javascript'], '/preview.js': ['dist/preview.js', 'text/javascript'], '/': ['dev/index.html', 'text/html'] };
const port = Number(process.env.PORT || 8788);
createServer(async (req,res) => {
  const route = routes[new URL(req.url, 'http://localhost').pathname];
  if (!route) { res.writeHead(404); res.end(); return; }
  try { const content = await readFile(new URL('../' + route[0], import.meta.url)); res.writeHead(200, { 'Content-Type': route[1] + '; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(content); }
  catch { res.writeHead(500); res.end('Run npm run build first.'); }
}).listen(port, '127.0.0.1', function () { console.log(`Local installer: http://127.0.0.1:${this.address().port}/`); });
