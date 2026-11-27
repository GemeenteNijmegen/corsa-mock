import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/corsa-mock/config';
import { createHandler, HttpEvent, HttpResult } from '../src/corsa-mock/handler';
import { MemoryObjectStore, PutOptions } from '../src/corsa-mock/store';
import { escape } from '../src/corsa-mock/xml';

/**
 * Requests shaped like the templates of the laravel-zaakdms client
 * (resources/views/*.blade.php), which is what corsa-zgw sends. Values are escaped, as Blade's
 * {{ }} does.
 */

const ALLOWED_PEM = readFileSync(join(__dirname, 'fixtures/test-client-allowed.pem'), 'utf8');
// openssl x509 -in test/fixtures/test-client-allowed.pem -noout -fingerprint -sha256
const ALLOWED_FINGERPRINT = '81:A8:5B:90:61:FE:28:82:6F:2A:4F:A0:D8:37:9E:DC:F2:33:34:12:69:38:A6:19:22:22:B7:DF:41:6A:9E:88';

const ZKN = 'http://www.egem.nl/StUF/sector/zkn/0310';

/**
 * Keeps the options of every put, so tests can check tags.
 */
export class RecordingStore extends MemoryObjectStore {
  readonly options = new Map<string, PutOptions>();

  override async put(key: string, body: string | Buffer, options: PutOptions = {}): Promise<boolean> {
    const written = await super.put(key, body, options);
    if (written) {
      this.options.set(key, options);
    }
    return written;
  }
}

export function setup(env: NodeJS.ProcessEnv = {}) {
  const store = new RecordingStore();
  const config = loadConfig({ ALLOWED_CERT_FINGERPRINTS: ALLOWED_FINGERPRINT, ...env });
  const handler = createHandler(config, store, { wait: async () => undefined });
  const send = (action: string, endpoint: string, body: string): Promise<HttpResult> => {
    const request: HttpEvent = {
      path: `/${endpoint}`,
      httpMethod: 'POST',
      headers: { SOAPAction: `"${ZKN}/${action}"` },
      body,
      isBase64Encoded: false,
      requestContext: { identity: { clientCert: { clientCertPem: ALLOWED_PEM } } },
    };
    return handler(request);
  };
  return { store, handler, send };
}

function envelope(body: string): string {
  return '<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/"'
    + ` xmlns:zkn="${ZKN}" xmlns:stuf="http://www.egem.nl/StUF/StUF0301">`
    + `<SOAP-ENV:Header/><SOAP-ENV:Body>${body}</SOAP-ENV:Body></SOAP-ENV:Envelope>`;
}

function stuurgegevens(berichtcode: string, referentie: string, extra = ''): string {
  return '<zkn:stuurgegevens>'
    + `<stuf:berichtcode>${berichtcode}</stuf:berichtcode>`
    + '<stuf:zender><stuf:applicatie>corsa-zgw</stuf:applicatie><stuf:gebruiker>Systeemgebruiker</stuf:gebruiker></stuf:zender>'
    + '<stuf:ontvanger><stuf:organisatie>Gemeente</stuf:organisatie><stuf:applicatie>Corsa</stuf:applicatie><stuf:gebruiker>Systeemgebruiker</stuf:gebruiker></stuf:ontvanger>'
    + `<stuf:referentienummer>${referentie}</stuf:referentienummer>`
    + '<stuf:tijdstipBericht>20261127100000</stuf:tijdstipBericht>'
    + extra
    + '</zkn:stuurgegevens>';
}

export function creeerZaak(zaak: string): string {
  return envelope('<zkn:zakLk01>'
    + stuurgegevens('Lk01', zaak, '<stuf:entiteittype>ZAK</stuf:entiteittype>')
    + '<zkn:parameters><stuf:mutatiesoort>T</stuf:mutatiesoort><stuf:indicatorOvername>V</stuf:indicatorOvername></zkn:parameters>'
    + `<zkn:object stuf:entiteittype="ZAK" stuf:verwerkingssoort="T"><zkn:identificatie>${zaak}</zkn:identificatie>`
    + '<zkn:omschrijving>Test</zkn:omschrijving></zkn:object>'
    + '</zkn:zakLk01>');
}

export interface DocumentFields {
  identificatie: string;
  zaak: string;
  titel?: string;
  vertrouwelijkAanduiding?: string;
  bestandsnaam?: string;
  content?: Buffer | string;
  status?: string;
}

function documentObject(fields: DocumentFields, withInhoud = true): string {
  const content = Buffer.from(fields.content ?? `content of ${fields.identificatie}`);
  return `<zkn:identificatie>${fields.identificatie}</zkn:identificatie>`
    + '<zkn:dct.omschrijving>Bijlage</zkn:dct.omschrijving>'
    + '<zkn:creatiedatum>20261127</zkn:creatiedatum>'
    + (fields.status ? `<zkn:status>${fields.status}</zkn:status>` : '')
    + `<zkn:titel>${escape(fields.titel ?? `Titel ${fields.identificatie}`)}</zkn:titel>`
    + '<zkn:formaat>.txt</zkn:formaat>'
    + '<zkn:taal>nl</zkn:taal>'
    + `<zkn:vertrouwelijkAanduiding>${fields.vertrouwelijkAanduiding ?? 'ZAAKVERTROUWELIJK'}</zkn:vertrouwelijkAanduiding>`
    + '<zkn:auteur>Test</zkn:auteur>'
    + (withInhoud ? `<zkn:inhoud stuf:bestandsnaam="${escape(fields.bestandsnaam ?? 'titel-1764230400..txt')}">${content.toString('base64')}</zkn:inhoud>` : '')
    + '<zkn:isRelevantVoor stuf:entiteittype="EDCZAK" stuf:verwerkingssoort="I">'
    + `<zkn:gerelateerde stuf:entiteittype="ZAK" stuf:verwerkingssoort="I"><zkn:identificatie>${fields.zaak}</zkn:identificatie></zkn:gerelateerde>`
    + '</zkn:isRelevantVoor>';
}

export function voegZaakdocumentToe(fields: DocumentFields): string {
  return envelope('<zkn:edcLk01>'
    + stuurgegevens('Lk01', fields.identificatie, '<stuf:entiteittype>EDC</stuf:entiteittype>')
    + '<zkn:parameters><stuf:mutatiesoort>T</stuf:mutatiesoort><stuf:indicatorOvername>I</stuf:indicatorOvername></zkn:parameters>'
    + `<zkn:object stuf:verwerkingssoort="T" stuf:entiteittype="EDC">${documentObject(fields)}</zkn:object>`
    + '</zkn:edcLk01>');
}

export function updateZaakDocument(fields: DocumentFields, options: { withInhoud?: boolean } = {}): string {
  return envelope('<zkn:updateZaakdocument_Di02>'
    + stuurgegevens('Di02', fields.identificatie, '<stuf:functie>updateZaakdocument</stuf:functie>')
    + '<zkn:parameters><zkn:checkedOutId>0</zkn:checkedOutId></zkn:parameters>'
    + '<zkn:edcLk02 stuf:entiteittype="EDC" stuf:functie="update">'
    + '<zkn:parameters><stuf:mutatiesoort>T</stuf:mutatiesoort></zkn:parameters>'
    + `<zkn:object stuf:entiteittype="EDC" stuf:verwerkingssoort="T">${documentObject(fields, options.withInhoud ?? true)}</zkn:object>`
    + '</zkn:edcLk02>'
    + '</zkn:updateZaakdocument_Di02>');
}

/**
 * geefLijstZaakdocumenten sends the same body as geefZaakDetails; only the SOAPAction differs.
 */
export function zaakVraag(zaak: string): string {
  return envelope('<zkn:zakLv01>'
    + stuurgegevens('Lv01', zaak, '<stuf:entiteittype>ZAK</stuf:entiteittype>')
    + '<zkn:parameters><stuf:sortering>0</stuf:sortering><stuf:indicatorVervolgvraag>false</stuf:indicatorVervolgvraag></zkn:parameters>'
    + `<zkn:gelijk stuf:entiteittype="ZAK"><zkn:identificatie>${zaak}</zkn:identificatie></zkn:gelijk>`
    + '</zkn:zakLv01>');
}

export function geefZaakdocumentLezen(document: string): string {
  return envelope('<zkn:edcLv01>'
    + stuurgegevens('Lv01', document, '<stuf:entiteittype>EDC</stuf:entiteittype>')
    + '<zkn:parameters><stuf:sortering>0</stuf:sortering><stuf:indicatorVervolgvraag>false</stuf:indicatorVervolgvraag></zkn:parameters>'
    + `<zkn:gelijk stuf:entiteittype="EDC"><zkn:identificatie>${document}</zkn:identificatie></zkn:gelijk>`
    + '<zkn:scope><zkn:object stuf:entiteittype="EDC" stuf:scope="alles"/></zkn:scope>'
    + '</zkn:edcLv01>');
}
