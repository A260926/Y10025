/**
 * Companion of trace-pipeline.test.ts. Every test here runs inside
 * `jest.isolateModules`, so each one gets a FRESH src module graph: the shared
 * parser arrays contain only plugins extended inside that scope, and the
 * Colord prototype is untouched by other tests. This isolates the two claims
 * the main file cannot re-demonstrate after its own extend():
 *
 *   1. plugin formats and prototype methods are invisible until extend().
 *   2. for an input two plugin parsers accept, the winner is purely positional.
 */
import { Plugin } from "../src/extend";
import { Colord } from "../src/colord";
import { Format, Input, Parsers, RgbaColor } from "../src/types";

interface IsolatedScope {
  colord: (input: Input | Colord) => Colord;
  extend: (plugins: Plugin[]) => void;
  getFormat: (input: Input) => Format | undefined;
  parsers: Parsers;
}

const isolated = (plugins: unknown[]): IsolatedScope => {
  let scope = {} as IsolatedScope;
  jest.isolateModules(() => {
    const { colord, extend } = require("../src/");
    const { getFormat, parsers } = require("../src/parse");
    extend(plugins);
    scope = { colord, extend, getFormat, parsers };
  });
  return scope;
};

describe("before extend(): core only", () => {
  it("knows nothing of plugin formats", () => {
    const { getFormat } = isolated([]);
    expect(getFormat("white")).toBeUndefined();
    expect(getFormat("hwb(0 0% 0%)")).toBeUndefined();
    expect(getFormat("lch(50% 10 0)")).toBeUndefined();
    expect(getFormat({ h: 0, w: 0, b: 0 })).toBeUndefined();
  });

  it("has no plugin methods even on a constructed instance", () => {
    const { colord } = isolated([]);
    const instance = colord("#ff0000");
    expect(instance.isValid()).toBe(true);
    expect(typeof instance.toHwb).toBe("undefined");
    expect(typeof instance.toLab).toBe("undefined");
    expect(typeof instance.contrast).toBe("undefined");
  });
});

describe("load order decides getFormat for multi-parser objects", () => {
  // lch is extended BEFORE lab - the inverse of the canonical list in
  // trace-pipeline.test.ts, where the same object resolves to "lab".
  const lchFirst = (): IsolatedScope =>
    isolated([
      require("../src/plugins/lch").default,
      require("../src/plugins/lab").default,
      require("../src/plugins/hwb").default,
    ]);

  it("resolves the ambiguous object to lch when lch was loaded first", () => {
    const { colord, getFormat } = lchFirst();
    const ambiguous = { l: 50, c: 10, h: 0, a: 1, b: 0 };
    expect(getFormat(ambiguous)).toBe("lch");
    expect(colord(ambiguous).toHex()).toBe("#887177");
  });

  it("records that positional order in the object parser tail", () => {
    const { parsers } = lchFirst();
    expect(parsers.object.map((parser) => parser[1])).toEqual([
      "rgb",
      "hsl",
      "hsv",
      "lch",
      "lab",
      "hwb",
    ]);
  });

  it("does not reorder when the same plugins are re-extended in reverse", () => {
    // activePlugins dedupes by identity: ordering is first-extension-wins.
    const { extend, parsers } = lchFirst();
    extend([
      require("../src/plugins/hwb").default,
      require("../src/plugins/lab").default,
      require("../src/plugins/lch").default,
    ]);
    const names = parsers.object.map((parser) => parser[1]);
    expect(names.indexOf("lch")).toBeLessThan(names.indexOf("lab"));
  });

  it("exposes both methods no matter which parser won", () => {
    // Parser ordering and prototype methods are independent mechanisms: loading
    // lch first never removes toLab(), and vice versa.
    const { colord } = lchFirst();
    const color = colord("#ffffff");
    expect(typeof color.toLch).toBe("function");
    expect(typeof color.toLab).toBe("function");
  });
});

describe("a pushed parser can only catch what built-ins reject", () => {
  it("wins for its own sentinel but never shadows an earlier hex match", () => {
    const trailing: Plugin = (_ColordClass, list: Parsers) => {
      list.string.push([
        (input: string): RgbaColor | null =>
          input === "trace:trailing" ? { r: 1, g: 2, b: 3, a: 1 } : null,
        "rgb",
      ]);
    };
    const { colord, getFormat, parsers } = isolated([trailing]);

    expect(parsers.string[parsers.string.length - 1][1]).toBe("rgb");
    expect(colord("trace:trailing").toRgb()).toEqual({ r: 1, g: 2, b: 3, a: 1 });
    // "#fff" is consumed at index 0; the trailing parser is never consulted.
    expect(getFormat("#fff")).toBe("hex");
  });

  it("an unshifted parser shadows even the built-in hex parser", () => {
    const sentinel: RgbaColor = { r: 9, g: 8, b: 7, a: 1 };
    const hijack: Plugin = (_ColordClass, list: Parsers) => {
      list.string.unshift([
        (input: string): RgbaColor | null => (input === "#fff" ? sentinel : null),
        "hwb",
      ]);
    };
    const { colord, getFormat } = isolated([hijack]);
    expect(getFormat("#fff")).toBe("hwb");
    expect(colord("#fff").rgba).toEqual(sentinel);
    // Inputs the hijack does not claim keep flowing to the built-in parsers.
    expect(getFormat("#000")).toBe("hex");
  });
});

describe("mix plugin is self-contained: no lab plugin required", () => {
  // mix() imports rgbaToLaba/labaToRgba from the core color model directly
  // (src/manipulate/mix.ts); extending the mix plugin alone must be enough.
  it("mixes through LAB with only the mix plugin loaded", () => {
    jest.isolateModules(() => {
      const { colord, extend } = require("../src/");
      expect(typeof colord("#fff").toLab).toBe("undefined");
      extend([require("../src/plugins/mix").default]);
      expect(typeof colord("#fff").toLab).toBe("undefined");
      expect(colord("#ff0000").mix("#0000ff").toHex()).toBe("#c10088");
      expect(colord("#ff0000").mix("#0000ff", 0.5, "rgb").toHex()).toBe("#800080");
    });
  });
});
