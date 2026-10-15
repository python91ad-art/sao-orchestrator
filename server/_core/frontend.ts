import express from 'express';
import fs from 'node:fs';
import path from 'node:path';

export function serveBuiltFrontend(app: express.Express, directory: string) {
  if (!fs.existsSync(path.join(directory, 'index.html'))) return false;
  app.use(express.static(directory, {
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html') || filePath.endsWith('build-info.json')) res.setHeader('Cache-Control', 'no-store');
      else if (filePath.startsWith(path.join(directory, 'assets') + path.sep)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    },
  }));
  app.get('*', (req, res, next) => {
    if (req.path.startsWith('/api') || req.path.startsWith('/assets/')) return next();
    res.setHeader('Cache-Control', 'no-store');
    res.sendFile(path.join(directory, 'index.html'));
  });
  return true;
}
