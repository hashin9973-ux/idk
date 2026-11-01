'use strict';

(function attachAgentTerminal(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.AgentTerminal = api;
})(typeof globalThis === 'object' ? globalThis : this, function createAgentTerminal() {
  const SECRET_KEY = /(?:token|secret|password|authorization|api[_-]?key|private[_-]?key)/i;

  function parseRecord(value) {
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    if (typeof value !== 'string' || !value.trim()) return null;
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch { return null; }
  }

  function quote(value) {
    const raw = typeof value === 'string' ? value : JSON.stringify(value);
    return "'" + String(raw).replace(/'/g, "'\\''") + "'";
  }

  function flagName(key) {
    return String(key).replace(/([a-z0-9])([A-Z])/g, '$1-$2').replace(/_/g, '-').toLowerCase();
  }

  function redactValue(value) {
    if (Array.isArray(value)) return value.map(item => redactValue(item));
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, SECRET_KEY.test(key) ? '[redacted]' : redactValue(nested)]));
  }

  function safeArgument(key, value) {
    if (SECRET_KEY.test(key)) return '--' + flagName(key) + ' [redacted]';
    if (typeof value === 'boolean') return value ? '--' + flagName(key) : '--no-' + flagName(key);
    if (value === null) return '--' + flagName(key) + ' null';
    const safe = redactValue(value);
    const rendered = typeof safe === 'string' ? safe : JSON.stringify(safe);
    return '--' + flagName(key) + ' ' + quote(rendered);
  }

  function formatSingle(tool, args) {
    const name = String(tool || 'unknown_tool').replace(/[^a-zA-Z0-9_.:-]/g, '_');
    const values = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
    if (['shell', 'run_command', 'powershell'].includes(name) &&
        typeof (values.command || values.script || values.cmd) === 'string') {
      const command = String(values.command || values.script || values.cmd).trim();
      return command.split(/\r?\n/).filter(Boolean).map(line => '$ ' + line).join('\n') || '$ ' + name;
    }
    const argsText = Object.entries(values).map(([key, value]) => safeArgument(key, value)).join(' ');
    return '$ ' + name + (argsText ? ' ' + argsText : '');
  }


  function formatSlashValue(value) {
    if (value === null) return 'null';
    if (typeof value === 'boolean' || typeof value === 'number') return String(value);
    if (typeof value === 'string') {
      return /[\s,;=\[\]"']/.test(value) ? JSON.stringify(value) : value;
    }
    if (Array.isArray(value)) return '[' + value.map(formatSlashValue).join(', ') + ']';
    return '[structured value]';
  }

  function formatSlashCommand(tool, args) {
    const name = String(tool || 'unknown_tool').replace(/[^a-zA-Z0-9_.:-]/g, '_');
    const values = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
    if (name === 'batch' && Array.isArray(values.steps)) {
      const steps = values.steps.map(step => formatSlashCommand(step && step.tool, step && step.args)).map(command => command.replace(/^\//, ''));
      const options = Object.entries(values).filter(([key]) => key !== 'steps')
        .map(([key, value]) => key + '=' + formatSlashValue(value));
      return '/' + name + (steps.length ? ' steps=' + JSON.stringify(steps.join('; ')) : '') +
        (options.length ? ' ' + options.join(' ') : '');
    }
    const argsText = Object.entries(values).filter(([key]) => !SECRET_KEY.test(key))
      .map(([key, value]) => key + '=' + formatSlashValue(redactValue(value))).join(' ');
    return '/' + name + (argsText ? ' ' + argsText : '');
  }

  function formatRequestCommands(requestJson, fallbackTool) {
    const envelope = parseRecord(requestJson);
    if (!envelope) return formatSingle(fallbackTool, {});
    const tool = envelope.tool || fallbackTool || 'unknown_tool';
    const args = envelope.args && typeof envelope.args === 'object' ? envelope.args : {};
    if (tool === 'batch' && Array.isArray(args.steps)) {
      const lines = [];
      for (const [index, step] of args.steps.entries()) {
        if (!step || typeof step !== 'object') continue;
        lines.push('# ' + String(step.id || 'step-' + (index + 1)).replace(/[\r\n]/g, ' '));
        lines.push(formatSingle(step.tool, step.args));
      }
      return lines.join('\n') || '$ batch';
    }
    return formatSingle(tool, args);
  }

  function formatResultOutput(resultJson, status, error) {
    const record = parseRecord(resultJson);
    if (!record) return error ? '! ' + String(error).replace(/[\r\n]+/g, ' ') : '# ' + String(status || 'pending');
    const nested = record.result && typeof record.result === 'object' ? record.result : record;
    const state = String(record.status || nested.status || status || 'pending');
    const lines = ['# ' + state];
    const message = error || record.error || nested.error || nested.message;
    if (message) lines.push('! ' + String(message).replace(/[\r\n]+/g, ' '));
    const output = nested.output && typeof nested.output === 'object' ? nested.output : nested;
    for (const key of ['stdout', 'stderr', 'output']) {
      if (typeof output[key] === 'string' && output[key].trim()) {
        const prefix = key === 'stderr' ? '! ' : '';
        lines.push(...output[key].trimEnd().split(/\r?\n/).map(line => prefix + line));
      }
    }
    return lines.join('\n');
  }

  return { parseRecord, formatRequestCommands, formatSlashCommand, formatResultOutput };
});
