import { escape, section, text } from './xml';

/**
 * Responses use the `soap:` envelope prefix on purpose. The laravel-zaakdms client strips
 * the colon from every tag name and then looks up `//soapBody`, so any other prefix
 * (`SOAP-ENV:`, `s:`) makes the client fail.
 */
const NAMESPACES = 'xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"'
  + ' xmlns:stuf="http://www.egem.nl/StUF/StUF0301"'
  + ' xmlns:zkn="http://www.egem.nl/StUF/sector/zkn/0310"';

/**
 * Routing data from the request's stuurgegevens, needed to address the answer.
 */
export interface MessageContext {
  /**
   * Inner XML of the request's zender, used as ontvanger in the answer.
   */
  zender: string;
  /**
   * Inner XML of the request's ontvanger, used as zender in the answer.
   */
  ontvanger: string;
  referentienummer?: string;
}

export function messageContext(xml: string): MessageContext {
  const requestStuurgegevens = section(xml, 'stuurgegevens');
  return {
    zender: section(requestStuurgegevens, 'zender').trim(),
    ontvanger: section(requestStuurgegevens, 'ontvanger').trim(),
    referentienummer: text(requestStuurgegevens, 'referentienummer') || undefined,
  };
}

export function envelope(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<soap:Envelope ${NAMESPACES}><soap:Header/><soap:Body>${body}</soap:Body></soap:Envelope>`;
}

interface Stuurgegevens {
  berichtcode: string;
  entiteittype?: string;
  functie?: string;
}

function stuurgegevens(context: MessageContext, values: Stuurgegevens, element = 'stuf:stuurgegevens'): string {
  return `<${element}>`
    + `<stuf:berichtcode>${values.berichtcode}</stuf:berichtcode>`
    + `<stuf:zender>${context.ontvanger}</stuf:zender>`
    + `<stuf:ontvanger>${context.zender}</stuf:ontvanger>`
    + `<stuf:referentienummer>${escape(newReferentienummer())}</stuf:referentienummer>`
    + `<stuf:tijdstipBericht>${tijdstip()}</stuf:tijdstipBericht>`
    + (context.referentienummer ? `<stuf:crossRefnummer>${escape(context.referentienummer)}</stuf:crossRefnummer>` : '')
    + (values.entiteittype ? `<stuf:entiteittype>${values.entiteittype}</stuf:entiteittype>` : '')
    + (values.functie ? `<stuf:functie>${values.functie}</stuf:functie>` : '')
    + `</${element}>`;
}

/**
 * Acknowledgement of an asynchronous Lk01 message. The client reads `stuf:crossRefnummer`.
 */
export function bv03(context: MessageContext): string {
  return envelope(`<stuf:Bv03Bericht>${stuurgegevens(withCrossRef(context), { berichtcode: 'Bv03' })}</stuf:Bv03Bericht>`);
}

export interface ZaakDetails {
  identificatie: string;
  dossierId: string;
  omschrijving?: string;
  startdatum?: string;
  registratiedatum?: string;
  einddatum?: string;
  resultaat?: string;
  zaaktype?: { code?: string; omschrijving?: string };
  status?: { volgnummer?: string; omschrijving?: string; datumStatusGezet?: string };
}

/**
 * Answer to geefZaakDetails. The client reads `zkn:identificatie` and the
 * `corsa_dossierid` extra element; without that element it throws.
 * `zaak` undefined gives an empty answer, which is how StUF reports "not found".
 */
export function zaakLa01(context: MessageContext, zaak: ZaakDetails | undefined): string {
  const optional = (name: string, value: string | undefined) =>
    value === undefined ? '' : `<zkn:${name}>${escape(value)}</zkn:${name}>`;

  const antwoord = zaak === undefined ? '' : '<zkn:antwoord><zkn:object stuf:entiteittype="ZAK">'
    + `<zkn:identificatie>${escape(zaak.identificatie)}</zkn:identificatie>`
    + optional('omschrijving', zaak.omschrijving)
    + optional('startdatum', zaak.startdatum)
    + optional('registratiedatum', zaak.registratiedatum)
    + optional('einddatum', zaak.einddatum)
    + (zaak.resultaat === undefined ? '' : `<zkn:resultaat>${optional('omschrijving', zaak.resultaat)}</zkn:resultaat>`)
    + (zaak.zaaktype === undefined ? '' : '<zkn:isVan stuf:entiteittype="ZAKZKT"><zkn:gerelateerde stuf:entiteittype="ZKT">'
      + optional('omschrijving', zaak.zaaktype.omschrijving)
      + optional('code', zaak.zaaktype.code)
      + '</zkn:gerelateerde></zkn:isVan>')
    + (zaak.status === undefined ? '' : '<zkn:heeft stuf:entiteittype="ZAKSTT"><zkn:gerelateerde stuf:entiteittype="STT">'
      + optional('volgnummer', zaak.status.volgnummer)
      + optional('omschrijving', zaak.status.omschrijving)
      + '</zkn:gerelateerde>'
      + optional('datumStatusGezet', zaak.status.datumStatusGezet)
      + '</zkn:heeft>')
    + '<stuf:extraElementen>'
    + `<stuf:extraElement naam="corsa_dossierid">${escape(zaak.dossierId)}</stuf:extraElement>`
    + '</stuf:extraElementen>'
    + '</zkn:object></zkn:antwoord>';

  return envelope('<zkn:zakLa01>'
    + stuurgegevens(withCrossRef(context), { berichtcode: 'La01', entiteittype: 'ZAK' }, 'zkn:stuurgegevens')
    + '<zkn:parameters><stuf:indicatorVervolgvraag>false</stuf:indicatorVervolgvraag></zkn:parameters>'
    + antwoord
    + '</zkn:zakLa01>');
}

/**
 * Answer to genereerDocumentIdentificatie. The client reads `zkn:identificatie`.
 */
export function documentIdentificatieDu02(context: MessageContext, identificatie: string): string {
  return envelope('<zkn:genereerDocumentIdentificatie_Du02>'
    + stuurgegevens(context, { berichtcode: 'Du02', functie: 'genereerDocumentidentificatie' }, 'zkn:stuurgegevens')
    + `<zkn:document stuf:entiteittype="EDC"><zkn:identificatie>${escape(identificatie)}</zkn:identificatie></zkn:document>`
    + '</zkn:genereerDocumentIdentificatie_Du02>');
}

export interface Fout {
  code: string;
  plek: 'client' | 'server';
  omschrijving: string;
  details?: string;
}

function fo02Bericht(context: MessageContext, fout: Fout): string {
  return '<stuf:Fo02Bericht>'
    + stuurgegevens(context, { berichtcode: 'Fo02' })
    + '<stuf:body>'
    + `<stuf:code>${escape(fout.code)}</stuf:code>`
    + `<stuf:plek>${fout.plek}</stuf:plek>`
    + `<stuf:omschrijving>${escape(fout.omschrijving)}</stuf:omschrijving>`
    + (fout.details ? `<stuf:details>${escape(fout.details)}</stuf:details>` : '')
    + '</stuf:body>'
    + '</stuf:Fo02Bericht>';
}

/**
 * Fo02 in the default namespace. The client glues prefixes onto tag names and then looks
 * for exactly `Fo02Bericht`, `omschrijving` and `details`, so a prefixed `stuf:Fo02Bericht`
 * in an HTTP 200 response is not recognised as an error at all.
 */
function unprefixedFo02Bericht(fout: Fout): string {
  return '<Fo02Bericht xmlns="http://www.egem.nl/StUF/StUF0301">'
    + '<stuurgegevens><berichtcode>Fo02</berichtcode></stuurgegevens>'
    + '<body>'
    + `<code>${escape(fout.code)}</code>`
    + `<plek>${fout.plek}</plek>`
    + `<omschrijving>${escape(fout.omschrijving)}</omschrijving>`
    + (fout.details ? `<details>${escape(fout.details)}</details>` : '')
    + '</body>'
    + '</Fo02Bericht>';
}

/**
 * A StUF error the standard way: HTTP 500 with the Fo02 message in the SOAP fault detail.
 */
export function soapFault(context: MessageContext, fout: Fout): string {
  return envelope('<soap:Fault>'
    + `<faultcode>soap:${fout.plek === 'client' ? 'Client' : 'Server'}</faultcode>`
    + `<faultstring>${escape(fout.omschrijving)}</faultstring>`
    + `<detail>${fo02Bericht(context, fout)}</detail>`
    + '</soap:Fault>');
}

/**
 * A StUF error in the body of an HTTP 200 response. The client checks for this explicitly.
 */
export function fo02(fout: Fout): string {
  return envelope(unprefixedFo02Bericht(fout));
}

function withCrossRef(context: MessageContext): MessageContext {
  // The client casts crossRefnummer to string, so it must never be missing.
  return context.referentienummer ? context : { ...context, referentienummer: newReferentienummer() };
}

function newReferentienummer(): string {
  return `MOCK-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * StUF tijdstip: yyyyMMddHHmmssSSS.
 */
export function tijdstip(date = new Date()): string {
  return date.toISOString().replace(/\D/g, '').slice(0, 17);
}
