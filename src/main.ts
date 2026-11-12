import {
    App,
    Editor,
    MarkdownFileInfo,
    MarkdownView,
    Notice,
    Plugin,
    PluginSettingTab,
    Modal,
    Setting,
    TFile,
    normalizePath,
    moment
} from 'obsidian';

export type CaptureDestination = 'daily' | 'journal' | 'gratitude' | 'win' | 'inbox' | 'task';

export type TaskPriority = 'none' | 'high' | 'medium' | 'low';
export type PurgeAgeUnit = 'days' | 'months';

interface OrganizedTaskBlock {
    lines: string[];
    priority: number;
    date: string | null;
    completed: boolean;
    originalIndex: number;
}

const TASK_LINE_REGEX = /^(\s*)[-*+]\s+\[([^\]]+)\]/;

function getTaskPriorityOrder(taskLine: string): number {
    if (taskLine.includes('🔺')) return 0;
    if (taskLine.includes('⏫')) return 1;
    if (taskLine.includes('🔼')) return 2;
    if (taskLine.includes('🔽')) return 3;
    if (taskLine.includes('⏬')) return 4;
    return 5;
}

const TASK_FIELD_ORDER: Record<string, number> = {
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

function repositionTaskKeywordTag(line: string): string {
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

function normalizeTaskLineOrder(line: string): string {
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

function organizeTaskListContent(
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

function purgeCompletedTasksContent(
    content: string,
    olderThan: moment.Moment | null
): { content: string; removed: number } {
    const lineEnding = content.includes('\r\n') ? '\r\n' : '\n';
    let removed = 0;
    const lines = content.split(/\r?\n/).filter((line) => {
        const taskMatch = line.match(TASK_LINE_REGEX);
        if (!taskMatch || taskMatch[2].toLowerCase() !== 'x') return true;
        if (!olderThan) {
            removed++;
            return false;
        }

        const completionDateMatch = line.match(/✅\s*(\d{4}-\d{2}-\d{2})/);
        if (!completionDateMatch) return true;
        const completionDate = moment(completionDateMatch[1], 'YYYY-MM-DD', true);
        if (!completionDate.isValid() || !completionDate.isBefore(olderThan, 'day')) return true;

        removed++;
        return false;
    });

    if (removed > 0) {
        while (lines.length > 0 && lines[0].trim() === '') lines.shift();
        while (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
    }

    return { content: lines.join(lineEnding), removed };
}

// Embedded CSS so the Standalone OS BrowserWindow has 100% of the Spotlight/Things styling immediately
export const EMBEDDED_STANDALONE_CSS = `/* =========================================================
   Quick Capture v1.4 (Standalone Electron BrowserWindow)
   ========================================================= */
.qc-standalone-root {
    margin: 0;
    padding: 14px 18px 12px 18px;
    display: flex;
    flex-direction: column;
    gap: 10px;
    position: relative;
    box-sizing: border-box;
    height: 100%;
    background: #1e1e24;
    color: #e4e4e7;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Inter, sans-serif;
    user-select: none;
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 12px;
}

/* Top Drag Bar + Close Button for Standalone Floating Window */
.qc-top-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    height: 18px;
    margin-top: -4px;
    -webkit-app-region: drag;
    cursor: grab;
}

.qc-top-title {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.03em;
    color: #71717a;
    display: flex;
    align-items: center;
    gap: 6px;
}

.qc-top-close {
    -webkit-app-region: no-drag;
    background: transparent;
    border: none;
    color: #71717a;
    font-size: 16px;
    line-height: 1;
    padding: 2px 6px;
    border-radius: 5px;
    cursor: pointer;
}

.qc-top-close:hover {
    color: #f4f4f6;
    background: rgba(255, 255, 255, 0.08);
}

/* Main borderless Spotlight-style Textarea */
.qc-textarea-wrapper {
    position: relative;
    width: 100%;
    flex: 1;
    display: flex;
    -webkit-app-region: no-drag;
}

.qc-textarea {
    width: 100%;
    min-height: 105px;
    height: 100%;
    resize: none;
    padding: 4px 2px;
    font-size: 16px;
    line-height: 1.55;
    border: none !important;
    background: transparent !important;
    color: #f4f4f6;
    font-family: inherit;
    box-sizing: border-box;
    box-shadow: none !important;
}

.qc-textarea:focus {
    outline: none !important;
    border: none !important;
    box-shadow: none !important;
}

.qc-textarea::placeholder {
    color: #71717a;
}

.qc-textarea.is-dragover {
    border-radius: 8px;
    outline: 2px dashed #8b5cf6 !important;
    background: rgba(139, 92, 246, 0.08) !important;
}

/* Metadata Pill Badges Row */
.qc-pills-row {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    align-items: center;
    min-height: 4px;
    -webkit-app-region: no-drag;
}

.qc-pills-row:empty {
    display: none;
}

.qc-pill {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 3px 9px;
    border-radius: 999px;
    font-size: 11.5px;
    font-weight: 500;
    background: rgba(139, 92, 246, 0.16);
    color: #a78bfa;
    border: 1px solid rgba(139, 92, 246, 0.35);
    cursor: pointer;
    user-select: none;
    transition: all 0.12s ease;
}

.qc-pill:hover {
    background: rgba(139, 92, 246, 0.26);
}

.qc-pill .qc-pill-clear {
    margin-left: 3px;
    opacity: 0.75;
    font-weight: 700;
}

.qc-pill .qc-pill-clear:hover {
    opacity: 1;
}

/* Bottom Bar */
.qc-bottom-bar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding-top: 10px;
    border-top: 1px solid rgba(255, 255, 255, 0.1);
    gap: 8px;
    position: relative;
    -webkit-app-region: no-drag;
}

.qc-bottom-left {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    position: relative;
}

.qc-dest-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    border-radius: 7px;
    font-size: 12.5px;
    font-weight: 600;
    background: #27272f;
    color: #f4f4f6;
    border: 1px solid rgba(255, 255, 255, 0.12);
    cursor: pointer;
    transition: all 0.12s ease;
}

.qc-dest-btn:hover {
    border-color: #8b5cf6;
}

.qc-dest-btn svg {
    width: 14px;
    height: 14px;
    color: #8b5cf6;
    stroke: #8b5cf6;
}

/* Custom Destination Dropdown Menu */
.qc-dest-menu {
    position: absolute;
    bottom: 36px;
    left: 0;
    width: 215px;
    background: #1e1e24;
    border: 1px solid rgba(255, 255, 255, 0.18);
    border-radius: 10px;
    box-shadow: 0 12px 32px rgba(0, 0, 0, 0.65);
    padding: 5px;
    z-index: 1100;
    display: flex;
    flex-direction: column;
    gap: 2px;
}

.qc-dest-menu-item {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 6px 9px;
    border-radius: 6px;
    font-size: 12px;
    color: #e4e4e7;
    background: transparent;
    border: none;
    cursor: pointer;
    text-align: left;
}

.qc-dest-menu-item:hover,
.qc-dest-menu-item.is-active {
    background: rgba(139, 92, 246, 0.22);
    color: #c4b5fd;
}

.qc-dest-menu-left {
    display: flex;
    align-items: center;
    gap: 7px;
}

.qc-dest-menu-left svg {
    width: 14px;
    height: 14px;
    stroke: #8b5cf6;
}

.qc-dest-menu-hint {
    font-size: 10.5px;
    color: #9ca3af;
    font-family: monospace;
}

.qc-target-sub {
    font-size: 11px;
    color: #9ca3af;
    font-family: monospace;
    max-width: 195px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}

/* Right Action Cluster */
.qc-bottom-right {
    display: flex;
    align-items: center;
    gap: 6px;
}

.qc-icon-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    height: 28px;
    min-width: 28px;
    padding: 0 7px;
    border-radius: 6px;
    border: 1px solid transparent;
    background: transparent;
    color: #9ca3af;
    cursor: pointer;
    font-size: 11.5px;
    transition: all 0.12s ease;
}

.qc-icon-btn:hover {
    color: #f4f4f6;
    background: #27272f;
    border-color: rgba(255, 255, 255, 0.12);
}

.qc-icon-btn.has-value {
    color: #a78bfa;
    background: rgba(139, 92, 246, 0.15);
    border-color: rgba(139, 92, 246, 0.35);
}

.qc-icon-btn svg {
    width: 15px;
    height: 15px;
}

.qc-btn-submit {
    background: #8b5cf6;
    color: #ffffff;
    font-weight: 600;
    font-size: 12.5px;
    border: none;
    border-radius: 7px;
    padding: 5px 13px;
    height: 28px;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 5px;
    transition: opacity 0.12s ease;
}

.qc-btn-submit:hover {
    opacity: 0.92;
}

/* Things-Style Floating Date Picker Popover */
.qc-calendar-popover {
    position: absolute;
    bottom: 44px;
    right: 12px;
    width: 276px;
    background: #1e1e24;
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 11px;
    box-shadow: 0 14px 38px rgba(0, 0, 0, 0.7);
    padding: 9px;
    z-index: 1200;
    display: flex;
    flex-direction: column;
    gap: 6px;
    -webkit-app-region: no-drag;
}

.qc-cal-type-tabs {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 4px;
    background: #27272f;
    padding: 3px;
    border-radius: 7px;
}

.qc-cal-type-tab {
    border: none;
    background: transparent;
    color: #9ca3af;
    font-size: 11px;
    font-weight: 600;
    padding: 3px 6px;
    border-radius: 5px;
    cursor: pointer;
}

.qc-cal-type-tab.is-active {
    background: #8b5cf6;
    color: #ffffff;
}

.qc-cal-presets {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 4px;
}

.qc-cal-preset-btn {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 4px 7px;
    border-radius: 6px;
    font-size: 11px;
    background: #27272f;
    color: #f4f4f6;
    border: 1px solid transparent;
    cursor: pointer;
    text-align: left;
}

.qc-cal-preset-btn:hover {
    border-color: #8b5cf6;
}

.qc-cal-preset-sub {
    font-size: 10px;
    color: #9ca3af;
}

.qc-cal-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 2px 4px;
    font-size: 12px;
    font-weight: 600;
    color: #f4f4f6;
}

.qc-cal-nav {
    display: flex;
    gap: 3px;
}

.qc-cal-nav-btn {
    background: transparent;
    border: none;
    color: #9ca3af;
    cursor: pointer;
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 11px;
}

.qc-cal-nav-btn:hover {
    background: #27272f;
    color: #f4f4f6;
}

.qc-cal-grid {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 2px;
    text-align: center;
}

.qc-cal-dow {
    font-size: 10px;
    font-weight: 600;
    color: #71717a;
    padding: 2px 0;
}

.qc-cal-day {
    font-size: 11px;
    padding: 4px 0;
    border-radius: 6px;
    border: none;
    background: transparent;
    color: #f4f4f6;
    cursor: pointer;
}

.qc-cal-day:hover {
    background: rgba(139, 92, 246, 0.25);
}

.qc-cal-day.is-outside {
    color: #71717a;
    opacity: 0.45;
}

.qc-cal-day.is-today {
    font-weight: 700;
    color: #a78bfa;
    box-shadow: inset 0 0 0 1px #8b5cf6;
}

.qc-cal-day.is-selected {
    background: #8b5cf6 !important;
    color: #ffffff !important;
    font-weight: 700;
}

.qc-cal-footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 6px;
    padding-top: 5px;
    border-top: 1px solid rgba(255, 255, 255, 0.1);
}

.qc-cal-native-input {
    font-size: 11px;
    padding: 2px 6px;
    border-radius: 5px;
    border: 1px solid rgba(255, 255, 255, 0.14);
    background: #27272f;
    color: #f4f4f6;
    flex: 1;
}

.qc-cal-clear-btn {
    font-size: 11px;
    padding: 3px 8px;
    border-radius: 5px;
    border: none;
    background: transparent;
    color: #9ca3af;
    cursor: pointer;
}

.qc-cal-clear-btn:hover {
    color: #f87171;
}

/* Shortcut Footer Strip */
.qc-shortcut-strip {
    display: flex;
    align-items: center;
    justify-content: space-between;
    font-size: 10.5px;
    color: #71717a;
    padding: 0 2px;
    flex-wrap: wrap;
    gap: 6px;
    -webkit-app-region: no-drag;
}

.qc-kbd {
    background: #27272f;
    border: 1px solid rgba(255, 255, 255, 0.12);
    padding: 0px 4px;
    border-radius: 3px;
    font-family: monospace;
    font-size: 9.5px;
    color: #9ca3af;
}

.qc-detected-info {
    background: var(--background-secondary);
    border: 1px solid var(--background-modifier-border);
    border-radius: 8px;
    padding: 10px 14px;
    margin-bottom: 16px;
    font-size: 12.5px;
    line-height: 1.5;
}
`;

// Inline Lucide SVG icons for the standalone OS window.
export const LUCIDE_SVGS: Record<string, string> = {
    'calendar-with-checkmark': `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="4" rx="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/><path d="m9 16 2 2 4-4"/></svg>`,
    'book-open': `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>`,
    'heart': `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>`,
    'trophy': `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg>`,
    'inbox': `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>`,
    'check-square': `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="3" rx="2"/><path d="m9 12 2 2 4-4"/></svg>`,
    'chevron-down': `<svg xmlns="http://www.w3.org/2000/svg" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>`,
    'calendar-days': `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect width="18" height="18" x="3" y="4" rx="2"/><line x1="16" x2="16" y1="2" y2="6"/><line x1="8" x2="8" y1="2" y2="6"/><line x1="3" x2="21" y1="10" y2="10"/><path d="M8 14h.01"/><path d="M12 14h.01"/><path d="M16 14h.01"/><path d="M8 18h.01"/><path d="M12 18h.01"/><path d="M16 18h.01"/></svg>`,
    'calendar-clock': `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 7.5V6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h3.5"/><path d="M16 2v4"/><path d="M8 2v4"/><path d="M3 10h5"/><path d="M17.5 17.5 16 16.3V14"/><circle cx="16" cy="16" r="6"/></svg>`,
    'paperclip': `<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m21.44 11.05-9.19 9.19a6 6 0 0 1-8.49-8.49l8.57-8.57A4 4 0 1 1 18 8.84l-8.59 8.57a2 2 0 0 1-2.83-2.83l8.49-8.48"/></svg>`
};

export interface QuickCaptureSettings {
    globalHotkey: string;
    defaultDestination: CaptureDestination;
    rememberLastDestination: boolean;
    lastUsedDestination: CaptureDestination;
    captureWindowWidth: number;
    captureWindowHeight: number;

    autoDetectVaultConfig: boolean;

    inboxMode: 'append-file' | 'new-note-first-line';
    inboxFilePath: string;
    inboxFolderPath: string;
    inboxInsertPosition: 'append' | 'prepend';
    includeTimestampInInbox: boolean;

    tasksFilePath: string;
    taskGlobalFilter: string;
    taskInsertPosition: 'append' | 'prepend';
    organizeTasks: boolean;
    normalizeTaskOrder: boolean;
    includeCreatedDateInTask: boolean;
    taskAutoTag: string;
    purgeCompletedAge: number;
    purgeCompletedAgeUnit: PurgeAgeUnit;

    dailyNoteFolder: string;
    dailyNoteFormat: string;
    dailyNoteTemplatePath: string;
    dailyCaptureHeading: string;
    journalHeading: string;
    journalTag: string;
    gratitudeHeading: string;
    gratitudeTag: string;
    winHeading: string;
    winTag: string;

    timestampFormat: string;
    submitOnEnter: boolean;
}

export const DEFAULT_SETTINGS: QuickCaptureSettings = {
    globalHotkey: 'Alt+Space',
    defaultDestination: 'inbox',
    rememberLastDestination: true,
    lastUsedDestination: 'inbox',
    captureWindowWidth: 620,
    captureWindowHeight: 350,

    autoDetectVaultConfig: true,

    inboxMode: 'append-file',
    inboxFilePath: 'inbox.md',
    inboxFolderPath: '00 Inbox',
    inboxInsertPosition: 'append',
    includeTimestampInInbox: true,

    tasksFilePath: 'Master Task List.md',
    taskGlobalFilter: '',
    taskInsertPosition: 'append',
    organizeTasks: false,
    normalizeTaskOrder: false,
    includeCreatedDateInTask: false,
    taskAutoTag: '',
    purgeCompletedAge: 30,
    purgeCompletedAgeUnit: 'days',

    dailyNoteFolder: '',
    dailyNoteFormat: 'YYYY-MM-DD',
    dailyNoteTemplatePath: '',
    dailyCaptureHeading: '### Captured',
    journalHeading: '### Journal',
    journalTag: '#journal',
    gratitudeHeading: '### Gratitude',
    gratitudeTag: '#gratitude',
    winHeading: '### Wins',
    winTag: '#win',

    timestampFormat: 'YYYY-MM-DD HH:mm',
    submitOnEnter: true
};

export const DESTINATION_META: Record<
    CaptureDestination,
    { label: string; icon: string; shortcutHint: string; placeholder: string }
> = {
    daily: {
        label: 'Daily Note',
        icon: 'calendar-with-checkmark',
        shortcutHint: 'Ctrl+0',
        placeholder: 'Capture a bullet to your Daily Note...'
    },
    journal: {
        label: 'Journal Entry',
        icon: 'book-open',
        shortcutHint: 'Ctrl+J',
        placeholder: 'Write a journal entry for today...'
    },
    gratitude: {
        label: 'Gratitude',
        icon: 'heart',
        shortcutHint: 'Ctrl+G',
        placeholder: 'What are you grateful for right now?'
    },
    win: {
        label: 'Win',
        icon: 'trophy',
        shortcutHint: 'Ctrl+W',
        placeholder: 'Capture a win or milestone for today...'
    },
    inbox: {
        label: 'Inbox',
        icon: 'inbox',
        shortcutHint: 'Ctrl+I',
        placeholder: 'Capture thought, link, or note to Inbox...'
    },
    task: {
        label: 'Task',
        icon: 'check-square',
        shortcutHint: 'Ctrl+T',
        placeholder: 'Type task... (Click calendar icon or Ctrl+D for due date)'
    }
};

const MAX_BRIDGE_REQUEST_BYTES = 44 * 1024 * 1024;
const MAX_ATTACHMENT_BYTES = 32 * 1024 * 1024;
const MAX_CAPTURE_TEXT_LENGTH = 1024 * 1024;

function isCaptureDestination(value: unknown): value is CaptureDestination {
    return typeof value === 'string' && Object.prototype.hasOwnProperty.call(DESTINATION_META, value);
}

function isOptionalIsoDate(value: unknown): boolean {
    return value === undefined || value === '' ||
        (typeof value === 'string' && moment(value, 'YYYY-MM-DD', true).isValid());
}

function serializeForInlineScript(value: unknown): string {
    return JSON.stringify(value)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}

export default class QuickCapturePlugin extends Plugin {
    settings: QuickCaptureSettings;
    private electronRemote: any = null;
    private standaloneWin: any = null;
    private standaloneWindowSizeSaveTimer: ReturnType<typeof setTimeout> | null = null;
    private standaloneBaseBounds: { x: number; y: number; width: number; height: number } | null = null;
    private calendarExpanded = false;
    private loopbackServer: any = null;
    private loopbackSockets = new Set<any>();
    private loopbackPort: number = 0;
    private loopbackToken = '';
    private isUnloading = false;
    private organizeTasksCommandRegistered = false;
    public currentStandaloneDest: CaptureDestination = 'inbox';

    public detectedInfo: {
        inboxFound?: string;
        tasksFound?: string;
        dailyFolder?: string;
        dailyFormat?: string;
        dailyTemplate?: string;
        attachmentFolder?: string;
        tasksGlobalFilter?: string;
    } = {};

    async onload() {
        await this.loadSettings();
        this.initElectronRemote();

        this.app.workspace.onLayoutReady(async () => {
            if (this.isUnloading) return;
            this.scanAndDetectVaultConfig(false);
            await this.startLoopbackServer();
            if (this.isUnloading) {
                this.stopLoopbackServer();
                return;
            }
            this.registerGlobalShortcut();
        });

        this.addCommand({
            id: 'open-quick-capture-modal',
            name: 'Open Quick Capture',
            callback: () => {
                this.triggerGlobalQuickCapture();
            }
        });

        this.addCommand({
            id: 'purge-completed-tasks',
            name: 'Purge Completed Tasks',
            callback: () => {
                new PurgeCompletedTasksModal(this.app, this).open();
            }
        });

        this.addCommand({
            id: 'move-task-to-master-task-list',
            name: 'Move Task to Master Task List',
            editorCallback: (editor: Editor, ctx: MarkdownView | MarkdownFileInfo) => {
                void this.moveTaskAtCursorToMasterList(editor, ctx.file ?? null);
            }
        });

        (Object.keys(DESTINATION_META) as CaptureDestination[]).forEach((dest) => {
            this.addCommand({
                id: `open-quick-capture-${dest}`,
                name: `Quick Capture: ${DESTINATION_META[dest].label}`,
                callback: () => {
                    this.triggerGlobalQuickCapture(dest);
                }
            });
        });

        this.updateOrganizeTasksCommand();
        this.addSettingTab(new QuickCaptureSettingTab(this.app, this));
    }

    onunload() {
        this.isUnloading = true;
        this.cleanupRuntimeResources();
    }

    private cleanupRuntimeResources() {
        this.unregisterGlobalShortcut();
        this.destroyStandaloneWindow();
        this.stopLoopbackServer();
    }

    public updateOrganizeTasksCommand() {
        const commandId = 'organize-tasks';
        if (this.settings.organizeTasks && !this.organizeTasksCommandRegistered) {
            this.addCommand({
                id: commandId,
                name: 'Organize Tasks',
                callback: () => {
                    void this.organizeConfiguredTasks();
                }
            });
            this.organizeTasksCommandRegistered = true;
        } else if (!this.settings.organizeTasks && this.organizeTasksCommandRegistered) {
            this.removeCommand(commandId);
            this.organizeTasksCommandRegistered = false;
        }
    }

    private async organizeConfiguredTasks() {
        if (!this.settings.organizeTasks) return;

        const targetPath = normalizePath(this.settings.tasksFilePath || 'Master Task List.md');
        const file = this.app.vault.getAbstractFileByPath(targetPath);
        if (!(file instanceof TFile)) {
            new Notice(`Task list not found: ${targetPath}`);
            return;
        }

        try {
            await this.app.vault.process(file, (content) =>
                organizeTaskListContent(
                    content,
                    this.settings.taskInsertPosition,
                    this.settings.normalizeTaskOrder
                )
            );
            new Notice(`Tasks organized in ${targetPath}`);
        } catch (err) {
            console.error('QuickCapture: Failed to organize tasks:', err);
            new Notice(`Could not organize tasks in ${targetPath}. Check the console for details.`);
        }
    }

    private async moveTaskAtCursorToMasterList(editor: Editor, activeFile: TFile | null) {
        const lineNumber = editor.getCursor().line;
        const rawLine = editor.getLine(lineNumber);

        if (!/^\s*-\s+\[\s\]/.test(rawLine)) {
            new Notice('Current line must be a task starting with "- [ ]".');
            return;
        }

        const cleanedTask = rawLine.replace(/^\s*-\s+\[\s\]\s*/, '').trim();
        if (!cleanedTask) {
            new Notice('Task line is empty.');
            return;
        }

        const targetPath = normalizePath(this.settings.tasksFilePath || 'Master Task List.md');
        if (activeFile && normalizePath(activeFile.path) === targetPath) {
            new Notice('This task is already in the Master Task List.');
            return;
        }

        const parts: string[] = ['- [ ]'];

        const globalFilter = (
            this.settings.taskGlobalFilter ||
            this.detectedInfo.tasksGlobalFilter ||
            ''
        ).trim();
        if (globalFilter && !cleanedTask.includes(globalFilter)) {
            parts.push(globalFilter);
        }

        parts.push(cleanedTask);

        const taskAutoTag = (this.settings.taskAutoTag || '').trim();
        const normalizedAutoTag = taskAutoTag
            ? (taskAutoTag.startsWith('#') ? taskAutoTag : `#${taskAutoTag}`)
            : '';
        if (normalizedAutoTag && !cleanedTask.includes(normalizedAutoTag)) {
            parts.push(normalizedAutoTag);
        }

        if (this.settings.includeCreatedDateInTask && !/➕\s*\d{4}-\d{2}-\d{2}/u.test(cleanedTask)) {
            parts.push(`➕ ${moment().format('YYYY-MM-DD')}`);
        }

        const rawTaskLine = parts.join(' ');
        const taskLine = this.settings.normalizeTaskOrder
            ? normalizeTaskLineOrder(rawTaskLine)
            : repositionTaskKeywordTag(rawTaskLine);

        try {
            if (this.settings.organizeTasks) {
                await this.writeOrganizedTaskToFile(
                    targetPath,
                    taskLine,
                    this.settings.taskInsertPosition
                );
            } else {
                await this.writeLineToFile(targetPath, taskLine, this.settings.taskInsertPosition);
            }

            let targetLine = lineNumber;
            if (editor.getLine(targetLine) !== rawLine) {
                targetLine = -1;
                const total = editor.lineCount();
                for (let i = 0; i < total; i++) {
                    if (editor.getLine(i) === rawLine) {
                        targetLine = i;
                        break;
                    }
                }
            }

            if (targetLine !== -1) {
                const lineCount = editor.lineCount();
                if (targetLine < lineCount - 1) {
                    editor.replaceRange(
                        '',
                        { line: targetLine, ch: 0 },
                        { line: targetLine + 1, ch: 0 }
                    );
                } else if (targetLine > 0) {
                    const prevLineLength = editor.getLine(targetLine - 1).length;
                    editor.replaceRange(
                        '',
                        { line: targetLine - 1, ch: prevLineLength },
                        { line: targetLine, ch: rawLine.length }
                    );
                } else {
                    editor.replaceRange(
                        '',
                        { line: 0, ch: 0 },
                        { line: 0, ch: rawLine.length }
                    );
                }
            }

            new Notice(`Task moved to ${targetPath}`);
        } catch (err) {
            console.error('QuickCapture: Failed to move task to master task list:', err);
            new Notice(`Could not move task to ${targetPath}. Check the console for details.`);
        }
    }

    public async purgeCompletedTasks(olderThan: boolean) {
        const targetPath = normalizePath(this.settings.tasksFilePath || 'Master Task List.md');
        const file = this.app.vault.getAbstractFileByPath(targetPath);
        if (!(file instanceof TFile)) {
            new Notice(`Task list not found: ${targetPath}`);
            return;
        }

        const cutoff = olderThan
            ? moment()
                .subtract(this.settings.purgeCompletedAge, this.settings.purgeCompletedAgeUnit)
                .startOf('day')
            : null;

        try {
            let removed = 0;
            await this.app.vault.process(file, (content) => {
                const result = purgeCompletedTasksContent(content, cutoff);
                removed = result.removed;
                return result.content;
            });
            new Notice(`Purged ${removed} completed task${removed === 1 ? '' : 's'} from ${targetPath}`);
        } catch (err) {
            console.error('QuickCapture: Failed to purge completed tasks:', err);
            new Notice(`Could not purge completed tasks in ${targetPath}. Check the console for details.`);
        }
    }

    private initElectronRemote() {
        try {
            const electron = (window as any).require?.('electron');
            this.electronRemote = electron?.remote || (window as any).require?.('@electron/remote');
        } catch (err) {
            console.warn('QuickCapture: Electron remote API not available:', err);
        }
    }

    /**
     * Starts a tiny in-memory loopback HTTP bridge on 127.0.0.1:0 so our standalone
     * Electron BrowserWindow can load the full Quick Capture UI and save directly to the vault
     * in <1ms without ever touching or focusing the main Obsidian window.
     */
    private async startLoopbackServer(): Promise<void> {
        try {
            const http = (window as any).require?.('http');
            const crypto = (window as any).require?.('crypto');
            if (!http || !crypto?.randomBytes) {
                console.error('QuickCapture: Required local bridge APIs are unavailable.');
                return;
            }

            const bridgeToken = crypto.randomBytes(32).toString('hex');
            const server = http.createServer(async (req: any, res: any) => {
                const expectedHost = `127.0.0.1:${this.loopbackPort}`;
                const expectedOrigin = `http://${expectedHost}`;
                if (req.headers.host !== expectedHost) {
                    res.writeHead(403);
                    res.end();
                    return;
                }

                let requestUrl: URL;
                try {
                    requestUrl = new URL(req.url || '/', expectedOrigin);
                } catch {
                    res.writeHead(400);
                    res.end();
                    return;
                }
                if (requestUrl.origin !== expectedOrigin) {
                    res.writeHead(403);
                    res.end();
                    return;
                }

                if (req.method === 'GET' && requestUrl.pathname === '/') {
                    if (requestUrl.searchParams.get('token') !== bridgeToken) {
                        res.writeHead(401);
                        res.end();
                        return;
                    }
                    res.writeHead(200, {
                        'Content-Type': 'text/html; charset=utf-8',
                        'Cache-Control': 'no-store'
                    });
                    res.end(this.buildStandaloneBrowserWindowHtml());
                    return;
                }

                if (req.headers.origin && req.headers.origin !== expectedOrigin) {
                    res.writeHead(403);
                    res.end();
                    return;
                }
                if (req.headers.authorization !== `Bearer ${bridgeToken}`) {
                    res.writeHead(401);
                    res.end();
                    return;
                }

                const sendJson = (status: number, body: unknown) => {
                    res.writeHead(status, {
                        'Content-Type': 'application/json; charset=utf-8',
                        'Cache-Control': 'no-store'
                    });
                    res.end(JSON.stringify(body));
                };
                const route = requestUrl.pathname;

                if (req.method === 'GET' && route === '/api/state') {
                    res.writeHead(200, {
                        'Content-Type': 'application/json; charset=utf-8',
                        'Cache-Control': 'no-store'
                    });
                    res.end(JSON.stringify(this.getBridgeStatePayload()));
                    return;
                }

                const postRoutes = ['/api/close', '/api/calendar', '/api/set-dest', '/api/attach', '/api/capture'];
                if (req.method !== 'POST' || !postRoutes.includes(route)) {
                    res.writeHead(404);
                    res.end();
                    return;
                }

                if (req.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
                    sendJson(415, { ok: false, error: 'Expected application/json.' });
                    return;
                }

                const contentLength = Number(req.headers['content-length']);
                if (Number.isFinite(contentLength) && contentLength > MAX_BRIDGE_REQUEST_BYTES) {
                    sendJson(413, { ok: false, error: 'Request is too large.' });
                    req.resume();
                    return;
                }

                const chunks: Buffer[] = [];
                let requestBytes = 0;
                let requestTooLarge = false;
                req.on('data', (chunk: Buffer) => {
                    if (requestTooLarge) return;
                    requestBytes += chunk.length;
                    if (requestBytes > MAX_BRIDGE_REQUEST_BYTES) {
                        requestTooLarge = true;
                        chunks.length = 0;
                        sendJson(413, { ok: false, error: 'Request is too large.' });
                        return;
                    }
                    chunks.push(chunk);
                });
                req.on('end', async () => {
                    if (requestTooLarge) return;

                    let data: any;
                    try {
                        const rawBody = Buffer.concat(chunks).toString('utf-8');
                        data = rawBody ? JSON.parse(rawBody) : {};
                    } catch {
                        sendJson(400, { ok: false, error: 'Invalid JSON request.' });
                        return;
                    }
                    if (!data || typeof data !== 'object' || Array.isArray(data)) {
                        sendJson(400, { ok: false, error: 'Invalid request body.' });
                        return;
                    }

                    try {
                        if (route === '/api/close') {
                            this.hideStandaloneWindowOnly();
                            sendJson(200, { ok: true });
                            return;
                        }

                        if (route === '/api/calendar') {
                            if (
                                typeof data.open !== 'boolean' ||
                                (data.height !== undefined &&
                                    (typeof data.height !== 'number' ||
                                        !Number.isFinite(data.height) ||
                                        data.height < 0 ||
                                        data.height > 10000))
                            ) {
                                sendJson(400, { ok: false, error: 'Invalid calendar request.' });
                                return;
                            }
                            this.setStandaloneCalendarExpanded(data.open, data.height);
                            sendJson(200, { ok: true });
                            return;
                        }

                        if (route === '/api/set-dest') {
                            if (!isCaptureDestination(data.destination)) {
                                sendJson(400, { ok: false, error: 'Invalid capture destination.' });
                                return;
                            }
                            if (this.settings.rememberLastDestination) {
                                this.settings.lastUsedDestination = data.destination;
                                this.currentStandaloneDest = data.destination;
                                await this.saveSettings();
                            }
                            sendJson(200, { ok: true });
                            return;
                        }

                        if (route === '/api/attach') {
                            const fileName = data.name ?? 'Attachment.png';
                            const base64Data = data.base64;
                            const maxBase64Length = Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4;
                            const extension = typeof fileName === 'string' && fileName.includes('.')
                                ? fileName.slice(fileName.lastIndexOf('.') + 1)
                                : '';
                            if (
                                typeof fileName !== 'string' ||
                                fileName.length > 255 ||
                                /[\\/\u0000-\u001f]/.test(fileName) ||
                                (fileName.includes('.') && !/^[a-zA-Z0-9]{1,16}$/.test(extension)) ||
                                typeof base64Data !== 'string' ||
                                base64Data.length === 0 ||
                                base64Data.length > maxBase64Length ||
                                !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(base64Data)
                            ) {
                                sendJson(400, { ok: false, error: 'Invalid attachment request.' });
                                return;
                            }

                            const buf = Buffer.from(base64Data, 'base64');
                            if (buf.length === 0 || buf.length > MAX_ATTACHMENT_BYTES) {
                                sendJson(400, { ok: false, error: 'Attachment size is invalid.' });
                                return;
                            }
                            const arrayBuffer = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
                            const embedText = await this.saveAttachmentFromBuffer(fileName, arrayBuffer);
                            sendJson(200, { ok: true, embedText });
                            return;
                        }

                        if (route === '/api/capture') {
                            const validPriority = data.taskPriority === undefined ||
                                ['none', 'high', 'medium', 'low'].includes(data.taskPriority);
                            const validDates = isOptionalIsoDate(data.taskDueDate) &&
                                isOptionalIsoDate(data.taskScheduledDate) &&
                                isOptionalIsoDate(data.taskStartDate) &&
                                isOptionalIsoDate(data.targetDailyDate);
                            if (
                                !isCaptureDestination(data.destination) ||
                                typeof data.rawText !== 'string' ||
                                data.rawText.length > MAX_CAPTURE_TEXT_LENGTH ||
                                !validPriority ||
                                !validDates
                            ) {
                                sendJson(400, { ok: false, error: 'Invalid capture request.' });
                                return;
                            }
                            await this.executeCapturePayload(data);
                            this.hideStandaloneWindowOnly();
                            sendJson(200, { ok: true });
                        }
                    } catch (err) {
                        console.error('QuickCapture: Local bridge request failed:', err);
                        sendJson(500, { ok: false, error: 'Quick Capture request failed.' });
                    }
                });
            });

            server.on('connection', (socket: any) => {
                this.loopbackSockets.add(socket);
                socket.once('close', () => this.loopbackSockets.delete(socket));
            });

            await new Promise<void>((resolve) => {
                server.listen(0, '127.0.0.1', () => {
                    const addr = server.address();
                    if (addr && typeof addr === 'object') {
                        this.loopbackPort = addr.port;
                        this.loopbackToken = bridgeToken;
                    }
                    this.loopbackServer = server;
                    resolve();
                });
                server.on('error', (err: Error) => {
                    console.error('QuickCapture: Local bridge server error:', err);
                    resolve();
                });
            });
        } catch (err) {
            console.warn('QuickCapture: Could not start loopback server:', err);
        }
    }

    private stopLoopbackServer() {
        const server = this.loopbackServer;
        this.loopbackServer = null;
        this.loopbackPort = 0;
        this.loopbackToken = '';
        if (!server) return;

        server.close((err: NodeJS.ErrnoException | undefined) => {
            if (err && err.code !== 'ERR_SERVER_NOT_RUNNING') {
                console.error('QuickCapture: Could not close loopback server:', err);
            }
        });
        for (const socket of this.loopbackSockets) socket.destroy();
        this.loopbackSockets.clear();
    }

    public getBridgeStatePayload() {
        return {
            destination: this.currentStandaloneDest,
            settings: this.settings,
            todayStr: moment().format('YYYY-MM-DD')
        };
    }

    public async saveAttachmentFromBuffer(rawName: string, buffer: ArrayBuffer): Promise<string> {
        const timestampSuffix = moment().format('YYYYMMDDHHmmss');
        const extIndex = rawName.lastIndexOf('.');
        const baseName = extIndex !== -1 ? rawName.substring(0, extIndex) : rawName || 'Attachment';
        const ext = extIndex !== -1 ? rawName.substring(extIndex + 1) : 'png';
        const cleanBase = baseName.replace(/[\\/:*?"<>|]/g, '_') || `Pasted_Image_${timestampSuffix}`;

        const destPath = await (this.app.fileManager as any).getAvailablePathForAttachment(
            `${cleanBase}.${ext}`
        );
        const createdFile = await this.app.vault.createBinary(destPath, buffer);
        const markdownLink = this.app.fileManager.generateMarkdownLink(createdFile, '');
        const embedText = markdownLink.startsWith('!') ? markdownLink : `!${markdownLink}`;
        new Notice(`Attached ${createdFile.name}`);
        return embedText;
    }

    public async executeCapturePayload(payload: {
        destination: CaptureDestination;
        rawText: string;
        taskDueDate?: string;
        taskScheduledDate?: string;
        taskStartDate?: string;
        taskPriority?: TaskPriority;
        targetDailyDate?: string;
    }) {
        if (!isCaptureDestination(payload.destination)) {
            throw new Error('Invalid capture destination.');
        }
        const rawText = (payload.rawText || '').trim();
        if (!rawText) return;

        const dest = payload.destination;
        if (this.settings.rememberLastDestination) {
            this.settings.lastUsedDestination = dest;
            await this.saveSettings();
        }

        const now = moment();
        const formattedTime = now.format(this.settings.timestampFormat || 'YYYY-MM-DD HH:mm');

        if (dest === 'task') {
            const targetPath = normalizePath(this.settings.tasksFilePath || 'Master Task List.md');
            const cleanedTask = rawText.replace(/^-\s*\[[ xX]?\]\s*/, '');
            const parts: string[] = [`- [ ]`];

            const globalFilter = (
                this.settings.taskGlobalFilter ||
                this.detectedInfo.tasksGlobalFilter ||
                ''
            ).trim();
            if (globalFilter && !cleanedTask.includes(globalFilter)) {
                parts.push(globalFilter);
            }

            parts.push(cleanedTask);

            // Optional auto-tag (Tasks only): append the configured tag right after the
            // description, before priority/date fields. Blank setting = feature off.
            const taskAutoTag = (this.settings.taskAutoTag || '').trim();
            if (taskAutoTag && !cleanedTask.includes(taskAutoTag)) {
                parts.push(taskAutoTag.startsWith('#') ? taskAutoTag : `#${taskAutoTag}`);
            }

            if (payload.taskPriority === 'high') parts.push('⏫');
            else if (payload.taskPriority === 'medium') parts.push('🔼');
            else if (payload.taskPriority === 'low') parts.push('🔽');

            if (payload.taskStartDate) parts.push(`🛫 ${payload.taskStartDate}`);
            if (payload.taskScheduledDate) parts.push(`⏳ ${payload.taskScheduledDate}`);
            if (this.settings.includeCreatedDateInTask) parts.push(`➕ ${now.format('YYYY-MM-DD')}`);
            if (payload.taskDueDate) parts.push(`📅 ${payload.taskDueDate}`);

            const rawTaskLine = parts.join(' ');
            const taskLine = this.settings.normalizeTaskOrder
                ? normalizeTaskLineOrder(rawTaskLine)
                : repositionTaskKeywordTag(rawTaskLine);
            if (this.settings.organizeTasks) {
                await this.writeOrganizedTaskToFile(
                    targetPath,
                    taskLine,
                    this.settings.taskInsertPosition
                );
            } else {
                await this.writeLineToFile(targetPath, taskLine, this.settings.taskInsertPosition);
            }
            new Notice(`Task added to ${targetPath}`);
        } else if (dest === 'inbox') {
            if (this.settings.inboxMode === 'new-note-first-line') {
                const lines = rawText.split(/\r?\n/);
                const firstLine =
                    lines[0].replace(/[\\/:*?"<>|#]/g, '').trim() ||
                    `Quick Note ${moment().format('YYYY-MM-DD HHmmss')}`;
                const body = lines.slice(1).join('\n').trim();
                const folder = this.settings.inboxFolderPath.trim();
                const rawPath = folder ? `${folder}/${firstLine}.md` : `${firstLine}.md`;
                const fullPath = normalizePath(rawPath);

                await this.ensureParentFolderExists(fullPath);

                let finalPath = fullPath;
                let counter = 1;
                while (this.app.vault.getAbstractFileByPath(finalPath)) {
                    finalPath = fullPath.replace(/\.md$/, ` ${counter}.md`);
                    counter++;
                }

                await this.app.vault.create(finalPath, (body ? body : rawText) + '\n');
                new Notice(`Created ${finalPath}`);
            } else {
                const targetPath = normalizePath(this.settings.inboxFilePath || 'inbox.md');
                const entry = this.settings.includeTimestampInInbox
                    ? `- **${formattedTime}** — ${rawText}`
                    : `- ${rawText}`;
                await this.writeLineToFile(targetPath, entry, this.settings.inboxInsertPosition);
                new Notice(`Captured to ${targetPath}`);
            }
        } else {
            const targetDateStr = payload.targetDailyDate || now.format('YYYY-MM-DD');
            const targetMoment = moment(targetDateStr, 'YYYY-MM-DD');
            const dailyFile = await this.ensureDailyNoteForDate(targetMoment);

            let heading = this.settings.dailyCaptureHeading.trim();
            let tag = '';

            if (dest === 'journal') {
                heading = this.settings.journalHeading.trim();
                tag = this.settings.journalTag.trim();
            } else if (dest === 'gratitude') {
                heading = this.settings.gratitudeHeading.trim();
                tag = this.settings.gratitudeTag.trim();
            } else if (dest === 'win') {
                heading = this.settings.winHeading.trim();
                tag = this.settings.winTag.trim();
            }

            const timePrefix = now.format('HH:mm');
            const tagPart = tag ? ` ${tag}` : '';
            const bulletLine = `- **${timePrefix}**${tagPart} ${rawText}`;

            await this.insertUnderHeading(dailyFile, heading, bulletLine);
            new Notice(`Captured to ${dailyFile.path}${heading ? ` (${heading})` : ''}`);
        }
    }

    public async insertUnderHeading(file: TFile, heading: string, lineToInsert: string) {
        if (!heading) {
            await this.writeLineToFile(file.path, lineToInsert, 'append');
            return;
        }

        await this.app.vault.process(file, (content) => {
            const lines = content.split(/\r?\n/);
            const targetNormalized = heading.trim().toLowerCase();
            const headingMatch = heading.trim().match(/^(#+)/);
            const targetLevel = headingMatch ? headingMatch[1].length : 3;

            let headingIndex = -1;
            for (let i = 0; i < lines.length; i++) {
                if (lines[i].trim().toLowerCase() === targetNormalized) {
                    headingIndex = i;
                    break;
                }
            }

            if (headingIndex === -1) {
                const cleanEnd = content.replace(/\s+$/, '');
                const prefix = cleanEnd.length > 0 ? `${cleanEnd}\n\n` : '';
                return `${prefix}${heading}\n${lineToInsert}\n`;
            }

            let insertAt = lines.length;
            for (let i = headingIndex + 1; i < lines.length; i++) {
                const m = lines[i].match(/^(#+)\s+/);
                if (m && m[1].length <= targetLevel) {
                    insertAt = i;
                    break;
                }
            }

            while (insertAt > headingIndex + 1 && lines[insertAt - 1].trim() === '') {
                insertAt--;
            }

            lines.splice(insertAt, 0, lineToInsert);
            return lines.join('\n');
        });
    }

    public async writeLineToFile(
        filePath: string,
        lineToInsert: string,
        position: 'append' | 'prepend'
    ) {
        await this.ensureParentFolderExists(filePath);
        const existing = this.app.vault.getAbstractFileByPath(filePath);

        if (existing instanceof TFile) {
            await this.app.vault.process(existing, (currentData) => {
                if (!currentData.trim()) {
                    return lineToInsert + '\n';
                }
                if (position === 'prepend') {
                    const fmMatch = currentData.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
                    if (fmMatch) {
                        const fm = fmMatch[0];
                        const rest = currentData.slice(fm.length);
                        return `${fm}${lineToInsert}\n${rest}`;
                    }
                    return `${lineToInsert}\n${currentData}`;
                } else {
                    const separator = currentData.endsWith('\n') ? '' : '\n';
                    return `${currentData}${separator}${lineToInsert}\n`;
                }
            });
        } else {
            await this.app.vault.create(filePath, `${lineToInsert}\n`);
        }
    }

    private async writeOrganizedTaskToFile(
        filePath: string,
        taskLine: string,
        position: 'append' | 'prepend'
    ) {
        await this.ensureParentFolderExists(filePath);
        const existing = this.app.vault.getAbstractFileByPath(filePath);

        if (existing instanceof TFile) {
            await this.app.vault.process(existing, (currentData) => {
                if (!currentData.trim()) {
                    return `${taskLine}\n`;
                }

                let updatedData: string;
                if (position === 'prepend') {
                    const frontmatter = currentData.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
                    if (frontmatter) {
                        updatedData = `${frontmatter[0]}${taskLine}\n${currentData.slice(frontmatter[0].length)}`;
                    } else {
                        updatedData = `${taskLine}\n${currentData}`;
                    }
                } else {
                    const separator = currentData.endsWith('\n') ? '' : '\n';
                    updatedData = `${currentData}${separator}${taskLine}\n`;
                }

                return organizeTaskListContent(
                    updatedData,
                    position,
                    this.settings.normalizeTaskOrder
                );
            });
        } else {
            const fileContent = organizeTaskListContent(
                `${taskLine}\n`,
                position,
                this.settings.normalizeTaskOrder
            );
            await this.app.vault.create(filePath, fileContent);
        }
    }

    /**
     * Triggered when user presses the global shortcut.
     * Opens Quick Capture as an independent OS floating window WITHOUT ever touching,
     * restoring, showing, or hiding the main Obsidian window!
     */
    public async triggerGlobalQuickCapture(forcedDest?: CaptureDestination) {
        const initialDest = forcedDest
            ? forcedDest
            : this.settings.rememberLastDestination
            ? this.settings.lastUsedDestination
            : this.settings.defaultDestination;

        this.currentStandaloneDest = initialDest;

        const opened = await this.openTrueStandaloneBrowserWindow(Boolean(forcedDest));
        if (!opened) {
            new Notice('Quick Capture could not open its standalone window. Check the console for details.');
        }
    }

    /**
     * Creates or toggles a true OS-level Electron BrowserWindow (`new electronRemote.BrowserWindow(...)`)
     * that is completely independent of the main Obsidian window.
     */
    private async openTrueStandaloneBrowserWindow(isForcedDest: boolean): Promise<boolean> {
        try {
            const BrowserWindow = this.electronRemote?.BrowserWindow;
            if (!BrowserWindow) {
                console.error('QuickCapture: Electron BrowserWindow API is unavailable.');
                return false;
            }

            if (!this.loopbackPort || !this.loopbackToken) {
                await this.startLoopbackServer();
            }
            if (!this.loopbackPort || !this.loopbackToken) {
                console.error('QuickCapture: Standalone window bridge is unavailable.');
                return false;
            }

            const width = this.getConfiguredCaptureWindowSize('width');
            const height = this.getConfiguredCaptureWindowSize('height');

            if (this.standaloneWin && !this.standaloneWin.isDestroyed()) {
                const isVis = this.standaloneWin.isVisible();
                const isFoc = this.standaloneWin.isFocused();
                if (isVis && isFoc && !isForcedDest) {
                    this.hideStandaloneWindowOnly();
                    return true;
                }
                try {
                    await this.standaloneWin.webContents.executeJavaScript(
                        `window.__qcReset && window.__qcReset(${serializeForInlineScript(this.getBridgeStatePayload())});`
                    );
                } catch {}
                this.standaloneWin.show();
                this.standaloneWin.focus();
                return true;
            }

            const bw = new BrowserWindow({
                width,
                height,
                minWidth: 420,
                minHeight: 240,
                frame: false,
                transparent: false,
                resizable: true,
                movable: true,
                minimizable: false,
                maximizable: false,
                fullscreenable: false,
                alwaysOnTop: true,
                skipTaskbar: true,
                show: false,
                backgroundColor: '#1e1e24',
                webPreferences: {
                    contextIsolation: false,
                    nodeIntegration: false
                }
            });

            this.standaloneWin = bw;
            bw.setMenuBarVisibility?.(false);
            bw.setAlwaysOnTop?.(true, 'floating');
            bw.setSkipTaskbar?.(true);
            this.centerPopupWindow(bw, width, height);

            bw.on('resize', () => {
                if (!this.calendarExpanded) {
                    this.scheduleStandaloneWindowSizeSave();
                }
            });
            bw.on('closed', () => {
                if (this.standaloneWindowSizeSaveTimer) {
                    clearTimeout(this.standaloneWindowSizeSaveTimer);
                    this.standaloneWindowSizeSaveTimer = null;
                }
                this.standaloneWin = null;
            });

            await bw.loadURL(
                `http://127.0.0.1:${this.loopbackPort}/?token=${encodeURIComponent(this.loopbackToken)}`
            );
            bw.show();
            bw.focus();
            return true;
        } catch (err) {
            console.error('QuickCapture: True standalone BrowserWindow failed:', err);
            return false;
        }
    }

    private getConfiguredCaptureWindowSize(dimension: 'width' | 'height'): number {
        const configured = dimension === 'width'
            ? this.settings.captureWindowWidth
            : this.settings.captureWindowHeight;
        const fallback = dimension === 'width' ? 620 : 350;
        const minimum = dimension === 'width' ? 420 : 240;
        return Number.isFinite(configured) ? Math.max(minimum, Math.round(configured)) : fallback;
    }

    private scheduleStandaloneWindowSizeSave() {
        if (this.standaloneWindowSizeSaveTimer) {
            clearTimeout(this.standaloneWindowSizeSaveTimer);
        }
        this.standaloneWindowSizeSaveTimer = setTimeout(() => {
            this.standaloneWindowSizeSaveTimer = null;
            this.saveStandaloneWindowSize();
        }, 250);
    }

    private saveStandaloneWindowSize() {
        if (!this.standaloneWin || this.standaloneWin.isDestroyed?.() || this.calendarExpanded) return;
        const [width, height] = this.standaloneWin.getSize();
        this.settings.captureWindowWidth = width;
        this.settings.captureWindowHeight = height;
        void this.saveSettings().catch((err) => {
            console.error('QuickCapture: Could not save capture window size:', err);
        });
    }

    private setStandaloneCalendarExpanded(open: boolean, requestedHeight?: number) {
        const win = this.standaloneWin;
        if (!win || win.isDestroyed?.()) return;

        if (open) {
            if (!this.standaloneBaseBounds) {
                const bounds = win.getBounds();
                this.standaloneBaseBounds = {
                    x: bounds.x,
                    y: bounds.y,
                    width: bounds.width,
                    height: bounds.height
                };
                this.settings.captureWindowWidth = bounds.width;
                this.settings.captureWindowHeight = bounds.height;
                void this.saveSettings().catch((err) => {
                    console.error('QuickCapture: Could not save capture window size:', err);
                });
            }
            this.calendarExpanded = true;
            const base = this.standaloneBaseBounds;
            const height = Math.max(
                base.height,
                typeof requestedHeight === 'number' && Number.isFinite(requestedHeight)
                    ? Math.ceil(requestedHeight)
                    : base.height
            );
            this.setStandaloneBoundsKeepingBottom(base, base.width, height);
            return;
        }

        if (!this.standaloneBaseBounds) {
            this.calendarExpanded = false;
            return;
        }
        const base = this.standaloneBaseBounds;
        this.calendarExpanded = false;
        this.standaloneBaseBounds = null;
        this.setStandaloneBoundsKeepingBottom(base, base.width, base.height);
        this.settings.captureWindowWidth = base.width;
        this.settings.captureWindowHeight = base.height;
        void this.saveSettings().catch((err) => {
            console.error('QuickCapture: Could not save capture window size:', err);
        });
    }

    private setStandaloneBoundsKeepingBottom(
        base: { x: number; y: number; width: number; height: number },
        width: number,
        requestedHeight: number
    ) {
        const screen = this.electronRemote?.screen;
        const display = screen?.getDisplayMatching?.(base) ||
            screen?.getDisplayNearestPoint?.({ x: base.x, y: base.y });
        const workArea = display?.workArea;
        const height = workArea
            ? Math.min(requestedHeight, workArea.height)
            : requestedHeight;
        const maxX = workArea ? workArea.x + workArea.width - width : base.x;
        const maxY = workArea ? workArea.y + workArea.height - height : base.y;
        const x = workArea ? Math.max(workArea.x, Math.min(base.x, maxX)) : base.x;
        const y = workArea
            ? Math.max(workArea.y, Math.min(base.y + base.height - height, maxY))
            : base.y + base.height - height;
        this.standaloneWin?.setBounds({ x, y, width, height });
    }

    private centerPopupWindow(ebw: any, width: number, height: number) {
        try {
            const screen = this.electronRemote?.screen;
            if (screen?.getCursorScreenPoint && screen?.getDisplayNearestPoint) {
                const pt = screen.getCursorScreenPoint();
                const display = screen.getDisplayNearestPoint(pt);
                if (display?.workArea) {
                    const wa = display.workArea;
                    const x = Math.round(wa.x + (wa.width - width) / 2);
                    const y = Math.round(wa.y + Math.max(60, (wa.height - height) / 3));
                    ebw.setBounds({ x, y, width, height });
                    return;
                }
            }
            ebw.center?.();
        } catch {}
    }

    /**
     * Hides ONLY the standalone floating Quick Capture window.
     * NEVER hides, minimizes, or alters the main Obsidian window!
     */
    public hideStandaloneWindowOnly() {
        try {
            if (this.standaloneWin && !this.standaloneWin.isDestroyed?.()) {
                this.setStandaloneCalendarExpanded(false);
                this.saveStandaloneWindowSize();
                this.standaloneWin.hide();
            }
        } catch {}
    }

    public destroyStandaloneWindow() {
        if (this.standaloneWin) {
            try {
                if (!this.standaloneWin.isDestroyed?.()) {
                    this.setStandaloneCalendarExpanded(false);
                    this.saveStandaloneWindowSize();
                    this.standaloneWin.destroy();
                }
            } catch {}
            this.standaloneWin = null;
        }
    }

    /**
     * Generates the self-contained HTML + JS document served to the standalone Electron BrowserWindow.
     * Includes full support for:
     * - All 6 Destinations (Daily, Journal, Gratitude, Win, Inbox, Task)
     * - Interactive Things 3 Calendar Date Picker (Due Date, Start Date, Priority, Target Daily Note Day)
     * - Clipboard Paste & Drag-and-Drop Attachments
     * - Keyboard shortcuts (Tab, Ctrl+0/J/G/W/I/T, Ctrl+D, Enter to Save, Esc to Close)
     */
    private buildStandaloneBrowserWindowHtml(): string {
        const initialStateJson = serializeForInlineScript(this.getBridgeStatePayload());
        const svgsJson = serializeForInlineScript(LUCIDE_SVGS);
        const destMetaJson = serializeForInlineScript(DESTINATION_META);

        return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8" />
<title>Quick Capture</title>
<style>
${EMBEDDED_STANDALONE_CSS}
html, body {
    margin: 0;
    padding: 0;
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: #1e1e24;
}
</style>
</head>
<body class="theme-dark">
<div id="qc-standalone-root" class="qc-standalone-root"></div>
<script>
(function() {
    const bridgeToken = new URLSearchParams(location.search).get('token') || '';
    history.replaceState(null, '', '/');
    const SVGS = ${svgsJson};
    const DEST_META = ${destMetaJson};
    let state = ${initialStateJson};

    let destination = state.destination || 'inbox';
    let settings = state.settings || {};
    let todayStr = state.todayStr || new Date().toISOString().slice(0, 10);

    let taskDueDate = '';
    let taskStartDate = '';
    let taskPriority = 'none';
    let targetDailyDate = todayStr;

    let activeCalField = 'due';
    let calViewYear = parseInt(todayStr.slice(0, 4), 10);
    let calViewMonth = parseInt(todayStr.slice(5, 7), 10) - 1; // 0-indexed
    let isSubmitting = false;

    const root = document.getElementById('qc-standalone-root');
    let textAreaEl, pillsRowEl, destBtnEl, destMenuEl = null, targetSubEl;
    let taskCalBtnEl, dailyCalBtnEl, fileInputEl, calPopoverEl = null;

    function el(parent, tag, cls, text, attrs) {
        const node = document.createElement(tag);
        if (cls) node.className = cls;
        if (text !== undefined) node.textContent = text;
        if (attrs) {
            for (const k in attrs) node.setAttribute(k, attrs[k]);
        }
        parent.appendChild(node);
        return node;
    }

    function pad2(n) { return n < 10 ? '0' + n : '' + n; }
    function fmtYMD(d) {
        return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
    }
    function parseYMD(s) {
        const p = (s || todayStr).split('-').map(Number);
        return new Date(p[0], (p[1] || 1) - 1, p[2] || 1);
    }
    function friendlyDate(s) {
        if (!s) return '';
        const d = parseYMD(s);
        const t = parseYMD(todayStr);
        const diff = Math.round((d.getTime() - t.getTime()) / 86400000);
        if (diff === 0) return 'Today (' + s + ')';
        if (diff === 1) return 'Tomorrow (' + s + ')';
        if (diff === -1) return 'Yesterday (' + s + ')';
        const days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
        const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        return days[d.getDay()] + ', ' + months[d.getMonth()] + ' ' + d.getDate() + ' (' + s + ')';
    }

    async function postApi(path, body) {
        try {
            const res = await fetch(path, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': 'Bearer ' + bridgeToken
                },
                body: JSON.stringify(body || {})
            });
            return await res.json();
        } catch (e) {
            console.error(e);
            return { ok: false };
        }
    }

    function closePopup() {
        postApi('/api/close', {});
    }

    function closeCalPopover(notifyWindow = true) {
        if (calPopoverEl) {
            calPopoverEl.remove();
            calPopoverEl = null;
            if (notifyWindow) postApi('/api/calendar', { open: false });
        }
    }

    function closeDestMenu() {
        if (destMenuEl) {
            destMenuEl.remove();
            destMenuEl = null;
        }
    }

    function focusInput() {
        setTimeout(() => { if (textAreaEl) textAreaEl.focus(); }, 15);
    }

    window.__qcReset = function(newState) {
        if (newState) {
            state = newState;
            destination = newState.destination || destination;
            settings = newState.settings || settings;
            todayStr = newState.todayStr || todayStr;
        }
        isSubmitting = false;
        taskDueDate = '';
        taskStartDate = '';
        taskPriority = 'none';
        targetDailyDate = todayStr;
        if (textAreaEl) textAreaEl.value = '';
        closeCalPopover();
        closeDestMenu();
        setDestination(destination, false);
        focusInput();
    };

    function setDestination(dest, notifyServer = true) {
        destination = dest;
        if (notifyServer) {
            postApi('/api/set-dest', { destination: dest });
        }
        const meta = DEST_META[dest] || DEST_META.inbox;
        destBtnEl.innerHTML = (SVGS[meta.icon] || '') + '<span>' + meta.label + '</span>' + SVGS['chevron-down'];
        textAreaEl.placeholder = meta.placeholder;

        if (dest === 'task') {
            taskCalBtnEl.style.display = 'inline-flex';
            dailyCalBtnEl.style.display = 'none';
        } else if (['daily', 'journal', 'gratitude', 'win'].includes(dest)) {
            taskCalBtnEl.style.display = 'none';
            dailyCalBtnEl.style.display = 'inline-flex';
        } else {
            taskCalBtnEl.style.display = 'none';
            dailyCalBtnEl.style.display = 'none';
            closeCalPopover();
        }

        updateTargetSubtitle();
        renderPills();
    }

    function updateTargetSubtitle() {
        const dailyFile = (targetDailyDate || todayStr) + '.md';
        if (destination === 'daily') {
            const h = (settings.dailyCaptureHeading || '').trim();
            targetSubEl.textContent = h ? (dailyFile + ' → ' + h) : dailyFile;
        } else if (destination === 'journal') {
            targetSubEl.textContent = dailyFile + ' → ' + (settings.journalHeading || '### Journal');
        } else if (destination === 'gratitude') {
            targetSubEl.textContent = dailyFile + ' → ' + (settings.gratitudeHeading || '### Gratitude');
        } else if (destination === 'win') {
            targetSubEl.textContent = dailyFile + ' → ' + (settings.winHeading || '### Wins');
        } else if (destination === 'inbox') {
            if (settings.inboxMode === 'new-note-first-line') {
                targetSubEl.textContent = 'New Note in ' + (settings.inboxFolderPath || 'Vault Root') + '/';
            } else {
                targetSubEl.textContent = '→ ' + (settings.inboxFilePath || 'inbox.md');
            }
        } else if (destination === 'task') {
            targetSubEl.textContent = '→ ' + (settings.tasksFilePath || 'Master Task List.md');
        }

        const hasTaskMeta = Boolean(taskDueDate || taskStartDate || taskPriority !== 'none');
        taskCalBtnEl.classList.toggle('has-value', hasTaskMeta);
        dailyCalBtnEl.classList.toggle('has-value', targetDailyDate !== todayStr);
    }

    function renderPills() {
        pillsRowEl.innerHTML = '';
        if (destination === 'task') {
            if (taskDueDate) {
                const p = el(pillsRowEl, 'div', 'qc-pill', '📅 Due: ' + friendlyDate(taskDueDate));
                const c = el(p, 'span', 'qc-pill-clear', '×');
                c.onclick = (e) => { e.stopPropagation(); taskDueDate = ''; renderPills(); updateTargetSubtitle(); };
                p.onclick = (e) => { e.stopPropagation(); toggleCalPopover('due'); };
            }
            if (taskStartDate) {
                const p = el(pillsRowEl, 'div', 'qc-pill', '🛫 Start: ' + friendlyDate(taskStartDate));
                const c = el(p, 'span', 'qc-pill-clear', '×');
                c.onclick = (e) => { e.stopPropagation(); taskStartDate = ''; renderPills(); updateTargetSubtitle(); };
                p.onclick = (e) => { e.stopPropagation(); toggleCalPopover('start'); };
            }
            if (taskPriority !== 'none') {
                const map = { high: '⏫ High Priority', medium: '🔼 Medium Priority', low: '🔽 Low Priority' };
                const p = el(pillsRowEl, 'div', 'qc-pill', map[taskPriority]);
                const c = el(p, 'span', 'qc-pill-clear', '×');
                c.onclick = (e) => { e.stopPropagation(); taskPriority = 'none'; renderPills(); updateTargetSubtitle(); };
            }
        } else if (['daily', 'journal', 'gratitude', 'win'].includes(destination)) {
            if (targetDailyDate !== todayStr) {
                const p = el(pillsRowEl, 'div', 'qc-pill', '📆 Target Day: ' + friendlyDate(targetDailyDate));
                const c = el(p, 'span', 'qc-pill-clear', '×');
                c.onclick = (e) => { e.stopPropagation(); targetDailyDate = todayStr; renderPills(); updateTargetSubtitle(); };
                p.onclick = (e) => { e.stopPropagation(); toggleCalPopover('dailyTarget'); };
            }
        }
    }

    function toggleDestMenu() {
        if (destMenuEl) { closeDestMenu(); return; }
        closeCalPopover();
        const menu = el(destBtnEl.parentElement, 'div', 'qc-dest-menu');
        menu.onclick = (e) => e.stopPropagation();
        destMenuEl = menu;

        Object.keys(DEST_META).forEach((k) => {
            const m = DEST_META[k];
            const item = el(menu, 'button', 'qc-dest-menu-item ' + (destination === k ? 'is-active' : ''), undefined, { type: 'button' });
            const left = el(item, 'span', 'qc-dest-menu-left');
            left.innerHTML = (SVGS[m.icon] || '') + '<span>' + m.label + '</span>';
            el(item, 'span', 'qc-dest-menu-hint', m.shortcutHint);
            item.onclick = () => {
                setDestination(k, true);
                closeDestMenu();
                focusInput();
            };
        });
    }

    function getActiveCalVal() {
        if (activeCalField === 'due') return taskDueDate;
        if (activeCalField === 'start') return taskStartDate;
        return targetDailyDate;
    }

    function setActiveCalVal(val) {
        if (activeCalField === 'due') taskDueDate = val;
        else if (activeCalField === 'start') taskStartDate = val;
        else targetDailyDate = val || todayStr;
        renderPills();
        updateTargetSubtitle();
        renderCalPopover();
    }

    function toggleCalPopover(field) {
        if (calPopoverEl && activeCalField === field) {
            closeCalPopover();
            return;
        }
        activeCalField = field;
        const cur = parseYMD(getActiveCalVal() || todayStr);
        calViewYear = cur.getFullYear();
        calViewMonth = cur.getMonth();
        renderCalPopover();
    }

    function renderCalPopover() {
        closeCalPopover(false);
        const pop = el(root, 'div', 'qc-calendar-popover');
        pop.onclick = (e) => e.stopPropagation();
        calPopoverEl = pop;

        if (destination === 'task') {
            const tabs = el(pop, 'div', 'qc-cal-type-tabs');
            const dueBtn = el(tabs, 'button', 'qc-cal-type-tab ' + (activeCalField === 'due' ? 'is-active' : ''), '📅 Due Date', { type: 'button' });
            const startBtn = el(tabs, 'button', 'qc-cal-type-tab ' + (activeCalField === 'start' ? 'is-active' : ''), '🛫 Start Date', { type: 'button' });
            dueBtn.onclick = () => { activeCalField = 'due'; renderCalPopover(); };
            startBtn.onclick = () => { activeCalField = 'start'; renderCalPopover(); };
        }

        const presetsGrid = el(pop, 'div', 'qc-cal-presets');
        const dToday = parseYMD(todayStr);
        const dTom = new Date(dToday.getFullYear(), dToday.getMonth(), dToday.getDate() + 1);
        const daysToSat = (6 - dToday.getDay() + 7) % 7 || 7;
        const dSat = new Date(dToday.getFullYear(), dToday.getMonth(), dToday.getDate() + daysToSat);
        const daysToMon = (1 - dToday.getDay() + 7) % 7 || 7;
        const dMon = new Date(dToday.getFullYear(), dToday.getMonth(), dToday.getDate() + daysToMon);

        const daysShort = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
        const monthsShort = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
        const monthsFull = ['January','February','March','April','May','June','July','August','September','October','November','December'];

        [
            { label: '★ Today', sub: daysShort[dToday.getDay()], val: fmtYMD(dToday) },
            { label: '☀ Tomorrow', sub: daysShort[dTom.getDay()], val: fmtYMD(dTom) },
            { label: '🛋 Weekend', sub: monthsShort[dSat.getMonth()] + ' ' + dSat.getDate(), val: fmtYMD(dSat) },
            { label: '⇥ Next Mon', sub: monthsShort[dMon.getMonth()] + ' ' + dMon.getDate(), val: fmtYMD(dMon) }
        ].forEach((p) => {
            const b = el(presetsGrid, 'button', 'qc-cal-preset-btn', undefined, { type: 'button' });
            el(b, 'span', undefined, p.label);
            el(b, 'span', 'qc-cal-preset-sub', p.sub);
            b.onclick = () => setActiveCalVal(p.val);
        });

        const hdr = el(pop, 'div', 'qc-cal-header');
        el(hdr, 'span', undefined, monthsFull[calViewMonth] + ' ' + calViewYear);
        const nav = el(hdr, 'div', 'qc-cal-nav');
        const prev = el(nav, 'button', 'qc-cal-nav-btn', '◀', { type: 'button' });
        const dot = el(nav, 'button', 'qc-cal-nav-btn', '●', { type: 'button' });
        const next = el(nav, 'button', 'qc-cal-nav-btn', '▶', { type: 'button' });

        prev.onclick = () => {
            calViewMonth--;
            if (calViewMonth < 0) { calViewMonth = 11; calViewYear--; }
            renderCalPopover();
        };
        dot.onclick = () => {
            calViewYear = dToday.getFullYear();
            calViewMonth = dToday.getMonth();
            renderCalPopover();
        };
        next.onclick = () => {
            calViewMonth++;
            if (calViewMonth > 11) { calViewMonth = 0; calViewYear++; }
            renderCalPopover();
        };

        const grid = el(pop, 'div', 'qc-cal-grid');
        ['Su','Mo','Tu','We','Th','Fr','Sa'].forEach((w) => el(grid, 'div', 'qc-cal-dow', w));

        const firstOfMonth = new Date(calViewYear, calViewMonth, 1);
        const startOffset = firstOfMonth.getDay();
        const gridStart = new Date(calViewYear, calViewMonth, 1 - startOffset);
        const selectedVal = getActiveCalVal();

        for (let i = 0; i < 42; i++) {
            const cellDate = new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i);
            const cellStr = fmtYMD(cellDate);
            const btn = el(grid, 'button', 'qc-cal-day', String(cellDate.getDate()), { type: 'button', title: cellStr });
            if (cellDate.getMonth() !== calViewMonth) btn.classList.add('is-outside');
            if (cellStr === todayStr) btn.classList.add('is-today');
            if (cellStr === selectedVal) btn.classList.add('is-selected');
            btn.onclick = () => setActiveCalVal(cellStr);
        }

        if (destination === 'task') {
            const prioRow = el(pop, 'div', 'qc-cal-presets');
            [
                { id: 'high', label: '⏫ High' },
                { id: 'medium', label: '🔼 Med' },
                { id: 'low', label: '🔽 Low' },
                { id: 'none', label: '○ Normal' }
            ].forEach((pr) => {
                const pb = el(prioRow, 'button', 'qc-cal-preset-btn', pr.label, { type: 'button' });
                if (taskPriority === pr.id && pr.id !== 'none') pb.style.borderColor = '#8b5cf6';
                pb.onclick = () => {
                    taskPriority = pr.id;
                    renderPills();
                    updateTargetSubtitle();
                    renderCalPopover();
                };
            });
        }

        const ftr = el(pop, 'div', 'qc-cal-footer');
        const nativeInp = el(ftr, 'input', 'qc-cal-native-input', undefined, {
            type: 'date',
            value: selectedVal || todayStr
        });
        nativeInp.onchange = () => { if (nativeInp.value) setActiveCalVal(nativeInp.value); };
        const clr = el(ftr, 'button', 'qc-cal-clear-btn', 'Clear Date', { type: 'button' });
        clr.onclick = () => setActiveCalVal('');
        postApi('/api/calendar', {
            open: true,
            height: Math.ceil(pop.scrollHeight + 58)
        });
    }

    async function handleFiles(fileList) {
        for (let i = 0; i < fileList.length; i++) {
            const f = fileList[i];
            const reader = new FileReader();
            const b64 = await new Promise((resolve) => {
                reader.onload = () => {
                    const s = String(reader.result || '');
                    const idx = s.indexOf(',');
                    resolve(idx !== -1 ? s.slice(idx + 1) : s);
                };
                reader.readAsDataURL(f);
            });
            const resp = await postApi('/api/attach', { name: f.name || 'Pasted_Image.png', base64: b64 });
            if (resp && resp.ok && resp.embedText) {
                const start = textAreaEl.selectionStart ?? textAreaEl.value.length;
                const end = textAreaEl.selectionEnd ?? textAreaEl.value.length;
                const prefix = start > 0 && textAreaEl.value.charCodeAt(start - 1) !== 10 ? ' ' : '';
                textAreaEl.setRangeText(prefix + resp.embedText + ' ', start, end, 'end');
            }
        }
    }

    async function submitCapture() {
        if (isSubmitting) return;
        const rawText = (textAreaEl.value || '').trim();
        if (!rawText) {
            closePopup();
            return;
        }
        isSubmitting = true;
        await postApi('/api/capture', {
            destination,
            rawText,
            taskDueDate,
            taskStartDate,
            taskPriority,
            targetDailyDate
        });
        textAreaEl.value = '';
        isSubmitting = false;
    }

    // Build UI
    const topBar = el(root, 'div', 'qc-top-bar');
    el(topBar, 'div', 'qc-top-title', '⚡ QUICK CAPTURE');
    const topClose = el(topBar, 'button', 'qc-top-close', '×', { type: 'button', title: 'Close (Esc)' });
    topClose.onclick = () => closePopup();

    const textWrap = el(root, 'div', 'qc-textarea-wrapper');
    textAreaEl = el(textWrap, 'textarea', 'qc-textarea');

    pillsRowEl = el(root, 'div', 'qc-pills-row');

    const bottomBar = el(root, 'div', 'qc-bottom-bar');
    const bottomLeft = el(bottomBar, 'div', 'qc-bottom-left');

    destBtnEl = el(bottomLeft, 'button', 'qc-dest-btn', undefined, { type: 'button' });
    destBtnEl.onclick = (e) => { e.stopPropagation(); toggleDestMenu(); };

    targetSubEl = el(bottomLeft, 'div', 'qc-target-sub');

    const bottomRight = el(bottomBar, 'div', 'qc-bottom-right');

    taskCalBtnEl = el(bottomRight, 'button', 'qc-icon-btn', undefined, { type: 'button', title: 'Due / Start Date & Priority (Ctrl+D)' });
    taskCalBtnEl.innerHTML = SVGS['calendar-days'];
    taskCalBtnEl.onclick = (e) => { e.stopPropagation(); closeDestMenu(); toggleCalPopover('due'); };

    dailyCalBtnEl = el(bottomRight, 'button', 'qc-icon-btn', undefined, { type: 'button', title: 'Target Daily Note Date (Ctrl+D)' });
    dailyCalBtnEl.innerHTML = SVGS['calendar-clock'];
    dailyCalBtnEl.onclick = (e) => { e.stopPropagation(); closeDestMenu(); toggleCalPopover('dailyTarget'); };

    const attachBtn = el(bottomRight, 'button', 'qc-icon-btn', undefined, { type: 'button', title: 'Attach File / Screenshot' });
    attachBtn.innerHTML = SVGS['paperclip'];
    fileInputEl = el(bottomRight, 'input', undefined, undefined, { type: 'file', multiple: 'true', style: 'display:none;' });
    attachBtn.onclick = () => fileInputEl.click();
    fileInputEl.onchange = async () => {
        if (fileInputEl.files && fileInputEl.files.length > 0) {
            await handleFiles(fileInputEl.files);
            fileInputEl.value = '';
            focusInput();
        }
    };

    const submitBtn = el(bottomRight, 'button', 'qc-btn-submit', 'Capture ↵', { type: 'button' });
    submitBtn.onclick = () => submitCapture();

    const strip = el(root, 'div', 'qc-shortcut-strip');
    const submitKey = settings.submitOnEnter !== false ? 'Enter' : 'Ctrl+Enter';
    strip.innerHTML = '<span><kbd class="qc-kbd">Ctrl+0</kbd> Daily <kbd class="qc-kbd">Ctrl+J</kbd> Journal <kbd class="qc-kbd">Ctrl+G</kbd> Gratitude <kbd class="qc-kbd">Ctrl+W</kbd> Win <kbd class="qc-kbd">Ctrl+I</kbd> Inbox <kbd class="qc-kbd">Ctrl+T</kbd> Task</span><span><kbd class="qc-kbd">Ctrl+D</kbd> Date <kbd class="qc-kbd">' + submitKey + '</kbd> Save <kbd class="qc-kbd">Esc</kbd> Close</span>';

    root.onclick = () => { closeCalPopover(); closeDestMenu(); };

    textAreaEl.addEventListener('keydown', async (e) => {
        const ctrl = e.ctrlKey || e.metaKey;
        if (e.key === 'Escape') {
            e.preventDefault();
            if (calPopoverEl || destMenuEl) {
                closeCalPopover();
                closeDestMenu();
                focusInput();
            } else {
                closePopup();
            }
            return;
        }
        if (e.key === 'Tab') {
            e.preventDefault();
            const order = ['daily','journal','gratitude','win','inbox','task'];
            const next = (order.indexOf(destination) + (e.shiftKey ? order.length - 1 : 1)) % order.length;
            setDestination(order[next], true);
            return;
        }
        if (ctrl && !e.shiftKey && !e.altKey) {
            const k = e.key.toLowerCase();
            const map = { '0': 'daily', 'j': 'journal', 'g': 'gratitude', 'w': 'win', 'i': 'inbox', 't': 'task' };
            if (map[k]) {
                e.preventDefault();
                setDestination(map[k], true);
                return;
            }
            if (k === 'd') {
                e.preventDefault();
                if (destination === 'task') toggleCalPopover('due');
                else if (['daily','journal','gratitude','win'].includes(destination)) toggleCalPopover('dailyTarget');
                return;
            }
        }
        if (e.key === 'Enter') {
            if (settings.submitOnEnter !== false) {
                if (!e.shiftKey) {
                    e.preventDefault();
                    await submitCapture();
                }
            } else if (ctrl) {
                e.preventDefault();
                await submitCapture();
            }
        }
    });

    textAreaEl.addEventListener('paste', async (e) => {
        const files = e.clipboardData && e.clipboardData.files;
        if (files && files.length > 0) {
            e.preventDefault();
            await handleFiles(files);
        }
    });

    textAreaEl.addEventListener('dragover', (e) => { e.preventDefault(); textAreaEl.classList.add('is-dragover'); });
    textAreaEl.addEventListener('dragleave', () => { textAreaEl.classList.remove('is-dragover'); });
    textAreaEl.addEventListener('drop', async (e) => {
        e.preventDefault();
        textAreaEl.classList.remove('is-dragover');
        const files = e.dataTransfer && e.dataTransfer.files;
        if (files && files.length > 0) await handleFiles(files);
    });

    setDestination(destination, false);
    focusInput();
})();
</script>
</body>
</html>`;
    }

    public scanAndDetectVaultConfig(forceOverride: boolean = false) {
        const files = this.app.vault.getMarkdownFiles();
        let inboxFound: string | undefined;
        let tasksFound: string | undefined;

        for (const file of files) {
            const lowerName = file.name.toLowerCase();
            if (!inboxFound && lowerName === 'inbox.md') {
                inboxFound = file.path;
            }
            if (
                !tasksFound &&
                (lowerName === 'master task list.md' ||
                    lowerName === 'master tasks.md' ||
                    lowerName === 'tasks.md')
            ) {
                if (lowerName === 'master task list.md' || !tasksFound) {
                    tasksFound = file.path;
                }
            }
        }

        let dailyFolder = '';
        let dailyFormat = 'YYYY-MM-DD';
        let dailyTemplate = '';
        try {
            const internalPlugins = (this.app as any).internalPlugins;
            const dailyPlugin = internalPlugins?.getPluginById?.('daily-notes');
            const opts = dailyPlugin?.instance?.options;
            if (opts) {
                if (opts.folder) dailyFolder = opts.folder.trim();
                if (opts.format) dailyFormat = opts.format.trim();
                if (opts.template) dailyTemplate = opts.template.trim();
            }
        } catch {}

        let tasksGlobalFilter = '';
        try {
            const plugins = (this.app as any).plugins?.plugins;
            const tasksPlugin = plugins?.['obsidian-tasks-plugin'];
            if (tasksPlugin?.settings?.globalFilter) {
                tasksGlobalFilter = tasksPlugin.settings.globalFilter;
            }
        } catch {}

        let attachmentFolder = '/';
        try {
            attachmentFolder = (this.app.vault as any).getConfig?.('attachmentFolderPath') || '/';
        } catch {}

        this.detectedInfo = {
            inboxFound,
            tasksFound,
            dailyFolder,
            dailyFormat,
            dailyTemplate,
            attachmentFolder,
            tasksGlobalFilter
        };

        if (!this.settings.autoDetectVaultConfig && !forceOverride) {
            return this.detectedInfo;
        }

        let changed = false;
        const currentInboxExists =
            this.app.vault.getAbstractFileByPath(normalizePath(this.settings.inboxFilePath)) instanceof TFile;
        const currentTasksExists =
            this.app.vault.getAbstractFileByPath(normalizePath(this.settings.tasksFilePath)) instanceof TFile;

        if (inboxFound && (!currentInboxExists || forceOverride)) {
            this.settings.inboxFilePath = inboxFound;
            changed = true;
        }
        if (tasksFound && (!currentTasksExists || forceOverride)) {
            this.settings.tasksFilePath = tasksFound;
            changed = true;
        }
        if (dailyFolder && (!this.settings.dailyNoteFolder || forceOverride)) {
            this.settings.dailyNoteFolder = dailyFolder;
            changed = true;
        }
        if (dailyFormat && (this.settings.dailyNoteFormat === 'YYYY-MM-DD' || forceOverride)) {
            this.settings.dailyNoteFormat = dailyFormat;
            changed = true;
        }
        if (dailyTemplate && (!this.settings.dailyNoteTemplatePath || forceOverride)) {
            this.settings.dailyNoteTemplatePath = dailyTemplate;
            changed = true;
        }

        if (changed) {
            this.saveSettings();
        }

        if (forceOverride) {
            new Notice(
                `Vault synced!\nInbox: ${this.settings.inboxFilePath}\nTasks: ${this.settings.tasksFilePath}\nDaily Format: ${this.settings.dailyNoteFormat}`
            );
        }

        return this.detectedInfo;
    }

    public registerGlobalShortcut(): boolean {
        this.unregisterGlobalShortcut();
        const globalShortcut = this.electronRemote?.globalShortcut;
        if (!globalShortcut || !this.settings.globalHotkey.trim()) return false;

        try {
            let success = globalShortcut.register(this.settings.globalHotkey, () => {
                this.triggerGlobalQuickCapture();
            });
            if (!success && this.settings.globalHotkey === 'Alt+Space') {
                console.warn('QuickCapture: Alt+Space in use, falling back to CommandOrControl+Shift+Q');
                this.settings.globalHotkey = 'CommandOrControl+Shift+Q';
                void this.saveSettings().catch((err) => {
                    console.error('QuickCapture: Failed to save fallback shortcut:', err);
                });
                success = globalShortcut.register(this.settings.globalHotkey, () => {
                    this.triggerGlobalQuickCapture();
                });
            }
            return success;
        } catch (err) {
            console.error('QuickCapture: Failed to register global shortcut:', err);
            return false;
        }
    }

    public unregisterGlobalShortcut() {
        try {
            const globalShortcut = this.electronRemote?.globalShortcut;
            if (globalShortcut && this.settings.globalHotkey) {
                globalShortcut.unregister(this.settings.globalHotkey);
            }
        } catch (err) {
            console.warn('QuickCapture: Error unregistering shortcut:', err);
        }
    }

    public async ensureDailyNoteForDate(targetDate: moment.Moment): Promise<TFile> {
        const format = this.settings.dailyNoteFormat.trim() || 'YYYY-MM-DD';
        const fileName = `${targetDate.format(format)}.md`;
        const folder = this.settings.dailyNoteFolder.trim();
        const fullPath = normalizePath(folder ? `${folder}/${fileName}` : fileName);

        await this.ensureParentFolderExists(fullPath);

        const existing = this.app.vault.getAbstractFileByPath(fullPath);
        if (existing instanceof TFile) {
            return existing;
        }

        let initialContent = '';
        const tplRaw = this.settings.dailyNoteTemplatePath.trim();
        if (tplRaw) {
            const tplPath = normalizePath(tplRaw.endsWith('.md') ? tplRaw : `${tplRaw}.md`);
            const tplFile = this.app.vault.getAbstractFileByPath(tplPath);
            if (tplFile instanceof TFile) {
                const rawTpl = await this.app.vault.read(tplFile);
                initialContent = rawTpl
                    .replace(/\{\{date\}\}/g, targetDate.format(format))
                    .replace(/\{\{date:([^}]+)\}\}/g, (_, fmt) => targetDate.format(fmt))
                    .replace(/\{\{time\}\}/g, moment().format('HH:mm'))
                    .replace(/\{\{title\}\}/g, targetDate.format(format));
            }
        }

        return await this.app.vault.create(fullPath, initialContent);
    }

    public async ensureParentFolderExists(filePath: string) {
        const lastSlash = filePath.lastIndexOf('/');
        if (lastSlash === -1) return;
        const folderPath = normalizePath(filePath.substring(0, lastSlash));
        if (!folderPath) return;

        const existingFolder = this.app.vault.getAbstractFileByPath(folderPath);
        if (!existingFolder) {
            await this.app.vault.createFolder(folderPath);
        }
    }

    async loadSettings() {
        const data = (await this.loadData()) || {};
        delete data.windowMode;
        this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
    }

    async saveSettings() {
        await this.saveData(this.settings);
    }
}

export class QuickCaptureViewController {
    app: App;
    plugin: QuickCapturePlugin;
    rootEl: HTMLElement;
    doc: Document;
    destination: CaptureDestination;
    isStandaloneWindow: boolean;
    onCloseCallback: () => void;

    private textAreaEl!: HTMLTextAreaElement;
    private pillsRowEl!: HTMLElement;
    private destBtnEl!: HTMLButtonElement;
    private destMenuEl: HTMLElement | null = null;
    private targetSubEl!: HTMLElement;
    private taskCalendarBtnEl!: HTMLButtonElement;
    private dailyTargetDateBtnEl!: HTMLButtonElement;
    private fileInputEl!: HTMLInputElement;
    private calendarPopoverEl: HTMLElement | null = null;

    private taskDueDate: string = '';
    private taskScheduledDate: string = '';
    private taskStartDate: string = '';
    private taskPriority: TaskPriority = 'none';
    private targetDailyDate: string = moment().format('YYYY-MM-DD');

    private activeCalendarField: 'due' | 'scheduled' | 'start' | 'dailyTarget' = 'due';
    private calendarViewMonth: moment.Moment = moment().startOf('month');
    private isSubmitting: boolean = false;

    constructor(
        app: App,
        plugin: QuickCapturePlugin,
        rootEl: HTMLElement,
        doc: Document,
        initialDestination: CaptureDestination,
        isStandaloneWindow: boolean,
        onCloseCallback: () => void
    ) {
        this.app = app;
        this.plugin = plugin;
        this.rootEl = rootEl;
        this.doc = doc;
        this.destination = initialDestination;
        this.isStandaloneWindow = isStandaloneWindow;
        this.onCloseCallback = onCloseCallback;
    }

    private el<K extends keyof HTMLElementTagNameMap>(
        parent: HTMLElement,
        tag: K,
        cls?: string,
        text?: string,
        attrs?: Record<string, string>
    ): HTMLElementTagNameMap[K] {
        const elem = this.doc.createElement(tag);
        if (cls) elem.className = cls;
        if (text !== undefined) elem.textContent = text;
        if (attrs) {
            for (const [k, v] of Object.entries(attrs)) {
                elem.setAttribute(k, v);
            }
        }
        parent.appendChild(elem);
        return elem;
    }

    public render() {
        this.rootEl.innerHTML = '';

        if (this.isStandaloneWindow) {
            const topBar = this.el(this.rootEl, 'div', 'qc-top-bar');
            this.el(topBar, 'div', 'qc-top-title', '⚡ QUICK CAPTURE');
            const topClose = this.el(topBar, 'button', 'qc-top-close', '×', {
                type: 'button',
                title: 'Close (Esc)'
            });
            topClose.addEventListener('click', () => this.onCloseCallback());
        }

        const textWrapper = this.el(this.rootEl, 'div', 'qc-textarea-wrapper');
        this.textAreaEl = this.el(textWrapper, 'textarea', 'qc-textarea');

        this.pillsRowEl = this.el(this.rootEl, 'div', 'qc-pills-row');

        const bottomBar = this.el(this.rootEl, 'div', 'qc-bottom-bar');
        const bottomLeft = this.el(bottomBar, 'div', 'qc-bottom-left');

        this.destBtnEl = this.el(bottomLeft, 'button', 'qc-dest-btn', undefined, {
            type: 'button',
            title: 'Switch Destination (Tab or Click)'
        });
        this.destBtnEl.addEventListener('click', (e) => {
            e.stopPropagation();
            this.toggleDestinationMenu();
        });

        this.targetSubEl = this.el(bottomLeft, 'div', 'qc-target-sub');

        const bottomRight = this.el(bottomBar, 'div', 'qc-bottom-right');

        this.taskCalendarBtnEl = this.el(bottomRight, 'button', 'qc-icon-btn', undefined, {
            type: 'button',
            title: 'Set Due / Start Date & Priority (Ctrl+D)'
        });
        this.taskCalendarBtnEl.innerHTML = LUCIDE_SVGS['calendar-days'];
        this.taskCalendarBtnEl.addEventListener('click', (e) => {
            e.stopPropagation();
            this.closeDestinationMenu();
            this.toggleCalendarPopover('due');
        });

        this.dailyTargetDateBtnEl = this.el(bottomRight, 'button', 'qc-icon-btn', undefined, {
            type: 'button',
            title: 'Target Past or Future Daily Note (Ctrl+D)'
        });
        this.dailyTargetDateBtnEl.innerHTML = LUCIDE_SVGS['calendar-clock'];
        this.dailyTargetDateBtnEl.addEventListener('click', (e) => {
            e.stopPropagation();
            this.closeDestinationMenu();
            this.toggleCalendarPopover('dailyTarget');
        });

        const attachBtn = this.el(bottomRight, 'button', 'qc-icon-btn', undefined, {
            type: 'button',
            title: 'Attach Image or File (or Paste with Ctrl+V / Drag & Drop)'
        });
        attachBtn.innerHTML = LUCIDE_SVGS['paperclip'];

        this.fileInputEl = this.el(bottomRight, 'input', undefined, undefined, {
            type: 'file',
            multiple: 'true',
            style: 'display:none;'
        });
        attachBtn.addEventListener('click', () => this.fileInputEl.click());
        this.fileInputEl.addEventListener('change', async () => {
            if (this.fileInputEl.files && this.fileInputEl.files.length > 0) {
                await this.handleAttachedFiles(this.fileInputEl.files);
                this.fileInputEl.value = '';
                this.focusInput();
            }
        });

        const submitBtn = this.el(bottomRight, 'button', 'qc-btn-submit', 'Capture ↵', {
            type: 'button'
        });
        submitBtn.addEventListener('click', () => this.submitCapture());

        const shortcutStrip = this.el(this.rootEl, 'div', 'qc-shortcut-strip');
        const submitKey = this.plugin.settings.submitOnEnter ? 'Enter' : 'Ctrl+Enter';
        shortcutStrip.innerHTML = `
            <span>
                <kbd class="qc-kbd">Ctrl+0</kbd> Daily
                <kbd class="qc-kbd">Ctrl+J</kbd> Journal
                <kbd class="qc-kbd">Ctrl+G</kbd> Gratitude
                <kbd class="qc-kbd">Ctrl+W</kbd> Win
                <kbd class="qc-kbd">Ctrl+I</kbd> Inbox
                <kbd class="qc-kbd">Ctrl+T</kbd> Task
            </span>
            <span>
                <kbd class="qc-kbd">Ctrl+D</kbd> Date
                <kbd class="qc-kbd">${submitKey}</kbd> Save
                <kbd class="qc-kbd">Esc</kbd> Close
            </span>
        `;

        this.rootEl.addEventListener('click', () => {
            this.closeCalendarPopover();
            this.closeDestinationMenu();
        });

        this.setDestination(this.destination);

        this.textAreaEl.addEventListener('keydown', async (e: KeyboardEvent) => {
            const ctrlOrMeta = e.ctrlKey || e.metaKey;

            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                if (this.calendarPopoverEl || this.destMenuEl) {
                    this.closeCalendarPopover();
                    this.closeDestinationMenu();
                    this.focusInput();
                } else {
                    this.onCloseCallback();
                }
                return;
            }

            if (e.key === 'Tab') {
                e.preventDefault();
                const order: CaptureDestination[] = ['daily', 'journal', 'gratitude', 'win', 'inbox', 'task'];
                const nextIdx = (order.indexOf(this.destination) + (e.shiftKey ? order.length - 1 : 1)) % order.length;
                this.setDestination(order[nextIdx]);
                return;
            }

            if (ctrlOrMeta && !e.shiftKey && !e.altKey) {
                const lower = e.key.toLowerCase();
                const destMap: Record<string, CaptureDestination> = {
                    '0': 'daily',
                    'j': 'journal',
                    'g': 'gratitude',
                    'w': 'win',
                    'i': 'inbox',
                    't': 'task'
                };
                if (destMap[lower]) {
                    e.preventDefault();
                    this.setDestination(destMap[lower]);
                    return;
                }

                if (lower === 'd') {
                    e.preventDefault();
                    if (this.destination === 'task') {
                        this.toggleCalendarPopover('due');
                    } else if (['daily', 'journal', 'gratitude', 'win'].includes(this.destination)) {
                        this.toggleCalendarPopover('dailyTarget');
                    }
                    return;
                }
            }

            if (e.key === 'Enter') {
                if (this.plugin.settings.submitOnEnter) {
                    if (!e.shiftKey) {
                        e.preventDefault();
                        await this.submitCapture();
                    }
                } else if (ctrlOrMeta) {
                    e.preventDefault();
                    await this.submitCapture();
                }
            }
        });

        this.textAreaEl.addEventListener('paste', async (e: ClipboardEvent) => {
            const files = e.clipboardData?.files;
            if (files && files.length > 0) {
                e.preventDefault();
                await this.handleAttachedFiles(files);
            }
        });

        this.textAreaEl.addEventListener('dragover', (e: DragEvent) => {
            e.preventDefault();
            this.textAreaEl.classList.add('is-dragover');
        });
        this.textAreaEl.addEventListener('dragleave', () => {
            this.textAreaEl.classList.remove('is-dragover');
        });
        this.textAreaEl.addEventListener('drop', async (e: DragEvent) => {
            e.preventDefault();
            this.textAreaEl.classList.remove('is-dragover');
            const files = e.dataTransfer?.files;
            if (files && files.length > 0) {
                await this.handleAttachedFiles(files);
            }
        });
    }

    public focusInput() {
        setTimeout(() => {
            this.textAreaEl?.focus();
        }, 15);
    }

    public setDestination(dest: CaptureDestination) {
        this.destination = dest;
        if (this.plugin.settings.rememberLastDestination) {
            this.plugin.settings.lastUsedDestination = dest;
            this.plugin.saveSettings();
        }

        const meta = DESTINATION_META[dest];
        this.destBtnEl.innerHTML = `${LUCIDE_SVGS[meta.icon] || ''}<span>${meta.label}</span>${LUCIDE_SVGS['chevron-down']}`;
        this.textAreaEl.placeholder = meta.placeholder;

        if (dest === 'task') {
            this.taskCalendarBtnEl.style.display = 'inline-flex';
            this.dailyTargetDateBtnEl.style.display = 'none';
        } else if (['daily', 'journal', 'gratitude', 'win'].includes(dest)) {
            this.taskCalendarBtnEl.style.display = 'none';
            this.dailyTargetDateBtnEl.style.display = 'inline-flex';
        } else {
            this.taskCalendarBtnEl.style.display = 'none';
            this.dailyTargetDateBtnEl.style.display = 'none';
            this.closeCalendarPopover();
        }

        this.updateTargetSubtitle();
        this.renderPills();
    }

    private toggleDestinationMenu() {
        if (this.destMenuEl) {
            this.closeDestinationMenu();
            return;
        }
        this.closeCalendarPopover();

        const parentLeft = this.destBtnEl.parentElement!;
        const menuEl = this.el(parentLeft, 'div', 'qc-dest-menu');
        menuEl.addEventListener('click', (e) => e.stopPropagation());
        this.destMenuEl = menuEl;

        (Object.keys(DESTINATION_META) as CaptureDestination[]).forEach((dest) => {
            const meta = DESTINATION_META[dest];
            const itemBtn = this.el(
                menuEl,
                'button',
                `qc-dest-menu-item ${this.destination === dest ? 'is-active' : ''}`,
                undefined,
                { type: 'button' }
            );
            const left = this.el(itemBtn, 'span', 'qc-dest-menu-left');
            left.innerHTML = `${LUCIDE_SVGS[meta.icon] || ''}<span>${meta.label}</span>`;
            this.el(itemBtn, 'span', 'qc-dest-menu-hint', meta.shortcutHint);

            itemBtn.addEventListener('click', () => {
                this.setDestination(dest);
                this.closeDestinationMenu();
                this.focusInput();
            });
        });
    }

    private closeDestinationMenu() {
        if (this.destMenuEl) {
            this.destMenuEl.remove();
            this.destMenuEl = null;
        }
    }

    private updateTargetSubtitle() {
        const dest = this.destination;
        const targetMoment = moment(this.targetDailyDate, 'YYYY-MM-DD');
        const formattedDaily = targetMoment.format(this.plugin.settings.dailyNoteFormat || 'YYYY-MM-DD') + '.md';

        if (dest === 'daily') {
            const heading = this.plugin.settings.dailyCaptureHeading.trim();
            this.targetSubEl.textContent = heading ? `${formattedDaily} → ${heading}` : formattedDaily;
        } else if (dest === 'journal') {
            this.targetSubEl.textContent = `${formattedDaily} → ${this.plugin.settings.journalHeading}`;
        } else if (dest === 'gratitude') {
            this.targetSubEl.textContent = `${formattedDaily} → ${this.plugin.settings.gratitudeHeading}`;
        } else if (dest === 'win') {
            this.targetSubEl.textContent = `${formattedDaily} → ${this.plugin.settings.winHeading}`;
        } else if (dest === 'inbox') {
            if (this.plugin.settings.inboxMode === 'new-note-first-line') {
                const folder = this.plugin.settings.inboxFolderPath || 'Vault Root';
                this.targetSubEl.textContent = `New Note in ${folder}/`;
            } else {
                this.targetSubEl.textContent = `→ ${this.plugin.settings.inboxFilePath}`;
            }
        } else if (dest === 'task') {
            this.targetSubEl.textContent = `→ ${this.plugin.settings.tasksFilePath}`;
        }

        const hasTaskMeta = Boolean(
            this.taskDueDate || this.taskScheduledDate || this.taskStartDate || this.taskPriority !== 'none'
        );
        this.taskCalendarBtnEl.classList.toggle('has-value', hasTaskMeta);

        const hasCustomDaily = this.targetDailyDate !== moment().format('YYYY-MM-DD');
        this.dailyTargetDateBtnEl.classList.toggle('has-value', hasCustomDaily);
    }

    private renderPills() {
        this.pillsRowEl.innerHTML = '';

        if (this.destination === 'task') {
            if (this.taskDueDate) {
                const pill = this.el(this.pillsRowEl, 'div', 'qc-pill', `📅 Due: ${this.formatFriendlyDate(this.taskDueDate)}`);
                const clear = this.el(pill, 'span', 'qc-pill-clear', '×');
                clear.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.taskDueDate = '';
                    this.renderPills();
                    this.updateTargetSubtitle();
                });
                pill.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.toggleCalendarPopover('due');
                });
            }

            if (this.taskStartDate) {
                const pill = this.el(this.pillsRowEl, 'div', 'qc-pill', `🛫 Start: ${this.formatFriendlyDate(this.taskStartDate)}`);
                const clear = this.el(pill, 'span', 'qc-pill-clear', '×');
                clear.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.taskStartDate = '';
                    this.renderPills();
                    this.updateTargetSubtitle();
                });
                pill.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.toggleCalendarPopover('start');
                });
            }

            if (this.taskPriority !== 'none') {
                const emojiMap: Record<TaskPriority, string> = {
                    none: '',
                    high: '⏫ High Priority',
                    medium: '🔼 Medium Priority',
                    low: '🔽 Low Priority'
                };
                const pill = this.el(this.pillsRowEl, 'div', 'qc-pill', emojiMap[this.taskPriority]);
                const clear = this.el(pill, 'span', 'qc-pill-clear', '×');
                clear.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.taskPriority = 'none';
                    this.renderPills();
                    this.updateTargetSubtitle();
                });
            }
        } else if (['daily', 'journal', 'gratitude', 'win'].includes(this.destination)) {
            const todayStr = moment().format('YYYY-MM-DD');
            if (this.targetDailyDate !== todayStr) {
                const pill = this.el(this.pillsRowEl, 'div', 'qc-pill', `📆 Target Day: ${this.formatFriendlyDate(this.targetDailyDate)}`);
                const clear = this.el(pill, 'span', 'qc-pill-clear', '×');
                clear.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.targetDailyDate = todayStr;
                    this.renderPills();
                    this.updateTargetSubtitle();
                });
                pill.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.toggleCalendarPopover('dailyTarget');
                });
            }
        }
    }

    private formatFriendlyDate(dateStr: string): string {
        const m = moment(dateStr, 'YYYY-MM-DD');
        const today = moment().startOf('day');
        const diff = m.diff(today, 'days');
        if (diff === 0) return `Today (${dateStr})`;
        if (diff === 1) return `Tomorrow (${dateStr})`;
        if (diff === -1) return `Yesterday (${dateStr})`;
        return `${m.format('ddd, MMM D')} (${dateStr})`;
    }

    private toggleCalendarPopover(field: 'due' | 'scheduled' | 'start' | 'dailyTarget') {
        if (this.calendarPopoverEl && this.activeCalendarField === field) {
            this.closeCalendarPopover();
            return;
        }
        this.activeCalendarField = field;
        const currentVal = this.getActiveCalendarDateValue();
        this.calendarViewMonth = (currentVal ? moment(currentVal, 'YYYY-MM-DD') : moment()).startOf('month');
        this.renderCalendarPopover();
    }

    public closeCalendarPopover() {
        if (this.calendarPopoverEl) {
            this.calendarPopoverEl.remove();
            this.calendarPopoverEl = null;
        }
    }

    private getActiveCalendarDateValue(): string {
        if (this.activeCalendarField === 'due') return this.taskDueDate;
        if (this.activeCalendarField === 'scheduled') return this.taskScheduledDate;
        if (this.activeCalendarField === 'start') return this.taskStartDate;
        return this.targetDailyDate;
    }

    private setActiveCalendarDateValue(val: string) {
        if (this.activeCalendarField === 'due') {
            this.taskDueDate = val;
        } else if (this.activeCalendarField === 'scheduled') {
            this.taskScheduledDate = val;
        } else if (this.activeCalendarField === 'start') {
            this.taskStartDate = val;
        } else {
            this.targetDailyDate = val || moment().format('YYYY-MM-DD');
        }
        this.renderPills();
        this.updateTargetSubtitle();
        this.closeCalendarPopover();
        this.focusInput();
    }

    private renderCalendarPopover() {
        this.closeCalendarPopover();

        const popover = this.el(this.rootEl, 'div', 'qc-calendar-popover');
        popover.addEventListener('click', (e) => e.stopPropagation());
        this.calendarPopoverEl = popover;

        if (this.destination === 'task') {
            const typeTabs = this.el(popover, 'div', 'qc-cal-type-tabs');
            const dueTab = this.el(
                typeTabs,
                'button',
                `qc-cal-type-tab ${this.activeCalendarField === 'due' ? 'is-active' : ''}`,
                '📅 Due Date',
                { type: 'button' }
            );
            const startTab = this.el(
                typeTabs,
                'button',
                `qc-cal-type-tab ${this.activeCalendarField === 'start' ? 'is-active' : ''}`,
                '🛫 Start Date',
                { type: 'button' }
            );

            dueTab.addEventListener('click', () => {
                this.activeCalendarField = 'due';
                this.renderCalendarPopover();
            });
            startTab.addEventListener('click', () => {
                this.activeCalendarField = 'start';
                this.renderCalendarPopover();
            });
        }

        const presetsGrid = this.el(popover, 'div', 'qc-cal-presets');
        const today = moment();
        const tomorrow = moment().add(1, 'days');
        const saturday = moment().day(6).isSameOrBefore(today, 'day')
            ? moment().add(1, 'weeks').day(6)
            : moment().day(6);
        const nextMonday = moment().add(1, 'weeks').isoWeekday(1);

        const presets = [
            { label: '★ Today', sub: today.format('ddd'), val: today.format('YYYY-MM-DD') },
            { label: '☀ Tomorrow', sub: tomorrow.format('ddd'), val: tomorrow.format('YYYY-MM-DD') },
            { label: '🛋 Weekend', sub: saturday.format('MMM D'), val: saturday.format('YYYY-MM-DD') },
            { label: '⇥ Next Mon', sub: nextMonday.format('MMM D'), val: nextMonday.format('YYYY-MM-DD') }
        ];

        presets.forEach((p) => {
            const btn = this.el(presetsGrid, 'button', 'qc-cal-preset-btn', undefined, { type: 'button' });
            this.el(btn, 'span', undefined, p.label);
            this.el(btn, 'span', 'qc-cal-preset-sub', p.sub);
            btn.addEventListener('click', () => this.setActiveCalendarDateValue(p.val));
        });

        const calHeader = this.el(popover, 'div', 'qc-cal-header');
        this.el(calHeader, 'span', undefined, this.calendarViewMonth.format('MMMM YYYY'));

        const navGroup = this.el(calHeader, 'div', 'qc-cal-nav');
        const prevBtn = this.el(navGroup, 'button', 'qc-cal-nav-btn', '◀', { type: 'button' });
        const todayJumpBtn = this.el(navGroup, 'button', 'qc-cal-nav-btn', '●', {
            type: 'button',
            title: 'Jump to Current Month'
        });
        const nextBtn = this.el(navGroup, 'button', 'qc-cal-nav-btn', '▶', { type: 'button' });

        prevBtn.addEventListener('click', () => {
            this.calendarViewMonth = this.calendarViewMonth.clone().subtract(1, 'months');
            this.renderCalendarPopover();
        });
        todayJumpBtn.addEventListener('click', () => {
            this.calendarViewMonth = moment().startOf('month');
            this.renderCalendarPopover();
        });
        nextBtn.addEventListener('click', () => {
            this.calendarViewMonth = this.calendarViewMonth.clone().add(1, 'months');
            this.renderCalendarPopover();
        });

        const grid = this.el(popover, 'div', 'qc-cal-grid');
        ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'].forEach((dow) => {
            this.el(grid, 'div', 'qc-cal-dow', dow);
        });

        const startOfGrid = this.calendarViewMonth.clone().startOf('month').startOf('week');
        const selectedVal = this.getActiveCalendarDateValue();
        const todayStr = moment().format('YYYY-MM-DD');

        for (let i = 0; i < 42; i++) {
            const dayMoment = startOfGrid.clone().add(i, 'days');
            const dateStr = dayMoment.format('YYYY-MM-DD');
            const isCurrentMonth = dayMoment.month() === this.calendarViewMonth.month();

            const dayBtn = this.el(grid, 'button', 'qc-cal-day', String(dayMoment.date()), {
                type: 'button',
                title: dateStr
            });

            if (!isCurrentMonth) dayBtn.classList.add('is-outside');
            if (dateStr === todayStr) dayBtn.classList.add('is-today');
            if (dateStr === selectedVal) dayBtn.classList.add('is-selected');

            dayBtn.addEventListener('click', () => {
                this.setActiveCalendarDateValue(dateStr);
            });
        }

        if (this.destination === 'task') {
            const prioRow = this.el(popover, 'div', 'qc-cal-presets');
            const prios: { id: TaskPriority; label: string }[] = [
                { id: 'high', label: '⏫ High' },
                { id: 'medium', label: '🔼 Med' },
                { id: 'low', label: '🔽 Low' },
                { id: 'none', label: '○ Normal' }
            ];
            prios.forEach((pr) => {
                const pBtn = this.el(prioRow, 'button', 'qc-cal-preset-btn', pr.label, { type: 'button' });
                if (this.taskPriority === pr.id && pr.id !== 'none') {
                    pBtn.style.borderColor = '#8b5cf6';
                }
                pBtn.addEventListener('click', () => {
                    this.taskPriority = pr.id;
                    this.renderPills();
                    this.updateTargetSubtitle();
                    this.closeCalendarPopover();
                    this.focusInput();
                });
            });
        }

        const calFooter = this.el(popover, 'div', 'qc-cal-footer');
        const nativeDateInput = this.el(calFooter, 'input', 'qc-cal-native-input', undefined, {
            type: 'date',
            value: selectedVal || todayStr
        });
        nativeDateInput.addEventListener('change', () => {
            if (nativeDateInput.value) {
                this.setActiveCalendarDateValue(nativeDateInput.value);
            }
        });

        const clearBtn = this.el(calFooter, 'button', 'qc-cal-clear-btn', 'Clear Date', { type: 'button' });
        clearBtn.addEventListener('click', () => {
            this.setActiveCalendarDateValue('');
        });
    }

    private async handleAttachedFiles(files: FileList) {
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            try {
                const buffer = await file.arrayBuffer();
                const embedText = await this.plugin.saveAttachmentFromBuffer(file.name, buffer);

                const start = this.textAreaEl.selectionStart ?? this.textAreaEl.value.length;
                const end = this.textAreaEl.selectionEnd ?? this.textAreaEl.value.length;
                const prefix =
                    start > 0 && !this.textAreaEl.value.slice(0, start).endsWith('\n') ? ' ' : '';
                this.textAreaEl.setRangeText(`${prefix}${embedText} `, start, end, 'end');
            } catch (err) {
                console.error('QuickCapture: Failed to attach file:', err);
                new Notice('Failed to save attachment.');
            }
        }
    }

    private async submitCapture() {
        if (this.isSubmitting) return;
        const rawText = this.textAreaEl.value.trim();
        if (!rawText) {
            this.onCloseCallback();
            return;
        }

        this.isSubmitting = true;
        try {
            await this.plugin.executeCapturePayload({
                destination: this.destination,
                rawText,
                taskDueDate: this.taskDueDate,
                taskScheduledDate: this.taskScheduledDate,
                taskStartDate: this.taskStartDate,
                taskPriority: this.taskPriority,
                targetDailyDate: this.targetDailyDate
            });
            this.textAreaEl.value = '';
            this.onCloseCallback();
        } catch (err) {
            console.error('QuickCapture: Error saving capture:', err);
            new Notice('Error saving capture. Check console for details.');
            this.isSubmitting = false;
        }
    }
}

class PurgeCompletedTasksModal extends Modal {
    constructor(app: App, private plugin: QuickCapturePlugin) {
        super(app);
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.createEl('h2', { text: 'Purge completed tasks?' });
        contentEl.createEl('p', {
            text: 'Choose which completed tasks to remove from your configured task list.'
        });

        const buttons = contentEl.createDiv({ cls: 'modal-button-container' });
        const cancelButton = buttons.createEl('button', { text: 'Cancel' });
        cancelButton.addEventListener('click', () => this.close());

        const allButton = buttons.createEl('button', {
            text: 'All completed',
            cls: 'mod-warning'
        });
        allButton.addEventListener('click', () => {
            this.close();
            void this.plugin.purgeCompletedTasks(false);
        });

        const amount = this.plugin.settings.purgeCompletedAge;
        const unit = amount === 1
            ? this.plugin.settings.purgeCompletedAgeUnit.slice(0, -1)
            : this.plugin.settings.purgeCompletedAgeUnit;
        const olderButton = buttons.createEl('button', {
            text: `Older than ${amount} ${unit}`,
            cls: 'mod-warning'
        });
        olderButton.addEventListener('click', () => {
            this.close();
            void this.plugin.purgeCompletedTasks(true);
        });
    }

    onClose() {
        this.contentEl.empty();
    }
}

export class QuickCaptureSettingTab extends PluginSettingTab {
    plugin: QuickCapturePlugin;

    constructor(app: App, plugin: QuickCapturePlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();

        containerEl.createEl('h2', { text: 'Quick Capture Settings' });

        const detected = this.plugin.scanAndDetectVaultConfig(false);
        const infoBox = containerEl.createDiv({ cls: 'qc-detected-info' });
        infoBox.createEl('strong', { text: '⚡ Live Detected Vault Settings:' });

        const addDetectedLine = (label: string, value: string) => {
            const line = infoBox.createDiv({ cls: 'qc-detected-line' });
            line.createEl('strong', { text: `• ${label}:` });
            line.createEl('code', { text: value });
        };

        addDetectedLine(
            'Inbox File',
            detected.inboxFound || `Not found (will create ${this.plugin.settings.inboxFilePath})`
        );
        addDetectedLine(
            'Tasks File',
            detected.tasksFound || `Not found (will create ${this.plugin.settings.tasksFilePath})`
        );

        const dailyFormat = detected.dailyFormat || 'YYYY-MM-DD';
        const dailyExample = moment().format(dailyFormat);
        const dailyFilePath = detected.dailyFolder
            ? `${detected.dailyFolder}/${dailyExample}.md`
            : `/${dailyExample}.md`;
        const dailyLine = infoBox.createDiv({ cls: 'qc-detected-daily' });
        dailyLine.createEl('strong', { cls: 'qc-detected-daily-label', text: '• Daily Notes:' });
        const dailyDetails = dailyLine.createDiv({ cls: 'qc-detected-daily-details' });
        const formatLine = dailyDetails.createDiv();
        formatLine.createEl('span', { text: 'Format: ' });
        formatLine.createEl('code', { text: dailyFormat });
        const exampleLine = dailyDetails.createDiv();
        exampleLine.createEl('span', { text: 'Example: ' });
        exampleLine.createEl('code', { text: dailyFilePath });
        const templateLine = dailyDetails.createDiv();
        templateLine.createEl('span', { text: 'Template: ' });
        templateLine.createEl('code', { text: detected.dailyTemplate || 'None' });

        addDetectedLine('Attachments Folder', detected.attachmentFolder || '/');
        if (detected.tasksGlobalFilter) {
            addDetectedLine('Tasks Global Filter', detected.tasksGlobalFilter);
        }

        const allMarkdownFiles = this.app.vault.getMarkdownFiles().map((f) => f.path);
        const dataListId = 'qc-vault-files-datalist';
        const dataListEl = containerEl.createEl('datalist', { attr: { id: dataListId } });
        allMarkdownFiles.forEach((p) => {
            dataListEl.createEl('option', { value: p });
        });

        new Setting(containerEl)
            .setName('Auto-detect Vault Settings & Files on Startup')
            .setDesc('Automatically read your vault for inbox.md, Master Task List.md, Daily Note settings, and Tasks filter.')
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.autoDetectVaultConfig).onChange(async (value) => {
                    this.plugin.settings.autoDetectVaultConfig = value;
                    await this.plugin.saveSettings();
                })
            )
            .addButton((btn) =>
                btn
                    .setButtonText('Re-Scan & Sync Vault Now')
                    .setCta()
                    .onClick(() => {
                        this.plugin.scanAndDetectVaultConfig(true);
                        this.display();
                    })
            );

        containerEl.createEl('h3', { text: '1. Quick Capture Window & Global Shortcut' });

        let hotkeyDisplay: HTMLInputElement | undefined;
        new Setting(containerEl)
            .setName('Global Shortcut')
            .setDesc('Click Record shortcut, then press a modifier and key (for example, Alt+Q). Press Escape to cancel.')
            .addText((text) => {
                text.setValue(this.plugin.settings.globalHotkey);
                text.inputEl.readOnly = true;
                text.inputEl.setAttribute('aria-label', 'Current global shortcut');
                hotkeyDisplay = text.inputEl;
            })
            .addButton((button) => {
                let keydownHandler: ((event: KeyboardEvent) => void) | null = null;
                const doc = containerEl.ownerDocument;

                const stopRecording = () => {
                    if (keydownHandler) {
                        doc.removeEventListener('keydown', keydownHandler, true);
                        keydownHandler = null;
                    }
                    button.setButtonText('Record shortcut');
                };

                const restoreShortcut = () => {
                    this.plugin.registerGlobalShortcut();
                    if (hotkeyDisplay) hotkeyDisplay.value = this.plugin.settings.globalHotkey;
                };

                button
                    .setButtonText('Record shortcut')
                    .onClick(() => {
                        if (keydownHandler) {
                            stopRecording();
                            restoreShortcut();
                            return;
                        }

                        this.plugin.unregisterGlobalShortcut();
                        button.setButtonText('Press shortcut (Esc to cancel)');
                        keydownHandler = async (event: KeyboardEvent) => {
                            if (event.isComposing) return;

                            if (event.key === 'Escape') {
                                event.preventDefault();
                                event.stopPropagation();
                                stopRecording();
                                restoreShortcut();
                                return;
                            }

                            if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) {
                                event.preventDefault();
                                event.stopPropagation();
                                return;
                            }

                            const modifiers: string[] = [];
                            if (event.ctrlKey) modifiers.push('Ctrl');
                            if (event.altKey) modifiers.push('Alt');
                            if (event.shiftKey) modifiers.push('Shift');
                            if (event.metaKey) modifiers.push('Super');

                            event.preventDefault();
                            event.stopPropagation();
                            if (modifiers.length === 0) {
                                button.setButtonText('Use a modifier + key');
                                return;
                            }

                            const keyNames: Record<string, string> = {
                                ' ': 'Space',
                                ArrowDown: 'Down',
                                ArrowLeft: 'Left',
                                ArrowRight: 'Right',
                                ArrowUp: 'Up',
                                '+': 'Plus'
                            };
                            const key = keyNames[event.key] ||
                                (event.key.length === 1 ? event.key.toUpperCase() : event.key);
                            if (!key || key === 'Dead' || key === 'Unidentified') return;

                            const previousHotkey = this.plugin.settings.globalHotkey;
                            const accelerator = [...modifiers, key].join('+');
                            stopRecording();
                            this.plugin.settings.globalHotkey = accelerator;
                            if (hotkeyDisplay) hotkeyDisplay.value = accelerator;

                            try {
                                await this.plugin.saveSettings();
                            } catch (err) {
                                console.error('QuickCapture: Failed to save global shortcut:', err);
                                this.plugin.settings.globalHotkey = previousHotkey;
                                restoreShortcut();
                                new Notice('Could not save the shortcut. Check the console for details.');
                                return;
                            }

                            const registered = this.plugin.registerGlobalShortcut();
                            if (hotkeyDisplay) {
                                hotkeyDisplay.value = this.plugin.settings.globalHotkey;
                            }
                            if (this.plugin.settings.globalHotkey !== accelerator) {
                                new Notice(`Shortcut is in use. Using ${this.plugin.settings.globalHotkey} instead.`);
                            } else if (!registered) {
                                new Notice(`Could not register ${accelerator}. It may already be in use.`);
                            }
                        };
                        doc.addEventListener('keydown', keydownHandler, true);
                    });
            });

        new Setting(containerEl)
            .setName('Submit on Enter (Return — and you are back to work)')
            .setDesc('Pressing Enter immediately saves and closes the capture popup (Shift+Enter inserts a new line).')
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.submitOnEnter).onChange(async (value) => {
                    this.plugin.settings.submitOnEnter = value;
                    await this.plugin.saveSettings();
                })
            );

        containerEl.createEl('h3', { text: '2. Tasks Destination (Ctrl+T)' });

        new Setting(containerEl)
            .setName('Master Task List File Path')
            .setDesc('Target file for captured tasks (formatted with Obsidian Tasks emoji dates 📅 / 🛫).')
            .addText((text) => {
                text.setPlaceholder('Master Task List.md')
                    .setValue(this.plugin.settings.tasksFilePath)
                    .onChange(async (value) => {
                        this.plugin.settings.tasksFilePath = value.trim() || 'Master Task List.md';
                        await this.plugin.saveSettings();
                    });
                text.inputEl.setAttribute('list', dataListId);
                text.inputEl.style.width = '260px';
            });

        new Setting(containerEl)
            .setName('Task Insert Position')
            .setDesc('Append to the bottom of Master Task List.md or prepend to the top.')
            .addDropdown((drop) =>
                drop
                    .addOption('append', 'Append (Bottom)')
                    .addOption('prepend', 'Prepend (Top)')
                    .setValue(this.plugin.settings.taskInsertPosition)
                    .onChange(async (value: 'append' | 'prepend') => {
                        this.plugin.settings.taskInsertPosition = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName('Organize Tasks by Priority and Date')
            .setDesc('When enabled, sorts each task list by priority (high to none), then due date (earliest first; scheduled/start date as fallback). Active tasks have no blank lines between them. Completed tasks are grouped at the top when appending or at the bottom when prepending, with a blank line between completed tasks.')
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.organizeTasks).onChange(async (value) => {
                    this.plugin.settings.organizeTasks = value;
                    await this.plugin.saveSettings();
                    this.plugin.updateOrganizeTasksCommand();
                })
            );

        new Setting(containerEl)
            .setName('Normalize Task Icon and Metadata Order')
            .setDesc('When Organize Tasks is enabled, put priority icons first, keep the task description next, then place date/status fields in a consistent order: start, scheduled, created, due, completed, cancelled. Run Organize Tasks to apply this to existing tasks.')
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.normalizeTaskOrder).onChange(async (value) => {
                    this.plugin.settings.normalizeTaskOrder = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('Include Created Date (➕ YYYY-MM-DD) in Tasks')
            .setDesc('Automatically append the creation date alongside any selected Due/Start dates.')
            .addToggle((toggle) =>
                toggle.setValue(this.plugin.settings.includeCreatedDateInTask).onChange(async (value) => {
                    this.plugin.settings.includeCreatedDateInTask = value;
                    await this.plugin.saveSettings();
                })
            );

        new Setting(containerEl)
            .setName('Auto-tag captured Tasks')
            .setDesc('Append a tag to every Task you capture (Tasks destination only, Ctrl+T), for example #task. Leave blank to turn this off.')
            .addText((text) =>
                text
                    .setPlaceholder('#task')
                    .setValue(this.plugin.settings.taskAutoTag)
                    .onChange(async (value) => {
                        this.plugin.settings.taskAutoTag = value.trim();
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName('Purge completed tasks older than')
            .setDesc('The age threshold shown in the Purge Completed Tasks command. Older-than purges use the task completion date (✅ YYYY-MM-DD); tasks without one are kept.')
            .addText((text) => {
                text.inputEl.type = 'number';
                text.inputEl.min = '1';
                text.inputEl.step = '1';
                text.setValue(String(this.plugin.settings.purgeCompletedAge))
                    .onChange(async (value) => {
                        const age = Number(value);
                        if (!Number.isInteger(age) || age < 1) return;
                        this.plugin.settings.purgeCompletedAge = age;
                        await this.plugin.saveSettings();
                    });
            })
            .addDropdown((drop) =>
                drop
                    .addOption('days', 'day(s)')
                    .addOption('months', 'month(s)')
                    .setValue(this.plugin.settings.purgeCompletedAgeUnit)
                    .onChange(async (value: PurgeAgeUnit) => {
                        this.plugin.settings.purgeCompletedAgeUnit = value;
                        await this.plugin.saveSettings();
                    })
            );

        containerEl.createEl('h3', { text: '3. Inbox Destination (Ctrl+I)' });

        new Setting(containerEl)
            .setName('Inbox Capture Behavior')
            .setDesc('Append entries to your single inbox.md file, or create a new note in your Inbox folder where line 1 is the note title.')
            .addDropdown((drop) =>
                drop
                    .addOption('append-file', 'Append to inbox.md file')
                    .addOption('new-note-first-line', 'New note in Inbox folder (First line = Title)')
                    .setValue(this.plugin.settings.inboxMode)
                    .onChange(async (value: 'append-file' | 'new-note-first-line') => {
                        this.plugin.settings.inboxMode = value;
                        await this.plugin.saveSettings();
                        this.display();
                    })
            );

        if (this.plugin.settings.inboxMode === 'append-file') {
            new Setting(containerEl)
                .setName('Inbox File Path')
                .setDesc('Target file when appending to inbox.md.')
                .addText((text) => {
                    text.setPlaceholder('inbox.md')
                        .setValue(this.plugin.settings.inboxFilePath)
                        .onChange(async (value) => {
                            this.plugin.settings.inboxFilePath = value.trim() || 'inbox.md';
                            await this.plugin.saveSettings();
                        });
                    text.inputEl.setAttribute('list', dataListId);
                    text.inputEl.style.width = '260px';
                });
        } else {
            new Setting(containerEl)
                .setName('Inbox Folder Path')
                .setDesc('Folder where new Inbox notes are created.')
                .addText((text) =>
                    text
                        .setPlaceholder('00 Inbox')
                        .setValue(this.plugin.settings.inboxFolderPath)
                        .onChange(async (value) => {
                            this.plugin.settings.inboxFolderPath = value.trim();
                            await this.plugin.saveSettings();
                        })
                );
        }

        containerEl.createEl('h3', { text: '4. Daily Note & Journal Sections (Ctrl+0 / J / G / W)' });

        new Setting(containerEl)
            .setName('Daily Note Capture Heading (Ctrl+0)')
            .setDesc('Heading inside your Daily Note for general captures (leave blank to append to bottom with no heading).')
            .addText((text) =>
                text
                    .setPlaceholder('### Captured')
                    .setValue(this.plugin.settings.dailyCaptureHeading)
                    .onChange(async (value) => {
                        this.plugin.settings.dailyCaptureHeading = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName('Journal Section Heading & Tag (Ctrl+J)')
            .setDesc('Heading and optional tag for Journal entries.')
            .addText((text) =>
                text
                    .setPlaceholder('### Journal')
                    .setValue(this.plugin.settings.journalHeading)
                    .onChange(async (value) => {
                        this.plugin.settings.journalHeading = value;
                        await this.plugin.saveSettings();
                    })
            )
            .addText((text) =>
                text
                    .setPlaceholder('#journal')
                    .setValue(this.plugin.settings.journalTag)
                    .onChange(async (value) => {
                        this.plugin.settings.journalTag = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName('Gratitude Section Heading & Tag (Ctrl+G)')
            .setDesc('Heading and optional tag for Gratitude entries.')
            .addText((text) =>
                text
                    .setPlaceholder('### Gratitude')
                    .setValue(this.plugin.settings.gratitudeHeading)
                    .onChange(async (value) => {
                        this.plugin.settings.gratitudeHeading = value;
                        await this.plugin.saveSettings();
                    })
            )
            .addText((text) =>
                text
                    .setPlaceholder('#gratitude')
                    .setValue(this.plugin.settings.gratitudeTag)
                    .onChange(async (value) => {
                        this.plugin.settings.gratitudeTag = value;
                        await this.plugin.saveSettings();
                    })
            );

        new Setting(containerEl)
            .setName('Win Section Heading & Tag (Ctrl+W)')
            .setDesc('Heading and optional tag for Wins.')
            .addText((text) =>
                text
                    .setPlaceholder('### Wins')
                    .setValue(this.plugin.settings.winHeading)
                    .onChange(async (value) => {
                        this.plugin.settings.winHeading = value;
                        await this.plugin.saveSettings();
                    })
            )
            .addText((text) =>
                text
                    .setPlaceholder('#win')
                    .setValue(this.plugin.settings.winTag)
                    .onChange(async (value) => {
                        this.plugin.settings.winTag = value;
                        await this.plugin.saveSettings();
                    })
            );
    }
}
