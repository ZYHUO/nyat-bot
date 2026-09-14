import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  compareLongHorizonReports,
  type LongHorizonReportLike,
} from "../src/eval/long-horizon-report.js";

const [baselinePath, experimentPath, outputPath] = process.argv.slice(2);
if (!baselinePath || !experimentPath || !outputPath)
  throw new Error(
    "usage: compare-long-horizon-reports <baseline.json> <experiment.json> <output.json>",
  );
const baseline = JSON.parse(
  await readFile(resolve(baselinePath), "utf8"),
) as LongHorizonReportLike;
const experiment = JSON.parse(
  await readFile(resolve(experimentPath), "utf8"),
) as LongHorizonReportLike;
const report = compareLongHorizonReports(baseline, experiment);
const target = resolve(outputPath);
await mkdir(dirname(target), { recursive: true });
await writeFile(target, `${JSON.stringify(report, null, 2)}\n`, "utf8");
console.log(JSON.stringify(report, null, 2));
