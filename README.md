# corsa-mock

A mock of a Corsa DMS that speaks the **StUF-ZKN 3.10 zaakdocumentservices** ("ZaakDMS") standard. Use it to test a ZaakDMS client end to end, such as the laravel-zaakdms client, without a real Corsa environment.

The mock runs as one AWS Lambda behind an API Gateway REST API that requires a client certificate (mutual TLS). It keeps state in S3, so a zaak you create can be read back, gets statuses and a result, and can have documents attached. It can also inject failures on purpose, so you can test how the client handles errors and retries.

## Contents

- [How it works](#how-it-works)
- [Supported operations](#supported-operations)
- [Deploying](#deploying)
- [Connecting a client](#connecting-a-client)
- [Certificates](#certificates)
- [Configuration](#configuration)
- [Failure injection](#failure-injection)
- [Stored data](#stored-data)
- [Errors returned by the mock](#errors-returned-by-the-mock)
- [Development](#development)

## How it works

```
client ──POST, client certificate──▶ API Gateway ──▶ Lambda ──▶ S3 bucket (state, requests, documents)
          https://corsa-mock.<account zone>/<Endpoint>
```

- API Gateway only accepts client certificates signed by a CA in the trust store. The default `execute-api` endpoint is disabled, so this domain is the only way in.
- The Lambda then checks that the SHA-256 fingerprint of the certificate is on the allowlist of the environment. Any other certificate gets a `403`, on every path.
- The operation is chosen from the last segment of the `SOAPAction` header (for example `.../creeerZaak_Lk01`).
- The last path segment must be the endpoint that belongs to that operation (`OntvangAsynchroon`, `BeantwoordVraag` or `VerwerkSynchroonVrijBericht`).
- Every change is written to S3 as a new object, and nothing is ever read, changed and written back. Concurrent Lambda invocations therefore cannot overwrite each other.
- `GET /health` returns `200 ok`. Any other method than `GET` (for health) or `POST` returns `405`.

## Supported operations

| SOAPAction (last segment)            | Endpoint                      | What the mock does                                                                                                                                              | Answer                                |
| ------------------------------------ | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `creeerZaak_Lk01`                    | `OntvangAsynchroon`           | Stores a new zaak (identificatie, omschrijving, dates, zaaktype, initiator) and assigns a `corsa_dossierid`. Fails if the zaak already exists.                  | `Bv03`                                |
| `geefZaakdetails_Lv01`               | `BeantwoordVraag`             | Returns the zaak with its latest status, latest result and einddatum, plus the `corsa_dossierid` extra element.                                                 | `zakLa01` (empty answer if not found) |
| `actualiseerZaakstatus_Lk01`         | `OntvangAsynchroon`           | Adds a status (volgnummer, omschrijving, datumStatusGezet, gezet door) to an existing zaak.                                                                     | `Bv03`                                |
| `updateZaak_Lk01`                    | `OntvangAsynchroon`           | Stores a result (resultaat omschrijving, einddatum) for an existing zaak. The latest one wins.                                                                  | `Bv03`                                |
| `genereerDocumentIdentificatie_Di02` | `VerwerkSynchroonVrijBericht` | Generates a new document identificatie, `DOCUMENT_ID_PREFIX` followed by a unique suffix.                                                                       | `genereerDocumentIdentificatie_Du02`  |
| `voegZaakdocumentToe_Lk01`           | `OntvangAsynchroon`           | Decodes the base64 `inhoud` and stores the file and its metadata with the zaak. Fails if the zaak does not exist or the document identificatie is already used. | `Bv03`                                |

Any other `SOAPAction` is answered with a SOAP fault (`MOCK-NIET-ONDERSTEUND`) that lists the supported actions.

Some details of the answers are there because the laravel-zaakdms client depends on them:

- Responses use the `soap:` envelope prefix. The client strips colons from tag names and looks up `soapBody`, so other prefixes break it.
- `Bv03` and `zakLa01` always contain a `crossRefnummer`, also when the request had no `referentienummer`.
- `zakLa01` always contains the `corsa_dossierid` extra element.
- Every XML response has an `esbbusinessproces` header with the operation name.

## Deploying

Deployment uses projen and the AWS CDK. A pipeline per environment deploys the branch of that environment. The environment is chosen with the `BRANCH_NAME` environment variable, which selects a configuration in [src/Configuration.ts](src/Configuration.ts):

| `BRANCH_NAME` | Account        | Region       | Document retention |
| ------------- | -------------- | ------------ | ------------------ |
| `development` | `958979025885` | eu-central-1 | 90 days            |
| `acceptance`  | `145023129433` | eu-central-1 | 30 days            |
| `production`  | `692859927138` | eu-central-1 | 1 day              |

Without `BRANCH_NAME`, synth fails with an error that lists the valid names.

Before the first deployment of an environment:

- The account needs the SSM parameters `/gemeente-nijmegen/account/hostedzone/id` and `/gemeente-nijmegen/account/hostedzone/name`, and that hosted zone must be delegated from its parent zone. The ACM certificate cannot be validated without it.
- The trust store `truststore/<environment>.pem` must exist. Without it synth fails. See [Certificates](#certificates).
- The fingerprint of each client certificate must be in `allowedFingerprints`. As long as that is empty, every request is refused.

The pipeline stack itself is deployed by hand once, to the build account. After that it updates itself:

```sh
npm ci
BRANCH_NAME=development npx projen deploy --parameters connectionArn=<arn>
```

The stack creates:

- an S3 bucket for state, private and encrypted, with a lifecycle rule that removes stored documents after the retention period;
- an S3 bucket with the trust store, private, encrypted and versioned;
- the Lambda (Node.js 24, 512 MB, 29 second timeout);
- a regional REST API with a custom domain that requires a client certificate, an ACM certificate and a DNS record;
- CloudWatch log groups, kept for one month.

Its `url` output is the base URL of the mock.

## Connecting a client

A client needs:

- the base URL (`ZAAKDMS_URL` for laravel-zaakdms): `https://corsa-mock.<account zone>/`, the `url` output of the stack. The trailing `/` matters: the client adds the endpoint name directly after the base URL;
- a client certificate and its private key, with the fingerprint on the allowlist;
- the Amazon root CAs, to verify the server certificate. They are in the default trust store of most systems.

```sh
curl --cert client.pem --key client.key https://corsa-mock.<account zone>/health
```

Requests that take longer than 29 seconds get a `504` from API Gateway. A request, including its headers and other event data, can be at most 6 MB.

## Certificates

Each environment has its own private CA. The public CA certificate is in `truststore/<environment>.pem`. Private keys never belong in this repository; synth fails when the trust store contains one, or a certificate that is not a CA.

Create a CA:

```sh
openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 1825 \
  -subj "/CN=corsa-mock <environment> CA" \
  -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
  -addext "keyUsage=critical,keyCertSign,cRLSign" \
  -keyout ca.key -out truststore/<environment>.pem
```

Create a client certificate:

```sh
openssl req -newkey rsa:3072 -nodes -subj "/CN=<client>" -keyout client.key -out client.csr
printf 'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=clientAuth\n' > client.ext
openssl x509 -req -in client.csr -CA truststore/<environment>.pem -CAkey ca.key -CAserial ca.srl -CAcreateserial \
  -days 397 -sha256 -extfile client.ext -out client.pem
```

Keep `ca.key`, `client.key` and the other generated files outside the repository.

Allow the client: add its fingerprint to `allowedFingerprints` in [src/Configuration.ts](src/Configuration.ts) and deploy. Colons and upper case are allowed.

```sh
openssl x509 -in client.pem -noout -fingerprint -sha256
```

- Replace a client certificate: add the new fingerprint, deploy, switch the client, remove the old fingerprint, deploy.
- Revoke a client certificate: remove its fingerprint and deploy. Revocation lists and OCSP are not checked.
- Replace a CA: add the new CA to the PEM file, next to the old one, and deploy. Replace the client certificates as above. Then remove the old CA and deploy.

The name of the trust store object contains a hash of its content, so API Gateway reloads it when the file changes.

## Configuration

The Lambda is configured with environment variables, read in [src/corsa-mock/config.ts](src/corsa-mock/config.ts). The stack sets `MOCK_BUCKET` and `ALLOWED_CERT_FINGERPRINTS`, and the `FAILURE_*` variables from the `failure` setting in [src/Configuration.ts](src/Configuration.ts). All other variables use their defaults unless you add them to `environment` in [src/CorsaMockStack.ts](src/CorsaMockStack.ts) and deploy again, or set them on the Lambda in the AWS console (the next deploy removes those again).

| Variable             | Default                   | Description                                                                                                                 |
| -------------------- | ------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `MOCK_BUCKET`        | (required)                | S3 bucket for all state. Set by the stack. The Lambda refuses to start without it.                                          |
| `MOCK_PREFIX`        | `''`                      | Key prefix inside the bucket, for example `zaakdms-mock/`.                                                                  |
| `ALLOWED_CERT_FINGERPRINTS` | `''` (none) | Comma separated SHA-256 fingerprints of the client certificates that are accepted. Set by the stack from `allowedFingerprints`. |
| `STORE_REQUESTS`     | `true`                    | Store every incoming request under `requests/`, with document content left out. Set to `false` to turn this off.            |
| `DOCUMENT_ID_PREFIX` | `MOCK-DOC-`               | Prefix of identificaties generated by `genereerDocumentIdentificatie`.                                                      |
| `FAILURE_PERCENTAGE` | `0`                       | Share of requests that fail on purpose, `0` to `100`. `0` turns failure injection off.                                      |
| `FAILURE_MODES`      | `soap-fault,fo02,http503` | Comma separated failure modes to choose from. See [Failure injection](#failure-injection).                                  |
| `FAILURE_OPERATIONS` | `''` (all)                | Comma separated operation names that can fail, for example `creeerZaak,voegZaakdocumentToe`. Empty means all operations.    |
| `FAILURE_SEED`       | `''`                      | When set, failures are deterministic instead of random. See [Deterministic failures](#deterministic-failures).              |
| `FAILURE_TIMEOUT_MS` | `25000` | How long the `timeout` mode waits before answering. At most 27000, which the stack checks for its `timeout` setting. |

Invalid values for `ALLOWED_CERT_FINGERPRINTS`, `FAILURE_PERCENTAGE` or `FAILURE_MODES` make the Lambda fail on start, with an error that says what is allowed.

The operation names for `FAILURE_OPERATIONS` are: `geefZaakDetails`, `creeerZaak`, `actualiseerZaakstatus`, `updateZaak`, `genereerDocumentIdentificatie` and `voegZaakdocumentToe`.

Settings in [src/Configuration.ts](src/Configuration.ts), per environment:

| Setting               | Description                                                                    |
| --------------------- | ------------------------------------------------------------------------------ |
| `deployToEnvironment` | AWS account and region to deploy to.                                           |
| `attachmentRetention` | How long stored document files are kept in the bucket before they are removed. |
| `truststorePath` | PEM file with the CAs that sign client certificates. |
| `allowedFingerprints` | SHA-256 fingerprints of the client certificates that are accepted. Empty means none. |
| `failure`             | Optional failure injection settings, see below.                                |

The `failure` setting maps to the `FAILURE_*` variables. Settings that are left out use the defaults from the table above.

| `failure` field | Variable             | Example                                     |
| --------------- | -------------------- | ------------------------------------------- |
| `percentage`    | `FAILURE_PERCENTAGE` | `10`                                        |
| `modes`         | `FAILURE_MODES`      | `['soap-fault', 'timeout']`                 |
| `operations`    | `FAILURE_OPERATIONS` | `['creeerZaak', 'voegZaakdocumentToe']`     |
| `seed`          | `FAILURE_SEED`       | `'run-1'`                                   |
| `timeout`       | `FAILURE_TIMEOUT_MS` | `Duration.seconds(25)`, at most 27 seconds  |

## Failure injection

With `FAILURE_PERCENTAGE` above `0`, that share of requests fails with one of the configured modes:

| Mode            | Response                                                                                                                        | Is the change stored? |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------- |
| `soap-fault`    | HTTP 500 with a SOAP fault holding a Fo02 message (code `MOCK-INJECTED`). This is how StUF normally reports errors.             | No                    |
| `fo02`          | HTTP 200 with a Fo02 message in the SOAP body.                                                                                  | No                    |
| `http503`       | HTTP 503 `Service Unavailable`, plain text.                                                                                     | No                    |
| `timeout`       | Waits `FAILURE_TIMEOUT_MS`, then HTTP 504 `Gateway Timeout`. Use it to test client timeouts, with a client timeout below this wait.                                    | No                    |
| `lost-response` | The operation is carried out, but the client gets HTTP 502 `Bad Gateway`. Use it to test that retries do not create duplicates. | **Yes**               |

`timeout` and `lost-response` are not in the default `FAILURE_MODES`; add them yourself when you need them.

Injected failures are decided after the request is stored (when `STORE_REQUESTS` is on), so failed requests can still be found under `requests/`.

### Deterministic failures

Without `FAILURE_SEED`, every request fails at random.

With `FAILURE_SEED`, whether a request fails, and how, is computed from the seed, the operation, the key (the zaak identificatie) and the attempt number. This means:

- the same zaak gets the same pattern of failures and successes in every test run with the same seed;
- a retry is a new attempt, so it can succeed where the previous attempt failed;
- a different seed gives a different but again repeatable pattern.

Attempts are counted in the bucket under `chaos/attempts/`, one object per attempt. To start counting from zero again, change the seed or remove those objects.

## Stored data

All data is in the state bucket (below `MOCK_PREFIX` when set):

```
zaken/{zaak}/zaak.json                              the zaak, created once by creeerZaak
zaken/{zaak}/statussen/{tijdstip}-{random}.json     one per actualiseerZaakstatus
zaken/{zaak}/resultaat/{tijdstip}-{random}.json     one per updateZaak, the latest wins
zaken/{zaak}/documenten/{document}/metadata.json    document metadata, created once
zaken/{zaak}/documenten/{document}/{bestandsnaam}   the decoded document file
requests/{date}/{tijdstip}-{operation}-{key}.xml    every request, without document content
chaos/attempts/{operation}/{key}/...                attempt counters for deterministic failures
```

Only document files are tagged `type=attachment` and removed after `attachmentRetention`. The rest of the data stays until you remove it.

Every request is also logged to CloudWatch as one JSON line with the operation, endpoint, key, attempt, outcome (`ok`, `injected:<mode>`, `stuf-error:<code>`, `unsupported`, `wrong-endpoint`) and HTTP status. Refused clients are logged with outcome `client-refused`, the reason, and the fingerprint and subject of the certificate when it could be read.

## Errors returned by the mock

Functional errors are answered as HTTP 500 with a SOAP fault holding a Fo02 message:

| Code                     | Cause                                                                                                 |
| ------------------------ | ----------------------------------------------------------------------------------------------------- |
| `MOCK-NIET-ONDERSTEUND`  | The `SOAPAction` is not one of the supported operations.                                              |
| `MOCK-VERKEERD-ENDPOINT` | The request was sent to the wrong endpoint for this operation (often a missing `/` in `ZAAKDMS_URL`). |
| `MOCK-ONGELDIG`          | A required element is missing or empty. `details` names the element.                                  |
| `MOCK-NIET-GEVONDEN`     | The zaak does not exist (status, update or document for an unknown zaak).                             |
| `MOCK-BESTAAT-AL`        | The zaak or document identificatie already exists.                                                    |
| `MOCK-INJECTED`          | A failure injected on purpose.                                                                        |
| `MOCK-INTERN`            | An unexpected error in the mock itself. Check the CloudWatch logs.                                    |

## Development

This is a [projen](https://projen.io) project. Change [.projenrc.ts](.projenrc.ts) instead of the generated files, then run `npx projen`.

```sh
npx projen build    # compile, test, lint and synth
npx projen test     # jest and eslint
BRANCH_NAME=development npx projen synth   # synth only
BRANCH_NAME=development npx projen diff    # compare with the deployed pipeline stack
npx projen bundle   # needed before running the tests on their own
```

| File                                                         | Contents                                              |
| ------------------------------------------------------------ | ----------------------------------------------------- |
| [src/Configuration.ts](src/Configuration.ts)                 | Environment configurations                            |
| [src/PipelineStack.ts](src/PipelineStack.ts)                 | Pipeline that deploys an environment                  |
| [src/CorsaMockStack.ts](src/CorsaMockStack.ts)               | Bucket and Lambda                                     |
| [src/MtlsApi.ts](src/MtlsApi.ts)                             | REST API, mTLS domain and trust store                 |
| [src/corsa-mock/handler.ts](src/corsa-mock/handler.ts)       | Client check, routing, failure injection and logging |
| [src/corsa-mock/operations.ts](src/corsa-mock/operations.ts) | The supported operations and how they store data      |
| [src/corsa-mock/soap.ts](src/corsa-mock/soap.ts)             | SOAP/StUF response messages                           |
| [src/corsa-mock/chaos.ts](src/corsa-mock/chaos.ts)           | Random and deterministic failure decisions            |
| [src/corsa-mock/clientCertificate.ts](src/corsa-mock/clientCertificate.ts) | Client certificate fingerprints |
| [src/corsa-mock/config.ts](src/corsa-mock/config.ts)         | Environment variables                                 |
| [src/corsa-mock/store.ts](src/corsa-mock/store.ts)           | S3 store, and an in-memory store for tests            |
| [src/corsa-mock/xml.ts](src/corsa-mock/xml.ts)               | Minimal XML helpers for the messages the client sends |
