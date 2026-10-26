import { setTimeout as sleep } from 'node:timers/promises';
import { Chaos } from './chaos';
import { Config, FailureMode } from './config';
import { OPERATIONS, StufError, ZaakdmsMock, uniqueName } from './operations';
import * as soap from './soap';
import { MessageContext } from './soap';
import { ObjectStore } from './store';
import { replaceContent } from './xml';

/**
 * The parts of a Lambda Function URL / API Gateway HTTP API (payload 2.0) event this mock
 * uses. API Gateway REST API (payload 1.0) events also work through `path`/`httpMethod`.
 */
export interface HttpEvent {
  rawPath?: string;
  path?: string;
  httpMethod?: string;
  requestContext?: { http?: { method?: string } };
  headers?: Record<string, string | undefined>;
  body?: string | null;
  isBase64Encoded?: boolean;
}

export interface HttpResult {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export interface Dependencies {
  wait?: (ms: number) => Promise<unknown>;
  random?: () => number;
}

export function createHandler(config: Config, store: ObjectStore, dependencies: Dependencies = {}) {
  const mock = new ZaakdmsMock(store, config);
  const chaos = new Chaos(config.failure, store, dependencies.random);
  const wait = dependencies.wait ?? sleep;

  return async (event: HttpEvent): Promise<HttpResult> => {
    const method = (event.requestContext?.http?.method ?? event.httpMethod ?? 'GET').toUpperCase();
    let path = event.rawPath ?? event.path ?? '/';

    if (config.pathSecret) {
      if (!path.startsWith(`/${config.pathSecret}/`)) {
        return plain(404, 'Not Found');
      }
      path = path.slice(config.pathSecret.length + 1);
    }
    if (method === 'GET' && path.replace(/\/+$/, '').endsWith('/health')) {
      return plain(200, 'ok');
    }
    if (method !== 'POST') {
      return plain(405, 'Method Not Allowed');
    }

    const headers = lowerCaseKeys(event.headers);
    const xml = event.isBase64Encoded ? Buffer.from(event.body ?? '', 'base64').toString('utf8') : event.body ?? '';
    const soapAction = (headers.soapaction ?? '').replace(/^"|"$/g, '');
    const action = soapAction.slice(soapAction.lastIndexOf('/') + 1);
    const operation = OPERATIONS[action];
    const context = soap.messageContext(xml);
    const endpoint = path.slice(path.lastIndexOf('/') + 1);
    const log = { operation: operation?.name ?? action, endpoint, key: '', attempt: undefined as number | undefined };

    try {
      if (!operation) {
        return finish(log, 'unsupported', xmlResponse(500, action, soap.soapFault(context, {
          code: 'MOCK-NIET-ONDERSTEUND',
          plek: 'client',
          omschrijving: `SOAPAction "${soapAction}" wordt niet ondersteund door de mock`,
          details: `Ondersteund: ${Object.keys(OPERATIONS).join(', ')}`,
        })));
      }
      if (endpoint !== operation.endpoint) {
        return finish(log, 'wrong-endpoint', xmlResponse(500, operation.name, soap.soapFault(context, {
          code: 'MOCK-VERKEERD-ENDPOINT',
          plek: 'client',
          omschrijving: `${operation.name} hoort bij endpoint ${operation.endpoint}, niet bij "${endpoint}"`,
          details: 'Controleer of ZAAKDMS_URL eindigt op een /',
        })));
      }

      log.key = operation.key(xml);
      if (config.storeRequests) {
        await storeRequest(store, operation.name, log.key, xml);
      }

      const decision = await chaos.decide(operation.name, log.key);
      log.attempt = decision.attempt;
      if (decision.mode && decision.mode !== 'lost-response') {
        return finish(log, `injected:${decision.mode}`, await injectedFailure(decision.mode, operation.name, context, config, wait));
      }

      let response: HttpResult;
      try {
        response = xmlResponse(200, operation.name, await operation.handle(mock, xml, context));
      } catch (error) {
        if (!(error instanceof StufError)) {
          throw error;
        }
        return finish(log, `stuf-error:${error.fout.code}`, xmlResponse(500, operation.name, soap.soapFault(context, error.fout)));
      }

      if (decision.mode === 'lost-response') {
        // The change is stored, but the client never hears about it.
        return finish(log, 'injected:lost-response', plain(502, 'Bad Gateway'));
      }
      return finish(log, 'ok', response);
    } catch (error) {
      console.error(JSON.stringify({ ...log, outcome: 'mock-error', error: String(error) }));
      return xmlResponse(500, log.operation, soap.soapFault(context, {
        code: 'MOCK-INTERN',
        plek: 'server',
        omschrijving: 'Interne fout in de mock',
        details: String(error),
      }));
    }
  };
}

async function injectedFailure(
  mode: Exclude<FailureMode, 'lost-response'>,
  operation: string,
  context: MessageContext,
  config: Config,
  wait: (ms: number) => Promise<unknown>,
): Promise<HttpResult> {
  const fout: soap.Fout = {
    code: 'MOCK-INJECTED',
    plek: 'server',
    omschrijving: 'Gesimuleerde storing',
    details: `Door de mock geïnjecteerde fout (${mode})`,
  };
  switch (mode) {
    case 'soap-fault':
      return xmlResponse(500, operation, soap.soapFault(context, fout));
    case 'fo02':
      return xmlResponse(200, operation, soap.fo02(fout));
    case 'http503':
      return plain(503, 'Service Unavailable');
    case 'timeout':
      await wait(config.failure.timeoutMs);
      return plain(504, 'Gateway Timeout');
  }
}

async function storeRequest(store: ObjectStore, operation: string, key: string, xml: string): Promise<void> {
  const name = `${uniqueName()}-${operation}-${encodeURIComponent(key || '_')}.xml`;
  const withoutDocument = replaceContent(xml, 'inhoud', '[document content not stored here, see zaken/]');
  await store.put(`requests/${name.slice(0, 10)}/${name}`, withoutDocument, { contentType: 'text/xml' });
}

function finish(log: object, outcome: string, response: HttpResult): HttpResult {
  console.log(JSON.stringify({ ...log, outcome, status: response.statusCode }));
  return response;
}

function xmlResponse(statusCode: number, operation: string, body: string): HttpResult {
  return {
    statusCode,
    // The client reads esbbusinessproces when it reports a Fo02 error and breaks without it.
    headers: { 'content-type': 'text/xml; charset=utf-8', 'esbbusinessproces': operation },
    body,
  };
}

function plain(statusCode: number, body: string): HttpResult {
  return { statusCode, headers: { 'content-type': 'text/plain; charset=utf-8' }, body };
}

function lowerCaseKeys(headers: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
}
