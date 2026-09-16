import type { AcceptanceContract } from "../agent/task-evidence.js";

export type ExternalAcceptance =
  | {
      kind: "json_fields";
      path: string;
      fields: Readonly<Record<string, unknown>>;
    }
  | { kind: "text_contains"; path: string; required: readonly string[] }
  | {
      kind: "program_static";
      path: string;
      required: readonly string[];
      forbidden?: readonly string[];
    }
  | {
      kind: "cross_file";
      paths: readonly string[];
      required: readonly string[];
    };

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
  externalAcceptance?: ExternalAcceptance;
  crashRestart?: boolean;
  interruptGoalChange?: string;
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
    externalAcceptance: {
      kind: "json_fields",
      path: "result.json",
      fields: { grandTotal: 91 },
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
    externalAcceptance: {
      kind: "json_fields",
      path: "dedup.json",
      fields: { uniqueIds: 4, scoreTotal: 25 },
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
    externalAcceptance: {
      kind: "text_contains",
      path: "report.txt",
      required: ["blue: 2 items, total 18", "grand total: 44"],
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
    externalAcceptance: {
      kind: "json_fields",
      path: "answer.json",
      fields: { stats: { count: 6, evenSum: 14, oddSum: 61 } },
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
    externalAcceptance: {
      kind: "json_fields",
      path: "inventory_report.json",
      fields: { totalAvailable: 24, restockUnits: 18 },
    },
  },
  {
    id: "lh-program-repair-06",
    domain: "programming repair",
    goal:
      "Read buggy.js and repair the average function into fixed.js. The caller requires an exported average(values) function, " +
      "an empty array must return 0, and a non-empty numeric array must return its arithmetic mean. Do not change the input file.",
    seedFiles: {
      "buggy.js":
        "export function average(values) {\n" +
        "  return values.reduce((sum, value) => sum + value, 0) / values.length;\n" +
        "}\n",
    },
    outputFiles: ["fixed.js"],
    phaseInstructions: [
      "Read buggy.js and set a repair plan. Do not write fixed.js or end the task.",
      "Write fixed.js with the repaired exported average function. Do not end the task.",
      "Read fixed.js, call runtime.verifyAcceptance, repair any failure, and end only after the caller and external checks pass.",
    ],
    minTurns: 3,
    maxTurns: 5,
    crashRestart: true,
    acceptance: {
      source: "caller",
      checks: [{ kind: "nonempty_file", path: "fixed.js" }],
    },
    externalAcceptance: {
      kind: "program_static",
      path: "fixed.js",
      required: ["export function average", "values.length", "return 0"],
      forbidden: ["process", "require", "fetch", "child_process"],
    },
  },
  {
    id: "lh-data-process-07",
    domain: "data processing",
    goal:
      "Read records.csv, group rows by department, sum amount and count rows, then write records.json with " +
      '{"departments":{"<name>":{"count":number,"total":number}},"grandTotal":number}. Sort department keys alphabetically.',
    seedFiles: {
      "records.csv":
        "department,amount\nalpha,12\nbeta,7\nalpha,5\ngamma,9\nbeta,11\n",
    },
    outputFiles: ["records.json"],
    phaseInstructions: [
      "Read records.csv and set a parsing and aggregation plan. Do not write records.json or end the task.",
      "Parse the CSV, aggregate each department, and write records.json. Do not end the task.",
      "Read records.json, verify the caller contract, repair if needed, and end after verification.",
    ],
    minTurns: 3,
    maxTurns: 5,
    acceptance: {
      source: "caller",
      checks: [
        {
          kind: "json_field",
          path: "records.json",
          field: ["departments"],
          equals: {
            alpha: { count: 2, total: 17 },
            beta: { count: 2, total: 18 },
            gamma: { count: 1, total: 9 },
          },
        },
        {
          kind: "json_field",
          path: "records.json",
          field: ["grandTotal"],
          equals: 44,
        },
      ],
    },
    externalAcceptance: {
      kind: "json_fields",
      path: "records.json",
      fields: { grandTotal: 44 },
    },
  },
  {
    id: "lh-information-verify-08",
    domain: "information verification",
    goal:
      "Read claims.json and write verification.json. Preserve each claim id, mark claims with an exact matching source fact as verified, " +
      'and mark all other claims unverified. Output {"claims":[{"id":string,"verified":boolean}],"verifiedCount":number} in input order.',
    seedFiles: {
      "claims.json": JSON.stringify(
        {
          claims: [
            {
              id: "c1",
              statement: "alpha has value 3",
              source: { subject: "alpha", value: 3 },
            },
            {
              id: "c2",
              statement: "beta has value 8",
              source: { subject: "beta", value: 7 },
            },
            {
              id: "c3",
              statement: "gamma has value 4",
              source: { subject: "gamma", value: 4 },
            },
          ],
        },
        null,
        2,
      ),
    },
    outputFiles: ["verification.json"],
    phaseInstructions: [
      "Read claims.json and set a verification plan. Do not write verification.json or end the task.",
      "Compare every claim with its source fact and write verification.json in input order. Do not end the task.",
      "Read verification.json, call runtime.verifyAcceptance, repair errors, and end only after it passes.",
    ],
    minTurns: 3,
    maxTurns: 5,
    acceptance: {
      source: "caller",
      checks: [
        {
          kind: "json_field",
          path: "verification.json",
          field: ["claims"],
          equals: [
            { id: "c1", verified: true },
            { id: "c2", verified: false },
            { id: "c3", verified: true },
          ],
        },
        {
          kind: "json_field",
          path: "verification.json",
          field: ["verifiedCount"],
          equals: 2,
        },
      ],
    },
    externalAcceptance: {
      kind: "json_fields",
      path: "verification.json",
      fields: { verifiedCount: 2 },
    },
  },
  {
    id: "lh-document-09",
    domain: "document output",
    goal:
      "Read brief.txt and write decision.md as a concise decision memo. It must contain the headings '# Decision', '# Evidence', " +
      "and '# Risks', and include the exact decision words 'proceed' and 'rollback'. Do not invent a different decision.",
    seedFiles: {
      "brief.txt":
        "Decision: proceed with the staged rollout. Evidence: two checks passed. Risk: rollback if error rate rises.\n",
    },
    outputFiles: ["decision.md"],
    phaseInstructions: [
      "Read brief.txt and set a memo plan. Do not write decision.md or end the task.",
      "Write decision.md with the required headings and source-grounded decision/evidence/risk content. Do not end the task.",
      "Read decision.md, verify the caller contract, repair if needed, and end after verification.",
    ],
    minTurns: 3,
    maxTurns: 5,
    acceptance: {
      source: "caller",
      checks: [{ kind: "nonempty_file", path: "decision.md" }],
    },
    externalAcceptance: {
      kind: "text_contains",
      path: "decision.md",
      required: ["# Decision", "# Evidence", "# Risks", "proceed", "rollback"],
    },
  },
  {
    id: "lh-cross-tool-10",
    domain: "cross-tool task",
    goal:
      "Read inventory.csv and rules.txt using separate file operations, apply the rule to compute reorder quantities, and write cross_tool.json " +
      'with {"items":[{"name":string,"reorder":number}],"totalReorder":number}; sort items alphabetically and never use external tools.',
    seedFiles: {
      "inventory.csv": "name,stock\nclips,3\nink,8\npaper,12\n",
      "rules.txt":
        "Target stock is 10 for every item; reorder is max(0, target - stock).\n",
    },
    outputFiles: ["cross_tool.json"],
    phaseInstructions: [
      "Read inventory.csv and rules.txt in separate operations, then set a plan. Do not write cross_tool.json or end the task.",
      "Apply the rule and write cross_tool.json. Do not end the task.",
      "Read cross_tool.json, verify the caller contract, repair any failure, and end after verification.",
    ],
    minTurns: 3,
    maxTurns: 5,
    crashRestart: true,
    acceptance: {
      source: "caller",
      checks: [
        {
          kind: "json_field",
          path: "cross_tool.json",
          field: ["items"],
          equals: [
            { name: "clips", reorder: 7 },
            { name: "ink", reorder: 2 },
            { name: "paper", reorder: 0 },
          ],
        },
        {
          kind: "json_field",
          path: "cross_tool.json",
          field: ["totalReorder"],
          equals: 9,
        },
      ],
    },
    externalAcceptance: {
      kind: "cross_file",
      paths: ["inventory.csv", "rules.txt", "cross_tool.json"],
      required: ["clips", "reorder", "totalReorder"],
    },
  },
  {
    id: "lh-social-organize-11",
    domain: "social information organization",
    goal:
      "Read messages.json and organize social information into social_digest.json with participants, topics, and actionItems. " +
      "Each action item must include owner, task, and priority (high/normal); preserve only actionable messages and sort actionItems by priority then owner.",
    seedFiles: {
      "messages.json": JSON.stringify(
        [
          {
            from: "Aki",
            text: "我来整理发布说明",
            actionable: true,
            priority: "high",
          },
          { from: "Bo", text: "周五一起看展吗", actionable: false },
          {
            from: "Chen",
            text: "请把测试结果发群里",
            actionable: true,
            priority: "normal",
          },
        ],
        null,
        2,
      ),
    },
    outputFiles: ["social_digest.json"],
    phaseInstructions: [
      "Read messages.json and set a plan for participants, topics, and actionable items. Do not write social_digest.json or end the task.",
      "Write social_digest.json, retaining actionable owners/tasks and assigning priorities from the source. Do not end the task.",
      "Read social_digest.json, verify the caller contract, repair errors, and end after verification.",
    ],
    minTurns: 3,
    maxTurns: 5,
    interruptGoalChange:
      "Goal change from the user: keep the same digest, but prioritize unresolved action items and include their priority explicitly.",
    acceptance: {
      source: "caller",
      checks: [
        {
          kind: "json_field",
          path: "social_digest.json",
          field: ["actionItems"],
          equals: [
            { owner: "Aki", task: "整理发布说明", priority: "high" },
            { owner: "Chen", task: "把测试结果发群里", priority: "normal" },
          ],
        },
        {
          kind: "json_field",
          path: "social_digest.json",
          field: ["participants"],
          equals: ["Aki", "Bo", "Chen"],
        },
      ],
    },
    externalAcceptance: {
      kind: "json_fields",
      path: "social_digest.json",
      fields: { participants: ["Aki", "Bo", "Chen"] },
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
