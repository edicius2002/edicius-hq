import { readToken } from '@/shared/auth/session';

/**
 * Puts the session token on a stream URL. **Every `EventSource` in this app
 * builds its URL through here.**
 *
 * `EventSource` cannot set request headers — there is no options argument that
 * takes them — so the four SSE routes are the one place the token cannot ride
 * in `Authorization`. The API accepts it in the query string for those four
 * routes and refuses it everywhere else.
 *
 * A token in a URL is normally a defect, because intermediaries log URLs.
 * There is no intermediary here: both transports this API is published on
 * terminate TLS on the owner's own machine. `tailscale serve --https` does so
 * obviously, and `tailscale funnel` does so as well — its ingress forwards the
 * stream without a key for it and `tailscaled` on the home PC decrypts — so
 * the only parties that see the URL are the browser and that PC either way.
 * **This reasoning does not survive a change of transport.** Routing the API
 * through Cloudflare, ngrok or a Vercel rewrite would put the session token in
 * someone else's logs, and whoever moves it must revisit this.
 *
 * Centralised rather than left at each call site because the four sites are
 * not symmetrical: three of them share an `options.create` seam and
 * `shared/api/tweets.ts` does not. Leaving construction at each site means the
 * odd one out is the one that gets forgotten — which has already happened once
 * in this repository's own documentation, where the four were counted as
 * three.
 */
export function withStreamToken(url: string): string {
  const token = readToken();
  if (!token) return url;

  const separator = url.includes('?') ? '&' : '?';
  return `${url}${separator}token=${encodeURIComponent(token)}`;
}
