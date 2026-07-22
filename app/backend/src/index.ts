import { createServer } from './server.js';

const port = Number(process.env.PORT ?? 8717);
const host = process.env.HOST ?? '127.0.0.1';

async function main(): Promise<void> {
  const server = await createServer();
  try {
    await server.listen({ port, host });
    server.log.info({ port, host }, 'rom-editor backend listening');
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
}

void main();
