import assert from 'node:assert/strict';
import { test } from 'node:test';

import { allowedDocumentUrl, proxySeaceDocument } from './documentProxy.ts';

const allowed =
  'https://prod6.seace.gob.pe/v1/s8uit-services/archivo/archivos-publico/descargar-archivo-contrato/123';

test('only public SEACE PDF paths can be fetched', async () => {
  assert.equal(allowedDocumentUrl(allowed), true);
  for (const url of [
    'http://prod6.seace.gob.pe/v1/s8uit-services/archivo/archivos-publico/descargar-archivo-contrato/123',
    `${allowed}?next=http://localhost`,
    allowed.replace('prod6.seace.gob.pe', 'localhost'),
    'https://prod4.seace.gob.pe:9000/api/con/documentos/descargar/123/extra',
  ]) {
    assert.equal(allowedDocumentUrl(url), false);
    const response = await proxySeaceDocument(url, () => {
      throw new Error('must not fetch');
    });
    assert.equal(response.status, 400);
  }
});

test('returns a PDF as an inline streamed response', async () => {
  const response = await proxySeaceDocument(allowed, async (_url, options) => {
    assert.equal(options.redirect, 'manual');
    assert.equal(options.headers.Referer, 'https://prod6.seace.gob.pe/buscador-publico/');
    return new Response(new Blob(['%P', 'DF-', 'sample']).stream(), { status: 200 });
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('Content-Disposition'), 'inline');
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(await response.text(), '%PDF-sample');
});

test('rejects redirects, HTML, and oversized PDFs', async () => {
  assert.equal(
    (await proxySeaceDocument(allowed, async () => new Response(null, { status: 302 }))).status,
    502,
  );
  assert.equal(
    (await proxySeaceDocument(allowed, async () => new Response('<html>not a PDF</html>'))).status,
    502,
  );
  assert.equal(
    (
      await proxySeaceDocument(
        allowed,
        async () => new Response('%PDF-', { headers: { 'Content-Length': '20971521' } }),
      )
    ).status,
    413,
  );
});
