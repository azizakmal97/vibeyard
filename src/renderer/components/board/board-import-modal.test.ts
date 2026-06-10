import { describe, it, expect } from 'vitest';

// Mock the sibling modules so importing the parser doesn't pull in the
// DOM-heavy state / board-state / custom-select graphs (env is node).
vi.mock('../../state.js', () => ({ appState: {} }));
vi.mock('../../board-state.js', () => ({
  getBoard: vi.fn(),
  getColumnByBehavior: vi.fn(),
  batchAddTasks: vi.fn(),
  TAG_COLORS: ['#000'],
}));
vi.mock('../custom-select.js', () => ({ createCustomSelect: vi.fn() }));

import { parsePlan, planScore, type ParsedTask } from './board-import-modal';

describe('parsePlan()', () => {
  it('parses GitHub-style checkboxes with done flags', () => {
    const tasks = parsePlan('- [ ] open task\n- [x] done task');
    expect(tasks).toEqual([
      { title: 'open task', section: '', done: false },
      { title: 'done task', section: '', done: true },
    ]);
  });

  it('handles CRLF line endings (the bug that made progress files import empty)', () => {
    // A \r left on each line breaks JS `$`, which previously parsed the whole file as empty.
    const crlf = '## Section\r\n- [ ] task one\r\n- [ ] task two\r\n';
    const tasks = parsePlan(crlf);
    expect(tasks.map(t => t.title)).toEqual(['task one', 'task two']);
    expect(tasks.every(t => t.section === 'Section')).toBe(true);
  });

  it('parses emoji-status headers as tasks under their parent plain-header section', () => {
    const md = [
      '## M4 — Pre-Release Hardening',
      '#### ✅ M4-P01 — Security scanning (DONE 2026-06-04) — **Model: Opus 4.8**',
      '#### ⬜ M4-P04 — Resolve exceljs → uuid — **Model: Sonnet 4.6**',
      '#### 🟡 M4-P05 — Triage Semgrep findings',
    ].join('\n');
    const tasks = parsePlan(md);
    // Sibling emoji headers must NOT tag each other — all share the milestone section.
    expect(tasks.every(t => t.section === 'M4 — Pre-Release Hardening')).toBe(true);
    expect(tasks).toEqual([
      { title: 'M4-P01 — Security scanning', section: 'M4 — Pre-Release Hardening', done: true },
      { title: 'M4-P04 — Resolve exceljs → uuid', section: 'M4 — Pre-Release Hardening', done: false },
      { title: 'M4-P05 — Triage Semgrep findings', section: 'M4 — Pre-Release Hardening', done: false },
    ]);
  });

  it('parses emoji-status bullets and skips legend lines', () => {
    const md = '- ⬜ pending\n- ✅ done\n- ⬜ real task here\n- 🟡 another task';
    const tasks = parsePlan(md);
    // "pending"/"done" are legend labels and must be dropped.
    expect(tasks.map(t => t.title)).toEqual(['real task here', 'another task']);
  });

  it('strips bold markers from all task syntaxes', () => {
    const tasks = parsePlan('- [ ] **bold checkbox**\n- ⬜ **bold bullet**');
    expect(tasks.map(t => t.title)).toEqual(['bold checkbox', 'bold bullet']);
  });

  it('plain headers update the section; emoji headers do not', () => {
    const md = '# Top\n## Phase A\n#### ⬜ task in A\n## Phase B\n#### ⬜ task in B';
    const tasks = parsePlan(md);
    expect(tasks).toEqual([
      { title: 'task in A', section: 'Phase A', done: false },
      { title: 'task in B', section: 'Phase B', done: false },
    ]);
  });

  it('returns no tasks for prose with no task markers', () => {
    expect(parsePlan('# Title\n\nJust some explanatory text.\n')).toEqual([]);
  });
});

describe('planScore()', () => {
  const open = (n: number): ParsedTask[] =>
    Array.from({ length: n }, (_, i) => ({ title: `t${i}`, section: '', done: false }));
  const mix = (openN: number, doneN: number): ParsedTask[] => [
    ...open(openN),
    ...Array.from({ length: doneN }, (_, i) => ({ title: `d${i}`, section: '', done: true })),
  ];

  it('never auto-selects a file with no open tasks', () => {
    expect(planScore('PROGRESS.md', [])).toBe(-1);
    expect(planScore('done.md', mix(0, 5))).toBe(-1);
  });

  it('ranks a genuine progress tracker (open + done) above a flat open-only list', () => {
    // REFACTOR_PROGRESS (7 open, has done) must beat AUDIT_AND_ROADMAP (10 open, no done).
    const tracker = planScore('REFACTOR_PROGRESS.md', mix(7, 52));
    const flatRoadmap = planScore('AUDIT_AND_ROADMAP.md', mix(10, 0));
    expect(tracker).toBeGreaterThan(flatRoadmap);
  });

  it('ranks plan-named files above non-plan files even with fewer tasks', () => {
    const planFile = planScore('PLAN.md', mix(1, 0));
    const promptDoc = planScore('DEEPSEEK_PROMPT.md', mix(32, 0));
    expect(planFile).toBeGreaterThan(promptDoc);
  });
});
