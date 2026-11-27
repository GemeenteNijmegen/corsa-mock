import { creeerZaak, geefZaakdocumentLezen, setup, updateZaakDocument, voegZaakdocumentToe } from './stuf';
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

describe('updateZaakDocument', () => {
  afterEach(() => jest.useRealTimers());

  const update = (fields: Partial<Parameters<typeof updateZaakDocument>[0]> = {}, options = {}) =>
    updateZaakDocument({ identificatie: 'DOC-1', zaak: 'ZAAK-1', ...fields }, options);

  test('stores a new version that geefZaakdocumentLezen returns, and keeps the first one', async () => {
    const { send, store } = await zaakWithDocument();

    const response = await send('updateZaakdocument_Di02', 'VerwerkSynchroonVrijBericht', update({
      titel: 'Nieuwe titel',
      vertrouwelijkAanduiding: 'GEHEIM',
      content: 'second version',
      bestandsnaam: 'nieuwe-titel-1764234000..txt',
    }));

    expect(response.statusCode).toBe(200);
    expect(response.headers.esbbusinessproces).toBe('updateZaakDocument');
    expect(response.body).toContain('<stuf:Bv02Bericht>');
    expect(response.body).toContain('<stuf:berichtcode>Bv02</stuf:berichtcode>');
    expect(response.body).toContain('<stuf:crossRefnummer>DOC-1</stuf:crossRefnummer>');

    const answer = readAnswer((await send('geefZaakdocumentLezen_Lv01', 'BeantwoordVraag', geefZaakdocumentLezen('DOC-1'))).body)!;
    expect(answer.content).toBe('second version');
    expect(answer.titel).toBe('Nieuwe titel');
    expect(answer.vertrouwelijkAanduiding).toBe('GEHEIM');
    expect(answer.bestandsnaam).toBe('nieuwe-titel-1764234000..txt');

    expect(store.objects.get('zaken/ZAAK-1/documenten/DOC-1/eerste-1764230400..txt')!.toString()).toBe('first version');
    expect(JSON.parse(store.objects.get('zaken/ZAAK-1/documenten/DOC-1/metadata.json')!.toString()).titel).toBe('Titel DOC-1');
    const versionKeys = [...store.objects.keys()].filter((key) => key.startsWith('zaken/ZAAK-1/documenten/DOC-1/versies/'));
    expect(versionKeys).toHaveLength(2);
    expect(versionKeys.some((key) => key.endsWith('/metadata.json'))).toBe(true);
    expect(versionKeys.some((key) => key.endsWith('/nieuwe-titel-1764234000..txt'))).toBe(true);
  });

  test('the latest of several updates wins', async () => {
    const { send } = await zaakWithDocument();
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });

    jest.setSystemTime(new Date('2026-11-27T10:00:00Z'));
    await send('updateZaakdocument_Di02', 'VerwerkSynchroonVrijBericht', update({ content: 'second version' }));
    jest.setSystemTime(new Date('2026-11-27T10:00:01Z'));
    await send('updateZaakdocument_Di02', 'VerwerkSynchroonVrijBericht', update({ content: 'third version' }));

    const answer = readAnswer((await send('geefZaakdocumentLezen_Lv01', 'BeantwoordVraag', geefZaakdocumentLezen('DOC-1'))).body)!;
    expect(answer.content).toBe('third version');
  });

  test('only the file of a version is tagged as attachment, so it expires like the first file', async () => {
    const { send, store } = await zaakWithDocument();

    await send('updateZaakdocument_Di02', 'VerwerkSynchroonVrijBericht', update({ bestandsnaam: 'v2.txt' }));

    const tagged = [...store.options.entries()].filter(([, options]) => options.tags?.type === 'attachment').map(([key]) => key);
    expect(tagged.sort()).toEqual([
      'zaken/ZAAK-1/documenten/DOC-1/eerste-1764230400..txt',
      expect.stringMatching(/^zaken\/ZAAK-1\/documenten\/DOC-1\/versies\/[^/]+\/v2\.txt$/),
    ]);
  });

  test('the stored request leaves out the document content', async () => {
    const { send, store } = await zaakWithDocument();

    await send('updateZaakdocument_Di02', 'VerwerkSynchroonVrijBericht', update({ content: 'secret content' }));

    const request = [...store.objects.entries()].find(([key]) => key.startsWith('requests/') && key.includes('-updateZaakDocument-'));
    expect(request).toBeDefined();
    expect(request![0]).toContain('-updateZaakDocument-ZAAK-1.xml');
    expect(request![1].toString()).not.toContain(Buffer.from('secret content').toString('base64'));
  });

  test.each([
    ['an unknown zaak', { zaak: 'ZAAK-9' }, {}, 'MOCK-NIET-GEVONDEN', 'Zaak ZAAK-9 bestaat niet'],
    ['a document that is not in the zaak', { identificatie: 'DOC-9' }, {}, 'MOCK-NIET-GEVONDEN', 'Document DOC-9 bestaat niet in zaak ZAAK-1'],
    ['no inhoud', {}, { withInhoud: false }, 'MOCK-ONGELDIG', 'object/inhoud'],
  ])('answers a Fo02 for %s', async (_name, fields, options, code, details) => {
    const { send } = await zaakWithDocument();

    const response = await send('updateZaakdocument_Di02', 'VerwerkSynchroonVrijBericht', update(fields, options));

    expect(response.statusCode).toBe(500);
    expect(response.body).toContain(`<stuf:code>${code}</stuf:code>`);
    expect(response.body).toContain(details);
  });

  test('is only answered on VerwerkSynchroonVrijBericht', async () => {
    const { send } = await zaakWithDocument();

    const response = await send('updateZaakdocument_Di02', 'OntvangAsynchroon', update());

    expect(response.statusCode).toBe(500);
    expect(response.body).toContain('MOCK-VERKEERD-ENDPOINT');
  });
});
