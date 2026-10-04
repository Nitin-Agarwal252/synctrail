import { buildApp } from './app';

const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || '0.0.0.0';

async function main() {
  const app = await buildApp({ logger: true });

  try {
    const address = await app.listen({ port: PORT, host: HOST });
    console.log(`SyncTrail server listening on ${address}`);
  } catch (err) {
    app.log.error(err);
    process.exit(1);
  }
}

main();
