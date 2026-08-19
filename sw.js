const CACHE_NAME = 'vcard-media-v1';

const rangeResponse = async (response, rangeHeader) => {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader || '');
  if (!match) return response;
  const buffer = await response.arrayBuffer();
  const size = buffer.byteLength;
  let start = match[1] === '' ? 0 : Number(match[1]);
  let end = match[2] === '' ? size - 1 : Number(match[2]);
  if (match[1] === '') start = Math.max(0, size - end);
  end = Math.min(size - 1, end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || start > end) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
  }
  return new Response(buffer.slice(start, end + 1), {
    status: 206,
    statusText: 'Partial Content',
    headers: {
      'Content-Type': response.headers.get('Content-Type') || 'application/octet-stream',
      'Content-Length': String(end - start + 1),
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Accept-Ranges': 'bytes',
    },
  });
};

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

const reportMediaSource = (event, url, source) => {
  const clientId = event.clientId || event.resultingClientId;
  if (!clientId) return;
  self.clients.get(clientId).then((client) => {
    client?.postMessage({ type: 'vcard-media-source', url, source });
  }).catch(() => {});
};

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin || !url.pathname.includes('/usr/')) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(url.href);
    if (cached) {
      reportMediaSource(event, url.href, 'cache');
      return request.headers.has('Range')
        ? rangeResponse(cached, request.headers.get('Range'))
        : cached;
    }
    const response = await fetch(request);
    reportMediaSource(event, url.href, 'loaded');
    return response;
  })());
});
