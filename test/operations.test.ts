import { creeerZaak, geefZaakdocumentLezen, setup, voegZaakdocumentToe } from './stuf';
import { attribute, element, section, text } from '../src/corsa-mock/xml';

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

function readAnswer(body: string) {
  const object = section(section(section(body, 'edcLa01'), 'antwoord'), 'object');
  if (!object) {
    return undefined;
  }
  const inhoud = element(object, 'inhoud')!;
  return {
    identificatie: text(object, 'identificatie'),
    titel: text(object, 'titel'),
    documenttype: text(object, 'dct.omschrijving'),
    status: text(object, 'status'),
    taal: text(object, 'taal'),
    vertrouwelijkAanduiding: text(object, 'vertrouwelijkAanduiding'),
    zaak: text(section(object, 'isRelevantVoor'), 'identificatie'),
    bestandsnaam: attribute(inhoud.attributes, 'bestandsnaam'),
    content: Buffer.from(inhoud.inner, 'base64').toString(),
  };
}

describe('geefZaakdocumentLezen', () => {
  test('reads a document back with its content and metadata', async () => {
    const { send } = setup();
    await send('creeerZaak_Lk01', 'OntvangAsynchroon', creeerZaak('ZAAK-1'));
    await send('voegZaakdocumentToe_Lk01', 'OntvangAsynchroon', voegZaakdocumentToe({
      identificatie: 'DOC-1',
      zaak: 'ZAAK-1',
      titel: 'Besluit & bijlage',
      vertrouwelijkAanduiding: 'ZEER GEHEIM',
      status: 'definitief',
      content: Buffer.from([0, 1, 2, 255, 254]),
      bestandsnaam: 'besluit-1764230400..pdf',
    }));

    const response = await send('geefZaakdocumentLezen_Lv01', 'BeantwoordVraag', geefZaakdocumentLezen('DOC-1'));

    expect(response.statusCode).toBe(200);
    expect(response.headers.esbbusinessproces).toBe('geefZaakdocumentLezen');
    expect(response.body).toContain('<soap:Body><zkn:edcLa01>');
    expect(response.body).toContain('<stuf:crossRefnummer>DOC-1</stuf:crossRefnummer>');
    const answer = readAnswer(response.body)!;
    expect(answer).toEqual({
      identificatie: 'DOC-1',
      titel: 'Besluit & bijlage',
      documenttype: 'Bijlage',
      status: 'definitief',
      taal: 'nl',
      vertrouwelijkAanduiding: 'ZEER GEHEIM',
      zaak: 'ZAAK-1',
      bestandsnaam: 'besluit-1764230400..pdf',
      content: Buffer.from([0, 1, 2, 255, 254]).toString(),
    });
    expect(Buffer.from(element(response.body, 'inhoud')!.inner, 'base64')).toEqual(Buffer.from([0, 1, 2, 255, 254]));
  });

  test('gives an empty answer for an unknown document', async () => {
    const { send } = setup();

    const response = await send('geefZaakdocumentLezen_Lv01', 'BeantwoordVraag', geefZaakdocumentLezen('DOC-9'));

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('<zkn:edcLa01>');
    expect(readAnswer(response.body)).toBeUndefined();
  });

  test('answers MOCK-VERLOPEN when the file was removed after the retention period', async () => {
    const { send, store } = await zaakWithDocument();
    store.objects.delete('zaken/ZAAK-1/documenten/DOC-1/eerste-1764230400..txt');

    const response = await send('geefZaakdocumentLezen_Lv01', 'BeantwoordVraag', geefZaakdocumentLezen('DOC-1'));

    expect(response.statusCode).toBe(500);
    expect(response.body).toContain('MOCK-VERLOPEN');
  });

  test('reads a document stored before files had their own key', async () => {
    const { send, store } = await zaakWithDocument();
    const key = 'zaken/ZAAK-1/documenten/DOC-1/metadata.json';
    const { bestand, ...withoutKey } = JSON.parse(store.objects.get(key)!.toString());
    store.objects.set(key, Buffer.from(JSON.stringify(withoutKey)));

    const response = await send('geefZaakdocumentLezen_Lv01', 'BeantwoordVraag', geefZaakdocumentLezen('DOC-1'));

    expect(bestand).toBe('zaken/ZAAK-1/documenten/DOC-1/eerste-1764230400..txt');
    expect(readAnswer(response.body)!.content).toBe('first version');
  });

  test('a query string on the endpoint, as the client sends it, is ignored', async () => {
    const { send } = await zaakWithDocument();

    const response = await send('geefZaakdocumentLezen_Lv01', 'BeantwoordVraag?documentType=native', geefZaakdocumentLezen('DOC-1'));

    expect(response.statusCode).toBe(200);
    expect(readAnswer(response.body)!.content).toBe('first version');
  });
});
