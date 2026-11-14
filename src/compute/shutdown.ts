import type { Server } from 'node:http';

/** Compute owns no durable writes. Stop HTTP admission, then exit; do not claim
 * that native inference has been cancelled or drained by closing HTTP sockets. */
export function stopEmbeddingServer(server: Server, options: {
  timeoutMs?: number; exit?: (code: number) => void;
} = {}): void {
  const exit = options.exit ?? ((code: number) => process.exit(code));
  let exited = false;
  const finish = (code: number) => {
    if (exited) return;
    exited = true;
    clearTimeout(deadline);
    exit(code);
  };
  const deadline = setTimeout(() => {
    server.closeAllConnections();
    finish(1);
  }, options.timeoutMs ?? 5000);
  server.close(() => finish(0));
  server.closeIdleConnections();
}
