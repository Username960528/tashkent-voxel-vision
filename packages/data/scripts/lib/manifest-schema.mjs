import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const MANIFEST_SCHEMA_URL = new URL('../../schemas/data-release-manifest.schema.json', import.meta.url);
export const MANIFEST_SCHEMA_PATH = fileURLToPath(MANIFEST_SCHEMA_URL);

let cachedSchema;
let cachedValidator;

export async function loadManifestSchema() {
  if (cachedSchema) return cachedSchema;
  const raw = await fs.readFile(MANIFEST_SCHEMA_PATH, 'utf8');
  cachedSchema = JSON.parse(raw);
  return cachedSchema;
}

function ajvErrorsToPretty(errors) {
  /** @type {{path: string, message: string}[]} */
  const out = [];
  for (const err of errors ?? []) {
    const basePath = err.instancePath ? `$${err.instancePath.replaceAll('/', '.')}` : '$';

    if (err.keyword === 'required' && err.params?.missingProperty) {
      out.push({ path: `${basePath}.${err.params.missingProperty}`, message: err.message ?? 'Missing property' });
      continue;
    }
    if (err.keyword === 'additionalProperties' && err.params?.additionalProperty) {
      out.push({ path: `${basePath}.${err.params.additionalProperty}`, message: err.message ?? 'Unknown property' });
      continue;
    }

    out.push({ path: basePath, message: err.message ?? 'Schema validation error' });
  }
  return out;
}

export async function getManifestValidator() {
  if (cachedValidator) return cachedValidator;

  const schema = await loadManifestSchema();
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
  });
  addFormats(ajv);

  cachedValidator = ajv.compile(schema);
  return cachedValidator;
}

export async function validateManifest(manifest) {
  const validate = await getManifestValidator();
  const ok = validate(manifest);
  return {
    valid: Boolean(ok),
    errors: ok ? [] : ajvErrorsToPretty(validate.errors),
  };
}
