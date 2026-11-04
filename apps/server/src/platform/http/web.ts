import express, { Router } from 'express';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export function webRouter(directory: string) {
  const router = Router();
  if (existsSync(directory)) {
    router.use(express.static(directory));
    router.get('/{*path}', (_req, res) => res.sendFile(resolve(directory, 'index.html')));
  }
  return router;
}
