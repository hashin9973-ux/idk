'use strict';

const CORE_TOOLS = Object.freeze([
  'exec_command', 'read_file', 'apply_patch', 'write_file', 'list_dir', 'directory_tree',
  'glob_file_search', 'search', 'run_tests', 'batch', 'project_status', 'git_status', 'git_diff'
]);

function inlineCode(value) {
  const marker = String.fromCharCode(96);
  return marker + String(value).replace(/[\r\n]/g, '').split(marker).join('') + marker;
}

function renderToolCatalogMarkdown(capabilityData) {
  const catalog = capabilityData && typeof capabilityData === 'object' ? capabilityData : {};
  const sourceTools = Array.isArray(catalog.tools) ? catalog.tools : [];
  const tools = new Map(sourceTools.filter(item => item && typeof item.name === 'string').map(item => [item.name, item]));
  const renderEntry = (name, maxDescriptionLength) => {
    const item = tools.get(name);
    if (!item) return null;
    const properties = item.parameters && item.parameters.properties || {};
    const required = new Set(item.parameters && item.parameters.required || []);
    const args = Object.keys(properties).map(key => required.has(key) ? key + '*' : key);
    let description = String(item.description || '').replace(/\s+/g, ' ').trim();
    if (description.length > maxDescriptionLength) description = description.slice(0, maxDescriptionLength - 3) + '...';
    return '- ' + inlineCode(name) + (args.length ? ' (' + args.join(', ') + ')' : '') +
      ' — ' + description + ' [' + String(item.mode || 'unknown') + ']';
  };

  const sections = [];
  const core = CORE_TOOLS.filter(name => tools.has(name));
  sections.push('## Core coding tools\n\n' +
    (core.map(name => renderEntry(name, 240)).filter(Boolean).join('\n') || '_No core tools are published._'));
  const groups = [
    ['Project and code intelligence', name => name.startsWith('project_') || name === 'game_project_intelligence'],
    ['Git and worktrees', name => name.startsWith('git_')],
    ['Agent collaboration', name => name.startsWith('task_') ||
      ['session_start', 'agent_status', 'send_agent_message', 'read_agent_messages', 'reply_to_agent_message'].includes(name)],
    ['Desktop, vision and audio', name => ['computer', 'tts'].includes(name)],
    ['Other utilities', name => !CORE_TOOLS.includes(name) && !name.startsWith('project_') &&
      !name.startsWith('git_') && !name.startsWith('task_') &&
      !['session_start', 'agent_status', 'send_agent_message', 'read_agent_messages', 'reply_to_agent_message', 'computer', 'tts'].includes(name)]
  ];
  for (const [title, predicate] of groups) {
    const names = [...tools.keys()].filter(predicate).sort();
    if (names.length) sections.push('## ' + title + '\n\n' + names.map(name => renderEntry(name, 140)).filter(Boolean).join('\n'));
  }

  return [
    '# Windows Bridge tools',
    '',
    '> Generated from the live Windows worker catalog. This is the compact coding guide, not a second schema definition.',
    '',
    '- Catalog version: ' + String(catalog.catalog_version || 1),
    '- Published tools: ' + tools.size,
    '',
    '## Any programming language',
    '',
    '**exec_command** is the general command tool. Windows PowerShell is only the host shell: invoke any interpreter, compiler, package manager, build system, test runner, or executable already installed on Windows. Examples include **python**, **node**, **cargo**, **go**, **javac**, **dotnet**, **cmake**, and engine command-line tools. Availability depends on installed toolchains and PATH. Project detection does not install runtimes.',
    '',
    'Commands run from the selected workspace and keep the normal local approval and Windows-user permission model. **shell** remains a backward-compatible alias.',
    '',
    '## Typical coding loop',
    '',
    '1. Use **project_status** to identify project roots, languages, and detected toolchains.',
    '2. Use **list_dir**, **directory_tree**, **glob_file_search**, and **search** to navigate; use **read_file** to inspect source in pages.',
    '3. Make focused edits with **apply_patch** or create/replace files with **write_file**.',
    '4. Run the project-native build or test command with **exec_command**; use **run_tests** where automatic detection applies.',
    '5. Check **git_diff** and actual exit code, timeout, stdout/stderr, and truncation fields.',
    '6. Use **batch** for independent operations. Preserve dependencies and shared-file ordering.',
    '',
    ...sections,
    '',
    '## Schemas and transport',
    '',
    'Use **bridge/context/capabilities.json** for exact argument schemas, required fields, bounds, permission modes, and result contracts. Requests and results remain validated JSON protocol records; Markdown is the readable tool guide.',
    ''
  ].join('\n');
}

module.exports = { CORE_TOOLS, renderToolCatalogMarkdown };
