const test = require('node:test');
const assert = require('node:assert/strict');
const {
  rankTaskCandidates, dueBucketFromIso, priorityNameFromCode, extractDetailText,
  normalizeTaskLineOrder, repositionTaskKeywordTag, organizeTaskListContent,
  findDetailIndex, splitTaskDescription, parseEditableTask, buildEditedTaskLine
} = require('../.test-build/task-model.cjs');

// Task 1 regressions: current behavior before any new feature.
test('normalize puts priority first and dates last', () => {
  assert.equal(normalizeTaskLineOrder('- [ ] Buy milk #task 📅 2026-11-30 🔺'),
               '- [ ] 🔺 Buy milk #task 📅 2026-11-30');
});
test('normalize orders date fields start, scheduled, due', () => {
  assert.equal(normalizeTaskLineOrder('- [ ] ⏳ 2026-12-01 x #task'),
               '- [ ] x #task ⏳ 2026-12-01');
});
test('reposition keeps #task after description', () => {
  assert.equal(repositionTaskKeywordTag('- [ ] #task Buy milk 📅 2026-11-30'),
               '- [ ] Buy milk #task 📅 2026-11-30');
});
test('organize is idempotent', () => {
  const input = '- [ ] a #task 📅 2026-12-01\n- [ ] b #task 📅 2026-11-30\n';
  const once = organizeTaskListContent(input, 'append', true);
  assert.equal(organizeTaskListContent(once, 'append', true), once);
});

// Task 2: suffix detection.
test('splits description suffix', () => {
  assert.deepEqual(splitTaskDescription('Buy milk | oat milk #task'), { title: 'Buy milk', detail: 'oat milk #task' });
  assert.deepEqual(splitTaskDescription('Buy milk'), { title: 'Buy milk', detail: '' });
});
test('ignores pipes inside links and code', () => {
  assert.equal(findDetailIndex('See [[Page|Alias]] for milk'), -1);
  assert.equal(findDetailIndex('Use `a|b` here'), -1);
  assert.equal(findDetailIndex('Buy milk |now'), 9);
});

// Task 3: edit parsing and rebuild.
test('parse editable line', () => {
  const p = parseEditableTask('- [ ] 🔺 Buy milk | oat #task 📅 2026-11-30');
  assert.equal(p.priority, 'highest');
  assert.equal(p.priorityEmoji, '🔺');
  assert.equal(p.due, '2026-11-30');
  assert.equal(p.text, 'Buy milk | oat #task');
});
test('rebuild preserves status, original priority emoji and suffix position', () => {
  const original = '- [ ] 🔺 Buy milk #task 📅 2026-11-30';
  const rebuilt = buildEditedTaskLine(original, {
    text: 'Buy milk | oat milk #task', priority: 'highest',
    priorityEmoji: '🔺', due: '2026-11-30', start: '', scheduled: '', created: '',
    preserved: [], normalize: true
  });
  assert.equal(rebuilt, '- [ ] 🔺 Buy milk | oat milk #task 📅 2026-11-30');
});
test('rebuild keeps priority first when normalize is off', () => {
  const original = '- [ ] 🔺 Buy milk #task 📅 2026-11-30';
  const rebuilt = buildEditedTaskLine(original, {
    text: 'Buy milk | oat milk #task', priority: 'highest', priorityEmoji: '🔺',
    due: '2026-11-30', start: '', scheduled: '', created: '', preserved: [], normalize: false
  });
  assert.equal(rebuilt, '- [ ] 🔺 Buy milk | oat milk #task 📅 2026-11-30');
});
test('changing priority away from 🔺 does NOT keep the old emoji', () => {
  const original = '- [ ] 🔺 Buy milk #task 📅 2026-11-30';
  const base = { text: 'Buy milk #task', due: '2026-11-30', start: '', scheduled: '',
                 created: '', preserved: [], normalize: true, priorityEmoji: '🔺' };
  assert.equal(buildEditedTaskLine(original, { ...base, priority: 'medium' }),
               '- [ ] 🔼 Buy milk #task 📅 2026-11-30');
  assert.equal(buildEditedTaskLine(original, { ...base, priority: 'lowest' }),
               '- [ ] ⏬ Buy milk #task 📅 2026-11-30');
  assert.equal(buildEditedTaskLine(original, { ...base, priority: 'none' }),
               '- [ ] Buy milk #task 📅 2026-11-30');
});


// Injected edit button: candidate ranking from rendered task signals.
test('due bucket and priority name match Tasks plugin attributes', () => {
  assert.equal(dueBucketFromIso('2026-11-23', '2026-11-23'), 'today');
  assert.equal(dueBucketFromIso('2026-11-22', '2026-11-23'), 'past-1d');
  assert.equal(dueBucketFromIso('2026-11-26', '2026-11-23'), 'future-3d');
  assert.equal(priorityNameFromCode('1'), 'high');
  assert.equal(priorityNameFromCode('3'), 'normal');
});
test('rank prefers exact description, matching status/priority/due and master list', () => {
  const signals = { description: 'Buy milk | oat milk #task', status: ' ', priority: 'high', dueBucket: 'today', sourcePath: 'Tasks.md' };
  const candidates = [
    { path: 'Other.md', line: 4, originalLine: '- [ ] 🔺 Buy milk | oat #task 📅 2026-11-23', description: 'Buy milk | oat', status: ' ', priority: 'high', dueBucket: '' },
    { path: 'Master Task List.md', line: 9, originalLine: '- [ ] 🔺 Buy milk | oat milk #task 📅 2026-11-23', description: 'Buy milk | oat milk #task', status: ' ', priority: 'high', dueBucket: 'today' },
    { path: 'Master Task List.md', line: 12, originalLine: '- [x] Buy milk | oat milk #task 📅 2026-11-23', description: 'Buy milk | oat milk #task', status: 'x', priority: 'high', dueBucket: 'today' }
  ];
  const ranked = rankTaskCandidates(signals, candidates);
  assert.equal(ranked[0].line, 9);
  assert.equal(ranked[1].line, 12);
});


test('unrelated tasks with same date and priority are not picker candidates', () => {
  const signals = { description: 'Send email tomorrow #task', status: ' ', priority: 'high', dueBucket: 'past-far' };
  const candidates = [
    { path: 'Master Task List.md', line: 0, originalLine: '- [ ] ⏫ Send email tomorrow #task 📅 2026-11-08', description: 'Send email tomorrow #task', status: ' ', priority: 'high', dueBucket: 'past-far' },
    { path: 'Master Task List.md', line: 1, originalLine: '- [ ] ⏫ Another task #task 📅 2026-11-08', description: 'Another task #task', status: ' ', priority: 'high', dueBucket: 'past-far' },
    { path: 'Master Task List.md', line: 2, originalLine: '- [ ] 🔼 A sample task #task 📅 2026-11-08', description: 'A sample task #task', status: ' ', priority: 'medium', dueBucket: 'past-far' }
  ];
  assert.equal(rankTaskCandidates(signals, candidates).length, 1);
});


test('detail whitespace keeps spaces around inline nodes', () => {
  assert.equal(extractDetailText(' get '), 'get ');
  assert.equal(extractDetailText(' see '), 'see ');
  assert.equal(extractDetailText('oat milk'), 'oat milk');
  assert.equal(extractDetailText('  two spaces'), ' two spaces');
});


test('all six priority levels parse and rebuild without collapsing', () => {
  const levels = [
    ['highest', '🔺'], ['high', '⏫'], ['medium', '🔼'],
    ['low', '🔽'], ['lowest', '⏬'], ['none', '']
  ];
  for (const [priority, emoji] of levels) {
    const line = '- [ ] ' + [emoji, 'Task #task 📅 2026-11-30'].filter(Boolean).join(' ');
    const parsed = parseEditableTask(line);
    assert.equal(parsed.priority, priority, 'parse ' + priority);
    assert.equal(parsed.priorityEmoji, emoji, 'emoji ' + priority);
    const rebuilt = buildEditedTaskLine(line, {
      text: 'Task #task', priority, priorityEmoji: emoji,
      due: '2026-11-30', start: '', scheduled: '', created: '',
      preserved: [], normalize: true
    });
    assert.equal(rebuilt, line, 'rebuild ' + priority);
  }
});
