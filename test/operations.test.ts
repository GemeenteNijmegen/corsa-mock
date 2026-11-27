import { creeerZaak, setup, voegZaakdocumentToe } from './stuf';

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation();
  jest.spyOn(console, 'warn').mockImplementation();
});
afterEach(() => jest.restoreAllMocks());

async function zaakWithDocument(env: NodeJS.ProcessEnv = {}) {
  const mock = setup(env);
  expect((await mock.send('creeerZaak_Lk01', 'OntvangAsynchroon', creeerZaak('ZAAK-1'))).statusCode).toBe(200);
  const added = await mock.send('voegZaakdocumentToe_Lk01', 'OntvangAsynchroon', voegZaakdocumentToe({
    identificatie: 'DOC-1',
    zaak: 'ZAAK-1',
    content: 'first version',
    bestandsnaam: 'eerste-1764230400..txt',
  }));
  expect(added.statusCode).toBe(200);
  return mock;
}

describe('voegZaakdocumentToe', () => {
  test('stores metadata, the file and an index of the document\'s zaak', async () => {
    const { store } = await zaakWithDocument();

    expect(JSON.parse(store.objects.get('zaken/ZAAK-1/documenten/DOC-1/metadata.json')!.toString()).titel).toBe('Titel DOC-1');
    expect(store.objects.get('zaken/ZAAK-1/documenten/DOC-1/eerste-1764230400..txt')!.toString()).toBe('first version');
    expect(JSON.parse(store.objects.get('documenten/DOC-1.json')!.toString())).toEqual({ identificatie: 'DOC-1', zaak: 'ZAAK-1' });
  });
});
