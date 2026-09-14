import type { AcceptanceContract } from "../agent/task-evidence.js";

export interface LongHorizonTask {
  id: string;
  domain: string;
  goal: string;
  seedFiles: Readonly<Record<string, string>>;
  outputFiles: readonly string[];
  phaseInstructions: readonly string[];
  minTurns: number;
  maxTurns: number;
  acceptance: AcceptanceContract;
}

const REPORT_TEXT =
  "blue: 2 items, total 18\n" +
  "green: 1 item, total 9\n" +
  "red: 2 items, total 17\n" +
  "grand total: 44\n";

const LONG_HORIZON_TASKS: LongHorizonTask[] = [
  {
    id: "lh-ledger-join-01",
    domain: "tabular arithmetic",
    goal:
      "Read sales.json and calculate revenue per SKU by summing units * unitPrice for every row. " +
      "sales.json is an object whose rows array contains the records. " +
      'Write result.json with exactly {"totals": {"<SKU>": number}, "grandTotal": number}; sort SKU keys alphabetically. ' +
      "Do not hardcode an answer: derive it from the file.",
    seedFiles: {
      "sales.json": JSON.stringify(
        {
          rows: [
            { sku: "A", units: 3, unitPrice: 7 },
            { sku: "B", units: 4, unitPrice: 5 },
            { sku: "A", units: 2, unitPrice: 11 },
            { sku: "C", units: 5, unitPrice: 3 },
            { sku: "B", units: 1, unitPrice: 13 },
          ],
        },
        null,
        2,
      ),
    },
    outputFiles: ["result.json"],
    phaseInstructions: [
      "Inspect sales.json and call runtime.setPlan with the calculation steps. Do not write result.json or end the task yet.",
      "Use the inspected rows to calculate each SKU total and write result.json. Do not end the task in this turn.",
      "Read result.json, call runtime.verifyAcceptance, repair any failed field, and call runtime.endTask only after verification passes.",
    ],
    minTurns: 3,
    maxTurns: 5,
    acceptance: {
      source: "caller",
      checks: [
        {
          kind: "json_field",
          path: "result.json",
          field: ["totals"],
          equals: { A: 43, B: 33, C: 15 },
        },
        {
          kind: "json_field",
          path: "result.json",
          field: ["grandTotal"],
          equals: 91,
        },
      ],
    },
  },
  {
    id: "lh-latest-record-02",
    domain: "stateful deduplication",
    goal:
      "Read events.json. For each id, keep only its last record in file order, then write dedup.json with exactly " +
      '{"uniqueIds": number, "latestIds": string[], "statusCounts": object, "scoreTotal": number}. ' +
      "latestIds must be alphabetical; statusCounts and scoreTotal must describe only the retained records.",
    seedFiles: {
      "events.json": JSON.stringify(
        [
          { id: "a", status: "open", score: 7 },
          { id: "b", status: "pending", score: 4 },
          { id: "c", status: "open", score: 6 },
          { id: "a", status: "closed", score: 9 },
          { id: "b", status: "closed", score: 8 },
          { id: "d", status: "closed", score: 2 },
        ],
        null,
        2,
      ),
    },
    outputFiles: ["dedup.json"],
    phaseInstructions: [
      "Read events.json and set a plan describing the last-record-wins rule. Do not write dedup.json or end the task.",
      "Compute the retained records, status counts, and score total, then write dedup.json. Do not end the task.",
      "Read dedup.json, verify it against the caller contract, repair if needed, and end only after verification passes.",
    ],
    minTurns: 3,
    maxTurns: 5,
    acceptance: {
      source: "caller",
      checks: [
        {
          kind: "json_field",
          path: "dedup.json",
          field: ["uniqueIds"],
          equals: 4,
        },
        {
          kind: "json_field",
          path: "dedup.json",
          field: ["latestIds"],
          equals: ["a", "b", "c", "d"],
        },
        {
          kind: "json_field",
          path: "dedup.json",
          field: ["statusCounts"],
          equals: { closed: 3, open: 1 },
        },
        {
          kind: "json_field",
          path: "dedup.json",
          field: ["scoreTotal"],
          equals: 25,
        },
      ],
    },
  },
  {
    id: "lh-multi-artifact-03",
    domain: "multi-artifact reporting",
    goal:
      "Read notes.txt. Each line has a label, a tag in square brackets, and an integer. " +
      'Write summary.json with {"tags": {"<tag>": {"count": number, "total": number}}, "grandTotal": number}; ' +
      "sort tag keys alphabetically. Also write report.txt with one line per tag in alphabetical order using exactly " +
      'the format "tag: N items, total T" (use "item" for N=1), followed by "grand total: G".',
    seedFiles: {
      "notes.txt":
        "alpha [red] 12\nbeta [blue] 7\ngamma [red] 5\ndelta [green] 9\nepsilon [blue] 11\n",
    },
    outputFiles: ["summary.json", "report.txt"],
    phaseInstructions: [
      "Read notes.txt, parse the records, and set a plan. Do not write either final artifact or end the task.",
      "Write summary.json with the per-tag counts and totals. Do not end the task.",
      "Write report.txt in the required exact line format, verify both artifacts, repair any failure, then end the task.",
    ],
    minTurns: 3,
    maxTurns: 5,
    acceptance: {
      source: "caller",
      checks: [
        {
          kind: "json_field",
          path: "summary.json",
          field: ["tags"],
          equals: {
            blue: { count: 2, total: 18 },
            green: { count: 1, total: 9 },
            red: { count: 2, total: 17 },
          },
        },
        {
          kind: "json_field",
          path: "summary.json",
          field: ["grandTotal"],
          equals: 44,
        },
        {
          kind: "sha256",
          path: "report.txt",
          equals:
            "5b127174f2fc89f591e9ed6683b34f413ef4b9c5108840661c50829be3830ac0",
        },
      ],
    },
  },
  {
    id: "lh-repair-loop-04",
    domain: "verification and repair",
    goal:
      'Read numbers.json and write answer.json with exactly {"stats": {"count": number, "evenSum": number, ' +
      '"oddSum": number, "min": number, "max": number}}. Derive every value from the input. ' +
      "numbers.json is an object whose values array contains the integers. Treat zero as even if it appears.",
    seedFiles: {
      "numbers.json": JSON.stringify(
        { values: [19, 4, 27, 8, 15, 2] },
        null,
        2,
      ),
    },
    outputFiles: ["answer.json"],
    phaseInstructions: [
      "Read numbers.json, set a plan, and create only a draft calculation if useful. Do not end the task.",
      "Write answer.json from the input and run runtime.verifyAcceptance. If a check fails, use that host feedback to repair it. Do not end yet.",
      "Re-read answer.json, verify again, repair any remaining error, and call runtime.endTask only when the caller contract passes.",
    ],
    minTurns: 3,
    maxTurns: 5,
    acceptance: {
      source: "caller",
      checks: [
        {
          kind: "json_field",
          path: "answer.json",
          field: ["stats"],
          equals: { count: 6, evenSum: 14, oddSum: 61, min: 2, max: 27 },
        },
      ],
    },
  },
  {
    id: "lh-plan-inventory-05",
    domain: "planning and constrained aggregation",
    goal:
      "Read inventory.json. Available stock is stock - reserved. Write inventory_report.json with exactly " +
      '{"totalAvailable": number, "lowStock": string[], "restockUnits": number}. ' +
      "lowStock contains alphabetical item names whose available stock is at most 3. " +
      "restockUnits is the total needed to bring every item to 10 available units; never count negative need.",
    seedFiles: {
      "inventory.json": JSON.stringify(
        [
          { name: "paper", stock: 12, reserved: 3 },
          { name: "ink", stock: 5, reserved: 2 },
          { name: "clips", stock: 20, reserved: 8 },
          { name: "folders", stock: 7, reserved: 7 },
        ],
        null,
        2,
      ),
    },
    outputFiles: ["inventory_report.json"],
    phaseInstructions: [
      "Read inventory.json and call runtime.setPlan with explicit aggregation and verification steps. Do not write the final report or end the task.",
      "Compute available stock, low-stock names, and restock units, then write inventory_report.json. Do not end the task.",
      "Read the report, call runtime.verifyAcceptance, repair any failed field, and call runtime.endTask only after it passes.",
    ],
    minTurns: 3,
    maxTurns: 5,
    acceptance: {
      source: "caller",
      checks: [
        {
          kind: "json_field",
          path: "inventory_report.json",
          field: ["totalAvailable"],
          equals: 24,
        },
        {
          kind: "json_field",
          path: "inventory_report.json",
          field: ["lowStock"],
          equals: ["folders", "ink"],
        },
        {
          kind: "json_field",
          path: "inventory_report.json",
          field: ["restockUnits"],
          equals: 18,
        },
      ],
    },
  },
];

export function buildLongHorizonTaskSet(): LongHorizonTask[] {
  return LONG_HORIZON_TASKS.map((task) => ({
    ...task,
    seedFiles: { ...task.seedFiles },
    outputFiles: [...task.outputFiles],
    phaseInstructions: [...task.phaseInstructions],
  }));
}

export function longHorizonReportText(): string {
  return REPORT_TEXT;
}
