/**
 * Runnable trace of the colord call chain (companion of ANALYSIS.md).
 *
 * Run from the repository root:
 *
 *   npx ts-node --compiler-options '{"module":"commonjs"}' scripts/trace-pipeline.ts
 *
 * It prints one row per boundary color: the Layer-1 parser decision, the
 * unrounded internal RGBA model (Layer 2), and a formatted public result
 * (Layer 3). Every row also carries an expectation: when the observed values
 * stop matching the documented ones, the script throws with the precise step
 * label and the offending value (exit code 1), so it doubles as a red-flag
 * check for the conclusions most often guessed wrong:
 *
 *   - percentage channels keep 127.5 internally (rounding is output-only);
 *   - a hex alpha byte is rounded at PARSE time (0x44 => 0.27);
 *   - 0.9996 alpha serializes as opaque but stays 0.9996 in the model;
 *   - "#fffff" is regex-accepted but rejected by the length dispatcher;
 *   - plugin load order alone flips an ambiguous object between lab and lch.
 */
import { colord, getFormat, extend, Colord } from "../src";
import hwbPlugin from "../src/plugins/hwb";
import xyzPlugin from "../src/plugins/xyz";
import labPlugin from "../src/plugins/lab";
import lchPlugin from "../src/plugins/lch";
import cmykPlugin from "../src/plugins/cmyk";
import namesPlugin from "../src/plugins/names";
import a11yPlugin from "../src/plugins/a11y";
import mixPlugin from "../src/plugins/mix";

extend([hwbPlugin, xyzPlugin, labPlugin, lchPlugin, cmykPlugin, namesPlugin, a11yPlugin, mixPlugin]);

type AnyInput = string | Record<string, number>;

interface TraceRow {
  step: string;
  input: AnyInput;
  format: ReturnType<typeof getFormat>;
  valid: boolean;
  rgba: RgbaView;
  output: string;
  stringify?: (color: Colord) => string;
  expect: { format: ReturnType<typeof getFormat>; rgba: RgbaView; output: string };
}

type RgbaView = { r: number; g: number; b: number; a: number };

const view = (color: Colord): RgbaView => color.rgba;

const rows: TraceRow[] = [
  {
    step: "L1 regex accepts digits, length dispatcher rejects 5",
    input: "#fffff",
    format: undefined,
    valid: false,
    rgba: { r: 0, g: 0, b: 0, a: 1 },
    output: "#000000",
    expect: { format: undefined, rgba: { r: 0, g: 0, b: 0, a: 1 }, output: "#000000" },
  },
  {
    step: "L1 mixed number/percentage rgb is invalid",
    input: "rgb(1 2% 3)",
    format: undefined,
    valid: false,
    rgba: { r: 0, g: 0, b: 0, a: 1 },
    output: "#000000",
    expect: { format: undefined, rgba: { r: 0, g: 0, b: 0, a: 1 }, output: "#000000" },
  },
  {
    step: "L2 percentage rgb keeps .5 fraction internally",
    input: "rgb(50%, 50%, 50%)",
    format: "rgb",
    valid: true,
    rgba: { r: 127.5, g: 127.5, b: 127.5, a: 1 },
    output: "#808080",
    expect: { format: "rgb", rgba: { r: 127.5, g: 127.5, b: 127.5, a: 1 }, output: "#808080" },
  },
  {
    step: "L2 clamp: 300/NaN alpha 2 -> 255/0/0,1",
    input: { r: 300, g: -5, b: Number("x"), a: 2 },
    format: "rgb",
    valid: true,
    rgba: { r: 255, g: 0, b: 0, a: 1 },
    output: "#ff0000",
    expect: { format: "rgb", rgba: { r: 255, g: 0, b: 0, a: 1 }, output: "#ff0000" },
  },
  {
    step: "L2 hex alpha byte is rounded at parse time (0x44 -> 0.27)",
    input: "#fff4",
    format: "hex",
    valid: true,
    rgba: { r: 255, g: 255, b: 255, a: 0.27 },
    output: "#ffffff45",
    expect: { format: "hex", rgba: { r: 255, g: 255, b: 255, a: 0.27 }, output: "#ffffff45" },
  },
  {
    step: "L3 alpha 0.9996 is opaque after rounding, exact internally",
    input: "rgba(0, 0, 0, 0.9996)",
    format: "rgb",
    valid: true,
    rgba: { r: 0, g: 0, b: 0, a: 0.9996 },
    output: "rgb(0, 0, 0)",
    stringify: (color) => color.toRgbString(),
    expect: { format: "rgb", rgba: { r: 0, g: 0, b: 0, a: 0.9996 }, output: "rgb(0, 0, 0)" },
  },
  {
    step: "L2 ambiguous object resolved to lab (lab extended before lch)",
    input: { l: 50, c: 10, h: 0, a: 1, b: 0 },
    format: "lab",
    valid: true,
    rgba: { r: 120.66830697305947, g: 118.35846509189417, b: 118.95394176926527, a: 1 },
    output: "#797677",
    expect: {
      format: "lab",
      rgba: { r: 120.66830697305947, g: 118.35846509189417, b: 118.95394176926527, a: 1 },
      output: "#797677",
    },
  },
  {
    step: "L2 same numbers via lch() string hit the lch parser",
    input: "lch(50% 10 0)",
    format: "lch",
    valid: true,
    rgba: { r: 135.6858182426416, g: 113.02298826009628, b: 119.33198616898308, a: 1 },
    output: "#887177",
    expect: {
      format: "lch",
      rgba: { r: 135.6858182426416, g: 113.02298826009628, b: 119.33198616898308, a: 1 },
      output: "#887177",
    },
  },
  {
    step: "L2 hwb w+b>=100 -> gray 127.5",
    input: { h: 0, w: 60, b: 60 },
    format: "hwb",
    valid: true,
    rgba: { r: 127.5, g: 127.5, b: 127.5, a: 1 },
    output: "#808080",
    expect: { format: "hwb", rgba: { r: 127.5, g: 127.5, b: 127.5, a: 1 }, output: "#808080" },
  },
  {
    step: "L1 name keyword is a plugin parser",
    input: "white",
    format: "name",
    valid: true,
    rgba: { r: 255, g: 255, b: 255, a: 1 },
    output: "#ffffff",
    expect: { format: "name", rgba: { r: 255, g: 255, b: 255, a: 1 }, output: "#ffffff" },
  },
];

const isSameRgba = (actual: RgbaView, expected: RgbaView): boolean =>
  Object.keys(expected).every(
    (channel) => actual[channel as keyof RgbaView] === expected[channel as keyof RgbaView]
  );

let failures = 0;

for (const row of rows) {
  const color = colord(row.input as Parameters<typeof colord>[0]);
  const actual = {
    format: getFormat(row.input as Parameters<typeof getFormat>[0]),
    valid: color.isValid(),
    rgba: view(color),
    output: color.toHex(),
  };

  const producedOutput = (row.stringify ? row.stringify(color) : color.toHex());
  const outputMatches = producedOutput === row.expect.output;

  const problems: string[] = [];
  if (actual.format !== row.expect.format)
    problems.push(`format: expected=${String(row.expect.format)} actual=${String(actual.format)}`);
  if (actual.valid !== row.valid)
    problems.push(`valid: expected=${String(row.valid)} actual=${String(actual.valid)}`);
  if (!isSameRgba(actual.rgba, row.expect.rgba))
    problems.push(`rgba: expected=${JSON.stringify(row.expect.rgba)} actual=${JSON.stringify(actual.rgba)}`);
  if (!outputMatches)
    problems.push(`output: expected=${row.expect.output} actual=${producedOutput}`);

  if (problems.length) {
    failures += 1;
    console.error(`FAIL [${row.step}] at input=${JSON.stringify(row.input)}`);
    for (const problem of problems) console.error(`       ${problem}`);
  } else {
    console.log(`ok   [${row.step}] -> ${producedOutput} @ ${String(actual.format)}`);
  }
}

// The alpha-serialization boundary is easy to guess backwards: assert the
// STRING output specifically, which is not part of the rows above.
const nearlyOpaque = colord("rgba(0, 0, 0, 0.9996)");
if (nearlyOpaque.toRgbString() !== "rgb(0, 0, 0)" || nearlyOpaque.rgba.a !== 0.9996) {
  failures += 1;
  console.error(
    `FAIL [L3 string boundary] rgba.a=${nearlyOpaque.rgba.a} string=${nearlyOpaque.toRgbString()}`
  );
}

// Plugin chains read the shared model: mix via LAB vs via RGB must differ,
// and contrast is computed from the rounded RGBA view.
if (colord("#ff0000").mix("#0000ff").toHex() !== "#c10088") failures += 1;
if (colord("#ff0000").mix("#0000ff", 0.5, "rgb").toHex() !== "#800080") failures += 1;
if (colord("#000000").contrast("#ffffff") !== 21) failures += 1;

if (failures > 0) {
  console.error(`\n${failures} trace assertion(s) failed`);
  process.exit(1);
}
console.log(`\nAll ${rows.length} trace rows and the cross-plugin invariants match ANALYSIS.md`);
