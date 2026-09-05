import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { spawn } from 'node:child_process';

const projectRoot = path.resolve(import.meta.dirname, '..');
const host = '127.0.0.1';
const requestedPort = Number(process.env.SHANGONG_PREVIEW_PORT || 4173);
const port = Number.isInteger(requestedPort) && requestedPort > 0 && requestedPort < 65536
  ? requestedPort
  : 4173;

const contentTypes = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
};

function openPreview(url) {
  if (process.env.SHANGONG_NO_OPEN === '1') return;
  try {
    const opener = process.platform === 'win32'
      ? spawn('rundll32.exe', ['url.dll,FileProtocolHandler', url], { detached: true, stdio: 'ignore' })
      : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' });
    opener.unref();
  } catch (error) {
    console.warn(`浏览器未能自动打开，请手动访问 ${url}`);
  }
}

function safeFilePath(requestUrl) {
  const pathname = decodeURIComponent(new URL(requestUrl, `http://${host}:${port}`).pathname);
  const relativePath = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const absolutePath = path.resolve(projectRoot, relativePath);
  return absolutePath.startsWith(`${projectRoot}${path.sep}`) || absolutePath === projectRoot
    ? absolutePath
    : null;
}

const server = http.createServer(async (request, response) => {
  const filePath = safeFilePath(request.url || '/');
  if (!filePath) {
    response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Forbidden');
    return;
  }

  try {
    const file = await fs.readFile(filePath);
    response.writeHead(200, {
      'Cache-Control': 'no-store',
      'Content-Type': contentTypes[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
    });
    response.end(file);
  } catch (error) {
    response.writeHead(error?.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain; charset=utf-8' });
    response.end(error?.code === 'ENOENT' ? 'Not found' : 'Local preview failed');
  }
});

server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`端口 ${port} 已被占用，请关闭旧的预览窗口后重试。`);
  } else {
    console.error('本地预览启动失败：', error.message);
  }
  process.exitCode = 1;
});

server.listen(port, host, () => {
  const previewUrl = `http://${host}:${port}/#/ai`;
  console.log('山商信息通本地预览已启动：');
  console.log(previewUrl);
  console.log('保持此窗口开启；结束预览时按 Ctrl+C。');
  openPreview(previewUrl);
});
