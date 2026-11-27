import { ATTACHMENT_TAG, Config } from './config';
import * as soap from './soap';
import { MessageContext, ZaakDetails } from './soap';
import { ObjectStore } from './store';
import { attribute, element, section, text } from './xml';

/**
 * Endpoint names are the last path segment the client appends to ZAAKDMS_URL.
 */
export type Endpoint = 'OntvangAsynchroon' | 'BeantwoordVraag' | 'VerwerkSynchroonVrijBericht';

export interface Operation {
  name: string;
  endpoint: Endpoint;
  /**
   * The value chaos decisions and logging are grouped by, usually a zaak identificatie.
   */
  key(xml: string): string;
  handle(mock: ZaakdmsMock, xml: string, context: MessageContext): Promise<string>;
}

/**
 * Keyed by the last segment of the SOAPAction header.
 */
export const OPERATIONS: Record<string, Operation> = {
  geefZaakdetails_Lv01: {
    name: 'geefZaakDetails',
    endpoint: 'BeantwoordVraag',
    key: (xml) => text(section(xml, 'gelijk'), 'identificatie') ?? '',
    handle: (mock, xml, context) => mock.geefZaakDetails(xml, context),
  },
  creeerZaak_Lk01: {
    name: 'creeerZaak',
    endpoint: 'OntvangAsynchroon',
    key: zaakObjectKey,
    handle: (mock, xml, context) => mock.creeerZaak(xml, context),
  },
  actualiseerZaakstatus_Lk01: {
    name: 'actualiseerZaakstatus',
    endpoint: 'OntvangAsynchroon',
    key: zaakObjectKey,
    handle: (mock, xml, context) => mock.actualiseerZaakstatus(xml, context),
  },
  updateZaakdocument_Di02: {
    name: 'updateZaakDocument',
    endpoint: 'VerwerkSynchroonVrijBericht',
    key: (xml) => text(section(section(xml, 'object'), 'isRelevantVoor'), 'identificatie') ?? '',
    handle: (mock, xml, context) => mock.updateZaakDocument(xml, context),
  },
  updateZaak_Lk01: {
    name: 'updateZaak',
    endpoint: 'OntvangAsynchroon',
    key: zaakObjectKey,
    handle: (mock, xml, context) => mock.updateZaak(xml, context),
  },
  genereerDocumentIdentificatie_Di02: {
    name: 'genereerDocumentIdentificatie',
    endpoint: 'VerwerkSynchroonVrijBericht',
    key: () => '',
    handle: (mock, _xml, context) => mock.genereerDocumentIdentificatie(context),
  },
  geefZaakdocumentLezen_Lv01: {
    name: 'geefZaakdocumentLezen',
    endpoint: 'BeantwoordVraag',
    key: (xml) => text(section(xml, 'gelijk'), 'identificatie') ?? '',
    handle: (mock, xml, context) => mock.geefZaakdocumentLezen(xml, context),
  },
  voegZaakdocumentToe_Lk01: {
    name: 'voegZaakdocumentToe',
    endpoint: 'OntvangAsynchroon',
    key: zaakObjectKey,
    handle: (mock, xml, context) => mock.voegZaakdocumentToe(xml, context),
  },
};

function zaakObjectKey(xml: string): string {
  return text(section(xml, 'object'), 'identificatie') ?? '';
}

/**
 * A functional error, answered as a StUF Fo02 message.
 */
export class StufError extends Error {
  constructor(readonly fout: soap.Fout) {
    super(fout.omschrijving);
  }
}

interface ZaakRecord {
  identificatie: string;
  dossierId: string;
  omschrijving?: string;
  startdatum?: string;
  registratiedatum?: string;
  zaakniveau?: string;
  zaaktype: { code?: string; omschrijving?: string };
  initiator?: Record<string, string | undefined>;
  aangemaaktOp: string;
}

/**
 * Metadata of one version of a document, as stored in metadata.json (the first version) or
 * versies/{tijdstip}.json (each update).
 */
interface DocumentRecord {
  identificatie: string;
  zaak: string;
  bestandsnaam: string;
  /**
   * Key of the file in the store. Missing in documents stored before versions existed; their
   * file is next to metadata.json, under the bestandsnaam.
   */
  bestand?: string;
  bytes: number;
  titel?: string;
  documenttype?: string;
  creatiedatum?: string;
  ontvangstdatum?: string;
  verzenddatum?: string;
  beschrijving?: string;
  status?: string;
  formaat?: string;
  taal?: string;
  vertrouwelijkAanduiding?: string;
  auteur?: string;
  ontvangenOp: string;
}

interface StatusRecord {
  volgnummer?: string;
  omschrijving?: string;
  datumStatusGezet?: string;
  gezetDoor?: string;
  ontvangenOp: string;
}

interface ResultaatRecord {
  omschrijving?: string;
  einddatum?: string;
  ontvangenOp: string;
}

/**
 * Object layout in the store. Every change is a new object, so nothing is ever read,
 * modified and written back:
 *
 *   zaken/{zaak}/zaak.json                              created once
 *   zaken/{zaak}/statussen/{tijdstip}-{random}.json     one per actualiseerZaakstatus
 *   zaken/{zaak}/resultaat/{tijdstip}-{random}.json     one per updateZaak, the latest wins
 *   zaken/{zaak}/documenten/{document}/metadata.json    created once
 *   zaken/{zaak}/documenten/{document}/{bestandsnaam}   the decoded document, tagged as attachment
 */
export class ZaakdmsMock {
  constructor(
    private readonly store: ObjectStore,
    private readonly config: Config,
  ) {}

  async geefZaakDetails(xml: string, context: MessageContext): Promise<string> {
    const identificatie = required(text(section(xml, 'gelijk'), 'identificatie'), 'gelijk/identificatie');
    const zaak = await this.readJson<ZaakRecord>(zaakKey(identificatie));
    if (!zaak) {
      return soap.zaakLa01(context, undefined);
    }

    const status = await this.latest<StatusRecord>(`${zaakPrefix(identificatie)}statussen/`);
    const resultaat = await this.latest<ResultaatRecord>(`${zaakPrefix(identificatie)}resultaat/`);
    const details: ZaakDetails = {
      identificatie: zaak.identificatie,
      dossierId: zaak.dossierId,
      omschrijving: zaak.omschrijving,
      startdatum: zaak.startdatum,
      registratiedatum: zaak.registratiedatum,
      einddatum: resultaat?.einddatum,
      resultaat: resultaat?.omschrijving,
      zaaktype: zaak.zaaktype,
      status: status && {
        volgnummer: status.volgnummer,
        omschrijving: status.omschrijving,
        datumStatusGezet: status.datumStatusGezet,
      },
    };
    return soap.zaakLa01(context, details);
  }

  async creeerZaak(xml: string, context: MessageContext): Promise<string> {
    const object = section(xml, 'object');
    const identificatie = required(text(object, 'identificatie'), 'object/identificatie');
    const isVan = section(object, 'isVan');
    const zaak: ZaakRecord = {
      identificatie,
      dossierId: String(Date.now()).slice(-9),
      omschrijving: text(object, 'omschrijving'),
      startdatum: text(object, 'startdatum'),
      registratiedatum: text(object, 'registratiedatum'),
      zaakniveau: text(object, 'zaakniveau'),
      zaaktype: { code: text(isVan, 'code'), omschrijving: text(isVan, 'omschrijving') },
      initiator: initiator(section(object, 'heeftAlsInitiator')),
      aangemaaktOp: new Date().toISOString(),
    };

    const created = await this.store.put(zaakKey(identificatie), JSON.stringify(zaak, null, 2), {
      contentType: 'application/json',
      createOnly: true,
    });
    if (!created) {
      throw new StufError({
        code: 'MOCK-BESTAAT-AL',
        plek: 'client',
        omschrijving: 'Object al aanwezig',
        details: `Zaak ${identificatie} bestaat al`,
      });
    }
    return soap.bv03(context);
  }

  async actualiseerZaakstatus(xml: string, context: MessageContext): Promise<string> {
    const object = section(xml, 'object');
    const identificatie = required(text(object, 'identificatie'), 'object/identificatie');
    await this.requireZaak(identificatie);

    const heeft = section(object, 'heeft');
    const gerelateerde = section(heeft, 'gerelateerde');
    const status: StatusRecord = {
      volgnummer: text(gerelateerde, 'volgnummer'),
      omschrijving: text(gerelateerde, 'omschrijving'),
      datumStatusGezet: text(heeft, 'datumStatusGezet'),
      gezetDoor: text(section(heeft, 'isGezetDoor'), 'identificatie'),
      ontvangenOp: new Date().toISOString(),
    };
    await this.store.put(`${zaakPrefix(identificatie)}statussen/${uniqueName()}.json`, JSON.stringify(status, null, 2), {
      contentType: 'application/json',
    });
    return soap.bv03(context);
  }

  async updateZaak(xml: string, context: MessageContext): Promise<string> {
    const object = section(xml, 'object');
    const identificatie = required(text(object, 'identificatie'), 'object/identificatie');
    await this.requireZaak(identificatie);

    const resultaat: ResultaatRecord = {
      omschrijving: text(section(object, 'resultaat'), 'omschrijving'),
      einddatum: text(object, 'einddatum'),
      ontvangenOp: new Date().toISOString(),
    };
    await this.store.put(`${zaakPrefix(identificatie)}resultaat/${uniqueName()}.json`, JSON.stringify(resultaat, null, 2), {
      contentType: 'application/json',
    });
    return soap.bv03(context);
  }

  async genereerDocumentIdentificatie(context: MessageContext): Promise<string> {
    const identificatie = `${this.config.documentIdPrefix}${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
    return soap.documentIdentificatieDu02(context, identificatie);
  }

  async voegZaakdocumentToe(xml: string, context: MessageContext): Promise<string> {
    const object = section(xml, 'object');
    const documentId = required(text(object, 'identificatie'), 'object/identificatie');
    const zaakId = required(text(section(object, 'isRelevantVoor'), 'identificatie'), 'isRelevantVoor/gerelateerde/identificatie');
    await this.requireZaak(zaakId);

    const { bestandsnaam, content } = readInhoud(object, documentId);
    const prefix = documentPrefix(zaakId, documentId);
    const metadata = documentRecord(object, documentId, zaakId, bestandsnaam, prefix + bestandsnaam, content);
    const created = await this.store.put(`${prefix}metadata.json`, JSON.stringify(metadata, null, 2), {
      contentType: 'application/json',
      createOnly: true,
    });
    if (!created) {
      throw new StufError({
        code: 'MOCK-BESTAAT-AL',
        plek: 'client',
        omschrijving: 'Object al aanwezig',
        details: `Document ${documentId} bestaat al`,
      });
    }
    await this.putFile(prefix + bestandsnaam, content);
    await this.store.put(documentIndexKey(documentId), JSON.stringify({ identificatie: documentId, zaak: zaakId }, null, 2), {
      contentType: 'application/json',
      createOnly: true,
    });
    return soap.bv03(context);
  }

  /**
   * Stores a new version of a document that is in the zaak. The file is written before its
   * metadata, so a reader never finds a version without its file.
   */
  async updateZaakDocument(xml: string, context: MessageContext): Promise<string> {
    const object = section(xml, 'object');
    const documentId = required(text(object, 'identificatie'), 'object/identificatie');
    const zaakId = required(text(section(object, 'isRelevantVoor'), 'identificatie'), 'isRelevantVoor/gerelateerde/identificatie');
    await this.requireZaak(zaakId);
    const prefix = documentPrefix(zaakId, documentId);
    if (!await this.store.get(`${prefix}metadata.json`)) {
      throw new StufError({
        code: 'MOCK-NIET-GEVONDEN',
        plek: 'client',
        omschrijving: 'Object niet gevonden',
        details: `Document ${documentId} bestaat niet in zaak ${zaakId}`,
      });
    }

    const { bestandsnaam, content } = readInhoud(object, documentId);
    const versionPrefix = `${prefix}versies/${uniqueName()}/`;
    await this.putFile(versionPrefix + bestandsnaam, content);
    const version = documentRecord(object, documentId, zaakId, bestandsnaam, versionPrefix + bestandsnaam, content);
    await this.store.put(`${versionPrefix}metadata.json`, JSON.stringify(version, null, 2), { contentType: 'application/json' });
    return soap.bv02(context);
  }

  async geefZaakdocumentLezen(xml: string, context: MessageContext): Promise<string> {
    const identificatie = required(text(section(xml, 'gelijk'), 'identificatie'), 'gelijk/identificatie');
    const index = await this.readJson<{ zaak: string }>(documentIndexKey(identificatie));
    const document = index && await this.latestVersion(index.zaak, identificatie);
    if (!document) {
      return soap.edcLa01(context, undefined);
    }

    const content = await this.store.get(fileKey(document));
    if (!content) {
      throw new StufError({
        code: 'MOCK-VERLOPEN',
        plek: 'server',
        omschrijving: 'Bestand niet meer beschikbaar',
        details: `Het bestand van document ${identificatie} is verwijderd na de bewaartermijn van de mock`,
      });
    }
    return soap.edcLa01(context, { ...document, content });
  }

  /**
   * The newest version of a document: the last update, else the version it was added with.
   */
  private async latestVersion(zaak: string, document: string): Promise<DocumentRecord | undefined> {
    const prefix = documentPrefix(zaak, document);
    const versions = (await this.store.list(`${prefix}versies/`)).filter((key) => key.endsWith('/metadata.json')).sort();
    const last = versions[versions.length - 1];
    return this.readJson<DocumentRecord>(last ?? `${prefix}metadata.json`);
  }

  private async putFile(key: string, content: Buffer): Promise<void> {
    await this.store.put(key, content, {
      contentType: 'application/octet-stream',
      tags: { [ATTACHMENT_TAG.key]: ATTACHMENT_TAG.value },
    });
  }

  private async requireZaak(identificatie: string): Promise<void> {
    if (!await this.store.get(zaakKey(identificatie))) {
      throw new StufError({
        code: 'MOCK-NIET-GEVONDEN',
        plek: 'client',
        omschrijving: 'Object niet gevonden',
        details: `Zaak ${identificatie} bestaat niet`,
      });
    }
  }

  private async readJson<T>(key: string): Promise<T | undefined> {
    const body = await this.store.get(key);
    return body ? JSON.parse(body.toString('utf8')) as T : undefined;
  }

  private async latest<T>(prefix: string): Promise<T | undefined> {
    const keys = (await this.store.list(prefix)).sort();
    const last = keys[keys.length - 1];
    return last === undefined ? undefined : this.readJson<T>(last);
  }
}

function zaakPrefix(identificatie: string): string {
  return `zaken/${encodeURIComponent(identificatie)}/`;
}

function zaakKey(identificatie: string): string {
  return `${zaakPrefix(identificatie)}zaak.json`;
}

function documentPrefix(zaak: string, document: string): string {
  return `${zaakPrefix(zaak)}documenten/${encodeURIComponent(document)}/`;
}

function readInhoud(object: string, documentId: string): { bestandsnaam: string; content: Buffer } {
  const inhoud = element(object, 'inhoud');
  if (!inhoud) {
    throw invalid('object/inhoud');
  }
  return {
    bestandsnaam: safeFileName(attribute(inhoud.attributes, 'bestandsnaam') || `${documentId}.bin`),
    content: Buffer.from(inhoud.inner.replace(/\s/g, ''), 'base64'),
  };
}

function documentRecord(object: string, identificatie: string, zaak: string, bestandsnaam: string, bestand: string, content: Buffer): DocumentRecord {
  return {
    identificatie,
    zaak,
    bestandsnaam,
    bestand,
    bytes: content.length,
    titel: text(object, 'titel'),
    documenttype: text(object, 'dct.omschrijving'),
    creatiedatum: text(object, 'creatiedatum'),
    ontvangstdatum: text(object, 'ontvangstdatum'),
    verzenddatum: text(object, 'verzenddatum'),
    beschrijving: text(object, 'beschrijving'),
    status: text(object, 'status'),
    formaat: text(object, 'formaat'),
    taal: text(object, 'taal'),
    vertrouwelijkAanduiding: text(object, 'vertrouwelijkAanduiding'),
    auteur: text(object, 'auteur'),
    ontvangenOp: new Date().toISOString(),
  };
}

function fileKey(document: DocumentRecord): string {
  return document.bestand ?? documentPrefix(document.zaak, document.identificatie) + document.bestandsnaam;
}

/**
 * Which zaak a document belongs to, for questions that only name the document.
 */
function documentIndexKey(document: string): string {
  return `documenten/${encodeURIComponent(document)}.json`;
}

/**
 * Sorts in the order of arrival, unique across concurrent invocations.
 */
export function uniqueName(): string {
  return `${new Date().toISOString()}-${Math.random().toString(36).slice(2, 8)}`;
}

function initiator(xml: string): Record<string, string | undefined> | undefined {
  const natuurlijkPersoon = section(xml, 'natuurlijkPersoon');
  if (natuurlijkPersoon) {
    return {
      type: 'natuurlijk_persoon',
      bsn: text(natuurlijkPersoon, 'inp.bsn'),
      identificatie: text(natuurlijkPersoon, 'anp.identificatie'),
      geslachtsnaam: text(natuurlijkPersoon, 'geslachtsnaam'),
    };
  }
  const nietNatuurlijkPersoon = section(xml, 'nietNatuurlijkPersoon');
  if (nietNatuurlijkPersoon) {
    return {
      type: 'niet_natuurlijk_persoon',
      nnpId: text(nietNatuurlijkPersoon, 'inn.nnpId'),
      statutaireNaam: text(nietNatuurlijkPersoon, 'statutaireNaam'),
    };
  }
  return undefined;
}

function safeFileName(name: string): string {
  return name.replace(/[/\\]/g, '_').replace(/^\.+/, '_') || 'document';
}

function required(value: string | undefined, path: string): string {
  if (!value) {
    throw invalid(path);
  }
  return value;
}

function invalid(path: string): StufError {
  return new StufError({
    code: 'MOCK-ONGELDIG',
    plek: 'client',
    omschrijving: 'Element ontbreekt of is leeg',
    details: path,
  });
}
