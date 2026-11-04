import request from 'supertest';
import type { Express } from 'express';
export async function authenticated(app: Express) {
  const agent = request.agent(app);
  await agent
    .post('/api/auth/register')
    .send({ username: 'test-user', password: 'test-password-123' })
    .expect(201);
  return agent;
}
