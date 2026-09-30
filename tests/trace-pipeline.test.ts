/**
 * Targeted trace of the full call chain documented in ANALYSIS.md:
 *
 *   input -> parse() walks the registered parser arrays in registration order
 *         -> first hit is clamped to a (deliberately UNROUNDED) RGBA model
 *         -> Colord stores it; plugins only mutate the prototype/parser registry
 *         -> output methods round/clamp again at serialization time
 *
 * Every `it` below is an independently runnable piece of evidence for one claim:
 * the test name names the claim, the body asserts both the public result and,
 * where the claim is about internals, the intermediate `rgba` model.
 */
import { colord, getFormat, extend, Colord, Plugin } from "../src/";
import { parsers } from "../src/parse";
import { RgbaColor, Parsers } from "../src/types";
import hwbPlugin from "../src/plugins/hwb";
import xyzPlugin from "../src/plugins/xyz";
import labPlugin from "../src/plugins/lab";
import lchPlugin from "../src/plugins/lch";
import cmykPlugin from "../src/plugins/cmyk";
import namesPlugin from "../src/plugins/names";
import a11yPlugin from "../src/plugins/a11y";
import mixPlugin from "../src/plugins/mix";
import minifyPlugin from "../src/plugins/minify";

// Canonical extension order for THIS file: it fixes the parser arrays so the
// ordering assertions below are deterministic (see "Layer 1" in ANALYSIS.md).
extend([
  hwbPlugin,
  xyzPlugin,
  labPlugin,
  lchPlugin,
  cmykPlugin,
  namesPlugin,
  a11yPlugin,
  mixPlugin,
  minifyPlugin,
]);

const BLACK = { r: 0, g: 0, b: 0, a: 1 };

describe("Layer 1 - input validity: a parser either accepts or returns null", () => {
  it("a 5-digit hex passes the broad character matcher but is rejected as no notation", () => {
    // Layer 1 is syntactic. "#fffff" is all hex digits, so parseHex's regex
    // admits it; only the length dispatcher (3/4/6/8) rejects it, after which
    // rgb()/hsl() fail too and the whole parse is [null, undefined].
    expect(getFormat("#fffff")).toBeUndefined();
    const color = colord("#fffff");
    expect(color.isValid()).toBe(false);
    expect(color.rgba).toEqual(BLACK);
  });

  it("rejects rgb() that mixes number and percentage channels in linear-time regex form", () => {
    // Both separators match syntactically; the explicit number/percentage
    // cross-check is what rejects. No parser further down the list accepts it.
    for (const input of ["rgb(1 2% 3)", "rgb(1, 2%, 3)"]) {
      expect(getFormat(input)).toBeUndefined();
      expect(colord(input).isValid()).toBe(false);
    }
  });

  it("rejects a non-numeric alpha token instead of coercing it to NaN", () => {
    // The number alternative `(?:\d*\.\d+|\d+)` does not match "abc", so the
    // alpha group itself makes the whole string invalid.
    expect(colord("rgba(0, 0, 0, abc)").isValid()).toBe(false);
  });

  it("trims surrounding whitespace before any parser sees the string", () => {
    // parse() trims once centrally: trimming is not each parser's responsibility.
    expect(getFormat("  #fff  ")).toBe("hex");
    expect(colord("  #fff  ").rgba).toEqual({ r: 255, g: 255, b: 255, a: 1 });
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a number", 42],
    ["an array", [255, 0, 0]],
    ["empty string", ""],
  ])("failure recovery: %s becomes opaque black, never a throw", (_label, input) => {
    // parse() only dispatches strings and non-null objects; everything else
    // short-circuits to [null, undefined]. Colord then falls back to black and
    // keeps the failure visible through isValid().
    expect(getFormat(input as never)).toBeUndefined();
    const color = colord(input as never);
    expect(color.isValid()).toBe(false);
    expect(color.rgba).toEqual(BLACK);
    expect(color.toHex()).toBe("#000000");
  });

  it("an object missing required channels falls THROUGH the list instead of clamping", () => {
    // {r:""} fails isPresent(r), so the rgb parser returns null and the hsl
    // parser gets its turn. An object with no model's required channels at all
    // is invalid; an object with h/s/l is accepted by hsl.
    expect(getFormat({ r: "", g: 0, b: 0 } as never)).toBeUndefined();
    expect(colord({ r: "", g: 0, b: 0 } as never).isValid()).toBe(false);
    expect(getFormat({ r: undefined, h: 120, s: 50, l: 50 } as never)).toBe("hsl");
  });

  it("plugin formats are opt-in at the parser level: getFormat and isValid agree", () => {
    // Both call the same parse(): the format label exists exactly when the
    // parse result is non-null. (In a fresh module scope without namesPlugin
    // this would be undefined; see trace-plugin-order.test.ts.)
    expect(getFormat("white")).toBe("name");
    expect(colord("white").isValid()).toBe(true);
  });
});

describe("Layer 2 - parser registration order selects the mapping for ambiguous objects", () => {
  // Each object below carries enough keys for MORE THAN ONE parser. The winner
  // is the first parser whose required channels are present, never the "best"
  // semantic fit: rgb > hsl > hsv are built-in, plugins are appended after them.
  it.each([
    ["rgb wins over hsl/hsv keys", { r: 255, g: 0, b: 0, h: 120, s: 50, l: 50, v: 1 }, "rgb"],
    ["hsl wins when r is absent, even with v present", { h: 0, s: 100, l: 50, v: 100 }, "hsl"],
    ["hsv wins over the appended hwb parser", { h: 0, s: 100, v: 100, w: 0, b: 0 }, "hsv"],
    ["hwb wins for an h/w/b object hsv cannot read", { h: 0, w: 0, b: 0 }, "hwb"],
    ["lab wins over lch: its parser was extended first", { l: 50, a: 0, b: 0, c: 10, h: 0 }, "lab"],
    ["lch still wins for an l/c/h object lab cannot read", { l: 50, c: 10, h: 0, a: 1 }, "lch"],
    ["xyz wins on x/y/z", { x: 0, y: 0, z: 0 }, "xyz"],
    ["cmyk wins on c/m/y/k", { c: 0, m: 0, y: 0, k: 0 }, "cmyk"],
  ])("%s", (_label, input, format) => {
    expect(getFormat(input)).toBe(format);
  });

  it("freezes the exact registry order produced by the canonical extend() list", () => {
    // These two arrays are the single source of parse priority. If a plugin
    // starts inserting differently, this fails loudly instead of silently
    // re-routing ambiguous inputs.
    expect(parsers.object.map((parser) => parser[1])).toEqual([
      "rgb",
      "hsl",
      "hsv",
      "hwb",
      "xyz",
      "lab",
      "lch",
      "cmyk",
    ]);
    expect(parsers.string.map((parser) => parser[1])).toEqual([
      "hex",
      "rgb",
      "hsl",
      "hwb",
      "lch",
      "cmyk",
      "name",
    ]);
  });

  it("proves order is load-dependent: lab beats lch only because lab was extended first", () => {
    // Same object, opposite winner in trace-plugin-order.test.ts (fresh module
    // scope, reversed extend order). This is the pairing the doc points at.
    const ambiguous = { l: 50, c: 10, h: 0, a: 1, b: 0 };
    expect(getFormat(ambiguous)).toBe("lab");
    // The two interpretations genuinely map to different colors.
    expect(colord(ambiguous).toHex()).toBe("#797677");
    expect(colord("lch(50% 10 0)").toHex()).toBe("#887177");
  });
});

describe("Layer 2 - clamp happens on the way IN to the unrounded RGBA model", () => {
  it("clamps numeric channels and coerces NaN to the lower bound", () => {
    // clamp() is NaN-aware: Number("x") => NaN => 0, 300 => 255, -5 => 0,
    // alpha 2 => 1. The clamped object IS the stored model (objects do not
    // round), so rgba and toRgb() coincide here.
    const color = colord({ r: 300, g: -5, b: "x", a: 2 } as never);
    expect(color.rgba).toEqual({ r: 255, g: 0, b: 0, a: 1 });
    expect(color.toRgb()).toEqual({ r: 255, g: 0, b: 0, a: 1 });
  });

  it("keeps percentage-rgb fractions unrounded internally and rounds only on output", () => {
    // 50% = 127.5: it must survive in rgba (conversion accuracy) while every
    // public 8-bit view reports 128.
    const color = colord("rgb(50%, 50%, 50%)");
    expect(color.rgba).toEqual({ r: 127.5, g: 127.5, b: 127.5, a: 1 });
    expect(color.toRgb()).toEqual({ r: 128, g: 128, b: 128, a: 1 });
    expect(color.toHex()).toBe("#808080");
  });

  it("maps non-finite hues to 0 and clamps saturation/lightness", () => {
    // clampHue: NaN/Infinity => 0; s/l percentages clamp to [0,100].
    const invalidHue = colord({ h: NaN, s: 200, l: -10 });
    expect(invalidHue.rgba).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    expect(invalidHue.toHsl()).toEqual({ h: 0, s: 0, l: 0, a: 1 });
  });

  it("treats a hue of exactly 360 as 0 at the mapping boundary", () => {
    // 360 is a valid CSS angle equal to 0; wrapping is exclusive at the top.
    expect(colord({ h: 360, s: 100, l: 50 }).toHex()).toBe("#ff0000");
  });

  it("normalizes HWB whiteness + blackness over 100% to the achromatic gray", () => {
    // hwbaToRgba special-cases w + b >= 100: gray = w/(w+b)*255 = 127.5.
    const fromObject = colord({ h: 0, w: 60, b: 60 });
    const fromString = colord("hwb(0 60% 60%)");
    expect(fromObject.rgba).toEqual({ r: 127.5, g: 127.5, b: 127.5, a: 1 });
    expect(fromString.rgba).toEqual(fromObject.rgba);
    expect(fromObject.toHex()).toBe("#808080");
  });

  it("gives every symmetric entry of pure red the same unrounded RGBA model", () => {
    // String/object, comma/space syntax and angle units are separate Layer-1
    // gates, but Layer 2 must converge on one RGBA value exactly.
    const target: RgbaColor = { r: 255, g: 0, b: 0, a: 1 };
    const entries = [
      "rgb(255, 0, 0)",
      "rgb(255 0 0)",
      "rgb(100% 0% 0%)",
      "hsl(0, 100%, 50%)",
      "hsl(0 100% 50%)",
      "hsl(1turn 100% 50%)",
      "hwb(0 0% 0%)",
      "#ff0000",
      { r: 255, g: 0, b: 0 },
      { h: 0, s: 100, l: 50 },
      { h: 0, s: 100, v: 100 },
      { h: 0, w: 0, b: 0 },
    ];
    for (const entry of entries) expect(colord(entry).rgba).toEqual(target);
  });
});

describe("Layer 2 - internal alpha is carried verbatim; hex parses are the exception", () => {
  it("stores a raw 0.5 alpha from number and percentage syntax", () => {
    expect(colord("rgba(0, 0, 0, .5)").rgba.a).toBe(0.5);
    expect(colord("rgba(0, 0, 0, 50%)").rgba.a).toBe(0.5);
  });

  it("clamps object alpha into [0, 1] and passes it through untouched", () => {
    expect(colord({ r: 0, g: 0, b: 0, a: -2 }).rgba.a).toBe(0);
    expect(colord({ r: 0, g: 0, b: 0, a: 1.5 }).rgba.a).toBe(1);
    const half = colord({ h: 0, s: 0, l: 0, a: 0.3333333333 });
    expect(half.rgba.a).toBe(0.3333333333);
  });

  it("rounds hex alpha DURING parsing, unlike every other parser", () => {
    // parseHex quantizes to a byte then rounds to 2 digits: 0x44/255 =
    // 0.2666... => 0.27. The quantized value does not round-trip to byte 0x44.
    const hex4 = colord("#fff4");
    expect(hex4.rgba.a).toBe(0.27);
    expect(hex4.toHex()).toBe("#ffffff45");
    const hex8 = colord("#ffffff80");
    expect(hex8.rgba.a).toBe(0.5);
  });

  it("never rounds a fractional alpha before an output method asks for it", () => {
    const color = colord("rgba(0, 0, 0, 0.123456)");
    expect(color.rgba.a).toBe(0.123456);
    expect(color.alpha()).toBe(0.123);
    expect(color.toRgb().a).toBe(0.123);
  });
});

describe("Layer 2 - plugin conversions read the same RGBA model", () => {
  it("converts red through LAB and XYZ with each model's own output rounding", () => {
    expect(colord("#ff0000").toLab()).toEqual({ l: 54.29, a: 80.81, b: 69.89, alpha: 1 });
    expect(colord("#ff0000").toXyz()).toEqual({ x: 43.61, y: 22.25, z: 1.39, a: 1 });
  });

  it("parses LAB/LCH/CMYK objects and strings back into RGBA", () => {
    // L=50 on the neutral axis is the classic LAB boundary: not clamped, and
    // channels arrive as the unrounded floats below.
    const neutral = colord({ l: 50, a: 0, b: 0 });
    expect(neutral.toHex()).toBe("#777777");
    expect(colord("lch(50% 10 0)").toHex()).toBe("#887177");
    expect(colord("device-cmyk(0 100 100 0)").toHex()).toBe("#ff0000");
    expect(colord("#ff0000").toCmyk()).toEqual({ c: 0, m: 100, y: 100, k: 0, a: 1 });
  });

  it("mixes through LAB by default and through RGBA only when asked", () => {
    // The mix plugin reuses the core LAB math; the space argument selects the
    // interpolation domain, and the result re-enters via the RGBA parser.
    expect(colord("#ff0000").mix("#0000ff").toHex()).toBe("#c10088");
    expect(colord("#ff0000").mix("#0000ff", 0.5, "rgb").toHex()).toBe("#800080");
  });

  it("computes contrast from the rounded RGBA model", () => {
    expect(colord("#000000").contrast("#ffffff")).toBe(21);
    expect(colord("#ffffff").luminance()).toBe(1);
    expect(colord("#ff0000").delta("#ff0000")).toBe(0);
  });

  it("lets minify discover the names plugin at call time, regardless of load order", () => {
    // minifyPlugin was extended BEFORE namesPlugin; it never captures toName at
    // registration time, so the keyword is still available as a variant.
    expect(colord("red").minify({ name: true })).toBe("red");
    expect(colord("#ff0000").minify()).toBe("#f00");
  });
});

describe("Layer 3 - string formatting is a separate, rounding boundary", () => {
  it("omits alpha from rgb()/hsl() strings when the ROUNDED alpha is 1", () => {
    // The threshold sees the output-rounded alpha: 0.9996 serializes as opaque.
    // The same input keeps 0.9996 in the internal model and reports alpha() 1.
    const nearlyOpaque = colord("rgba(0, 0, 0, 0.9996)");
    expect(nearlyOpaque.rgba.a).toBe(0.9996);
    expect(nearlyOpaque.toRgbString()).toBe("rgb(0, 0, 0)");
    expect(nearlyOpaque.toHslString()).toBe("hsl(0, 0%, 0%)");
    expect(nearlyOpaque.toHex()).toBe("#000000");
    expect(nearlyOpaque.alpha()).toBe(1);

    expect(colord("rgba(0, 0, 0, 0.5)").toRgbString()).toBe("rgba(0, 0, 0, 0.5)");
  });

  it("rounds objects to the documented precision while the model stays exact", () => {
    const color = colord("rgba(0, 0, 0, 0.123456)");
    expect(color.toRgb()).toEqual({ r: 0, g: 0, b: 0, a: 0.123 });
    expect(color.toRgbString()).toBe("rgba(0, 0, 0, 0.123)");
    // hex goes through a byte instead: 0.123456 * 255 = 31.48 => 0x1f.
    expect(color.toHex()).toBe("#0000001f");
  });

  it("emits alpha in hex8 and keeps hwb/lch round-trips lossless after rounding", () => {
    expect(colord("hwb(0 0% 0%)").toHwbString()).toBe("hwb(0 0% 0%)");
    const lch = colord("lch(50% 10 0)");
    expect(lch.toLchString()).toBe("lch(50% 10 0)");
    expect(colord(lch.toLchString()).toLchString()).toBe("lch(50% 10 0)");
    expect(colord("#ff0000").toHwb()).toEqual({ h: 0, w: 0, b: 0, a: 1 });
  });

  it("formats transparent keyword as zeroed black with alpha 0", () => {
    const transparent = colord("transparent");
    expect(transparent.rgba).toEqual({ r: 0, g: 0, b: 0, a: 0 });
    expect(transparent.toRgbString()).toBe("rgba(0, 0, 0, 0)");
    expect(transparent.toHex()).toBe("#00000000");
    expect(transparent.toName()).toBe("transparent");
  });

  it("clamps out-of-range channels at hex serialization time as well", () => {
    // rgba is already clamped on input, but format() clamps again so the byte
    // table is never indexed out of bounds - asserted here via the public path.
    expect(colord({ r: 999, g: -999, b: 0 }).toHex()).toBe("#ff0000");
  });
});

describe("extend() - plugin load order and prototype method visibility", () => {
  it("installs methods on the shared prototype, visible even to earlier instances", () => {
    const beforeExtend = colord("#ff0000");
    expect(beforeExtend.toHwb()).toEqual({ h: 0, w: 0, b: 0, a: 1 });
    // And the methods live on the prototype, not as per-instance properties.
    expect(Object.prototype.hasOwnProperty.call(beforeExtend, "toHwb")).toBe(false);
    expect(typeof Colord.prototype.toLab).toBe("function");
    expect(typeof Colord.prototype.contrast).toBe("function");
  });

  it("is idempotent: re-extending a plugin neither duplicates parsers nor reorders them", () => {
    const objectOrder = parsers.object.map((parser) => parser[1]);
    const stringOrder = parsers.string.map((parser) => parser[1]);
    extend([lchPlugin, labPlugin, hwbPlugin, lchPlugin]);
    expect(parsers.object.map((parser) => parser[1])).toEqual(objectOrder);
    expect(parsers.string.map((parser) => parser[1])).toEqual(stringOrder);
  });

  it("keeps colord(Colord) an identity: plugins never reparse an instance", () => {
    // Manipulations return fresh instances through the parser, but wrapping an
    // existing one returns it unchanged - so rgba identity is observable.
    const instance = colord("rgba(0, 0, 0, 0.123456)");
    expect(colord(instance)).toBe(instance);
    expect(colord(instance).rgba.a).toBe(0.123456);
  });

  it("lets REGISTRATION POSITION decide priority: an unshifted parser beats built-in hex", () => {
    // Most plugins push(), so they can only catch inputs the built-ins reject.
    // A parser inserted at index 0 wins over every earlier registration, even
    // for "#fff". Placed last because it mutates the shared string registry.
    const sentinel: RgbaColor = { r: 9, g: 8, b: 7, a: 1 };
    const hijackPlugin: Plugin = (_ColordClass: typeof Colord, list: Parsers) => {
      list.string.unshift([
        (input: string) => (input === "trace-hijack-sentinel" ? sentinel : null),
        "hwb",
      ]);
    };
    extend([hijackPlugin]);
    expect(getFormat("trace-hijack-sentinel")).toBe("hwb");
    expect(colord("trace-hijack-sentinel").rgba).toEqual(sentinel);
    // Inputs the hijack does not claim keep flowing to the built-in parsers.
    expect(getFormat("#fff")).toBe("hex");
  });
});
