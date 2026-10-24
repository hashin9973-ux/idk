'use strict';

const { TOOL_NAMES } = require('./command-protocol');

const REQUEST_PROTOCOL = 'chatgpt-windows-bridge/request-v1';
const RESULT_PROTOCOL = 'chatgpt-windows-bridge/result-v1';
const REQUEST_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const OWNER_OR_REPO_PATTERN = /^[A-Za-z0-9_.-]{1,100}$/;
const BRANCH_PATTERN = /^[A-Za-z0-9._/-]{1,120}$/;

function validateRepositoryName(value) {
  if (typeof value !== 'string') throw new Error('Enter the bridge repository as owner/repository.');
  const repository = value.trim();
  const parts = repository.split('/');
  if (parts.length !== 2 || parts.some(part => !OWNER_OR_REPO_PATTERN.test(part) || part === '.' || part === '..')) {
    throw new Error('Repository must be owner/repository and may contain only GitHub repository-name characters.');
  }
  return repository;
}

function validateBranchName(value) {
  const branch = String(value || 'main').trim();
  if (!BRANCH_PATTERN.test(branch) || branch.startsWith('/') || branch.endsWith('/') ||
      branch.includes('//') || branch.includes('..') || branch.includes('@{') ||
      /[~^:?*\\[\]\\\\\s]/.test(branch) || branch.split('/').some(segment =>
        !segment || segment.startsWith('.') || segment.endsWith('.lock'))) {
    throw new Error('Enter a valid Git branch name.');
  }
  return branch;
}

function parseRepositoryToolRequest(raw, expectedId) {
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 1024 * 1024) {
    throw new Error('Repository bridge request must be UTF-8 text under 1 MiB.');
  }
  let value;
  try { value = JSON.parse(raw); } catch { throw new Error('Repository bridge request is not valid JSON.'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Repository bridge request must be a JSON object.');
  }
  const extra = Object.keys(value).filter(key =>
    !['protocol', 'call_id', 'tool', 'args', 'created_at', 'description'].includes(key));
  if (extra.length) throw new Error('Unsupported request fields: ' + extra.join(', '));
  if (value.protocol !== REQUEST_PROTOCOL) throw new Error('Unsupported repository bridge request protocol.');
  if (typeof value.call_id !== 'string' || !REQUEST_ID_PATTERN.test(value.call_id)) {
    throw new Error('call_id must match the request filename and use only letters, numbers, dot, underscore or hyphen.');
  }
  if (value.call_id !== expectedId) throw new Error('call_id does not match the request filename.');
  if (typeof value.tool !== 'string' || !TOOL_NAMES.has(value.tool)) {
    throw new Error('Unknown local development tool: ' + String(value.tool || '(missing)'));
  }
  if (value.args !== undefined && (!value.args || typeof value.args !== 'object' || Array.isArray(value.args))) {
    throw new Error('args must be a JSON object.');
  }
  if (value.created_at !== undefined && (typeof value.created_at !== 'string' || value.created_at.length > 80)) {
    throw new Error('created_at must be a short timestamp string.');
  }
  if (value.description !== undefined && (typeof value.description !== 'string' || value.description.length > 500)) {
    throw new Error('description must be a string no longer than 500 characters.');
  }
  return {
    protocol: REQUEST_PROTOCOL,
    callId: value.call_id,
    tool: value.tool,
    args: value.args || {},
    created_at: value.created_at || null,
    description: value.description || ''
  };
}

function buildRepositoryRequest({ callId, tool, args = {}, description = '' }) {
  if (typeof callId !== 'string' || !REQUEST_ID_PATTERN.test(callId)) {
    throw new Error('callId must be a short safe request ID.');
  }
  if (typeof tool !== 'string' || !TOOL_NAMES.has(tool)) throw new Error('Unknown local development tool.');
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('args must be an object.');
  if (typeof description !== 'string' || description.length > 500) throw new Error('description must be under 500 characters.');
  return {
    protocol: REQUEST_PROTOCOL,
    call_id: callId,
    tool,
    args,
    description,
    created_at: new Date().toISOString()
  };
}

module.exports = {
  REQUEST_PROTOCOL,
  RESULT_PROTOCOL,
  REQUEST_ID_PATTERN,
  validateRepositoryName,
  validateBranchName,
  parseRepositoryToolRequest,
  buildRepositoryRequest
};
