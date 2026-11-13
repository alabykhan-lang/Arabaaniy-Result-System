'use strict';

// Versioned boundary contract for every AI adapter.
//
// Adapters never hand raw text to the pipeline. They return one of three
// versioned shapes below, and this module validates it. Non-conforming output
// is rejected as a failure; it is never coerced into something usable.
//
// Contract files for non-JavaScript workers live in ops-contract/v1/.

const CONTRACT_VERSION = '1.0.0';
const COMPONENTS = new Set(['ca1', 'ca2', 'ca3', 'exam']);
const INTENTS = new Set(['roster', 'scores', 'documents', 'unknown']);

class ContractError extends Error {
  constructor(code, detail) {
    super(code);
    this.name = 'ContractError';
    this.code = code;
    this.detail = detail || null;
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function checkVersion(value, path) {
  if (value.schema_version !== CONTRACT_VERSION) {
    throw new ContractError('OPS_CONTRACT_VERSION_MISMATCH', `${path}.schema_version must be ${CONTRACT_VERSION}`);
  }
}

function confidence(value, path) {
  if (value == null) return;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new ContractError('OPS_CONTRACT_INVALID', `${path} must be a number between 0 and 1`);
  }
}

function validatePark(value) {
  checkVersion(value, 'outcome');
  if (value.outcome !== 'park') throw new ContractError('OPS_CONTRACT_INVALID', 'outcome.park expected');
  if (typeof value.reason !== 'string' || !value.reason.trim()) {
    throw new ContractError('OPS_CONTRACT_INVALID', 'outcome.reason is required');
  }
  return value;
}

function validateIntent(value) {
  checkVersion(value, 'intent');
  if (!INTENTS.has(value.intent)) throw new ContractError('OPS_CONTRACT_INVALID', 'intent is not a known intent');
  confidence(value.confidence, 'intent.confidence');
  return value;
}

function validateStagedRows(value) {
  checkVersion(value, 'staged_rows');
  if (!Array.isArray(value.rows)) throw new ContractError('OPS_CONTRACT_INVALID', 'staged_rows.rows must be an array');
  if (value.rows.length > 5000) throw new ContractError('OPS_CONTRACT_INVALID', 'staged_rows.rows is too large');

  value.rows.forEach((row, index) => {
    const path = `staged_rows.rows[${index}]`;
    if (!isObject(row)) throw new ContractError('OPS_CONTRACT_INVALID', `${path} must be an object`);
    if (row.row_no != null && (!Number.isInteger(row.row_no) || row.row_no < 1)) {
      throw new ContractError('OPS_CONTRACT_INVALID', `${path}.row_no must be a positive integer`);
    }
    if (row.component != null && !COMPONENTS.has(row.component)) {
      throw new ContractError('OPS_CONTRACT_INVALID', `${path}.component must be ca1, ca2, ca3 or exam`);
    }
    if (row.value != null && (typeof row.value !== 'number' || !Number.isFinite(row.value) || row.value < 0 || row.value > 100)) {
      throw new ContractError('OPS_CONTRACT_INVALID', `${path}.value must be between 0 and 100`);
    }
    for (const field of ['admno', 'candidate_admno', 'name_raw', 'subject_label', 'flag', 'evidence']) {
      if (row[field] != null && typeof row[field] !== 'string') {
        throw new ContractError('OPS_CONTRACT_INVALID', `${path}.${field} must be a string`);
      }
      if (typeof row[field] === 'string' && row[field].length > 300) {
        throw new ContractError('OPS_CONTRACT_INVALID', `${path}.${field} is too long`);
      }
    }
    confidence(row.confidence, `${path}.confidence`);
    if (row.subject_key != null && !/^[a-z0-9._-]+:[a-z0-9._-]+$/i.test(String(row.subject_key))) {
      throw new ContractError('OPS_CONTRACT_INVALID', `${path}.subject_key must look like class:subject`);
    }
  });

  if (value.warnings != null && !Array.isArray(value.warnings)) {
    throw new ContractError('OPS_CONTRACT_INVALID', 'staged_rows.warnings must be an array');
  }
  return value;
}

// Accepts any contract shape and validates it. Returns the shape name.
function validateOutcome(value) {
  if (!isObject(value)) throw new ContractError('OPS_CONTRACT_INVALID', 'outcome must be an object');
  if (value.outcome === 'park') {
    validatePark(value);
    return 'park';
  }
  if (value.intent !== undefined) {
    validateIntent(value);
    return 'intent';
  }
  if (value.rows !== undefined) {
    validateStagedRows(value);
    return 'staged_rows';
  }
  throw new ContractError('OPS_CONTRACT_INVALID', 'unknown outcome shape');
}

module.exports = {
  CONTRACT_VERSION,
  COMPONENTS,
  ContractError,
  validateOutcome,
  validateIntent,
  validateStagedRows,
  validatePark,
};
