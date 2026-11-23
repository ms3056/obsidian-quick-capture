// Pure task-line helpers: no Obsidian imports, so they can be unit-tested in Node.

export type CaptureDestination = 'daily' | 'journal' | 'gratitude' | 'win' | 'inbox' | 'task';
export type TaskPriority = 'highest' | 'high' | 'medium' | 'low' | 'lowest' | 'none';
export type PurgeAgeUnit = 'days' | 'months';

export interface OrganizedTaskBlock {
    lines: string[];
    priority: number;
    date: string | null;
    completed: boolean;
    originalIndex: number;
}

export const TASK_LINE_REGEX = /^(\s*)[-*+]\s+\[([^\]]+)\]/;

/** Canonical Tasks-plugin emoji for each priority level. */
export const TASK_PRIORITY_EMOJI: Record<TaskPriority, string> = {
    highest: '🔺',
    high: '⏫',
    medium: '🔼',
    low: '🔽',
    lowest: '⏬',
    none: ''
};

export const TASK_PRIORITIES: TaskPriority[] = ['highest', 'high', 'medium', 'low', 'lowest', 'none'];

/** Icon metadata copied from tasks-lucide-icons (its data.json core priority rules). */
export const TASK_PRIORITY_META: Record<TaskPriority, { label: string; icon: string; color: string }> = {
    highest: { label: 'Highest', icon: 'chevrons-up', color: '#ef4444' },
    high: { label: 'High', icon: 'chevron-up', color: '#f97316' },
    medium: { label: 'Med', icon: 'minus', color: '#eab308' },
    low: { label: 'Low', icon: 'priority-chevron-down', color: '#3b82f6' },
    lowest: { label: 'Lowest', icon: 'chevrons-down', color: '#94a3b8' },
    none: { label: 'Normal', icon: 'circle', color: '#9ca3af' }
};

export function priorityCodeFromTaskPriority(priority: TaskPriority): string {
    switch (priority) {
        case 'highest': return '0';
        case 'high': return '1';
        case 'medium': return '2';
        case 'low': return '4';
        case 'lowest': return '5';
        default: return '3';
    }
}

export function getTaskPriorityOrder(taskLine: string): number {
    if (taskLine.includes('🔺')) return 0;
    if (taskLine.includes('⏫')) return 1;
    if (taskLine.includes('🔼')) return 2;
    if (taskLine.includes('🔽')) return 3;
    if (taskLine.includes('⏬')) return 4;
    return 5;
}

export const TASK_FIELD_ORDER: Record<string, number> = {
    '🔺': 0,
    '⏫': 1,
    '🔼': 2,
    '🔽': 3,
    '⏬': 4,
    '🛫': 10,
    '⏳': 11,
    '➕': 12,
    '📅': 13,
    '✅': 14,
    '❌': 15
};

const STANDALONE_TASK_TAG_REGEX = /(?:^|[ \t]+)#task(?=$|[ \t]+)/gi;

function extractStandaloneTaskTag(text: string): { cleaned: string; hasTaskTag: boolean } {
    let hasTaskTag = false;
    const cleaned = text
        .replace(STANDALONE_TASK_TAG_REGEX, () => {
            hasTaskTag = true;
            return ' ';
        })
        .replace(/[ \t]+/g, ' ')
        .trim();
    return { cleaned, hasTaskTag };
}

export function repositionTaskKeywordTag(line: string): string {
    const taskMatch = line.match(/^(\s*[-*+]\s+\[[^\]]+\])(?:[ \t]+(.*))?$/);
    if (!taskMatch) return line;

    const prefix = taskMatch[1];
    const body = taskMatch[2] ?? '';
    const { cleaned: bodyWithoutTaskTag, hasTaskTag } = extractStandaloneTaskTag(body);
    if (!hasTaskTag) return line;

    const trailingMatch = bodyWithoutTaskTag.match(
        /^([\s\S]*?)((?:(?:^|[ \t]+)(?:🔺|⏫|🔼|🔽|⏬|(?:🛫|⏳|➕|📅|✅|❌)(?:[ \t]+\d{4}-\d{2}-\d{2})?))+)$/u
    );
    const description = trailingMatch ? trailingMatch[1].trim() : bodyWithoutTaskTag;
    const trailingFields = trailingMatch ? trailingMatch[2].replace(/[ \t]+/g, ' ').trim() : '';

    return [prefix, description, '#task', trailingFields].filter(Boolean).join(' ');
}

export function normalizeTaskLineOrder(line: string): string {
    const taskMatch = line.match(/^(\s*[-*+]\s+\[[^\]]+\])(?:[ \t]+(.*))?$/);
    if (!taskMatch) return line;

    const prefix = taskMatch[1];
    const body = taskMatch[2] ?? '';
    const fields: { value: string; order: number; index: number }[] = [];
    const rawDescription = body.replace(
        /(🔺|⏫|🔼|🔽|⏬|🛫|⏳|➕|📅|✅|❌)(?:[ \t]+(\d{4}-\d{2}-\d{2}))?/gu,
        (match: string, marker: string, date: string | undefined) => {
            fields.push({
                value: date ? `${marker} ${date}` : marker,
                order: TASK_FIELD_ORDER[marker],
                index: fields.length
            });
            return ' ';
        }
    ).replace(/[ \t]+/g, ' ').trim();

    const { cleaned: description, hasTaskTag } = extractStandaloneTaskTag(rawDescription);

    if (fields.length === 0 && !hasTaskTag) return line;

    fields.sort((a, b) => a.order - b.order || a.index - b.index);
    const priorities = fields.filter((field) => field.order < 10);
    const metadata = fields.filter((field) => field.order >= 10);
    return [
        prefix,
        ...priorities.map((field) => field.value),
        description,
        hasTaskTag ? '#task' : '',
        ...metadata.map((field) => field.value)
    ]
        .filter(Boolean)
        .join(' ');
}

function getTaskSortDate(taskLine: string): string | null {
    for (const emoji of ['📅', '⏳', '🛫']) {
        const match = taskLine.match(new RegExp(`${emoji}\\s*(\\d{4}-\\d{2}-\\d{2})`));
        if (match) return match[1];
    }
    return null;
}

function sortTaskBlocks(blocks: OrganizedTaskBlock[]): OrganizedTaskBlock[] {
    return blocks.sort((a, b) => {
        if (a.priority !== b.priority) return a.priority - b.priority;
        if (a.date && b.date && a.date !== b.date) return a.date.localeCompare(b.date);
        if (a.date && !b.date) return -1;
        if (!a.date && b.date) return 1;
        return a.originalIndex - b.originalIndex;
    });
}

export function organizeTaskListContent(
    content: string,
    insertPosition: 'append' | 'prepend',
    normalizeTaskOrder = false
): string {
    const lineEnding = content.includes('\r\n') ? '\r\n' : '\n';
    const frontmatterMatch = content.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/);
    const frontmatter = frontmatterMatch?.[0] ?? '';
    const body = content.slice(frontmatter.length);
    const lines = body.split(/\r?\n/);
    const organizedLines: string[] = [];
    let index = 0;

    while (index < lines.length) {
        const firstTask = lines[index].match(TASK_LINE_REGEX);
        if (!firstTask) {
            organizedLines.push(lines[index]);
            index++;
            continue;
        }

        const baseIndent = firstTask[1].length;
        const blocks: OrganizedTaskBlock[] = [];
        let currentBlock: OrganizedTaskBlock | null = null;
        let originalIndex = 0;

        while (index < lines.length) {
            const taskMatch = lines[index].match(TASK_LINE_REGEX);
            if (taskMatch) {
                if (!currentBlock || taskMatch[1].length <= baseIndent) {
                    if (currentBlock) blocks.push(currentBlock);
                    currentBlock = {
                        lines: [lines[index]],
                        priority: getTaskPriorityOrder(lines[index]),
                        date: getTaskSortDate(lines[index]),
                        completed: taskMatch[2].toLowerCase() === 'x',
                        originalIndex: originalIndex++
                    };
                } else {
                    currentBlock.lines.push(lines[index]);
                }
                index++;
                continue;
            }

            if (lines[index].trim() === '') {
                let nextNonBlank = index;
                while (nextNonBlank < lines.length && lines[nextNonBlank].trim() === '') {
                    nextNonBlank++;
                }
                if (
                    nextNonBlank < lines.length &&
                    TASK_LINE_REGEX.test(lines[nextNonBlank])
                ) {
                    index = nextNonBlank;
                    continue;
                }
                break;
            }

            if (currentBlock && /^\s+\S/.test(lines[index])) {
                currentBlock.lines.push(lines[index]);
                index++;
                continue;
            }
            break;
        }
        if (currentBlock) blocks.push(currentBlock);

        const completed = sortTaskBlocks(blocks.filter((block) => block.completed));
        const incomplete = sortTaskBlocks(blocks.filter((block) => !block.completed));
        const ordered = insertPosition === 'append'
            ? [...completed, ...incomplete]
            : [...incomplete, ...completed];

        ordered.forEach((block, blockIndex) => {
            if (blockIndex > 0) {
                const previousBlock = ordered[blockIndex - 1];
                if (
                    previousBlock.completed !== block.completed ||
                    (!block.completed && previousBlock.priority !== block.priority)
                ) {
                    organizedLines.push('');
                }
            }
            organizedLines.push(
                ...(normalizeTaskOrder
                    ? block.lines.map(normalizeTaskLineOrder)
                    : block.lines.map(repositionTaskKeywordTag))
            );
        });
    }

    return `${frontmatter}${organizedLines.join(lineEnding).replace(/(?:\r?\n)*$/, '')}${lineEnding}`;
}

// --- Optional "| description" suffix ---------------------------------------

const PROTECTED_SPANS = /\[\[[^\]]*\]\]|\[[^\]]*\]\([^)]*\)|`[^`]*`/g;

/** Index of the delimiter pipe, or -1. Pipes inside links/code are ignored. */
export function findDetailIndex(text: string): number {
    const masked = text.replace(PROTECTED_SPANS, (m) => ' '.repeat(m.length));
    const match = masked.match(/(^|\s)\|(?!\|)/);
    return match ? (match.index ?? 0) + match[0].length - 1 : -1;
}

/** Strip only the pipe and ONE following space; keep spaces around inline nodes. */
export function extractDetailText(rawSuffix: string): string {
    return rawSuffix.startsWith(' ') ? rawSuffix.slice(1) : rawSuffix;
}

export function splitTaskDescription(description: string): { title: string; detail: string } {
    const i = findDetailIndex(description);
    if (i < 0) return { title: description.trim(), detail: '' };
    return { title: description.slice(0, i).trim(), detail: description.slice(i + 1).trim() };
}

// --- Edit prefill / rebuild --------------------------------------------------

const FIELD_RE = /(🔺|⏫|🔼|🔽|⏬|🛫|⏳|➕|📅|✅|❌)(?:\s+(\d{4}-\d{2}-\d{2}))?/gu;

export interface EditableTask {
    prefix: string;
    text: string;
    priorityEmoji: string;
    priority: TaskPriority;
    start: string;
    scheduled: string;
    created: string;
    due: string;
    preserved: string[];
}

export function parseEditableTask(line: string): EditableTask | null {
    const m = line.match(TASK_LINE_REGEX);
    if (!m) return null;
    const body = line.slice(m[0].length).trim();
    const out: EditableTask = {
        prefix: line.slice(0, m[0].length), text: '', priorityEmoji: '', priority: 'none',
        start: '', scheduled: '', created: '', due: '', preserved: []
    };
    const kept: string[] = [];
    let last = 0;
    FIELD_RE.lastIndex = 0;
    let hit: RegExpExecArray | null;
    while ((hit = FIELD_RE.exec(body)) !== null) {
        kept.push(body.slice(last, hit.index));
        const emoji = hit[1];
        const date = hit[2] ?? '';
        if (['🔺', '⏫', '🔼', '🔽', '⏬'].includes(emoji)) {
            out.priorityEmoji = emoji;
            out.priority = (Object.keys(TASK_PRIORITY_EMOJI) as TaskPriority[])
                .find((key) => TASK_PRIORITY_EMOJI[key] === emoji) ?? 'none';
        } else if (emoji === '🛫') out.start = date;
        else if (emoji === '⏳') out.scheduled = date;
        else if (emoji === '➕') out.created = date;
        else if (emoji === '📅') out.due = date;
        else out.preserved.push(date ? `${emoji} ${date}` : emoji);
        last = hit.index + hit[0].length;
    }
    kept.push(body.slice(last));
    out.text = kept.join(' ').replace(/\s+/g, ' ').trim();
    return out;
}

export function buildEditedTaskLine(original: string, edit: Omit<EditableTask, 'prefix'> & { normalize: boolean }): string {
    const parsed = parseEditableTask(original);
    if (!parsed) throw new Error('Not a task line');
    const parts = [parsed.prefix];
    // Reuse the original emoji only when the chosen priority is unchanged;
    // otherwise a 🔺/⏬ task would silently ignore a Medium/None edit.
    const reuseOriginal = edit.priority === parsed.priority && !!edit.priorityEmoji;
    const emoji = reuseOriginal ? edit.priorityEmoji : TASK_PRIORITY_EMOJI[edit.priority];
    if (emoji) parts.push(emoji);
    parts.push(edit.text.trim());
    parts.push(...edit.preserved);
    if (edit.start) parts.push(`🛫 ${edit.start}`);
    if (edit.scheduled) parts.push(`⏳ ${edit.scheduled}`);
    if (edit.created) parts.push(`➕ ${edit.created}`);
    if (edit.due) parts.push(`📅 ${edit.due}`);
    const joined = parts.filter(Boolean).join(' ');
    return edit.normalize ? normalizeTaskLineOrder(joined) : repositionTaskKeywordTag(joined);
}


// --- Resolving a rendered Tasks query row back to its source line ------------

export interface RenderedTaskSignals {
    description: string;
    status: string;
    priority: string;
    dueBucket: string;
    sourcePath?: string;
}

export interface TaskCandidate {
    path: string;
    line: number;
    originalLine: string;
    description: string;
    status: string;
    priority: string;
    dueBucket: string;
}

/** Same buckets the Tasks plugin publishes in data-task-due. */
export function dueBucketFromIso(iso: string, todayIso: string): string {
    const a = Date.parse(`${iso}T00:00:00Z`);
    const b = Date.parse(`${todayIso}T00:00:00Z`);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return '';
    const days = Math.round((b - a) / 86400000);
    if (days === 0) return 'today';
    const magnitude = Math.abs(days) <= 7 ? `${Math.abs(days)}d` : 'far';
    return days > 0 ? `past-${magnitude}` : `future-${magnitude}`;
}

export function priorityNameFromCode(code: string): string {
    switch (code) {
        case '0': return 'highest';
        case '1': return 'high';
        case '2': return 'medium';
        case '4': return 'low';
        case '5': return 'lowest';
        default: return 'normal';
    }
}

function normalizeForMatch(value: string): string {
    return (value || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Highest-scoring candidates first; ties are broken in favor of the master list. */
export function rankTaskCandidates(
    signals: RenderedTaskSignals,
    candidates: TaskCandidate[]
): TaskCandidate[] {
    const description = normalizeForMatch(signals.description);
    const scored = candidates.map((candidate) => {
        const candidateDescription = normalizeForMatch(candidate.description);
        let score = 0;
        let descriptionScore = 0;
        if (description && candidateDescription === description) {
            score += 10;
            descriptionScore = 10;
        } else if (description && (
            candidateDescription.includes(description) || description.includes(candidateDescription)
        )) {
            score += 5;
            descriptionScore = 5;
        }
        if (candidate.status === signals.status) score += 3;
        else if (signals.status && candidate.status) score -= 4;
        if (candidate.priority && candidate.priority === signals.priority) score += 2;
        else if (signals.priority && candidate.priority) score -= 2;
        if (signals.dueBucket && candidate.dueBucket === signals.dueBucket) score += 3;
        else if (signals.dueBucket && candidate.dueBucket) score -= 2;
        if (candidate.path.endsWith('Master Task List.md')) score += 2;
        if (signals.sourcePath && candidate.path === signals.sourcePath) score += 1;
        return { candidate, score, descriptionScore };
    });
    return scored
        .filter((entry) => entry.descriptionScore > 0 && entry.score >= 8)
        .sort((a, b) => b.score - a.score)
        .map((entry) => entry.candidate);
}
