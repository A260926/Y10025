# ANALYSIS：colord 从输入格式选择到插件注册与颜色转换的调用链

本文追踪的基线（`colord` v2.10 当前源码）：

> colord 会按 parser 注册顺序识别 string/object 输入，把内部值归一为 RGBA，然后由 core 与 plugins 动态扩展 LAB/LCH/HWB/XYZ、对比度、混色和输出方法。

结论不是“读出来的”，而是由一组**能被多个 parser 候选同时接受的边界颜色**逐条反证：每个结论都对应 `tests/trace-pipeline.test.ts` / `tests/trace-plugin-order.test.ts` 里的一个可单独运行的 `it`，以及可单独运行的 `scripts/trace-pipeline.ts`。所有数值均为实际运行结果（Node + ts-jest，见文末复现方式），没有引用外网、随机睡眠或本机绝对路径。

---

## 1. 调用链总览

```
AnyColor (string | object | Colord)
  │
  ├─ colord(input) 对 Colord 实例直接返回自身（恒等，不重解析）     src/colord.ts
  │
  └─ new Colord(input)
       ├─ parse(input)                                            src/parse.ts
       │    ├─ string → input.trim() → 顺序遍历 parsers.string
       │    ├─ object(非 null) → 顺序遍历 parsers.object
       │    └─ 其他（number / null / undefined / array）→ [null, undefined]
       │
       │  每个 parser：要么返回 RgbaColor，要么返回 null；
       │  findValidColor 命中第一个非 null 即返回 [rgba, format]。
       │
       ├─ this.parsed = 命中的 RgbaColor | null                   src/colord.ts:24
       ├─ this.rgba   = this.parsed ?? {r:0,g:0,b:0,a:1}          src/colord.ts:25
       │     ↑ 未取整的 RGBA（唯一内部模型），失败恢复为不透明黑
       │
       └─ 输出/操作方法（core 在原型上，plugin 在 extend 时挂到同一原型）
            toHex/toRgb/toRgbString/toHsl/toHsv …（core）
            toHwb/toLab/toLch/toXyz/toCmyk/contrast/mix/delta …（plugin）
            每个输出方法在序列化前才 clamp / round。
```

三个要点贯穿全链：

1. **解析永不抛错**。失败只表现为 `parse()` 返回 `[null, undefined]`、`isValid() === false` 与内部回退黑色（`src/colord.ts:24-33`）。
2. **内部只有未取整 RGBA**。clamp 在进入模型时做一次，round 只在输出时做（`src/colord.ts:21-26` 的注释明示这是为转换精度刻意为之）。
3. **插件只做两件事**：往共享的 `parsers.string/object` 数组尾部 `push` 解析器，以及给 `Colord.prototype` 挂方法（`src/extend.ts`、各 `src/plugins/*.ts`）。

---

## 2. 三层契约：输入合法性 / 颜色空间映射 / 字符串格式化

这三层最容易被混为一谈，但在代码里是不同的函数、不同的失败方式和不同的取整时机。下表先给全局定位，随后逐层给出边界证据。

| 层 | 回答的问题 | 代码落点 | 失败信号 | 是否取整 |
|---|---|---|---|---|
| L1 输入合法性 | “这个输入**像不像**某个受支持的记号？” | 各 parser 的 regex / `isPresent` 必填通道检查；`src/parse.ts:24-47` | parser 返回 `null` → 全列表落空 | 否 |
| L2 颜色空间映射 | “记号合法，它对应**哪个** RGBA 值？” | `clampX` + `xToRgba`；`src/colorModels/*` | 映射本身不失败（NaN/越界被 clamp） | clamp，是；round，否 |
| L3 字符串格式化 | “内部 RGBA 如何**写回**字符串/对象？” | `rgbaToX`/`roundX`/`xString`；各 `toX()` | 不失败（输出端再 clamp 一次） | 是，各格式各自的精度 |

### 2.1 第一层：输入合法性是“接受 / null”的语法判定

- **string 与 object 走两张不同的有序表**：`parse()` 按 `typeof` 分发（`src/parse.ts:37-47`），字符串先集中 `trim()` 一次，再逐个调用 parser；object 不 trim，逐个检查必填通道。
- **parser 只回答“能不能读”，返回 `RgbaColor | null`**（类型见 `src/types.ts` 的 `ParseFunction`）。第一个返回非 null 的 parser 决定一切，后面的 parser 根本不会被调用（`findValidColor`，`src/parse.ts:24-34`）。
- **“正则通过”不等于“输入合法”**。`#fffff` 能通过 hex 的宽字符匹配 `^#([0-9a-f]{3,8})$`（`src/colorModels/hex.ts:5`），但长度分派只接受 3/4/6/8 位（`hex.ts:36,45`，并显式注释“matcher 也会放进 5、7 位”），于是返回 null，rgb/hsl 也都不认 → 整体失败。
- **语法细节也在这一层拒绝**：`rgb(1 2% 3)` 数字与百分比混用会在 regex 命中后被显式交叉检查拒绝（`src/colorModels/rgbString.ts` 的 `match[2] !== match[4] …`）；`rgba(0,0,0,abc)` 因为数字写法 `(?:\d*\.\d+|\d+)` 不匹配 `abc` 而整体不匹配。
- **object 的“必填通道缺失”会继续向下 fall through，而不是 clamp**。`isPresent` 区分“缺字段/空串”与“值为 0”（`src/helpers.ts:3-7`）：`{r:"",g:0,b:0}` 让 rgb parser 返回 null，于是 hsl 得到机会；一个 h/s/l 齐全的对象此时被 hsl 接管。
- **失败恢复是统一且静默的**：`null`/`undefined`/`number`/`array`/`""` 都不会抛错，`parse` 短路为 `[null, undefined]`，实例回退为不透明黑，`isValid()` 为 false。
- **`getFormat` 与 `colord(...).isValid()` 是同一次判定的两个投影**：`getFormat` 只是 `parse(input)[1]`（`src/parse.ts:54`），format 标签存在当且仅当解析成功。

> 证据：`tests/trace-pipeline.test.ts` 的 `Layer 1 — input validity` 整组（含 `it.each` 的五种失败输入、5 位 hex、混用百分比、必填通道 fall-through、trim 集中化）。

### 2.2 第二层：映射到**未取整** RGBA，clamp 在入口发生

- 每个 object parser 的形状一致：检查必填通道 → `Number(...)` → `clampX(...)` → `xToRgba(...)`（如 `src/colorModels/rgb.ts:19-28`、`hsl.ts:20-30`、`hwb.ts:44-54`）。
- **clamp 是 NaN 敏感的**：`clamp` 用三元链实现，NaN 落到下界（`src/helpers.ts:23-26`）。因此 `{r:300,g:-5,b:"x",a:2}` 被映射为 `{r:255,g:0,b:0,a:1}`——不是失败，是合法但被钳制。
- **内部值刻意不 round**：`rgb(50%,50%,50%)` 的内部模型是 `{r:127.5,…}`，只有 `toRgb()`/`toHex()` 等输出才得到 128 / `#808080`。这是全库“内部 RGBA 不取整”不变量的直接观测点。
- **色相边界统一在 `clampHue`/`roundHue`**：`NaN/Infinity → 0`、`360 → 0`、`-1 → 359`（`src/helpers.ts:38-52`）；CSS 的 `360deg` 合法且等于 0。
- **HWB 的 w+b≥100 是独立分支**：映射为灰 `w/(w+b)*255`（`src/colorModels/hwb.ts` 的 `hwbaToRgba`），`hwb(0 60% 60%)` → 内部 127.5 灰。
- **对称入口必须收敛到同一个未取整 RGBA**：红 `#f00` 的 11 种入口（逗号/空格语法、百分比、turn 角度、hex、rgb/hsl/hsv/hwb 两种载体）内部模型逐一相等——L1 的门再多，L2 只有一个 RGBA。

### 2.3 第三层：格式化是另一个（各自取整的）边界

- `roundRgba` 对通道 0 位小数、alpha 3 位（`ALPHA_PRECISION`）；LAB/LCH/XYZ/CMYK 各有 2 位规则（`roundLaba`/`roundLcha`/`roundXyza`/`roundCmyka`），hue 再经 `roundHue` 保证不输出 360。
- **alpha 是否写进字符串，看的是“取整后”的 alpha**：`rgba(0,0,0,0.9996)` 的内部 `.rgba.a` 仍是 `0.9996`，但 `toRgbString()`/`toHslString()`/`toHex()` 都按不透明输出（`rgb(0, 0, 0)`、`#000000`），`alpha()` 返回 `1`。
- **同一个 alpha 在不同输出格式里量化路径不同**：`0.123456` 在对象/函数串里是三位 `0.123`，在 hex 里走字节 `round(0.123456*255)=31` → `#0000001f`。
- **输出端会再 clamp 一次**：hex 的 `format()` 用 `clamp(byte,0,255)` 索引 256 项字节表（`src/colorModels/hex.ts:73-77`），不依赖输入一定已经在界内。
- 第三层可独立往返：`lch(50% 10 0)` 的 `toLchString()` 再解析后字符串不变；`hwb` 同理。

> 证据：`tests/trace-pipeline.test.ts` 的两个 `Layer 2` 组与 `Layer 3 — string formatting` 组；`scripts/trace-pipeline.ts` 的逐行表把“公开结果 vs 中间模型”并排列出（`rgba` 列即中间模型，`->` 后为格式化结果）。

---

## 3. 插件加载顺序何时影响 `getFormat`，何时影响 method 可见性

这是两条**互相独立**的机制，必须分开陈述：

### 3.1 对 `getFormat` 的影响：只取决于 parser 在数组里的位置

- 内建顺序（`src/parse.ts:11-21`）：string = `[hex, rgb, hsl]`，object = `[rgb, hsl, hsv]`。
- 每个插件在被 `extend` 时把自己的 parser `push` 到数组**尾部**（如 hwb：`src/plugins/hwb.ts:35-36`；names 只 push string：`src/plugins/names.ts:237`）。所以在规范加载顺序
  `extend([hwb, xyz, lab, lch, cmyk, names, a11y, mix, minify])` 下，注册表冻结为：
  - object：`rgb, hsl, hsv, hwb, xyz, lab, lch, cmyk`
  - string：`hex, rgb, hsl, hwb, lch, cmyk, name`
- **只有“能被多个 parser 同时接受”的输入才会被顺序影响**：
  - 纯字符串记号几乎不重叠（`hwb(…)` 不可能被 hex/rgb/hsl 接受），`name` 又排在最后，所以字符串在正常 `push` 下无歧义；
  - object 是“鸭子形状”，重叠很多：`{h,s,l,v}` 同时满足 hsl 与 hsv → hsl 胜；`{h,s,v,w,b}` → 内建 hsv 胜过后挂的 hwb；`{l,a,b,c,h}` → **lab 与 lch 谁先 `extend` 谁胜**。
- **同一个对象，换加载顺序得到不同颜色**（最强反例）：
  - `{l:50,c:10,h:0,a:1,b:0}` 在“lab 先于 lch”时归 lab（中性 L=50）→ `#797677`；
  - 在“lch 先于 lab”时归 lch（C=10,H=0）→ `#887177`。
  - 两份测试用 Jest 的模块隔离各占一个全新注册表，分别断言这两个结果（配对用例）。
- **位置优先于身份**：`push` 的 parser 只能捡内建 parser 不认的输入；而 `unshift` 到 `index 0` 的 parser 连 `#fff` 都能从 hex 手里抢走。`extend` 本身不强制只能 `push`——数组是共享可变状态，顺序就是合约。
- **重复 `extend` 幂等且“首次加载定序”**：`activePlugins` 按函数身份去重（`src/extend.ts:7-14`），第二次以相反顺序再加载既不会重复注册，也不会重排。

### 3.2 对 method 可见性的影响：只取决于插件是否被加载过

- 方法挂在**同一个** `Colord.prototype` 上（`ColordClass.prototype.toX = …`），因此：
  - **未加载即不存在**：全新模块作用域里 `colord('#f00').toHwb/​toLab/​contrast` 全是 `undefined`，`getFormat('white')` 也是 `undefined`；
  - **加载对“老实例”即时可见**：extend 之前构造的实例，在 extend 之后同样拿到 `toHwb()`——方法查找发生在调用时，与实例出生时间无关；
  - **方法可见性与 parser 胜负无关**：lch 先加载并不删除 `toLab()`，两个转换方法始终都在。
- 跨插件协作靠**调用时特性检测**而非加载顺序：minify 只有在运行到 `typeof this.toName === "function"` 时才使用命名色（`src/plugins/minify.ts:110-114`），所以 minify 先于 names 加载，`colord("red").minify({name:true})` 仍能得到 `"red"`。
- **混色不依赖 lab 插件**：`mix()` 默认在 LAB 空间插值，但用的是 `src/manipulate/mix.ts` 直接导入的 `rgbaToLaba/labaToRgba`（核心颜色模型），不需要调用方 extend lab 插件；反过来 lab 插件也不提供 `mix`。

> 证据：`tests/trace-plugin-order.test.ts` 全部 8 个 `it`（全新注册表下的不可见、顺序反转、去重不重排、push vs unshift、方法不受胜负影响），以及 `tests/trace-pipeline.test.ts` 的 `extend() — plugin load order and prototype method visibility` 组（冻结数组、老实例可见、幂等、`colord(instance) === instance`、unshift 抢占 hex）。

---

## 4. 边界颜色追踪表（公开结果 ⇄ 中间模型）

| # | 边界输入 | 层/分支 | 命中 format | 内部 `rgba`（未取整） | 公开结果 |
|---|---|---|---|---|---|
| 1 | `#fffff` | L1 regex 过、长度分派拒 | `undefined`（无效） | `{0,0,0,1}` 回退 | `#000000`, `isValid()=false` |
| 2 | `rgb(1 2% 3)` / `rgb(1, 2%, 3)` | L1 数字/百分比混用 | `undefined` | `{0,0,0,1}` | 无效 |
| 3 | `rgba(0,0,0,abc)` | L1 alpha 记号不匹配 | `undefined` | `{0,0,0,1}` | 无效 |
| 4 | `  #fff  ` | L1 集中 trim | `hex` | `{255,255,255,1}` | `#ffffff` |
| 5 | `null`/`undefined`/`42`/`[255,0,0]`/`""` | L1 非 string/object | `undefined` | `{0,0,0,1}` | 无效黑 |
| 6 | `{r:"",g:0,b:0}` | L1 必填通道缺失→fall through | `undefined` | `{0,0,0,1}` | 无效 |
| 7 | `{r:undefined,h:120,s:50,l:50}` | L1 rgb 拒、hsl 接 | `hsl` | `{63.75,191.25,63.75,1}` | 有效（hsl(120 50% 50%)） |
| 8 | `rgb(50%,50%,50%)` | L2 百分比通道 | `rgb` | `{127.5,127.5,127.5,1}` | `#808080` / `rgb(128,…)` |
| 9 | `{r:300,g:-5,b:"x",a:2}` | L2 NaN 敏感 clamp | `rgb` | `{255,0,0,1}` | `#ff0000` |
| 10 | `{h:NaN,s:200,l:-10}` | L2 `clampHue`/百分比 clamp | `hsl` | `{0,0,0,1}` | `h:0,s:0,l:0` |
| 11 | `{h:360,s:100,l:50}` | L2 hue 上界开区间 | `hsl` | `{255,0,0,1}` | `#ff0000` |
| 12 | `{h:0,w:60,b:60}` / `hwb(0 60% 60%)` | L2 HWB 灰分支 | `hwb` | `{127.5,127.5,127.5,1}` | `#808080` |
| 13 | 红的 11 种对称入口 | L1 多门→L2 收敛 | 各异 | 全部 `{255,0,0,1}` | `#ff0000` |
| 14 | `rgba(0,0,0,.5)` / `…50%` | L2 alpha 原样 | `rgb` | `a:0.5` | `rgba(0, 0, 0, 0.5)` |
| 15 | `#fff4` | **hex 在解析期量化 alpha** | `hex` | `a:0.27` | `#ffffff45`（字节变成 0x45） |
| 16 | `#ffffff80` | 同上（恰好可往返） | `hex` | `a:0.5` | `#ffffff80` |
| 17 | `rgba(0,0,0,0.9996)` | L3 看取整后 alpha | `rgb` | `a:0.9996` 保留 | `rgb(0,0,0)` / `#000000` / `alpha()=1` |
| 18 | `rgba(0,0,0,0.123456)` | L3 三种量化路径 | `rgb` | `a:0.123456` 保留 | obj `0.123`，hex `#0000001f` |
| 19 | `{l:50,a:0,b:0,c:10,h:0}` | 顺序：lab 先则 lab 胜 | `lab` | `{118.91328297259392,118.91328977596915,118.91328663722719,1}` | `#797677` |
| 20 | 同数字，lch 先 extend | 顺序反转：lch 胜 | `lch` | `{135.69,113.02,119.33,1}` | `#887177` |
| 21 | `lch(50% 10 0)` | 字符串无歧义走 lch | `lch` | 同上 | `lch(50% 10 0)` 可往返 |
| 22 | `white` / `transparent` | 插件 parser（names） | `name` | 白 / `{0,0,0,0}` | `#ffffff` / `#00000000` |
| 23 | `#f00.mix(#00f)` vs `…,"rgb"` | 插件复用核心模型 | — | LAB 插值 `#c10088`；RGB 插值 `#800080` |
| 24 | `#000.contrast(#fff)` | a11y 用取整 RGBA | — | `21`；`#fff.luminance()=1` |

---

## 5. 最容易猜错的结论及其反证（逐条可单独运行）

| 容易猜错的说法 | 实际行为 | 反证入口（可单独跑） |
|---|---|---|
| “解析时就会把 RGB 通道 round 成整数。” | 内部模型保留 `127.5`，round 仅发生在输出。 | `-t "keeps percentage-rgb fractions unrounded"`；追踪脚本第 3 行 |
| “hex alpha 和别的 parser 一样保留原值。” | hex alpha 在**解析期**先量化为字节再 round 到 2 位（`#fff4`→0.27，回写变 `#ffffff45`）。 | `-t "rounds hex alpha DURING parsing"` |
| “alpha 0.9996 会输出 `rgba(…,0.9996)`。” | 字符串看取整后的 alpha，按不透明输出；但 `.rgba.a` 仍是 0.9996。 | `-t "omits alpha from rgb.* strings when the ROUNDED alpha is 1"`；脚本第 6 行 |
| “`#fffff` 不是合法 hex 字符，正则就拒了。” | 正则先接受 5 个十六进制字符，是长度分派拒的。 | `-t "5-digit hex passes the broad character matcher"` |
| “加载顺序只影响方法有没有，不影响解析结果。” | 同一 `{l,c,h,a,b}` 对象在 lab/lch 顺序互换时解析成**不同颜色**。 | `trace-plugin-order.test.ts -t "lch was loaded first"` 与主文件 `-t "lab was extended first"` 配对 |
| “插件 push 的解析器可以覆盖内建格式。” | push 只能捡漏；只有 unshift 到队首才能抢 `#fff`。 | `-t "unshifted parser shadows even the built-in hex"` / `"never shadows an earlier hex match"` |
| “再 extend 一次可以调整优先级。” | 按函数身份去重，首次加载定序，之后不可重排。 | `-t "does not reorder when the same plugins are re-extended in reverse"` |
| “老实例拿不到后加载插件的方法。” | 方法在共享原型上，extend 对旧实例即时生效。 | `-t "visible even to earlier instances"` |
| “mix 插件依赖 lab 插件先加载。” | mix 直接导入 `manipulate/mix.ts` 的 LAB 数学，独立工作。 | `trace-plugin-order.test.ts -t "self-contained"`（只加载 mix，toLab 仍不存在） |
| “`{r:""}` 会被 Number('') 成 0 当黑色。” | `isPresent` 让 rgb parser 返回 null；若无其他候选则整体无效。 | `-t "falls THROUGH the list instead of clamping"` |
| “minify 必须先加载 names 才能输出关键字。” | 运行时 `typeof this.toName === "function"` 特性检测，顺序无关。 | `-t "lets minify discover the names plugin at call time"` |

### 5.1 “用例 → 分支/不变量”落点映射（审查路径）

- 解析优先级的唯一决策点：`findValidColor` 首个非 null 即返回 —— `src/parse.ts:24` ↔ 主文件 `Layer 2 - parser registration order` 全表 + 冻结数组用例 + 第二份文件的位置用例。
- 未取整模型不变量：`this.rgba = this.parsed || …`，无 round —— `src/colord.ts:24-25` ↔ “keeps percentage-rgb fractions unrounded”“internal alpha is carried verbatim”。
- NaN→下界的 clamp 语义：`src/helpers.ts:23-26` ↔ “coerces NaN to the lower bound”“maps non-finite hues to 0”。
- HWB 灰分支：`src/colorModels/hwb.ts` `hwbaToRgba` ↔ “w+b over 100% to the achromatic gray”。
- hex 解析期 alpha 量化：`src/colorModels/hex.ts:36-50` ↔ “rounds hex alpha DURING parsing”。
- 输出端阈值看取整值：`rgbaToRgbaString`/`rgbaToHslaString` 的 `a < 1` ↔ “ROUNDED alpha is 1”用例。
- 插件注册/去重：`src/extend.ts:7-14` ↔ “idempotent”“re-extended in reverse”“freezes the exact registry order”。
- 原型可见性：各 `prototype.toX = …`（如 `src/plugins/hwb.ts:27-33`）↔ “visible even to earlier instances”“before extend()”组。
- 失败恢复黑盒：`src/colord.ts:24-33` ↔ `it.each` 五种非输入 + “5-digit hex”。

---

## 6. 复现方式

```sh
# 环境（仓库根目录，Node 18+；本机实测 Node 25 + npm ci 通过）
npm ci

# 1) 先跑新增的定向追踪用例（两个文件可独立运行，也可按 -t 跑单个结论）
npx jest tests/trace-pipeline.test.ts tests/trace-plugin-order.test.ts --runInBand
npx jest tests/trace-plugin-order.test.ts -t "lch was loaded first"

# 2) 可执行的人工追踪：打印边界表，并在文档结论被破坏时以 exit 1 失败
npx ts-node --compiler-options '{"module":"commonjs"}' scripts/trace-pipeline.ts

# 3) 全套（要求命令）
npm test -- --runInBand
```

## 7. 刻意保持、未改动的公开行为

- 未改动 `src/` 任何源码：解析顺序、clamp/round 数值、错误恢复（静默黑）、字符串序列化格式全部保持原样；追踪全部通过公开 API（含只读的 `color.rgba` 与导出的 `parsers`）完成。
- 未弱化或删除既有断言；新增测试与既有 102 个用例并存，无快照。
- 新增插件 parser 的探针使用一次性哨兵输入（`trace:…`），放在文件末尾或隔离模块里，不影响其他用例；测试不依赖网络、随机数、睡眠或任何 fixture 名称特判。

