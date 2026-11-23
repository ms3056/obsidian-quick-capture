const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

const notices = [];
const commands = [];
const postProcessors = [];
class Plugin {
  constructor(app) { this.app = app; }
  addCommand(c) { commands.push(c); }
  addSettingTab() {}
  registerMarkdownPostProcessor(cb, order) { postProcessors.push({ cb, order }); }
  registerGlobalShortcut() {}
  async loadData() { return {}; }
  async saveData() {}
}
class PluginSettingTab { constructor() {} }
class Modal { constructor() {} }
class Setting { constructor() {} }
class MarkdownView {}
class TFile { constructor(path) { this.path = path; this.extension = 'md'; } }
class MarkdownRenderChild { constructor(el) { this.el = el; } register(cb) { this._cleanup = cb; } }
const moment = () => ({ format: () => '2026-11-23' });
const obsidianStub = {
  Plugin, PluginSettingTab, Modal, Setting, MarkdownView, TFile, MarkdownRenderChild,
  Notice: class { constructor(msg) { notices.push(msg); } },
  normalizePath: (p) => p,
  setIcon: (el, name) => { el.icon = name; },
  getIcon: (name) => ({ outerHTML: '<svg data-icon="' + name + '"></svg>' }),
  moment
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === 'obsidian') return obsidianStub;
  return originalLoad.apply(this, arguments);
};
global.window = { require: () => undefined };
const loaded = require('../main.js');
Module._load = originalLoad;
const QuickCapturePlugin = loaded.default || loaded;

function makePlugin() {
  commands.length = 0;
  const file = new TFile('Master Task List.md');
  let content = '- [ ] 🔺 Buy milk #task 📅 2026-11-30\n';
  const app = {
    workspace: { onLayoutReady: () => {}, getActiveFile: () => null },
    fileManager: {},
    vault: {
      getAbstractFileByPath: (path) => (path === 'Tasks.md' ? new TFile('Tasks.md') : file),
      getMarkdownFiles: () => [file],
      cachedRead: async () => content,
      process: async (_f, cb) => { content = cb(content); }
    },
    plugins: { plugins: {} },
    metadataCache: {
      getFileCache: (f) => ({ frontmatter: { cssclasses: f.path === 'Tasks.md' ? ['tasklist'] : [] } })
    }
  };
  return { plugin: new QuickCapturePlugin(app, {}), file, getContent: () => content };
}

test('edit command is available only on task lines in Markdown views', async () => {
  const { plugin } = makePlugin();
  await plugin.onload();
  const cmd = commands.find((c) => c.id === 'quick-capture-edit-task');
  assert.ok(cmd, 'command registered');
  const editor = { getCursor: () => ({ line: 0 }), getLine: () => '- [ ] task #task' };
  const ctx = new MarkdownView(); ctx.file = new TFile('x.md');
  assert.equal(cmd.editorCheckCallback(true, editor, ctx), true);
  assert.equal(cmd.editorCheckCallback(true, { ...editor, getLine: () => '- not a task' }, ctx), false);
  assert.equal(cmd.editorCheckCallback(true, editor, {}), false);
});

test('executing the command opens task destination with parsed prefill', async () => {
  const { plugin } = makePlugin();
  await plugin.onload();
  const cmd = commands.find((c) => c.id === 'quick-capture-edit-task');
  const line = '- [ ] 🔺 Buy milk | oat #task 📅 2026-11-30';
  const editor = { getCursor: () => ({ line: 0 }), getLine: () => line };
  const ctx = new MarkdownView(); ctx.file = new TFile('Master Task List.md');
  let opened;
  plugin.triggerGlobalQuickCapture = async (dest, edit) => { opened = { dest, edit }; };
  cmd.editorCheckCallback(false, editor, ctx);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(opened.dest, 'task');
  assert.equal(opened.edit.text, 'Buy milk | oat #task');
  assert.equal(opened.edit.priority, 'highest');
  assert.equal(opened.edit.due, '2026-11-30');
});

test('capture in edit mode replaces the source line instead of appending', async () => {
  const { plugin, getContent } = makePlugin();
  await plugin.onload();
  const originalLine = '- [ ] 🔺 Buy milk #task 📅 2026-11-30';
  plugin.pendingEdit = {
    path: 'Master Task List.md', line: 0, originalLine,
    prefix: '- [ ]', text: 'Buy milk #task', priorityEmoji: '🔺', priority: 'highest',
    start: '', scheduled: '', created: '', due: '2026-11-30', preserved: []
  };
  await plugin.executeCapturePayload({
    destination: 'task',
    rawText: 'Buy milk | oat milk #task',
    taskPriority: 'highest',
    taskDueDate: '2026-11-30',
    edit: { path: 'Master Task List.md', line: 0, originalLine, priorityEmoji: '🔺' }
  });
  assert.equal(getContent(), '- [ ] 🔺 Buy milk | oat milk #task 📅 2026-11-30\n');
  assert.equal(plugin.pendingEdit, null);
  assert.ok(notices.includes('Task updated'));
});


test('edit button gating and Tasks cache resolution', async () => {
  const { plugin } = makePlugin();
  await plugin.onload();
  assert.equal(plugin.isTasklistNote('Tasks.md'), true);
  assert.equal(plugin.isTasklistNote('Master Task List.md'), false);
  plugin.app.plugins.plugins['obsidian-tasks-plugin'] = {
    getTasks: () => [{
      path: 'Master Task List.md',
      taskLocation: { path: 'Master Task List.md', lineNumber: 0 },
      originalLine: '- [ ] Buy milk #task 📅 2026-11-23',
      originalMarkdown: '- [ ] Buy milk #task 📅 2026-11-23',
      description: 'Buy milk #task',
      status: { symbol: ' ' },
      priority: '3',
      due: moment('2026-11-23')
    }]
  };
  const candidates = await plugin.getTaskCandidates('Tasks.md');
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].dueBucket, 'today');
  assert.equal(candidates[0].priority, 'normal');
});

test('injects one edit button in its own row-1 slot in tasklist notes only', async () => {
  const { plugin } = makePlugin();
  await plugin.onload();
  let clicked = false;
  plugin.openTaskEditorFromRenderedItem = async () => { clicked = true; };
  const makeNode = () => ({
    className: '', title: '', icon: '', children: [], listeners: {},
    appendChild(n) { this.children.push(n); },
    addEventListener(ev, cb) { this.listeners[ev] = cb; },
    setAttribute(k, v) { this[k] = v; }
  });
  const li = {
    children: [],
    querySelector(sel) {
      if (sel === '.qc-edit-btn') return this.children[0]?.children[0] ?? null;
      if (sel.includes('qc-action-slot')) return this.children[0] ?? null;
      return null;
    },
    appendChild(n) { this.children.push(n); }
  };
  const root = { querySelectorAll: () => [li] };
  const originalDocument = global.document;
  global.document = { createElement: () => makeNode() };
  try {
    plugin.injectEditButtons(root, 'Tasks.md');
    const slot = li.children[0];
    assert.equal(slot.className, 'qc-action-slot');
    const button = slot.children[0];
    assert.equal(button.className, 'qc-edit-btn');
    assert.equal(button.icon, 'zap');
    button.listeners.click({ preventDefault() {}, stopPropagation() {} });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(clicked, true);
    li.appendChild = () => { throw new Error('duplicate slot'); };
    plugin.injectEditButtons(root, 'Tasks.md');
    plugin.injectEditButtons(root, 'Other.md');
  } finally {
    global.document = originalDocument;
  }
});


test('post-processor observes Tasks blocks before any rows are rendered', async () => {
  const { plugin } = makePlugin();
  postProcessors.length = 0;
  await plugin.onload();
  const processor = postProcessors.find((p) => p.order === 100);
  assert.ok(processor, 'post-processor registered');
  let observed = false;
  const originalObserver = global.MutationObserver;
  global.MutationObserver = class {
    observe() { observed = true; }
    disconnect() {}
  };
  const originalDocument = global.document;
  global.document = { body: {}, querySelectorAll: () => [] };
  const children = [];
  try {
    processor.cb(
      {
        classList: { contains: (c) => c === 'block-language-tasks' },
        querySelector: () => null,
        querySelectorAll: () => [],
        matches: () => false
      },
      { sourcePath: 'Tasks.md', addChild: (c) => children.push(c) }
    );
    assert.equal(observed, true);
    assert.equal(children.length, 1);
  } finally {
    global.MutationObserver = originalObserver;
    global.document = originalDocument;
  }
});
