import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/corsa-mock/config';
import { createHandler, HttpEvent } from '../src/corsa-mock/handler';
import { MemoryObjectStore } from '../src/corsa-mock/store';

const ALLOWED_PEM = readFileSync(join(__dirname, 'fixtures/test-client-allowed.pem'), 'utf8');
const OTHER_PEM = readFileSync(join(__dirname, 'fixtures/test-client-other.pem'), 'utf8');
// openssl x509 -in test/fixtures/test-client-allowed.pem -noout -fingerprint -sha256
const ALLOWED_FINGERPRINT = '81:A8:5B:90:61:FE:28:82:6F:2A:4F:A0:D8:37:9E:DC:F2:33:34:12:69:38:A6:19:22:22:B7:DF:41:6A:9E:88';

const CREEER_ZAAK = `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body>
  <ZKN:zakLk01><ZKN:stuurgegevens><StUF:referentienummer>ref-1</StUF:referentienummer></ZKN:stuurgegevens>
  <ZKN:object><ZKN:identificatie>ZAAK-1</ZKN:identificatie><ZKN:omschrijving>Test</ZKN:omschrijving></ZKN:object>
  </ZKN:zakLk01></soapenv:Body></soapenv:Envelope>`;

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation();
  jest.spyOn(console, 'warn').mockImplementation();
});
afterEach(() => jest.restoreAllMocks());

function setup(env: NodeJS.ProcessEnv = {}) {
  const store = new MemoryObjectStore();
  const wait = jest.fn().mockResolvedValue(undefined);
  const config = loadConfig({ ALLOWED_CERT_FINGERPRINTS: ALLOWED_FINGERPRINT, ...env });
  return { store, wait, handler: createHandler(config, store, { wait }) };
}

function event(overrides: Partial<HttpEvent> = {}, pem: string | null = ALLOWED_PEM): HttpEvent {
  return {
    path: '/OntvangAsynchroon',
    httpMethod: 'POST',
    headers: { SOAPAction: '"http://www.egem.nl/StUF/sector/zkn/0310/creeerZaak_Lk01"' },
    body: CREEER_ZAAK,
    isBase64Encoded: false,
    requestContext: { identity: pem === null ? {} : { clientCert: { clientCertPem: pem } } },
    ...overrides,
  };
}

describe('requests', () => {
  test('creates a zaak', async () => {
    const { handler, store } = setup();

    const response = await handler(event());

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Bv03');
    expect(await store.get('zaken/ZAAK-1/zaak.json')).toBeDefined();
  });

  test('header names are case insensitive', async () => {
    const { handler } = setup();

    expect((await handler(event({ headers: { sOaPaCtIoN: 'x/creeerZaak_Lk01' } }))).statusCode).toBe(200);
  });

  test('decodes a base64 body', async () => {
    const { handler, store } = setup();

    await handler(event({ body: Buffer.from(CREEER_ZAAK).toString('base64'), isBase64Encoded: true }));

    expect(await store.get('zaken/ZAAK-1/zaak.json')).toBeDefined();
  });

  test('answers health checks and refuses other methods', async () => {
    const { handler } = setup();

    expect((await handler(event({ httpMethod: 'GET', path: '/health' }))).statusCode).toBe(200);
    expect((await handler(event({ httpMethod: 'PUT' }))).statusCode).toBe(405);
  });

  test('answers a wrong endpoint with a fault', async () => {
    const { handler } = setup();

    const response = await handler(event({ path: '/BeantwoordVraag' }));

    expect(response.statusCode).toBe(500);
    expect(response.body).toContain('MOCK-VERKEERD-ENDPOINT');
  });

  test('the timeout failure mode waits before answering with a 504', async () => {
    const { handler, wait } = setup({ FAILURE_PERCENTAGE: '100', FAILURE_MODES: 'timeout' });

    expect((await handler(event())).statusCode).toBe(504);
    expect(wait).toHaveBeenCalledWith(25000);
  });
});

describe('client certificates', () => {
  const refused: [string, string | null][] = [
    ['another certificate from the same CA', OTHER_PEM],
    ['no certificate', null],
    ['an unreadable certificate', '-----BEGIN CERTIFICATE-----\nbroken\n-----END CERTIFICATE-----'],
  ];

  test.each(refused)('%s is refused on every path, without touching the store', async (_name, pem) => {
    const { handler, store, wait } = setup({ FAILURE_PERCENTAGE: '100', FAILURE_MODES: 'timeout' });
    const put = jest.spyOn(store, 'put');
    const get = jest.spyOn(store, 'get');
    const list = jest.spyOn(store, 'list');

    expect((await handler(event({}, pem))).statusCode).toBe(403);
    expect((await handler(event({ httpMethod: 'GET', path: '/health' }, pem))).statusCode).toBe(403);
    expect((await handler(event({ httpMethod: 'PUT' }, pem))).statusCode).toBe(403);

    for (const call of [put, get, list, wait]) {
      expect(call).not.toHaveBeenCalled();
    }
  });

  test('an event without request context is refused', async () => {
    const { handler } = setup();

    expect((await handler(event({ requestContext: undefined }))).statusCode).toBe(403);
  });

  test('an empty allowlist refuses everything', async () => {
    const { handler } = setup({ ALLOWED_CERT_FINGERPRINTS: '' });

    expect((await handler(event())).statusCode).toBe(403);
  });

  test('colons and case in the allowlist do not matter, and it can hold several fingerprints', async () => {
    const plain = ALLOWED_FINGERPRINT.replace(/:/g, '').toLowerCase();

    for (const list of [plain, plain.toUpperCase(), `${'0'.repeat(64)}, ${ALLOWED_FINGERPRINT}`]) {
      expect((await setup({ ALLOWED_CERT_FINGERPRINTS: list }).handler(event())).statusCode).toBe(200);
    }
  });

  test('a refusal is logged with the fingerprint, without the certificate', async () => {
    const { handler } = setup();

    await handler(event({}, OTHER_PEM));

    const logged = (console.warn as jest.Mock).mock.calls.flat().join();
    expect(logged).toMatch(/"fingerprint":"[0-9a-f]{64}"/);
    expect(logged).toContain('CN=other-client');
    expect(logged).not.toContain('BEGIN CERTIFICATE');
  });

  test.each(['abc', `${'0'.repeat(64)}0`, 'g'.repeat(64)])('fingerprint "%s" is invalid', (fingerprint) => {
    expect(() => setup({ ALLOWED_CERT_FINGERPRINTS: fingerprint })).toThrow(/SHA-256 fingerprint/);
  });
});
