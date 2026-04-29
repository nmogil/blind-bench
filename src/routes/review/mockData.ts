import type { ReviewOutput } from "./types";

export const MOCK_PROMPT = `
You are a triage assistant. Given a bug report from a customer, summarize the
issue in 2-3 sentences for an on-call engineer. Include: the affected surface,
when it started, and whether the user found a workaround. Do not speculate about
root cause.
`.trim();

export const MOCK_INPUT = `
Subject: Dashboard charts blank since Tuesday morning

Hey team — since some time Tuesday (Apr 14) the charts on our
/reports/weekly page have been completely blank. No spinner, no error,
just empty. I thought it might be an ad blocker but the same thing happens
in an incognito window. Restarting the browser didn't help. I can still
export the CSV from the three-dot menu so the underlying data is fine,
I just can't see the graphs. Let me know what to try next.

— Priya, Retention team
`.trim();

export const MOCK_OUTPUTS: ReviewOutput[] = [
  {
    id: "out-1",
    blindLabel: "Output A",
    content: `Priya (Retention) reports that /reports/weekly charts have been blank since Tuesday, April 14. Issue reproduces in incognito and survives a browser restart; CSV export still works, so the blank rendering is isolated to the graph layer. No workaround beyond the CSV fallback.`,
    testCaseId: null,
  },
  {
    id: "out-2",
    blindLabel: "Output B",
    content: `The dashboard charts at /reports/weekly have been failing to render since Tuesday. This is almost certainly a frontend issue — probably a regression from the recent chart library upgrade. I'd start by checking the browser console for errors. Priya has found a workaround via CSV export.`,
    testCaseId: null,
  },
  {
    id: "out-3",
    blindLabel: "Output C",
    content: `Charts on /reports/weekly show blank since Tuesday (Apr 14). Confirmed in incognito and after browser restart; CSV export from the overflow menu still works. User has no other workaround.`,
    testCaseId: null,
  },
  {
    id: "out-4",
    blindLabel: "Output D",
    content: `Customer reports blank charts. They tried a few things. They can export CSV. They want to know what to do next.`,
    testCaseId: null,
  },
  {
    id: "out-5",
    blindLabel: "Output E",
    content: `Since Tuesday morning (April 14), the charts on /reports/weekly have rendered blank for Priya on the Retention team. The failure persists across browsers and incognito mode, ruling out extensions and session state. Data retrieval is unaffected — the CSV export from the overflow menu still returns results — which suggests a rendering-layer regression rather than an API issue. The user has no workaround beyond the CSV export.`,
    testCaseId: null,
  },
  {
    id: "out-6",
    blindLabel: "Output F",
    content: `Priya from Retention is seeing blank /reports/weekly charts starting Tuesday Apr 14. Reproduces in incognito + after browser restart, so not extension or session related. CSV download from the three-dot menu still works = data layer is healthy, issue is confined to chart rendering. Workaround: CSV export only.`,
    testCaseId: null,
  },
];

export function generateRoundRobinMatchups(
  outputs: ReviewOutput[],
  excluded: Set<string>,
): { leftId: string; rightId: string }[] {
  const pool = outputs.filter((o) => !excluded.has(o.id));
  const pairs: { leftId: string; rightId: string }[] = [];
  for (let i = 0; i < pool.length; i++) {
    const a = pool[i]!;
    for (let j = i + 1; j < pool.length; j++) {
      const b = pool[j]!;
      pairs.push({ leftId: a.id, rightId: b.id });
    }
  }
  for (let i = pairs.length - 1; i > 0; i--) {
    const swap = Math.floor(Math.random() * (i + 1));
    const tmp = pairs[i]!;
    pairs[i] = pairs[swap]!;
    pairs[swap] = tmp;
  }
  return pairs;
}
