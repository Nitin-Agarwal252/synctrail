import { buildApp } from './app';

const PORT = Number(process.env.PORT || 3001);
const HOST = process.env.HOST || '0.0.0.0';

async function main() {
  const app = await buildApp({ logger: true });
  const address = await app.listen({ port: PORT, host: HOST });
  console.log(`SyncTrail server listening on ${address}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
