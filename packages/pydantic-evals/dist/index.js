var qt = Object.defineProperty;
var Ae = (n, t, e) => t in n ? qt(n, t, { enumerable: !0, configurable: !0, writable: !0, value: e }) : n[t] = e;
var u = (n, t) => qt(n, "name", { value: t, configurable: !0 });
var l = (n, t, e) => Ae(n, typeof t != "symbol" ? t + "" : t, e);
import { AsyncLocalStorage as Ee } from "node:async_hooks";
import { parse as $e, stringify as Te } from "yaml";
function O(n, t) {
  return { reason: t ?? null, value: n };
}
u(O, "evaluationReason");
function he(n) {
  return n !== null && typeof n == "object" && "value" in n && (typeof n.value == "boolean" || typeof n.value == "number" || typeof n.value == "string");
}
u(he, "isEvaluationReason");
function gn(n, ...t) {
  for (const e of t)
    if (e === "boolean" && typeof n.value == "boolean" || e === "number" && typeof n.value == "number" && typeof n.value != "boolean" || e === "string" && typeof n.value == "string")
      return n;
  return null;
}
u(gn, "downcastEvaluationResult");
const $t = class $t {
  constructor() {
    l(this, "evaluationName");
  }
  asSpec() {
    const t = this.buildSerializationArguments(), e = Object.keys(t);
    let s;
    return e.length === 0 ? s = null : (e.length, s = t), { arguments: s, name: this.getSerializationName() };
  }
  buildSerializationArguments() {
    const t = {}, e = this;
    for (const [s, r] of Object.entries(e))
      r !== void 0 && (t[s] = r);
    return t;
  }
  async evaluateAsync(t) {
    return await Promise.resolve(this.evaluate(t));
  }
  getDefaultEvaluationName() {
    return typeof this.evaluationName == "string" ? this.evaluationName : this.getSerializationName();
  }
  getSerializationName() {
    return this.constructor.name;
  }
};
u($t, "Evaluator");
let T = $t;
function E(n, t = 100) {
  let e;
  try {
    e = JSON.stringify(n);
  } catch {
    e = String(n);
  }
  return e.length > t ? e.slice(0, Math.floor(t / 2)) + "..." + e.slice(-Math.floor(t / 2)) : e;
}
u(E, "truncatedRepr");
function C(n, t) {
  if (n === t) return !0;
  if (n === null || t === null || typeof n != typeof t || typeof n != "object") return !1;
  if (Array.isArray(n)) {
    if (!Array.isArray(t) || n.length !== t.length) return !1;
    for (let i = 0; i < n.length; i++)
      if (!C(n[i], t[i])) return !1;
    return !0;
  }
  const e = n, s = t, r = Object.keys(e), a = Object.keys(s);
  if (r.length !== a.length) return !1;
  for (const i of r)
    if (!C(e[i], s[i])) return !1;
  return !0;
}
u(C, "deepEqual");
const Tt = class Tt extends T {
  constructor(e) {
    super();
    l(this, "value");
    this.value = e.value, this.evaluationName = e.evaluationName;
  }
  evaluate(e) {
    return C(e.output, this.value);
  }
};
u(Tt, "Equals");
let it = Tt;
const Ot = class Ot extends T {
  constructor(t = {}) {
    super(), this.evaluationName = t.evaluationName;
  }
  evaluate(t) {
    return t.expectedOutput === null || t.expectedOutput === void 0 ? {} : C(t.output, t.expectedOutput);
  }
};
u(Ot, "EqualsExpected");
let ot = Ot;
const Dt = class Dt extends T {
  constructor(e) {
    super();
    l(this, "asStrings");
    l(this, "caseSensitive");
    l(this, "value");
    this.value = e.value, this.caseSensitive = e.caseSensitive ?? !0, this.asStrings = e.asStrings ?? !1, this.evaluationName = e.evaluationName;
  }
  evaluate(e) {
    let s = null;
    const r = e.output;
    if (this.asStrings || typeof this.value == "string" && typeof r == "string") {
      let i = String(r), o = String(this.value);
      return this.caseSensitive || (i = i.toLowerCase(), o = o.toLowerCase()), i.includes(o) || (s = `Output string ${E(i)} does not contain expected string ${E(o)}`), O(s === null, s);
    }
    try {
      if (Array.isArray(r))
        r.some((i) => C(i, this.value)) || (s = `Output ${E(r, 200)} does not contain provided value`);
      else if (r !== null && typeof r == "object") {
        const i = r;
        if (this.value !== null && typeof this.value == "object" && !Array.isArray(this.value)) {
          const o = this.value;
          for (const d of Object.keys(o))
            if (d in i) {
              if (!C(i[d], o[d])) {
                s = `Output has different value for key ${E(d, 30)}: ${E(i[d])} != ${E(o[d])}`;
                break;
              }
            } else {
              s = `Output does not contain expected key ${E(d, 30)}`;
              break;
            }
        } else
          (typeof this.value != "string" || !(this.value in i)) && (s = `Output ${E(i, 200)} does not contain provided value as a key`);
      } else
        s = `Output ${E(r, 200)} does not contain provided value`;
    } catch (i) {
      s = `Containment check failed: ${String(i)}`;
    }
    return O(s === null, s);
  }
};
u(Dt, "Contains");
let ut = Dt;
const kt = class kt extends T {
  constructor(e) {
    super();
    l(this, "typeName");
    this.typeName = e.typeName, this.evaluationName = e.evaluationName;
  }
  evaluate(e) {
    const s = e.output;
    if (s == null)
      return O(!1, `output is of type ${s === null ? "null" : "undefined"}`);
    const r = s.constructor, a = (r == null ? void 0 : r.name) ?? typeof s;
    return a === this.typeName || typeof s === this.typeName.toLowerCase() ? O(!0) : O(!1, `output is of type ${a}`);
  }
};
u(kt, "IsInstance");
let lt = kt;
const Mt = class Mt extends T {
  constructor(e) {
    super();
    l(this, "seconds");
    this.seconds = e.seconds;
  }
  evaluate(e) {
    return e.duration <= this.seconds;
  }
};
u(Mt, "MaxDuration");
let ct = Mt, _t = null;
function vn(n) {
  _t = n;
}
u(vn, "setDefaultJudgeFn");
function yn() {
  return _t;
}
u(yn, "getDefaultJudgeFn");
const Nt = class Nt extends T {
  constructor(e) {
    super();
    l(this, "assertion");
    l(this, "includeExpectedOutput");
    l(this, "includeInput");
    l(this, "judge");
    l(this, "rubric");
    l(this, "score");
    this.rubric = e.rubric, this.judge = e.judge, this.includeInput = e.includeInput ?? !1, this.includeExpectedOutput = e.includeExpectedOutput ?? !1, this.score = e.score ?? !1, this.assertion = e.assertion ?? { includeReason: !0 }, this.evaluationName = e.evaluationName;
  }
  async evaluate(e) {
    const s = this.judge ?? _t;
    if (s == null)
      throw new Error("LLMJudge: no `judge` function provided and no default judge set. Call setDefaultJudgeFn() or pass `judge`.");
    const r = await s({
      expectedOutput: this.includeExpectedOutput ? e.expectedOutput : void 0,
      inputs: this.includeInput ? e.inputs : void 0,
      output: e.output,
      rubric: this.rubric
    }), a = {}, i = this.score !== !1 && this.assertion !== !1, o = this.getDefaultEvaluationName();
    if (this.score !== !1) {
      const d = i ? `${o}_score` : o;
      this.applyOutput(a, r.score, r.reason, this.score, d);
    }
    if (this.assertion !== !1) {
      const d = i ? `${o}_pass` : o;
      this.applyOutput(a, r.pass_, r.reason, this.assertion, d);
    }
    return a;
  }
  applyOutput(e, s, r, a, i) {
    const o = a.evaluationName ?? i;
    a.includeReason && r !== null ? e[o] = O(s, r) : e[o] = s;
  }
};
u(Nt, "LLMJudge");
let ft = Nt;
const It = class It extends T {
  constructor(e) {
    super();
    l(this, "query");
    this.query = e.query, this.evaluationName = e.evaluationName;
  }
  evaluate(e) {
    return e.spanTree.any(this.query);
  }
};
u(It, "HasMatchingSpan");
let dt = It;
const Oe = [it, ot, ut, lt, ct, ft, dt], Ft = class Ft extends Error {
  constructor(t) {
    super(t), this.name = "SpanTreeRecordingError";
  }
};
u(Ft, "SpanTreeRecordingError");
let D = Ft;
const Pt = class Pt {
  constructor(t) {
    l(this, "attributes");
    l(this, "duration");
    l(this, "expectedOutput");
    l(this, "inputs");
    l(this, "metadata");
    l(this, "metrics");
    l(this, "name");
    l(this, "output");
    l(this, "_spanTree");
    this.name = t.name, this.inputs = t.inputs, this.metadata = t.metadata, this.expectedOutput = t.expectedOutput, this.output = t.output, this.duration = t.duration, this._spanTree = t.spanTree, this.attributes = t.attributes, this.metrics = t.metrics;
  }
  get spanTree() {
    if (this._spanTree instanceof D)
      throw this._spanTree;
    return this._spanTree;
  }
};
u(Pt, "EvaluatorContext");
let Q = Pt;
const Ct = class Ct {
  asSpec() {
    const t = this.buildSerializationArguments();
    return { arguments: Object.keys(t).length === 0 ? null : t, name: this.getSerializationName() };
  }
  buildSerializationArguments() {
    const t = this, e = {};
    for (const [s, r] of Object.entries(t))
      r !== void 0 && (e[s] = r);
    return e;
  }
  async evaluateAsync(t) {
    return await Promise.resolve(this.evaluate(t));
  }
  getSerializationName() {
    return this.constructor.name;
  }
};
u(Ct, "ReportEvaluator");
let R = Ct;
function De(n, t, e) {
  if (e === "scores") {
    const r = n.scores[t];
    return r !== void 0 ? Number(r.value) : null;
  }
  const s = n.metrics[t];
  return s !== void 0 ? Number(s) : null;
}
u(De, "getScore");
function ke(n, t, e) {
  if (t === "expected_output")
    return n.expectedOutput === null || n.expectedOutput === void 0 ? null : !!n.expectedOutput;
  if (t === "assertions") {
    if (e === null) throw new Error("'positiveKey' is required when positiveFrom='assertions'");
    const s = n.assertions[e];
    return s !== void 0 ? s.value : null;
  }
  if (t === "labels") {
    if (e === null) throw new Error("'positiveKey' is required when positiveFrom='labels'");
    const s = n.labels[e];
    return s !== void 0 ? !!s.value : null;
  }
  return null;
}
u(ke, "getPositive");
function xt(n, t, e, s, r) {
  const a = [];
  for (const i of n) {
    const o = De(i, t, e), d = ke(i, s, r);
    o === null || d === null || a.push([o, d]);
  }
  return a;
}
u(xt, "extractScoredCases");
function W(n, t) {
  return n.length <= t || t <= 1 ? n : Array.from(new Set(Array.from({ length: t }, (s, r) => Math.floor(r * (n.length - 1) / (t - 1))))).sort(
    (s, r) => s - r
  ).map((s) => n[s]);
}
u(W, "downsample");
function pe(n) {
  let t = 0;
  for (let e = 1; e < n.length; e++) {
    const [s, r] = n[e - 1], [a, i] = n[e];
    t += Math.abs(a - s) * ((r + i) / 2);
  }
  return t;
}
u(pe, "trapezoidalAUC");
function te(n, t) {
  let e = 0, s = n.length;
  for (; e < s; ) {
    const r = e + s >>> 1;
    n[r] <= t ? e = r + 1 : s = r;
  }
  return e;
}
u(te, "bisectRight");
const Rt = class Rt extends R {
  constructor(e = {}) {
    super();
    l(this, "expectedFrom");
    l(this, "expectedKey");
    l(this, "predictedFrom");
    l(this, "predictedKey");
    l(this, "title");
    this.predictedFrom = e.predictedFrom ?? "output", this.predictedKey = e.predictedKey ?? null, this.expectedFrom = e.expectedFrom ?? "expected_output", this.expectedKey = e.expectedKey ?? null, this.title = e.title ?? "Confusion Matrix";
  }
  evaluate(e) {
    const s = [], r = [];
    for (const d of e.report.cases) {
      const h = this.extract(d, this.predictedFrom, this.predictedKey), c = this.extract(d, this.expectedFrom, this.expectedKey);
      h === null || c === null || (s.push(h), r.push(c));
    }
    const a = Array.from(/* @__PURE__ */ new Set([...r, ...s])).sort(), i = new Map(a.map((d, h) => [d, h])), o = a.map(() => new Array(a.length).fill(0));
    for (let d = 0; d < s.length; d++) {
      const h = i.get(r[d]), c = i.get(s[d]);
      o[h][c] += 1;
    }
    return { classLabels: a, matrix: o, title: this.title, type: "confusion_matrix" };
  }
  extract(e, s, r) {
    if (s === "expected_output") return e.expectedOutput === null || e.expectedOutput === void 0 ? null : String(e.expectedOutput);
    if (s === "output") return e.output === null || e.output === void 0 ? null : String(e.output);
    if (s === "metadata") {
      if (r !== null) {
        if (e.metadata !== null && typeof e.metadata == "object") {
          const a = e.metadata[r];
          return a == null ? null : String(a);
        }
        return null;
      }
      return e.metadata === null || e.metadata === void 0 ? null : String(e.metadata);
    }
    if (s === "labels") {
      if (r === null) throw new Error("'key' is required when from='labels'");
      const a = e.labels[r];
      return a !== void 0 ? a.value : null;
    }
    return null;
  }
};
u(Rt, "ConfusionMatrixEvaluator");
let ht = Rt;
const jt = class jt extends R {
  constructor(e) {
    super();
    l(this, "nThresholds");
    l(this, "positiveFrom");
    l(this, "positiveKey");
    l(this, "scoreFrom");
    l(this, "scoreKey");
    l(this, "title");
    this.scoreKey = e.scoreKey, this.positiveFrom = e.positiveFrom, this.positiveKey = e.positiveKey ?? null, this.scoreFrom = e.scoreFrom ?? "scores", this.title = e.title ?? "Precision-Recall Curve", this.nThresholds = e.nThresholds ?? 100;
  }
  evaluate(e) {
    const s = xt(e.report.cases, this.scoreKey, this.scoreFrom, this.positiveFrom, this.positiveKey);
    if (s.length === 0)
      return [
        { curves: [], title: this.title, type: "precision_recall" },
        { title: `${this.title} AUC`, type: "scalar", value: Number.NaN }
      ];
    const r = s.filter(([, v]) => v).length, a = Array.from(new Set(s.map(([v]) => v))).sort((v, f) => f - v), o = [{ precision: 1, recall: 0, threshold: a[0] }];
    for (const v of a) {
      const f = s.filter(([A, x]) => A >= v && x).length, p = s.filter(([A, x]) => A >= v && !x).length, y = r - f, _ = f + p > 0 ? f / (f + p) : 1, S = y + f > 0 ? f / (y + f) : 0;
      o.push({ precision: _, recall: S, threshold: v });
    }
    const d = o.map((v) => [v.recall, v.precision]), h = pe(d), c = o.length <= this.nThresholds || this.nThresholds <= 1 ? o : W(o, this.nThresholds);
    return [
      { curves: [{ auc: h, name: e.name, points: c }], title: this.title, type: "precision_recall" },
      { title: `${this.title} AUC`, type: "scalar", value: h }
    ];
  }
};
u(jt, "PrecisionRecallEvaluator");
let pt = jt;
const Kt = class Kt extends R {
  constructor(e) {
    super();
    l(this, "nThresholds");
    l(this, "positiveFrom");
    l(this, "positiveKey");
    l(this, "scoreFrom");
    l(this, "scoreKey");
    l(this, "title");
    this.scoreKey = e.scoreKey, this.positiveFrom = e.positiveFrom, this.positiveKey = e.positiveKey ?? null, this.scoreFrom = e.scoreFrom ?? "scores", this.title = e.title ?? "ROC Curve", this.nThresholds = e.nThresholds ?? 100;
  }
  evaluate(e) {
    const s = [
      {
        curves: [],
        title: this.title,
        type: "line_plot",
        x_label: "False Positive Rate",
        x_range: [0, 1],
        y_label: "True Positive Rate",
        y_range: [0, 1]
      },
      { title: `${this.title} AUC`, type: "scalar", value: Number.NaN }
    ], r = xt(e.report.cases, this.scoreKey, this.scoreFrom, this.positiveFrom, this.positiveKey);
    if (r.length === 0) return s;
    const a = r.filter(([, f]) => f).length, i = r.length - a;
    if (a === 0 || i === 0) return s;
    const o = Array.from(new Set(r.map(([f]) => f))).sort((f, p) => p - f), d = [[0, 0]];
    for (const f of o) {
      const p = r.filter(([_, S]) => _ >= f && S).length, y = r.filter(([_, S]) => _ >= f && !S).length;
      d.push([y / i, p / a]);
    }
    d.sort((f, p) => f[0] - p[0] || f[1] - p[1]);
    const h = pe(d), c = W(d, this.nThresholds);
    return [
      {
        curves: [{
          name: `${e.name} (AUC: ${h.toFixed(3)})`,
          points: c.map(([f, p]) => ({ x: f, y: p }))
        }, {
          name: "Random",
          points: [
            { x: 0, y: 0 },
            { x: 1, y: 1 }
          ],
          style: "dashed"
        }],
        title: this.title,
        type: "line_plot",
        x_label: "False Positive Rate",
        x_range: [0, 1],
        y_label: "True Positive Rate",
        y_range: [0, 1]
      },
      { title: `${this.title} AUC`, type: "scalar", value: h }
    ];
  }
};
u(Kt, "ROCAUCEvaluator");
let mt = Kt;
const Lt = class Lt extends R {
  constructor(e) {
    super();
    l(this, "nThresholds");
    l(this, "positiveFrom");
    l(this, "positiveKey");
    l(this, "scoreFrom");
    l(this, "scoreKey");
    l(this, "title");
    this.scoreKey = e.scoreKey, this.positiveFrom = e.positiveFrom, this.positiveKey = e.positiveKey ?? null, this.scoreFrom = e.scoreFrom ?? "scores", this.title = e.title ?? "KS Plot", this.nThresholds = e.nThresholds ?? 100;
  }
  evaluate(e) {
    const s = [
      { curves: [], title: this.title, type: "line_plot", x_label: "Score", y_label: "Cumulative Probability", y_range: [0, 1] },
      { title: "KS Statistic", type: "scalar", value: Number.NaN }
    ], r = xt(e.report.cases, this.scoreKey, this.scoreFrom, this.positiveFrom, this.positiveKey);
    if (r.length === 0) return s;
    const a = r.filter(([, f]) => f).map(([f]) => f).sort((f, p) => f - p), i = r.filter(([, f]) => !f).map(([f]) => f).sort((f, p) => f - p);
    if (a.length === 0 || i.length === 0) return s;
    const o = Array.from(new Set(r.map(([f]) => f))).sort((f, p) => f - p), d = [[o[0], 0]], h = [[o[0], 0]];
    let c = 0;
    for (const f of o) {
      const p = te(a, f) / a.length, y = te(i, f) / i.length;
      d.push([f, p]), h.push([f, y]), c = Math.max(c, Math.abs(p - y));
    }
    const m = W(d, this.nThresholds), v = W(h, this.nThresholds);
    return [
      {
        curves: [
          { name: "Positive", points: m.map(([f, p]) => ({ x: f, y: p })), step: "end" },
          { name: "Negative", points: v.map(([f, p]) => ({ x: f, y: p })), step: "end" }
        ],
        title: this.title,
        type: "line_plot",
        x_label: "Score",
        y_label: "Cumulative Probability",
        y_range: [0, 1]
      },
      { title: "KS Statistic", type: "scalar", value: c }
    ];
  }
};
u(Lt, "KolmogorovSmirnovEvaluator");
let gt = Lt;
const Me = [
  ht,
  gt,
  pt,
  mt
];
let z = null, ee = !1;
async function Ne() {
  if (z !== null) return z;
  if (ee) return null;
  ee = !0;
  try {
    return z = (await import("@opentelemetry/api")).trace.getTracer("pydantic-evals"), z;
  } catch {
    return null;
  }
}
u(Ne, "getTracer");
const Ie = "logfire.msg_template", Fe = "logfire.msg", Pe = "logfire.span_type";
function Ce(n, t) {
  return n.replace(/\{(\w+)\}/g, (e, s) => {
    const r = t[s];
    if (r === void 0) return `{${s}}`;
    if (typeof r == "string") return r;
    try {
      return JSON.stringify(r);
    } catch {
      return String(r);
    }
  });
}
u(Ce, "formatMessage");
function Re(n) {
  if (n == null) return "";
  if (typeof n == "string" || typeof n == "number" || typeof n == "boolean" || Array.isArray(n) && n.every((t) => typeof t == "string" || typeof t == "number" || typeof t == "boolean")) return n;
  try {
    return JSON.stringify(n);
  } catch {
    return String(n);
  }
}
u(Re, "normalizeAttribute");
function je(n) {
  const t = {};
  for (const [e, s] of Object.entries(n))
    t[e] = Re(s);
  return t;
}
u(je, "normalizeAttributes");
async function tt(n, t, e) {
  const s = await Ne(), r = {
    ...je(t),
    [Fe]: Ce(n, t),
    [Ie]: n,
    [Pe]: "span"
  };
  if (s === null) {
    const a = {
      end: /* @__PURE__ */ u(() => {
      }, "end"),
      recordException: /* @__PURE__ */ u(() => {
      }, "recordException"),
      setAttribute: /* @__PURE__ */ u(() => {
      }, "setAttribute"),
      setAttributes: /* @__PURE__ */ u(() => {
      }, "setAttributes"),
      setStatus: /* @__PURE__ */ u(() => {
      }, "setStatus")
    };
    return await Promise.resolve(e(a));
  }
  return await s.startActiveSpan(n, { attributes: r }, async (a) => {
    try {
      const i = await Promise.resolve(e(a));
      return a.end(), i;
    } catch (i) {
      throw a.recordException(i), a.setStatus({ code: 2, message: i.message }), a.end(), i;
    }
  });
}
u(tt, "evalSpan");
async function At(n, t) {
  const e = n.getDefaultEvaluationName();
  return await tt("evaluator: {evaluator_name}", { evaluator_name: e }, async () => Ke(n, t));
}
u(At, "runEvaluator");
async function Ke(n, t) {
  try {
    const e = await n.evaluateAsync(t), s = Le(e, n.getDefaultEvaluationName()), r = [], a = n.asSpec();
    for (const [i, o] of Object.entries(s)) {
      const d = he(o) ? o : O(o);
      r.push({ name: i, reason: d.reason ?? null, source: a, value: d.value });
    }
    return r;
  } catch (e) {
    const s = e;
    return {
      errorMessage: `${s.name}: ${s.message}`,
      errorStacktrace: s.stack ?? String(e),
      name: n.getDefaultEvaluationName(),
      source: n.asSpec()
    };
  }
}
u(Ke, "runEvaluatorInner");
function Le(n, t) {
  return typeof n == "boolean" || typeof n == "number" || typeof n == "string" ? { [t]: n } : he(n) ? { [t]: n } : n;
}
u(Le, "convertToMapping");
function nt(n) {
  if (typeof n == "string")
    return { arguments: null, name: n };
  const t = Object.entries(n);
  if (t.length !== 1)
    throw new Error("Evaluator spec object must have exactly one key (the evaluator name).");
  const [e, s] = t[0];
  if (Array.isArray(s)) {
    if (s.length !== 1)
      throw new Error(`Evaluator spec for ${e}: positional form must be a single-element array.`);
    return { arguments: [s[0]], name: e };
  }
  return s !== null && typeof s == "object" ? { arguments: s, name: e } : { arguments: [s], name: e };
}
u(nt, "parseEvaluatorSpec");
function st(n) {
  return n.arguments === null || n.arguments === void 0 ? n.name : { [n.name]: n.arguments };
}
u(st, "serializeEvaluatorSpec");
const Bt = class Bt {
  constructor(t) {
    l(this, "attributes");
    l(this, "childrenById", /* @__PURE__ */ new Map());
    l(this, "endTimestamp");
    l(this, "name");
    l(this, "parent", null);
    l(this, "parentSpanId");
    l(this, "spanId");
    l(this, "startTimestamp");
    l(this, "traceId");
    this.name = t.name, this.traceId = t.traceId, this.spanId = t.spanId, this.parentSpanId = t.parentSpanId ?? null, this.startTimestamp = t.startTimestamp, this.endTimestamp = t.endTimestamp, this.attributes = t.attributes ?? {};
  }
  get ancestors() {
    return this.findAncestors(() => !0);
  }
  get children() {
    return Array.from(this.childrenById.values());
  }
  get descendants() {
    return this.findDescendants(() => !0);
  }
  get duration() {
    return (this.endTimestamp.getTime() - this.startTimestamp.getTime()) / 1e3;
  }
  get nodeKey() {
    return `${this.traceId}:${this.spanId}`;
  }
  get parentNodeKey() {
    return this.parentSpanId === null ? null : `${this.traceId}:${this.parentSpanId}`;
  }
  addChild(t) {
    this.childrenById.set(t.nodeKey, t), t.parent = this;
  }
  anyAncestor(t, e) {
    return this.firstAncestor(t, e) !== null;
  }
  anyChild(t) {
    return this.firstChild(t) !== null;
  }
  anyDescendant(t, e) {
    return this.firstDescendant(t, e) !== null;
  }
  findAncestors(t, e) {
    const s = [];
    let r = this.parent;
    for (; r !== null && (r.matches(t) && s.push(r), !(e !== void 0 && r.matches(e))); )
      r = r.parent;
    return s;
  }
  findChildren(t) {
    return this.children.filter((e) => e.matches(t));
  }
  findDescendants(t, e) {
    const s = [], r = [...this.children];
    for (; r.length > 0; ) {
      const a = r.pop();
      a.matches(t) && s.push(a), !(e !== void 0 && a.matches(e)) && r.push(...a.children);
    }
    return s;
  }
  firstAncestor(t, e) {
    let s = this.parent;
    for (; s !== null; ) {
      if (s.matches(t)) return s;
      if (e !== void 0 && s.matches(e)) return null;
      s = s.parent;
    }
    return null;
  }
  firstChild(t) {
    for (const e of this.children)
      if (e.matches(t)) return e;
    return null;
  }
  firstDescendant(t, e) {
    const s = [...this.children];
    for (; s.length > 0; ) {
      const r = s.pop();
      if (r.matches(t)) return r;
      e !== void 0 && r.matches(e) || s.push(...r.children);
    }
    return null;
  }
  matches(t) {
    return typeof t == "function" ? t(this) : this.matchesQuery(t);
  }
  toString() {
    return this.children.length > 0 ? `<SpanNode name='${this.name}' span_id='${this.spanId}'>...</SpanNode>` : `<SpanNode name='${this.name}' span_id='${this.spanId}' />`;
  }
  matchesQuery(t) {
    if (t.or_ !== void 0) {
      if (Object.keys(t).length > 1)
        throw new Error("Cannot combine 'or_' conditions with other conditions at the same level");
      return t.or_.some((d) => this.matchesQuery(d));
    }
    if (t.not_ !== void 0 && this.matchesQuery(t.not_) || t.and_ !== void 0 && !t.and_.every((o) => this.matchesQuery(o)) || t.name_equals !== void 0 && this.name !== t.name_equals || t.name_contains !== void 0 && !this.name.includes(t.name_contains) || t.name_matches_regex !== void 0 && !new RegExp(t.name_matches_regex).test(this.name)) return !1;
    if (t.has_attributes !== void 0) {
      for (const [o, d] of Object.entries(t.has_attributes))
        if (this.attributes[o] !== d) return !1;
    }
    if (t.has_attribute_keys !== void 0) {
      for (const o of t.has_attribute_keys)
        if (!(o in this.attributes)) return !1;
    }
    if (t.min_duration !== void 0 && this.duration < t.min_duration || t.max_duration !== void 0 && this.duration > t.max_duration) return !1;
    const e = this.children;
    if (t.min_child_count !== void 0 && e.length < t.min_child_count || t.max_child_count !== void 0 && e.length > t.max_child_count || t.some_child_has !== void 0 && !e.some((o) => o.matchesQuery(t.some_child_has)) || t.all_children_have !== void 0 && !e.every((o) => o.matchesQuery(t.all_children_have)) || t.no_child_has !== void 0 && e.some((o) => o.matchesQuery(t.no_child_has))) return !1;
    const s = this.descendants, r = t.stop_recursing_when !== void 0 ? this.findDescendants(() => !0, t.stop_recursing_when) : s;
    if (t.min_descendant_count !== void 0 && s.length < t.min_descendant_count || t.max_descendant_count !== void 0 && s.length > t.max_descendant_count || t.some_descendant_has !== void 0 && !r.some((o) => o.matchesQuery(t.some_descendant_has)) || t.all_descendants_have !== void 0 && !r.every((o) => o.matchesQuery(t.all_descendants_have)) || t.no_descendant_has !== void 0 && r.some((o) => o.matchesQuery(t.no_descendant_has))) return !1;
    const a = this.ancestors, i = t.stop_recursing_when !== void 0 ? this.findAncestors(() => !0, t.stop_recursing_when) : a;
    return !(t.min_depth !== void 0 && a.length < t.min_depth || t.max_depth !== void 0 && a.length > t.max_depth || t.some_ancestor_has !== void 0 && !i.some((o) => o.matchesQuery(t.some_ancestor_has)) || t.all_ancestors_have !== void 0 && !i.every((o) => o.matchesQuery(t.all_ancestors_have)) || t.no_ancestor_has !== void 0 && i.some((o) => o.matchesQuery(t.no_ancestor_has)));
  }
};
u(Bt, "SpanNode");
let vt = Bt;
const zt = class zt {
  constructor(t = []) {
    l(this, "nodesById", /* @__PURE__ */ new Map());
    l(this, "roots", []);
    for (const e of t)
      this.nodesById.set(e.nodeKey, e);
    this.rebuild();
  }
  addSpans(t) {
    for (const e of t)
      this.nodesById.set(e.nodeKey, e);
    this.rebuild();
  }
  any(t) {
    return this.first(t) !== null;
  }
  find(t) {
    return Array.from(this).filter((e) => e.matches(t));
  }
  first(t) {
    for (const e of this)
      if (e.matches(t)) return e;
    return null;
  }
  *[Symbol.iterator]() {
    for (const t of this.nodesById.values())
      yield t;
  }
  toString() {
    return `<SpanTree num_roots=${String(this.roots.length)} total_spans=${String(this.nodesById.size)} />`;
  }
  rebuild() {
    const t = Array.from(this.nodesById.values()).sort((e, s) => e.startTimestamp.getTime() - s.startTimestamp.getTime());
    this.nodesById = new Map(t.map((e) => [e.nodeKey, e]));
    for (const e of this.nodesById.values())
      e.parent = null, e.childrenById.clear();
    for (const e of this.nodesById.values()) {
      const s = e.parentNodeKey;
      if (s !== null) {
        const r = this.nodesById.get(s);
        r !== void 0 && r.addChild(e);
      }
    }
    this.roots = [];
    for (const e of this.nodesById.values()) {
      const s = e.parentNodeKey;
      (s === null || !this.nodesById.has(s)) && this.roots.push(e);
    }
  }
};
u(zt, "SpanTree");
let H = zt;
const j = /* @__PURE__ */ new Map();
let ne = 0, rt = !1, M = null, me = !1;
function bn() {
  return me = !0, {
    async forceFlush() {
      await Promise.resolve();
    },
    onEnd: /* @__PURE__ */ u((n) => {
      if (j.size === 0) return;
      const t = ge(n);
      for (const e of j.values())
        e.spans.push(t);
    }, "onEnd"),
    onStart: /* @__PURE__ */ u(() => {
    }, "onStart"),
    async shutdown() {
      await Promise.resolve();
    }
  };
}
u(bn, "getSpanTreeProcessor");
function se(n) {
  return n === void 0 ? /* @__PURE__ */ new Date() : new Date(n[0] * 1e3 + n[1] / 1e6);
}
u(se, "hrTimeToDate");
function ge(n) {
  var s;
  const t = n.spanContext(), e = ((s = n.parentSpanContext) == null ? void 0 : s.spanId) ?? n.parentSpanId ?? null;
  return {
    attributes: n.attributes ?? {},
    endTimestamp: se(n.endTime),
    name: n.name,
    parentSpanId: e === "" ? null : e,
    spanId: t.spanId,
    startTimestamp: se(n.startTime),
    traceId: t.traceId
  };
}
u(ge, "readableSpanToCaptured");
async function Be(n) {
  try {
    return await import(
      /* @vite-ignore */
      n
    );
  } catch {
    return null;
  }
}
u(Be, "dynamicImport");
async function ze() {
  if (rt) return null;
  if (me)
    return rt = !0, null;
  if (M !== null) return M;
  const n = await Be("@opentelemetry/api");
  if (n === null)
    return M = new D(
      "To make use of the `span_tree` in an evaluator, you must install `@opentelemetry/api` and a compatible SDK."
    ), M;
  const t = n.trace.getTracerProvider(), e = typeof t.getDelegate == "function" ? t.getDelegate() : t;
  if (typeof e.addSpanProcessor != "function")
    return M = new D(
      "To make use of the `span_tree` in an evaluator, you need to configure a TracerProvider with `getSpanTreeProcessor()` before running an evaluation."
    ), M;
  const s = {
    async forceFlush() {
      await Promise.resolve();
    },
    onEnd: /* @__PURE__ */ u((r) => {
      if (j.size === 0) return;
      const a = ge(r);
      for (const i of j.values())
        i.spans.push(a);
    }, "onEnd"),
    onStart: /* @__PURE__ */ u(() => {
    }, "onStart"),
    async shutdown() {
      await Promise.resolve();
    }
  };
  return e.addSpanProcessor(s), rt = !0, null;
}
u(ze, "installExporter");
function Ue() {
  return ne++, `capture-${String(ne)}`;
}
u(Ue, "newCaptureId");
async function ve(n) {
  const t = await ze();
  if (t !== null) return await Promise.resolve(n(() => t));
  const e = { id: Ue(), spans: [] };
  j.set(e.id, e);
  try {
    return await Promise.resolve(
      n(() => {
        const s = e.spans.map((r) => new vt({ ...r, attributes: r.attributes }));
        return new H(s);
      })
    );
  } finally {
    j.delete(e.id);
  }
}
u(ve, "contextSubtreeCapture");
const J = 3, Ge = 3, Je = 1, Qe = 100, ye = 0.01, We = 10;
function Y(n, t) {
  return n.toLocaleString("en-US", { maximumFractionDigits: t, minimumFractionDigits: t, useGrouping: !0 });
}
u(Y, "formatGroupedFixed");
function U(n) {
  if (Number.isInteger(n))
    return n.toLocaleString("en-US", { useGrouping: !0 });
  const t = Math.abs(n);
  let e;
  if (t === 0)
    e = J;
  else if (t >= 1) {
    const s = Math.floor(Math.log10(t)) + 1;
    e = Math.max(1, J - s);
  } else
    e = -Math.floor(Math.log10(t)) + J - 1;
  return Y(n, e);
}
u(U, "defaultRenderNumber");
function re(n) {
  const t = J - 2;
  return `${(n * 100).toLocaleString("en-US", { maximumFractionDigits: t, minimumFractionDigits: t })}%`;
}
u(re, "defaultRenderPercentage");
function He(n, t) {
  let s = Math.abs(n).toPrecision(t);
  if (!s.includes("e") && !s.includes(".") && (s += ".0"), !s.includes("e")) {
    const r = s.split(".");
    r[0] = Number(r[0]).toLocaleString("en-US", { useGrouping: !0 }), s = r.join(".");
  }
  return `${n >= 0 ? "+" : "-"}${s}`;
}
u(He, "renderSignedSigFigs");
function be(n, t, e) {
  if (t === 0) return null;
  const s = n - t;
  if (Math.abs(t) < e && Math.abs(s) > We * Math.abs(t)) return null;
  const r = s / t * 100, i = `${r >= 0 ? "+" : ""}${r.toFixed(Je)}%`;
  if (i === "+0.0%" || i === "-0.0%") return null;
  if (Math.abs(s) / Math.abs(t) <= 1)
    return i;
  const o = n / t;
  return Math.abs(o) < Qe ? `${Y(o, 1)}x` : `${Y(o, 0)}x`;
}
u(be, "renderRelative");
function Se(n, t) {
  if (n === 0) return "0s";
  let e = 1;
  const s = Math.abs(n);
  let r, a;
  return s < 1e-3 ? (r = n * 1e6, a = "µs", Math.abs(r) >= 1 && (e = 0)) : s < 1 ? (r = n * 1e3, a = "ms") : (r = n, a = "s"), `${t && r >= 0 ? "+" : ""}${Y(r, e)}${a}`;
}
u(Se, "renderDuration");
function Sn(n, t) {
  if (n === t) return null;
  if (Number.isInteger(n) && Number.isInteger(t)) {
    const a = t - n;
    return `${a >= 0 ? "+" : ""}${a.toString()}`;
  }
  const e = t - n, s = He(e, Ge), r = be(t, n, ye);
  return r === null ? s : `${s} / ${r}`;
}
u(Sn, "defaultRenderNumberDiff");
function N(n) {
  return Se(n, !1);
}
u(N, "defaultRenderDuration");
function wn(n, t) {
  if (n === t) return null;
  const e = Se(t - n, !0), s = be(t, n, ye);
  return s === null ? e : `${e} / ${s}`;
}
u(wn, "defaultRenderDurationDiff");
function ae(n) {
  const t = {}, e = {};
  for (const r of n)
    for (const [a, i] of Object.entries(r))
      t[a] = (t[a] ?? 0) + 1, e[a] = (e[a] ?? 0) + i;
  const s = {};
  for (const r of Object.keys(e))
    s[r] = e[r] / t[r];
  return s;
}
u(ae, "averageScores");
function Ye(n) {
  const t = {}, e = {};
  for (const r of n)
    for (const [a, i] of Object.entries(r))
      t[a] = (t[a] ?? 0) + 1, a in e || (e[a] = {}), e[a][i] = (e[a][i] ?? 0) + 1;
  const s = {};
  for (const r of Object.keys(e)) {
    s[r] = {};
    for (const [a, i] of Object.entries(e[r]))
      s[r][a] = i / t[r];
  }
  return s;
}
u(Ye, "averageLabels");
function ie(n) {
  const t = n.length;
  if (t === 0)
    return { assertions: null, labels: {}, metrics: {}, name: "Averages", scores: {}, taskDuration: 0, totalDuration: 0 };
  const e = n.reduce((h, c) => h + c.taskDuration, 0) / t, s = n.reduce((h, c) => h + c.totalDuration, 0) / t, r = ae(n.map((h) => Object.fromEntries(Object.entries(h.scores).map(([c, m]) => [c, m.value])))), a = Ye(n.map((h) => Object.fromEntries(Object.entries(h.labels).map(([c, m]) => [c, m.value])))), i = ae(n.map((h) => h.metrics)), o = n.reduce((h, c) => h + Object.keys(c.assertions).length, 0);
  let d = null;
  return o > 0 && (d = n.reduce((c, m) => c + Object.values(m.assertions).filter((v) => v.value).length, 0) / o), {
    assertions: d,
    labels: a,
    metrics: i,
    name: "Averages",
    scores: r,
    taskDuration: e,
    totalDuration: s
  };
}
u(ie, "aggregateAverage");
function Xe(n) {
  if (n.length === 0)
    return { assertions: null, labels: {}, metrics: {}, name: "Averages", scores: {}, taskDuration: 0, totalDuration: 0 };
  function t(c) {
    const m = /* @__PURE__ */ new Set();
    for (const f of c) for (const p of Object.keys(f)) m.add(p);
    const v = {};
    for (const f of m) {
      const p = c.filter((y) => f in y).map((y) => y[f]);
      p.length > 0 && (v[f] = p.reduce((y, _) => y + _, 0) / p.length);
    }
    return v;
  }
  u(t, "avgNumericDicts");
  const e = t(n.map((c) => c.scores)), s = t(n.map((c) => c.metrics)), r = /* @__PURE__ */ new Set();
  for (const c of n) for (const m of Object.keys(c.labels)) r.add(m);
  const a = {};
  for (const c of r) {
    const m = {};
    let v = 0;
    for (const f of n)
      if (c in f.labels) {
        v += 1;
        for (const [p, y] of Object.entries(f.labels[c]))
          m[p] = (m[p] ?? 0) + y;
      }
    a[c] = {};
    for (const [f, p] of Object.entries(m)) a[c][f] = p / v;
  }
  const i = n.filter((c) => c.assertions !== null).map((c) => c.assertions), o = i.length > 0 ? i.reduce((c, m) => c + m, 0) / i.length : null, d = n.map((c) => c.taskDuration), h = n.map((c) => c.totalDuration);
  return {
    assertions: o,
    labels: a,
    metrics: s,
    name: "Averages",
    scores: e,
    taskDuration: d.reduce((c, m) => c + m, 0) / d.length,
    totalDuration: h.reduce((c, m) => c + m, 0) / h.length
  };
}
u(Xe, "aggregateAverageFromAggregates");
const Ut = class Ut {
  constructor(t) {
    l(this, "analyses");
    l(this, "cases");
    l(this, "experimentMetadata");
    l(this, "failures");
    l(this, "name");
    l(this, "reportEvaluatorFailures");
    l(this, "spanId");
    l(this, "traceId");
    this.name = t.name, this.cases = t.cases, this.failures = t.failures ?? [], this.analyses = t.analyses ?? [], this.reportEvaluatorFailures = t.reportEvaluatorFailures ?? [], this.experimentMetadata = t.experimentMetadata ?? null, this.traceId = t.traceId ?? null, this.spanId = t.spanId ?? null;
  }
  averages() {
    const t = this.caseGroups();
    if (t !== null) {
      const e = t.filter((s) => s.runs.length > 0).map((s) => s.summary);
      return e.length > 0 ? Xe(e) : null;
    }
    return this.cases.length > 0 ? ie(this.cases) : null;
  }
  caseGroups() {
    if (!(this.cases.some((r) => r.sourceCaseName !== null) || this.failures.some((r) => r.sourceCaseName !== null))) return null;
    const e = /* @__PURE__ */ new Map();
    for (const r of this.cases) {
      const a = r.sourceCaseName ?? r.name;
      e.has(a) || e.set(a, { failures: [], runs: [] }), e.get(a).runs.push(r);
    }
    for (const r of this.failures) {
      const a = r.sourceCaseName ?? r.name;
      e.has(a) || e.set(a, { failures: [], runs: [] }), e.get(a).failures.push(r);
    }
    const s = [];
    for (const [r, { failures: a, runs: i }] of e) {
      const o = i[0] ?? a[0];
      s.push({
        expectedOutput: o.expectedOutput,
        failures: a,
        inputs: o.inputs,
        metadata: o.metadata,
        name: r,
        runs: i,
        summary: ie(i)
      });
    }
    return s;
  }
  render(t = {}) {
    return tn(this, t);
  }
  toString() {
    return this.render();
  }
};
u(Ut, "EvaluationReport");
let yt = Ut;
function G(n) {
  if (n == null) return "-";
  if (typeof n == "string") return n;
  if (typeof n == "number" || typeof n == "boolean") return String(n);
  try {
    return JSON.stringify(n);
  } catch {
    return String(n);
  }
}
u(G, "formatValue");
function Ze(n) {
  if (n.length === 0) return n;
  const t = Math.max(...n.map((r) => r.length)), e = new Array(t).fill(0);
  for (const r of n)
    for (let a = 0; a < r.length; a++) {
      const o = (r[a] ?? "").split(`
`).reduce((d, h) => Math.max(d, h.length), 0);
      o > e[a] && (e[a] = o);
    }
  const s = [];
  for (const r of n) {
    const a = r.map((i, o) => i.split(`
`).map((h) => h + " ".repeat(Math.max(0, e[o] - h.length))).join(`
`));
    s.push(a);
  }
  return s;
}
u(Ze, "padCells");
function X(n, t, e) {
  const s = [n, ...t], r = Ze(s), a = [];
  e.length > 0 && a.push(e);
  for (let i = 0; i < r.length; i++) {
    const o = r[i], d = Math.max(...o.map((h) => h.split(`
`).length));
    for (let h = 0; h < d; h++) {
      const c = o.map((m) => {
        const v = m.split(`
`);
        return v[h] ?? " ".repeat(v[0].length);
      });
      a.push(`| ${c.join(" | ")} |`);
    }
    if (i === 0) {
      const h = o.map((c) => "-".repeat(c.split(`
`)[0].length));
      a.push(`|-${h.join("-|-")}-|`);
    }
  }
  return a.join(`
`);
}
u(X, "renderTable");
function I(n, t) {
  return n.length === 0 ? "-" : n.map(([e, s]) => `${e}: ${t(s)}`).join(`
`);
}
u(I, "renderDict");
function Ve(n, t) {
  return n.length === 0 ? "-" : n.map((e) => {
    let s = e.value ? "✔" : "✗";
    return t && (s = `${e.name}: ${s}`, e.reason !== null && e.reason !== "" && (s += `
  Reason: ${e.reason}`)), s;
  }).join(`
`);
}
u(Ve, "renderAssertions");
function qe(n) {
  if (n.type === "confusion_matrix") {
    const e = ["Expected \\ Predicted", ...n.classLabels], s = n.classLabels.map((r, a) => [r, ...(n.matrix[a] ?? []).map((i) => String(i))]);
    return X(e, s, n.title);
  }
  if (n.type === "scalar") {
    const e = n.unit !== null && n.unit !== void 0 ? ` ${n.unit}` : "";
    return `${n.title}: ${String(n.value)}${e}`;
  }
  if (n.type === "precision_recall") {
    const e = [n.title];
    for (const s of n.curves) {
      const r = s.auc !== null && s.auc !== void 0 ? `, AUC=${s.auc.toFixed(4)}` : "";
      e.push(`  ${s.name}: ${String(s.points.length)} points${r}`);
    }
    return e.join(`
`);
  }
  if (n.type === "line_plot") {
    const e = [n.title];
    for (const s of n.curves)
      e.push(`  ${s.name}: ${String(s.points.length)} points`);
    return e.join(`
`);
  }
  const t = n.rows.map((e) => e.map((s) => s === null ? "" : String(s)));
  return X(n.columns, t, n.title);
}
u(qe, "renderAnalysis");
function tn(n, t) {
  var Vt;
  const e = t.includeInput ?? !1, s = t.includeMetadata ?? !1, r = t.includeExpectedOutput ?? !1, a = t.includeOutput ?? !1, i = t.includeDurations ?? !0, o = t.includeTotalDuration ?? !1, d = t.includeAverages ?? !0, h = t.includeErrors ?? !0, c = t.includeEvaluatorFailures ?? !0, m = t.includeAnalyses ?? !0, v = t.includeReasons ?? !1, f = n.cases, p = f.some((g) => Object.keys(g.scores).length > 0), y = f.some((g) => Object.keys(g.labels).length > 0), _ = f.some((g) => Object.keys(g.metrics).length > 0), S = f.some((g) => Object.keys(g.assertions).length > 0), A = c && f.some((g) => g.evaluatorFailures.length > 0), x = ["Case ID"];
  e && x.push("Inputs"), s && x.push("Metadata"), r && x.push("Expected Output"), a && x.push("Outputs"), p && x.push("Scores"), y && x.push("Labels"), _ && x.push("Metrics"), S && x.push("Assertions"), A && x.push("Evaluator Failures"), i && x.push(o ? "Durations" : "Duration");
  const et = [];
  for (const g of f) {
    const b = [g.name];
    if (e && b.push(G(g.inputs)), s && b.push(G(g.metadata)), r && b.push(G(g.expectedOutput)), a && b.push(G(g.output)), p && b.push(I(Object.entries(g.scores), (w) => U(w.value))), y && b.push(I(Object.entries(g.labels), (w) => w.value)), _ && b.push(I(Object.entries(g.metrics), (w) => U(w))), S && b.push(Ve(Object.values(g.assertions), v)), A && b.push(g.evaluatorFailures.length > 0 ? g.evaluatorFailures.map((w) => `${w.name}: ${w.errorMessage}`).join(`
`) : "-"), i) {
      const w = [];
      o ? (w.push(`task: ${N(g.taskDuration)}`), w.push(`total: ${N(g.totalDuration)}`)) : w.push(N(g.taskDuration)), b.push(w.join(`
`));
    }
    et.push(b);
  }
  if (d) {
    const g = n.averages();
    if (g !== null) {
      const b = [g.name];
      e && b.push(""), s && b.push(""), r && b.push(""), a && b.push(""), p && b.push(I(Object.entries(g.scores), (w) => U(w))), y && b.push(
        I(
          Object.entries(g.labels),
          (w) => Object.entries(w).map(([_e, xe]) => `${_e}=${re(xe)}`).join(", ")
        )
      ), _ && b.push(I(Object.entries(g.metrics), (w) => U(w))), S && b.push(g.assertions !== null ? `${re(g.assertions)} ✔` : ""), A && b.push(""), i && (o ? b.push(`task: ${N(g.taskDuration)}
total: ${N(g.totalDuration)}`) : b.push(N(g.taskDuration))), et.push(b);
    }
  }
  const Zt = (Vt = t.baseline) == null ? void 0 : Vt.name, we = t.baseline ? `Evaluation Diff: ${Zt === n.name ? n.name : `${Zt} → ${n.name}`}` : `Evaluation Summary: ${n.name}`;
  let k = X(x, et, we);
  if (t.baseline && (k += `

(Baseline diff rendering simplified - see individual case data for details)`), m && n.analyses.length > 0)
    for (const g of n.analyses)
      k += `

` + qe(g);
  if (c && n.reportEvaluatorFailures.length > 0) {
    k += `

Report Evaluator Failures:`;
    for (const g of n.reportEvaluatorFailures)
      k += `
  ${g.name}: ${g.errorMessage}`;
  }
  if (h && n.failures.length > 0) {
    const g = ["Case ID", "Error Message"], b = n.failures.map((w) => [w.name, w.errorMessage]);
    k += `

` + X(g, b, "Case Failures");
  }
  return k;
}
u(tn, "renderReport");
const Gt = class Gt {
  constructor(t) {
    l(this, "message");
    l(this, "name", "PydanticEvalsDeprecationWarning");
    this.message = t;
  }
};
u(Gt, "PydanticEvalsDeprecationWarning");
let oe = Gt;
function Et(n) {
  const t = n.name;
  return t && t !== "anonymous" ? t : "anonymous";
}
u(Et, "getFunctionName");
async function en(n) {
  return Promise.all(n.map((t) => t()));
}
u(en, "taskGroupGather");
async function nn(n, t) {
  if (t === null || t >= n.length)
    return en(n);
  const e = new Array(n.length);
  let s = 0;
  const r = [];
  for (let a = 0; a < t; a++)
    r.push(
      (async () => {
        for (; ; ) {
          const i = s++;
          if (i >= n.length) return;
          e[i] = await n[i]();
        }
      })()
    );
  return await Promise.all(r), e;
}
u(nn, "taskGroupGatherConcurrency");
const ue = /* @__PURE__ */ new Set();
function sn(n, t) {
  if (!ue.has(n)) {
    ue.add(n);
    try {
      typeof process < "u" && typeof process.emitWarning == "function" ? process.emitWarning(t, "PydanticEvalsDeprecationWarning") : console.warn(`PydanticEvalsDeprecationWarning: ${t}`);
    } catch {
      console.warn(`PydanticEvalsDeprecationWarning: ${t}`);
    }
  }
}
u(sn, "warnOnce");
const L = new Ee(), Jt = class Jt {
  constructor() {
    l(this, "attributes", {});
    l(this, "metrics", {});
  }
  incrementMetric(t, e) {
    const s = this.metrics[t] ?? 0, r = s + e;
    s === 0 && r === 0 || (this.metrics[t] = r);
  }
  recordAttribute(t, e) {
    this.attributes[t] = e;
  }
  recordMetric(t, e) {
    this.metrics[t] = e;
  }
};
u(Jt, "TaskRun");
let bt = Jt;
function _n(n, t) {
  const e = L.getStore();
  e !== void 0 && e.recordAttribute(n, t);
}
u(_n, "setEvalAttribute");
function xn(n, t) {
  const e = L.getStore();
  e !== void 0 && e.incrementMetric(n, t);
}
u(xn, "incrementEvalMetric");
function rn() {
  return L.getStore() ?? null;
}
u(rn, "getCurrentTaskRun");
const Qt = class Qt {
  constructor(t) {
    l(this, "evaluators");
    l(this, "expectedOutput");
    l(this, "inputs");
    l(this, "metadata");
    l(this, "name");
    this.name = t.name ?? null, this.inputs = t.inputs, this.metadata = t.metadata ?? null, this.expectedOutput = t.expectedOutput ?? null, this.evaluators = [...t.evaluators ?? []];
  }
};
u(Qt, "Case");
let B = Qt;
const K = class K {
  constructor(t) {
    l(this, "cases");
    l(this, "evaluators");
    l(this, "name");
    l(this, "reportEvaluators");
    (t.name === void 0 || t.name === null) && sn("dataset-name-missing", "Omitting the `name` parameter is deprecated. Please provide a name for your `Dataset`.");
    const e = /* @__PURE__ */ new Set();
    for (const s of t.cases)
      if (s.name !== null) {
        if (e.has(s.name)) throw new Error(`Duplicate case name: ${JSON.stringify(s.name)}`);
        e.add(s.name);
      }
    this.name = t.name ?? null, this.cases = [...t.cases], this.evaluators = [...t.evaluators ?? []], this.reportEvaluators = [...t.reportEvaluators ?? []];
  }
  static fromDict(t, e = {}) {
    const s = le(
      e.customEvaluatorTypes ?? [],
      Oe
    ), r = le(
      e.customReportEvaluatorTypes ?? [],
      Me
    ), a = [], i = t.cases ?? [];
    for (const c of i) {
      const m = c, v = [];
      for (const f of m.evaluators ?? [])
        v.push(at(s, nt(f)));
      a.push(
        new B({
          evaluators: v,
          expectedOutput: m.expected_output ?? null,
          inputs: m.inputs,
          metadata: m.metadata ?? null,
          name: m.name ?? null
        })
      );
    }
    const o = (t.evaluators ?? []).map(
      (c) => at(s, nt(c))
    ), d = (t.report_evaluators ?? []).map(
      (c) => at(r, nt(c))
    ), h = t.name ?? e.defaultName ?? null;
    return new K({
      cases: a,
      evaluators: o,
      name: h,
      reportEvaluators: d
    });
  }
  static fromText(t, e = {}) {
    const r = (e.fmt ?? "yaml") === "json" ? JSON.parse(t) : $e(t);
    return K.fromDict(r, e);
  }
  addCase(t) {
    if (t.name !== null && t.name !== void 0) {
      for (const e of this.cases)
        if (e.name === t.name) throw new Error(`Duplicate case name: ${JSON.stringify(t.name)}`);
    }
    this.cases.push(new B(t));
  }
  addEvaluator(t, e) {
    if (e === void 0) {
      this.evaluators.push(t);
      return;
    }
    let s = !1;
    for (const r of this.cases)
      r.name === e && (r.evaluators.push(t), s = !0);
    if (!s) throw new Error(`Case ${JSON.stringify(e)} not found in the dataset`);
  }
  async evaluate(t, e = {}) {
    const s = e.repeat ?? 1;
    if (s < 1) throw new Error(`repeat must be >= 1, got ${String(s)}`);
    const r = e.taskName ?? Et(t), a = e.name ?? r, i = this.buildTasksToRun(s), o = await tt(
      "evaluate {name}",
      {
        dataset_name: this.name,
        "gen_ai.operation.name": "experiment",
        n_cases: this.cases.length,
        name: a,
        task_name: r,
        ...e.metadata !== void 0 && e.metadata !== null ? { metadata: e.metadata } : {},
        ...s > 1 ? { "logfire.experiment.repeat": s } : {}
      },
      async (d) => {
        const h = i.map(
          ([y, _, S]) => () => un(t, y, _, this.evaluators, S, e.lifecycle ?? null)
        ), c = await nn(h, e.maxConcurrency ?? null), m = [], v = [];
        for (const y of c)
          "output" in y ? m.push(y) : v.push(y);
        const f = new yt({
          cases: m,
          experimentMetadata: e.metadata ?? null,
          failures: v,
          name: a
        }), p = f.averages();
        return p !== null && p.assertions !== null && d.setAttribute("assertion_pass_rate", p.assertions), f;
      }
    );
    return this.reportEvaluators.length > 0 && await fn(
      this.reportEvaluators,
      {
        experimentMetadata: e.metadata ?? null,
        name: a,
        report: o
      },
      o
    ), o;
  }
  async toDict() {
    return await Promise.resolve({
      cases: this.cases.map((t) => ({
        evaluators: t.evaluators.map((e) => st(e.asSpec())),
        expected_output: t.expectedOutput,
        inputs: t.inputs,
        metadata: t.metadata,
        name: t.name
      })),
      evaluators: this.evaluators.map((t) => st(t.asSpec())),
      name: this.name,
      report_evaluators: this.reportEvaluators.map((t) => st(t.asSpec()))
    });
  }
  async toJSON() {
    return JSON.stringify(await this.toDict(), null, 2);
  }
  async toYAML() {
    return Te(await this.toDict());
  }
  buildTasksToRun(t) {
    if (t > 1) {
      const e = [];
      return this.cases.forEach((s, r) => {
        const a = s.name ?? `Case ${String(r + 1)}`;
        for (let i = 1; i <= t; i++)
          e.push([s, `${a} [${String(i)}/${String(t)}]`, a]);
      }), e;
    }
    return this.cases.map((e, s) => [e, e.name ?? `Case ${String(s + 1)}`, null]);
  }
};
u(K, "Dataset");
let St = K;
function le(n, t) {
  const e = /* @__PURE__ */ new Map();
  for (const s of t)
    e.set(s.name, s);
  for (const s of n)
    e.set(s.name, s);
  return e;
}
u(le, "buildEvaluatorRegistry");
function at(n, t) {
  const e = n.get(t.name);
  if (e === void 0)
    throw new Error(`Unknown evaluator: ${t.name}. Register it via customEvaluatorTypes.`);
  return t.arguments === null || t.arguments === void 0 ? new e(void 0) : Array.isArray(t.arguments) ? new e(t.arguments[0]) : new e(t.arguments);
}
u(at, "instantiateFromRegistry");
function an(n, t) {
  for (const e of t)
    if ("gen_ai.request.model" in e.attributes)
      for (const [s, r] of Object.entries(e.attributes))
        if (s === "gen_ai.operation.name" && r === "chat")
          n.incrementMetric("requests", 1);
        else {
          if (typeof r != "number")
            continue;
          s === "operation.cost" ? n.incrementMetric("cost", r) : s.startsWith("gen_ai.usage.details.") ? n.incrementMetric(s.slice(21), r) : s.startsWith("gen_ai.usage.") && n.incrementMetric(s.slice(13), r);
        }
}
u(an, "extractSpanTreeMetrics");
async function on(n, t) {
  const e = new bt();
  if (L.getStore() !== void 0)
    throw new Error("A task run has already been entered. Task runs should not be nested");
  let s = new D("not-started"), r, a;
  return await L.run(e, async () => {
    await tt("execute {task}", { task: Et(n) }, async () => {
      await ve(async (i) => {
        const o = performance.now();
        r = await Promise.resolve(n(t.inputs)), a = (performance.now() - o) / 1e3, await new Promise((d) => setImmediate(d)), s = i();
      });
    });
  }), s instanceof H && an(e, s), new Q({
    attributes: e.attributes,
    duration: a,
    expectedOutput: t.expectedOutput,
    inputs: t.inputs,
    metadata: t.metadata,
    metrics: e.metrics,
    name: t.name,
    output: r,
    spanTree: s
  });
}
u(on, "runTask");
async function un(n, t, e, s, r, a) {
  return await tt(
    "case: {case_name}",
    {
      case_name: e,
      expected_output: t.expectedOutput,
      inputs: t.inputs,
      metadata: t.metadata,
      task_name: Et(n),
      ...r !== null ? { "logfire.experiment.source_case_name": r } : {}
    },
    async (i) => {
      const o = await ln(n, t, e, s, r, a);
      return "output" in o && (i.setAttribute("output", F(o.output)), i.setAttribute("task_duration", o.taskDuration), i.setAttribute("metrics", F(o.metrics)), i.setAttribute("attributes", F(o.attributes)), i.setAttribute("assertions", F(o.assertions)), i.setAttribute("scores", F(o.scores)), i.setAttribute("labels", F(o.labels))), o;
    }
  );
}
u(un, "runTaskAndEvaluators");
function F(n) {
  try {
    return JSON.stringify(n);
  } catch {
    return String(n);
  }
}
u(F, "normalizeForAttribute");
async function ln(n, t, e, s, r, a) {
  const i = performance.now();
  let o = null, d;
  try {
    a !== null && (o = new a(t), await o.setup());
    let h = await on(n, t);
    o !== null && (h = await o.prepareContext(h));
    const c = [...t.evaluators, ...s], m = [], v = [];
    if (c.length > 0) {
      const _ = await Promise.all(
        c.map((S) => At(S, h))
      );
      for (const S of _)
        Array.isArray(S) ? m.push(...S) : v.push(S);
    }
    const { assertions: f, labels: p, scores: y } = cn(m);
    d = {
      assertions: f,
      attributes: h.attributes,
      evaluatorFailures: v,
      expectedOutput: t.expectedOutput,
      inputs: t.inputs,
      labels: p,
      metadata: t.metadata,
      metrics: h.metrics,
      name: e,
      output: h.output,
      scores: y,
      sourceCaseName: r,
      spanId: null,
      taskDuration: h.duration,
      totalDuration: (performance.now() - i) / 1e3,
      traceId: null
    };
  } catch (h) {
    const c = h;
    d = {
      errorMessage: `${c.name}: ${c.message}`,
      errorStacktrace: c.stack ?? String(h),
      expectedOutput: t.expectedOutput,
      inputs: t.inputs,
      metadata: t.metadata,
      name: e,
      sourceCaseName: r,
      spanId: null,
      traceId: null
    };
  }
  return o !== null && await o.teardown(d), "output" in d && (d.totalDuration = (performance.now() - i) / 1e3), d;
}
u(ln, "runTaskAndEvaluatorsInner");
function cn(n) {
  const t = {}, e = {}, s = {}, r = /* @__PURE__ */ new Set();
  for (const a of n) {
    let i = a.name;
    if (r.has(i)) {
      let o = 2;
      for (; r.has(`${i}_${String(o)}`); ) o++;
      i = `${i}_${String(o)}`;
    }
    r.add(i), typeof a.value == "boolean" ? t[i] = a : typeof a.value == "number" ? e[i] = a : typeof a.value == "string" && (s[i] = a);
  }
  return { assertions: t, labels: s, scores: e };
}
u(cn, "groupEvaluatorOutputs");
async function fn(n, t, e) {
  for (const s of n)
    try {
      const r = await s.evaluateAsync(t);
      Array.isArray(r) ? e.analyses.push(...r) : e.analyses.push(r);
    } catch (r) {
      const a = r;
      e.reportEvaluatorFailures.push({
        errorMessage: `${a.name}: ${a.message}`,
        errorStacktrace: a.stack ?? String(r),
        name: s.getSerializationName(),
        source: s.asSpec()
      });
    }
}
u(fn, "runReportEvaluators");
async function An(n) {
  const t = n.nExamples ?? 3, s = (await n.generator({ extraInstructions: n.extraInstructions, nExamples: t })).cases.map(
    (r) => new B({
      expectedOutput: r.expectedOutput ?? null,
      inputs: r.inputs,
      metadata: r.metadata ?? null,
      name: r.name ?? null
    })
  );
  return new St({ cases: s, name: n.name ?? "generated" });
}
u(An, "generateDataset");
const Wt = class Wt {
  constructor(t) {
    l(this, "case");
    this.case = t;
  }
  async prepareContext(t) {
    return await Promise.resolve(t);
  }
  async setup() {
    await Promise.resolve();
  }
  async teardown(t) {
    await Promise.resolve();
  }
};
u(Wt, "CaseLifecycle");
let ce = Wt;
const Ht = class Ht {
  constructor(t) {
    l(this, "callback");
    this.callback = t;
  }
  async submit(t) {
    const e = this.callback(t.results, t.failures, t.context);
    e instanceof Promise && await e;
  }
};
u(Ht, "CallbackSink");
let Z = Ht;
function fe(n) {
  return n !== null && typeof n == "object" && "submit" in n && typeof n.submit == "function";
}
u(fe, "isEvaluationSink");
function dn(n) {
  return n === null ? [] : Array.isArray(n) ? n.map((t) => fe(t) ? t : new Z(t)) : fe(n) ? [n] : [new Z(n)];
}
u(dn, "normalizeSink");
const Yt = class Yt {
  constructor(t) {
    l(this, "evaluator");
    l(this, "maxConcurrency");
    l(this, "onError");
    l(this, "onMaxConcurrency");
    l(this, "onSamplingError");
    l(this, "sampleRate");
    l(this, "sink");
    l(this, "currentCount", 0);
    this.evaluator = t.evaluator, this.sampleRate = t.sampleRate ?? null, this.maxConcurrency = t.maxConcurrency ?? 10, this.sink = t.sink ?? null, this.onMaxConcurrency = t.onMaxConcurrency ?? null, this.onSamplingError = t.onSamplingError ?? null, this.onError = t.onError ?? null;
  }
  acquire() {
    return this.currentCount >= this.maxConcurrency ? !1 : (this.currentCount++, !0);
  }
  release() {
    this.currentCount--;
  }
};
u(Yt, "OnlineEvaluator");
let V = Yt;
const q = /* @__PURE__ */ new Set();
let P = 0;
function En(n) {
  P++;
  try {
    const t = n();
    return t instanceof Promise ? t.finally(() => {
      P--;
    }) : (P--, t);
  } catch (t) {
    throw P--, t;
  }
}
u(En, "disableEvaluation");
async function $n() {
  for (; q.size > 0; )
    await Promise.all(Array.from(q));
}
u($n, "waitForEvaluations");
const Xt = class Xt {
  constructor(t = {}) {
    l(this, "defaultSampleRate");
    l(this, "defaultSink");
    l(this, "enabled");
    l(this, "metadata");
    l(this, "onError");
    l(this, "onMaxConcurrency");
    l(this, "onSamplingError");
    l(this, "samplingMode");
    this.defaultSink = t.defaultSink ?? null, this.defaultSampleRate = t.defaultSampleRate ?? 1, this.samplingMode = t.samplingMode ?? "independent", this.enabled = t.enabled ?? !0, this.metadata = t.metadata ?? null, this.onMaxConcurrency = t.onMaxConcurrency ?? null, this.onSamplingError = t.onSamplingError ?? null, this.onError = t.onError ?? null;
  }
  evaluate(...t) {
    const e = t.map((s) => s instanceof V ? s : new V({ evaluator: s }));
    return (s) => /* @__PURE__ */ u(((...a) => !this.enabled || P > 0 || rn() !== null ? s(...a) : this.runWrapped(s, e, a)), "wrapped");
  }
  dispatchEvaluator(t, e, s, r) {
    const a = t.onMaxConcurrency ?? this.onMaxConcurrency, i = t.onError ?? this.onError;
    return t.acquire() ? (/* @__PURE__ */ u(async () => {
      try {
        const d = await At(t.evaluator, e), h = Array.isArray(d) ? d : [], c = Array.isArray(d) ? [] : [d];
        await Promise.all(
          r.map(async (m) => {
            try {
              await m.submit({ context: e, failures: c, results: h, spanReference: s });
            } catch (v) {
              await de(i, v, e, t.evaluator, "sink");
            }
          })
        );
      } finally {
        t.release();
      }
    }, "work"))() : a !== null ? (/* @__PURE__ */ u(async () => {
      try {
        const h = a(e);
        h instanceof Promise && await h;
      } catch (h) {
        await de(i, h, e, t.evaluator, "on_max_concurrency");
      }
    }, "callAndCatch"))() : Promise.resolve();
  }
  async runWrapped(t, e, s) {
    const r = Array.from(s), a = Math.random(), i = [];
    for (const p of e) {
      const y = p.sampleRate ?? this.defaultSampleRate, _ = { callSeed: a, evaluator: p.evaluator, inputs: r, metadata: this.metadata };
      try {
        const S = typeof y == "function" ? y(_) : y;
        this.shouldEvaluate(S, _) && i.push(p);
      } catch (S) {
        const A = p.onSamplingError ?? this.onSamplingError;
        if (A !== null)
          try {
            A(S, p.evaluator);
          } catch {
          }
        else
          throw S;
      }
    }
    if (i.length === 0) return await Promise.resolve(t(...s));
    let o, d, h = new D("not-captured");
    await ve(async (p) => {
      const y = performance.now();
      o = await Promise.resolve(t(...s)), d = (performance.now() - y) / 1e3, h = p();
    });
    const c = new Q({
      attributes: {},
      duration: d,
      expectedOutput: null,
      inputs: r,
      metadata: this.metadata,
      metrics: {},
      name: null,
      output: o,
      spanTree: h
    }), m = null, f = (/* @__PURE__ */ u(async () => {
      await Promise.all(
        i.map((p) => {
          const y = dn(p.sink ?? this.defaultSink);
          return y.length === 0 ? Promise.resolve() : this.dispatchEvaluator(p, c, m, y);
        })
      );
    }, "dispatch"))();
    return q.add(f), f.finally(() => q.delete(f)), o;
  }
  shouldEvaluate(t, e) {
    return !this.enabled || P > 0 ? !1 : typeof t == "boolean" ? t : t >= 1 ? !0 : t <= 0 ? !1 : this.samplingMode === "correlated" ? e.callSeed < t : Math.random() < t;
  }
};
u(Xt, "OnlineEvalConfig");
let wt = Xt;
async function de(n, t, e, s, r) {
  if (n !== null)
    try {
      const a = n(t, e, s, r);
      a instanceof Promise && await a;
    } catch {
    }
}
u(de, "callOnError");
const $ = new wt();
function Tn(...n) {
  return $.evaluate(...n);
}
u(Tn, "evaluate");
function On(n) {
  n.defaultSink !== void 0 && ($.defaultSink = n.defaultSink), n.defaultSampleRate !== void 0 && ($.defaultSampleRate = n.defaultSampleRate), n.samplingMode !== void 0 && ($.samplingMode = n.samplingMode), n.enabled !== void 0 && ($.enabled = n.enabled), n.metadata !== void 0 && ($.metadata = n.metadata), n.onMaxConcurrency !== void 0 && ($.onMaxConcurrency = n.onMaxConcurrency), n.onSamplingError !== void 0 && ($.onSamplingError = n.onSamplingError), n.onError !== void 0 && ($.onError = n.onError);
}
u(On, "configure");
async function Dn(n, t) {
  const e = [], s = [], r = await Promise.all(n.map((a) => At(a, t)));
  for (const a of r)
    Array.isArray(a) ? e.push(...a) : s.push(a);
  return { failures: s, results: e };
}
u(Dn, "runEvaluators");
export {
  Z as CallbackSink,
  B as Case,
  ce as CaseLifecycle,
  ht as ConfusionMatrixEvaluator,
  ut as Contains,
  $ as DEFAULT_CONFIG,
  Oe as DEFAULT_EVALUATORS,
  Me as DEFAULT_REPORT_EVALUATORS,
  St as Dataset,
  it as Equals,
  ot as EqualsExpected,
  yt as EvaluationReport,
  T as Evaluator,
  Q as EvaluatorContext,
  dt as HasMatchingSpan,
  lt as IsInstance,
  gt as KolmogorovSmirnovEvaluator,
  ft as LLMJudge,
  ct as MaxDuration,
  wt as OnlineEvalConfig,
  V as OnlineEvaluator,
  pt as PrecisionRecallEvaluator,
  oe as PydanticEvalsDeprecationWarning,
  mt as ROCAUCEvaluator,
  R as ReportEvaluator,
  vt as SpanNode,
  H as SpanTree,
  D as SpanTreeRecordingError,
  ie as aggregateAverage,
  Xe as aggregateAverageFromAggregates,
  On as configure,
  N as defaultRenderDuration,
  wn as defaultRenderDurationDiff,
  U as defaultRenderNumber,
  Sn as defaultRenderNumberDiff,
  re as defaultRenderPercentage,
  En as disableEvaluation,
  gn as downcastEvaluationResult,
  O as evaluationReason,
  An as generateDataset,
  rn as getCurrentTaskRun,
  yn as getDefaultJudgeFn,
  bn as getSpanTreeProcessor,
  xn as incrementEvalMetric,
  he as isEvaluationReason,
  Tn as onlineEvaluate,
  nt as parseEvaluatorSpec,
  At as runEvaluator,
  Dn as runEvaluators,
  st as serializeEvaluatorSpec,
  vn as setDefaultJudgeFn,
  _n as setEvalAttribute,
  $n as waitForEvaluations
};
