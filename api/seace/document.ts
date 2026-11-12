import { proxySeaceDocument } from './documentProxy.js';

export async function GET(request: Request): Promise<Response> {
  if (!request.headers.has('cookie')) return new Response('Unauthorized', { status: 401 });
  const { auth } = await import('../auth.js');
  const session = await auth.api.getSession({ headers: request.headers });
  if (!session) return new Response('Unauthorized', { status: 401 });
  return proxySeaceDocument(new URL(request.url).searchParams.get('url'));
}
