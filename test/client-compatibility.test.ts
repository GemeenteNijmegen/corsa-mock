import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { creeerZaak, geefZaakdocumentLezen, setup, updateZaakDocument, voegZaakdocumentToe, zaakVraag } from './stuf';

/**
 * Reads an answer the way the laravel-zaakdms client does (ZaakdmsResponse::validate): strip the
 * prefix from every tag name, remove the prefix of stuf:bestandsnaam, parse, take soapBody, and
 * look values up by the glued names (Helper::findInObject searches depth first).
 */
function readLikeClient(body: string) {
  const stripped = body
    .replace(/(<\/?)(\w+):([^>]*>)/g, '$1$2$3')
    .replace(/stuf:bestandsnaam/g, 'bestandsnaam');
  const valid = XMLValidator.validate(stripped);
  if (valid !== true) {
    throw new Error(`The client could not parse this answer: ${JSON.stringify(valid.err)}`);
  }
  const parsed = new XMLParser({ ignoreAttributes: false, parseTagValue: false, attributeNamePrefix: '@' }).parse(stripped);
  const soapBody = find(parsed, 'soapBody');
  if (soapBody === undefined) {
    throw new Error('The client finds no soapBody in this answer');
  }
  return (name: string) => find(soapBody, name);
}

function find(node: unknown, name: string): any {
  if (typeof node !== 'object' || node === null) {
    return undefined;
  }
  const record = node as Record<string, unknown>;
  if (name in record) {
    return record[name];
  }
  for (const value of Object.values(record)) {
    const found = find(value, name);
    if (found !== undefined) {
      return found;
    }
  }
  return undefined;
}

beforeEach(() => {
  jest.spyOn(console, 'log').mockImplementation();
});
afterEach(() => jest.restoreAllMocks());

async function zaakWithDocument() {
  const mock = setup();
  await mock.send('creeerZaak_Lk01', 'OntvangAsynchroon', creeerZaak('ZAAK-1'));
  await mock.send('voegZaakdocumentToe_Lk01', 'OntvangAsynchroon', voegZaakdocumentToe({
    identificatie: 'DOC-1',
    zaak: 'ZAAK-1',
    titel: 'Brief <concept> & "bijlage"',
    content: 'inhoud',
    bestandsnaam: 'brief-concept-bijlage-1764230400..txt',
  }));
  return mock;
}

test('updateZaakDocument: the client finds the crossRefnummer it returns', async () => {
  const { send } = await zaakWithDocument();

  const lookup = readLikeClient((await send('updateZaakdocument_Di02', 'VerwerkSynchroonVrijBericht',
    updateZaakDocument({ identificatie: 'DOC-1', zaak: 'ZAAK-1' }))).body);

  expect(lookup('stufcrossRefnummer')).toBe('DOC-1');
  expect(lookup('Fo02Bericht')).toBeUndefined();
});

test('geefLijstZaakdocumenten: the client returns the zaak object, and corsa-zgw finds the document identificaties in it', async () => {
  const { send } = await zaakWithDocument();
  await send('voegZaakdocumentToe_Lk01', 'OntvangAsynchroon', voegZaakdocumentToe({ identificatie: 'DOC-2', zaak: 'ZAAK-1' }));

  const lookup = readLikeClient((await send('geefLijstZaakdocumenten_Lv01', 'BeantwoordVraag', zaakVraag('ZAAK-1'))).body);
  const zaakObject = lookup('zknobject');
  const relevant = [zaakObject.zknheeftRelevant].flat();

  expect(zaakObject.zknidentificatie).toBe('ZAAK-1');
  expect(relevant.map((entry: any) => entry.zkngerelateerde.zknidentificatie)).toEqual(['DOC-1', 'DOC-2']);
});

test('geefZaakdocumentLezen: the client finds the content and the document object', async () => {
  const { send } = await zaakWithDocument();

  const lookup = readLikeClient((await send('geefZaakdocumentLezen_Lv01', 'BeantwoordVraag?documentType=native', geefZaakdocumentLezen('DOC-1'))).body);
  const inhoud = lookup('zkninhoud');

  expect(Buffer.from(inhoud['#text'], 'base64').toString()).toBe('inhoud');
  expect(inhoud['@bestandsnaam']).toBe('brief-concept-bijlage-1764230400..txt');
  expect(lookup('zknobject').zkntitel).toBe('Brief <concept> & "bijlage"');
});

test('empty answers for an unknown zaak or document are still readable', async () => {
  const { send } = setup();

  const list = readLikeClient((await send('geefLijstZaakdocumenten_Lv01', 'BeantwoordVraag', zaakVraag('ZAAK-9'))).body);
  const read = readLikeClient((await send('geefZaakdocumentLezen_Lv01', 'BeantwoordVraag', geefZaakdocumentLezen('DOC-9'))).body);

  expect(list('zknobject')).toBeUndefined();
  expect(read('zkninhoud')).toBeUndefined();
  expect(list('Fo02Bericht')).toBeUndefined();
});
