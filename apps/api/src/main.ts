import { createApp } from './bootstrap';
import { Config } from './config/config';
async function main() {
  const app = await createApp();
  const {PORT, HOST} = app.get(Config).values;
  await app.listen(PORT, HOST);
  console.log(JSON.stringify({level: 'info', message: 'API listening', host: HOST, port: PORT}));
}
void main().catch(() => { console.error('API startup failed; check configuration and database availability.'); process.exitCode = 1; });
