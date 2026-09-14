import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  buildContinuousOpsReport,
  type LongHorizonReportLike,
} from "../src/eval/long-horizon-report.js";

const [outputPath, ...inputPaths] = process.argv.slice(2);
if (!outputPath || inputPaths.length === 0)
  throw new Error(
    "usage: eval-ops-report <output.json> <window.json> [...window.json]",
  );
const reports = await Promise.all(
  inputPaths.map(
    async (path) =>
      JSON.parse(
        await readFile(resolve(path), "utf8"),
      ) as LongHorizonReportLike,
  ),
);
const report = buildContinuousOpsReport(reports);
const target = resolve(outputPath);
await mkdir(dirname(target), { recursive: true });
await writeFile(target, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
