import { createE2eApplication } from '../dist/scripts/e2e-server.js';

export default async function setup() {
  const instance = createE2eApplication();
  let server;
  try {
    server = instance.app.listen(3002, '127.0.0.1');
    await new Promise((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
  } catch (error) {
    await instance.close();
    throw error;
  }
  return async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await instance.close();
  };
}
