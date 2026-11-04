import { randomUUID } from 'node:crypto';
export const id = () => randomUUID();
export const now = () => new Date().toISOString();
