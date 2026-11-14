/** close() stops admissions; its callback waits for live requests to finish. */
export async function closeHttpServer(server: { close(callback: (error?: Error) => void): unknown } | null): Promise<void> {
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error?: Error) => error ? reject(error) : resolve());
  });
}
