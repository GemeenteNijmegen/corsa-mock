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

    const inhoud = element(object, 'inhoud');
    if (!inhoud) {
      throw invalid('object/inhoud');
    }
    const bestandsnaam = safeFileName(attribute(inhoud.attributes, 'bestandsnaam') || `${documentId}.bin`);
    const content = Buffer.from(inhoud.inner.replace(/\s/g, ''), 'base64');
    const documentPrefix = `${zaakPrefix(zaakId)}documenten/${encodeURIComponent(documentId)}/`;

    const metadata = {
      identificatie: documentId,
      zaak: zaakId,
      bestandsnaam,
      bytes: content.length,
      titel: text(object, 'titel'),
      documenttype: text(object, 'dct.omschrijving'),
      creatiedatum: text(object, 'creatiedatum'),
      ontvangstdatum: text(object, 'ontvangstdatum'),
      verzenddatum: text(object, 'verzenddatum'),
      beschrijving: text(object, 'beschrijving'),
      status: text(object, 'status'),
      formaat: text(object, 'formaat'),
      vertrouwelijkAanduiding: text(object, 'vertrouwelijkAanduiding'),
      auteur: text(object, 'auteur'),
      ontvangenOp: new Date().toISOString(),
    };
    const created = await this.store.put(`${documentPrefix}metadata.json`, JSON.stringify(metadata, null, 2), {
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
    await this.store.put(documentPrefix + bestandsnaam, content, {
      contentType: 'application/octet-stream',
      tags: { [ATTACHMENT_TAG.key]: ATTACHMENT_TAG.value },
    });
    return soap.bv03(context);
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
