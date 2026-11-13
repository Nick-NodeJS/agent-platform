import http from 'node:http';

export interface FakeRequest {
  url: string | undefined;
  body: unknown;
}

export interface FakeOpenAi {
  baseUrl: string;
  requests: FakeRequest[];
  close: () => Promise<void>;
}

/** A local stand-in for the provider: `respond` gets the parsed request body and returns the JSON to send back. */
export async function startFakeOpenAi(respond: (body: unknown) => unknown): Promise<FakeOpenAi> {
  const requests: FakeRequest[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      requests.push({ url: request.url, body });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(respond(body)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('fake provider is not listening on a TCP port');
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
