"use strict";
var kuinetic = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/index.ts
  var src_exports = {};
  __export(src_exports, {
    ATTR: () => ATTR,
    Animator: () => Animator,
    CHANNEL: () => CHANNEL,
    COMBOS: () => COMBOS,
    PRESETS: () => PRESETS,
    PRIMITIVES: () => PRIMITIVES,
    Registry: () => Registry,
    collectingReporter: () => collectingReporter,
    consoleReporter: () => consoleReporter,
    createActivationBinder: () => createActivationBinder,
    createAnimator: () => createAnimator,
    createRegistry: () => createRegistry,
    default: () => src_default,
    detect: () => detect,
    inertInstance: () => inertInstance,
    kuinetic: () => kuinetic,
    play: () => play,
    resolveTargets: () => resolveTargets,
    silentReporter: () => silentReporter,
    toAttributeValue: () => toAttributeValue
  });

  // src/core/attrs.ts
  var ATTR = {
    /** Authored. The rich grammar. */
    source: "data-kui",
    /** Library-owned and unstable: normalized effect names, for CSS hooks and debugging. */
    normalized: "data-kui-fx",
    state: "data-kui-state",
    on: "data-kui-on",
    timeline: "data-kui-timeline",
    threshold: "data-kui-threshold",
    stagger: "data-kui-stagger",
    cloak: "data-kui-cloak",
    /** Reduced-motion policy, stamped from the primitive so the CSS layer can act on it. */
    rm: "data-kui-rm"
  };

  // src/core/element-config.ts
  var ACTIVATIONS = /* @__PURE__ */ new Set(["load", "enter", "hover", "focus", "click", "manual"]);
  var TIMELINES = /* @__PURE__ */ new Set(["time", "view", "scroll", "pointer", "pin"]);
  function readAttributes(el) {
    return {
      source: el.getAttribute(ATTR.source) ?? "",
      on: el.getAttribute(ATTR.on),
      timeline: el.getAttribute(ATTR.timeline),
      threshold: el.getAttribute(ATTR.threshold)
    };
  }
  function resolveConfig(attributes, parsed) {
    const rawTimeline = parsed.timeline ?? attributes.timeline ?? "time";
    const [head = "time", ...rest] = rawTimeline.trim().split(/\s+/);
    const authored = parsed.activation ?? readActivation(attributes.on);
    return {
      activation: authored ?? "enter",
      activationAuthored: authored !== void 0,
      timeline: TIMELINES.has(head) ? head : "time",
      range: rest.join(" "),
      threshold: parsed.threshold ?? attributes.threshold ?? "0%"
    };
  }
  function readActivation(attribute) {
    return attribute && ACTIVATIONS.has(attribute) ? attribute : void 0;
  }
  function toThresholdRatio(raw) {
    const value = Number.parseFloat(raw);
    if (Number.isNaN(value)) return 0;
    const ratio = raw.includes("%") ? value / 100 : value;
    return Math.min(1, Math.max(0, ratio));
  }

  // src/core/activation.ts
  var NOOP = () => {
  };
  var ACTIVATION_EVENTS = {
    load: [],
    enter: [],
    manual: [],
    hover: ["pointerenter", "focusin"],
    focus: ["focusin"],
    click: ["click"]
  };
  function createActivationBinder(options = {}) {
    const observers = /* @__PURE__ */ new Map();
    const callbacks = /* @__PURE__ */ new WeakMap();
    const createObserver = options.createObserver ?? defaultObserverFactory();
    function observerFor(threshold) {
      if (!createObserver) return void 0;
      const ratio = toThresholdRatio(threshold);
      const key = String(ratio);
      const existing = observers.get(key);
      if (existing) return { key, shared: existing };
      const observer = createObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const binding = callbacks.get(entry.target);
            binding?.activate();
            binding?.release();
          }
        },
        { threshold: ratio }
      );
      const shared = { observer, count: 0 };
      observers.set(key, shared);
      return { key, shared };
    }
    function bindObserved(el, threshold, onActivate) {
      const binding = observerFor(threshold);
      if (!binding) {
        onActivate();
        return NOOP;
      }
      const { key, shared } = binding;
      let active = true;
      const release = () => {
        if (!active) return;
        active = false;
        callbacks.delete(el);
        shared.observer.unobserve(el);
        shared.count--;
        if (shared.count > 0) return;
        shared.observer.disconnect();
        observers.delete(key);
      };
      callbacks.set(el, { activate: onActivate, release });
      shared.count++;
      shared.observer.observe(el);
      return release;
    }
    function bindEvents(el, activation, onActivate) {
      const types = ACTIVATION_EVENTS[activation];
      if (types.length === 0) return NOOP;
      const handler = () => onActivate();
      for (const type of types) el.addEventListener(type, handler, { passive: true });
      return () => {
        for (const type of types) el.removeEventListener(type, handler);
      };
    }
    return {
      bind(el, activation, threshold, onActivate) {
        if (activation === "load") {
          onActivate();
          return NOOP;
        }
        if (activation === "enter") return bindObserved(el, threshold, onActivate);
        return bindEvents(el, activation, onActivate);
      },
      destroy() {
        for (const { observer } of observers.values()) observer.disconnect();
        observers.clear();
      }
    };
  }
  function defaultObserverFactory() {
    if (typeof IntersectionObserver === "undefined") return void 0;
    return (callback, init) => new IntersectionObserver(callback, init);
  }

  // src/core/capabilities.ts
  function supports(property, value) {
    if (typeof CSS === "undefined" || typeof CSS.supports !== "function") return false;
    try {
      return CSS.supports(property, value);
    } catch {
      return false;
    }
  }
  var cached;
  function detect(force = false) {
    if (cached && !force) return cached;
    cached = {
      viewTimeline: supports("animation-timeline", "view()"),
      scrollTimeline: supports("animation-timeline", "scroll()"),
      animationRange: supports("animation-range", "entry 0% cover 30%"),
      // `translate`/`rotate`/`scale` as independent properties is what makes the channel model
      // possible at all — under the `transform` shorthand every effect would collide.
      individualTransforms: supports("translate", "0 10px") && supports("scale", "1.1"),
      scrollTimelineName: supports("scroll-timeline-name", "--x"),
      viewTransitions: typeof document !== "undefined" && "startViewTransition" in document,
      intersectionObserver: typeof IntersectionObserver !== "undefined",
      reducedMotion: typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches
    };
    return cached;
  }

  // src/core/channels.ts
  function findConflicts(claims) {
    const conflicts = [];
    const seen = /* @__PURE__ */ new Map();
    for (const claim of claims) {
      for (const channel of claim.channels) {
        const owner = seen.get(channel);
        if (owner === void 0) {
          seen.set(channel, claim.name);
          continue;
        }
        conflicts.push({ channel, effects: [owner, claim.name] });
      }
    }
    return conflicts;
  }
  function describeConflicts(conflicts) {
    return conflicts.map((c) => `"${c.effects[0]}" and "${c.effects[1]}" both animate ${c.channel}`).join("; ");
  }

  // src/core/params.ts
  var DANGEROUS = /[;<]|\/\*|url\s*\(|expression\s*\(|@import|image-set\s*\(/i;
  var ABSOLUTE_OR_PROTOCOL_RELATIVE = /^(?:[a-z][a-z0-9+.-]*:|[/\\]{2})/i;
  var MAX_VALUE_LENGTH = 200;
  var NUM = String.raw`-?(?:\d+(?:\.\d+)?|\.\d+)`;
  var LENGTH_UNITS = "px|rem|em|vh|vw|vmin|vmax|ch|ex|cm|mm|in|pt|pc|q|%";
  var PATTERNS = {
    length: new RegExp(`^(?:0|${NUM}(?:${LENGTH_UNITS}))$`, "i"),
    time: new RegExp(`^${NUM}(?:ms|s)$`, "i"),
    number: new RegExp(`^${NUM}$`),
    percentage: new RegExp(`^${NUM}%$`),
    angle: new RegExp(`^${NUM}(?:deg|rad|turn|grad)$`, "i")
  };
  var HEX_COLOR = /^#[0-9a-f]{3,8}$/i;
  var COLOR_FUNCTIONS = /^(?:rgba?|hsla?|okl(?:ch|ab)|l(?:ch|ab)|color)\([^()]*\)$/i;
  var COLOR_KEYWORD = /^[a-z]+$/i;
  var EASING_KEYWORD = /^(?:linear|ease|step-start|step-end|spring|bounce|[a-z]+-(?:in|out|in-out))$/i;
  var EASING_FUNCTION = /^(?:cubic-bezier|steps|linear)\([^()]*\)$/i;
  var CALC_TYPES = /* @__PURE__ */ new Set(["length", "percentage", "number"]);
  var CALC_CHARACTER = /^[\d.\s+\-*/%a-z,]$/i;
  var CUSTOM_PROPERTY_NAME = /^--[\w-]+$/;
  function validate(raw, spec) {
    const value = raw.trim();
    const rejection = screen(value, spec);
    if (rejection) return rejection;
    if (spec.type === "keyword") return checkKeyword(value, spec);
    if (spec.type === "text") return { value, ok: true };
    if (isAcceptable(value, spec.type)) return checkNumericConstraints(value, spec);
    return reject(spec, `not a valid ${spec.type}`);
  }
  function screen(value, spec) {
    if (!value) return reject(spec, "empty value");
    if (value.length > MAX_VALUE_LENGTH) {
      return reject(spec, `value exceeds ${MAX_VALUE_LENGTH} characters`);
    }
    if (DANGEROUS.test(value)) return reject(spec, "value contains disallowed CSS syntax");
    return null;
  }
  function isAcceptable(value, type) {
    if (type === "color") return isColor(value);
    if (type === "easing") return EASING_KEYWORD.test(value) || EASING_FUNCTION.test(value);
    const pattern = PATTERNS[type];
    if (!pattern) return false;
    if (pattern.test(value)) return true;
    return CALC_TYPES.has(type) && isSafeCalc(value) && isWellFormedCalc(value);
  }
  function isColor(value) {
    return HEX_COLOR.test(value) || COLOR_FUNCTIONS.test(value) || COLOR_KEYWORD.test(value);
  }
  function checkKeyword(value, spec) {
    if (spec.values?.includes(value)) return { value, ok: true };
    return reject(spec, `expected one of ${spec.values?.join(", ") ?? "(none declared)"}`);
  }
  function isSameOriginPath(value) {
    return !ABSOLUTE_OR_PROTOCOL_RELATIVE.test(value);
  }
  function checkNumericConstraints(value, spec) {
    if (spec.type !== "number") return { value, ok: true };
    const numeric = Number(value);
    if (spec.finite && !Number.isFinite(numeric)) return reject(spec, "expected a finite number");
    if (spec.integer && !Number.isInteger(numeric)) return reject(spec, "expected an integer");
    if (spec.minimum !== void 0 && numeric < spec.minimum) {
      return reject(spec, `expected at least ${spec.minimum}`);
    }
    if (spec.maximum !== void 0 && numeric > spec.maximum) {
      return reject(spec, `expected at most ${spec.maximum}`);
    }
    return { value, ok: true };
  }
  function reject(spec, reason) {
    return { value: spec.default, ok: false, reason };
  }
  function isSafeCalc(value) {
    if (!value.startsWith("calc(") || !value.endsWith(")")) return false;
    const end = value.length - 1;
    let index = "calc(".length;
    while (index < end) {
      index = nextCalcToken(value, index, end);
      if (index < 0) return false;
    }
    return true;
  }
  function nextCalcToken(value, index, end) {
    if (value.startsWith("var(", index)) return consumeVar(value, index, end);
    return CALC_CHARACTER.test(value[index]) ? index + 1 : -1;
  }
  function consumeVar(value, start, end) {
    const close = value.indexOf(")", start + "var(".length);
    if (close < 0 || close >= end) return -1;
    const name = value.slice(start + "var(".length, close);
    return CUSTOM_PROPERTY_NAME.test(name) ? close + 1 : -1;
  }
  function isWellFormedCalc(value) {
    const body = value.slice("calc(".length, -1).trim();
    return body !== "" && !/[+\-*/]$/.test(body);
  }
  function resolveParams(authored, schema, warn) {
    const out = {};
    for (const [key, raw] of Object.entries(authored)) {
      const spec = Object.hasOwn(schema, key) ? schema[key] : void 0;
      if (!spec) {
        warn(`unknown parameter "${key}" (known: ${Object.keys(schema).join(", ") || "none"})`);
        continue;
      }
      if (spec.type === "text") continue;
      const result = validate(raw, spec);
      if (result.ok) out[spec.cssProperty] = result.value;
      else warn(`parameter "${key}": ${result.reason} \u2014 got "${raw}", using default "${spec.default}"`);
    }
    return out;
  }

  // src/core/registry.ts
  var Registry = class {
    primitives = /* @__PURE__ */ new Map();
    presets = /* @__PURE__ */ new Map();
    /** Sorted-name key → preset that renders that combination as one tested keyframe. */
    combos = /* @__PURE__ */ new Map();
    registerPrimitive(primitive) {
      if (this.primitives.has(primitive.id)) {
        throw new Error(`kuinetic: primitive "${primitive.id}" is already registered`);
      }
      this.primitives.set(primitive.id, namespaceTiming(primitive));
      return this;
    }
    registerPreset(preset) {
      if (this.presets.has(preset.name)) {
        throw new Error(`kuinetic: effect "${preset.name}" is already registered`);
      }
      if (!this.primitives.has(preset.primitive)) {
        throw new Error(
          `kuinetic: effect "${preset.name}" references unknown primitive "${preset.primitive}"`
        );
      }
      this.presets.set(preset.name, preset);
      return this;
    }
    registerPresets(presets) {
      for (const preset of presets) this.registerPreset(preset);
      return this;
    }
    registerPrimitives(primitives) {
      for (const primitive of primitives) this.registerPrimitive(primitive);
      return this;
    }
    /**
     * Declare that a set of effect names has a purpose-built single-keyframe implementation.
     * Checked before channel conflict analysis, so `fade-up` + `blur-in` can resolve to the
     * tested `fade-blur-up` rather than being rejected for both writing `opacity`.
     */
    registerCombo(names, presetName) {
      this.combos.set(comboKey(names), presetName);
      return this;
    }
    resolve(name) {
      const preset = this.presets.get(name);
      if (!preset) return void 0;
      const primitive = this.primitives.get(preset.primitive);
      return { preset, primitive };
    }
    findCombo(names) {
      const comboName = this.combos.get(comboKey(names));
      return comboName ? this.resolve(comboName) : void 0;
    }
    has(name) {
      return this.presets.has(name);
    }
    /** All registered effect names, for docs generation and dev-mode "did you mean" hints. */
    names() {
      return [...this.presets.keys()].sort((a, b) => a.localeCompare(b));
    }
    getPrimitive(id) {
      return this.primitives.get(id);
    }
  };
  var TIMING_PARAMS = ["duration", "delay", "ease"];
  function timingProperty(primitiveId, name) {
    return `--kui-${primitiveId}-${name}`;
  }
  function namespaceTiming(primitive) {
    const parameters = { ...primitive.parameters };
    for (const name of TIMING_PARAMS) {
      const spec = parameters[name];
      if (spec) parameters[name] = { ...spec, cssProperty: timingProperty(primitive.id, name) };
    }
    return { ...primitive, parameters };
  }
  function comboKey(names) {
    return [...names].sort((a, b) => a.localeCompare(b)).join("+");
  }
  function suggest(name, candidates) {
    let best;
    let bestScore = Infinity;
    for (const candidate of candidates) {
      const score = distance(name, candidate);
      if (score < bestScore) {
        bestScore = score;
        best = candidate;
      }
    }
    return bestScore <= Math.max(2, Math.floor(name.length / 3)) ? best : void 0;
  }
  function distance(a, b) {
    const rows = a.length + 1;
    const cols = b.length + 1;
    let prev = Array.from({ length: cols }, (_, i) => i);
    for (let i = 1; i < rows; i++) {
      const curr = [i, ...Array(cols - 1).fill(0)];
      for (let j = 1; j < cols; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
      }
      prev = curr;
    }
    return prev[cols - 1];
  }

  // src/core/compile.ts
  var NATIVE_EASINGS = /* @__PURE__ */ new Set([
    "linear",
    "ease",
    "ease-in",
    "ease-out",
    "ease-in-out",
    "step-start",
    "step-end"
  ]);
  var RM_RANK = { shorten: 0, crossfade: 1, disable: 2 };
  function compile(parsed, registry, timeline) {
    const warnings = [...parsed.warnings];
    const { entries, unknown } = resolveEntries(parsed.specs, registry, warnings);
    if (entries.length === 0) {
      return emptyPlan(unknown, warnings);
    }
    const composed = resolveComposition(entries, registry, warnings);
    return buildPlan(composed, timeline, unknown, warnings);
  }
  function emptyPlan(unknown, warnings) {
    return {
      fxNames: [],
      vars: {},
      declarations: {},
      jsEffects: [],
      unknown,
      reducedMotion: "shorten",
      supportedActivations: [],
      supportedTimelines: [],
      channels: [],
      warnings
    };
  }
  function resolveEntries(specs, registry, warnings) {
    const entries = [];
    const unknown = [];
    for (const spec of specs) {
      const resolved = registry.resolve(spec.name);
      if (resolved) {
        entries.push({ spec, resolved });
        continue;
      }
      unknown.push(spec.name);
      const hint = suggest(spec.name, registry.names());
      const suffix = hint ? ` \u2014 did you mean "${hint}"?` : "";
      warnings.push(`unknown effect "${spec.name}"${suffix}`);
    }
    return { entries, unknown };
  }
  function resolveComposition(entries, registry, warnings) {
    if (entries.length <= 1) return entries;
    const conflicts = findConflicts(
      entries.map((e) => ({ name: e.spec.name, channels: e.resolved.primitive.channels }))
    );
    if (conflicts.length === 0) return entries;
    const combo = registry.findCombo(entries.map((e) => e.spec.name));
    const remedy = combo ? `Use the "${combo.preset.name}" effect instead.` : "Apply them to nested elements, or register a combined effect.";
    warnings.push(`cannot compose: ${describeConflicts(conflicts)}. ${remedy}`);
    return [entries[0]];
  }
  function buildPlan(entries, timeline, unknown, warnings) {
    const plan = emptyPlan(unknown, warnings);
    const tracks = {
      names: [],
      durations: [],
      delays: [],
      easings: [],
      iterationCounts: []
    };
    const channels = /* @__PURE__ */ new Set();
    let activations;
    let timelines;
    for (const entry of entries) {
      const { preset, primitive } = entry.resolved;
      plan.fxNames.push(preset.name);
      plan.reducedMotion = strictestPolicy(plan.reducedMotion, primitive.reducedMotion);
      plan.defaultActivation ??= primitive.defaultActivation;
      activations = intersect(activations, primitive.supportedActivations);
      timelines = intersect(timelines, primitive.supportedTimelines);
      for (const channel of primitive.channels) channels.add(channel);
      warnUnsupportedTimeline(preset.name, primitive.supportedTimelines, timeline, warnings);
      Object.assign(
        plan.vars,
        resolveParams(entry.spec.params, primitive.parameters, (m) => warnings.push(m))
      );
      if (primitive.renderer === "css-keyframes") pushTrack(tracks, entry, timeline);
      else plan.jsEffects.push(entry);
    }
    Object.assign(plan.declarations, declarationsFor(tracks));
    plan.supportedActivations = activations;
    plan.supportedTimelines = timelines;
    plan.channels = [...channels];
    return plan;
  }
  function intersect(accumulated, supported) {
    if (!accumulated) return [...supported];
    return accumulated.filter((value) => supported.includes(value));
  }
  function iterationCountProperty(presetName) {
    return `--kui-fx-${presetName}-iterations`;
  }
  function pushTrack(tracks, entry, timeline) {
    const { spec, resolved } = entry;
    const id = resolved.primitive.id;
    tracks.names.push(resolved.preset.keyframes ?? `kui-${resolved.preset.name}`);
    const duration = spec.duration ?? `var(${timingProperty(id, "duration")}, 600ms)`;
    tracks.durations.push(duration);
    tracks.delays.push(staggerDelay(spec.delay, id, timeline, duration));
    tracks.easings.push(easingValue(spec.easing, id));
    tracks.iterationCounts.push(`var(${iterationCountProperty(resolved.preset.name)}, 1)`);
  }
  function declarationsFor(tracks) {
    if (tracks.names.length === 0) return {};
    return {
      "animation-name": tracks.names.join(", "),
      "animation-duration": tracks.durations.join(", "),
      "animation-delay": tracks.delays.join(", "),
      "animation-timing-function": tracks.easings.join(", "),
      "animation-iteration-count": tracks.iterationCounts.join(", "),
      "animation-fill-mode": tracks.names.map(() => "both").join(", ")
    };
  }
  function strictestPolicy(a, b) {
    return RM_RANK[b] > RM_RANK[a] ? b : a;
  }
  function warnUnsupportedTimeline(name, supported, timeline, warnings) {
    if (supported.includes(timeline)) return;
    warnings.push(
      `"${name}" does not support timeline "${timeline}" (supports: ${supported.join(", ")})`
    );
  }
  function staggerDelay(delay, primitiveId, timeline, duration) {
    const base = delay ?? `var(${timingProperty(primitiveId, "delay")}, 0ms)`;
    const staggered = `${base} + var(--kui-i, 0) * var(--kui-stagger, 0ms)`;
    if (timeline !== "pin") return `calc(${staggered})`;
    const span = `${duration} + (var(--kui-stagger-count, 1) - 1) * var(--kui-stagger, 0ms)`;
    return `calc(${staggered} - var(--kui-progress, 0) * (${span}))`;
  }
  function easingValue(easing, primitiveId) {
    if (!easing) return `var(${timingProperty(primitiveId, "ease")}, ease-out)`;
    if (NATIVE_EASINGS.has(easing)) return easing;
    if (easing.includes("(")) return easing;
    return `var(--kui-ease-${easing}, ease-out)`;
  }

  // src/core/dom-watcher.ts
  var WORK_BUDGET = 100;
  function createDomWatcher(options) {
    const { root, onElementAdded, onElementRemoved, onAttributeChanged } = options;
    const schedule = options.schedule ?? scheduleFrame;
    const createObserver = options.createObserver ?? defaultObserverFactory2();
    const added = /* @__PURE__ */ new Set();
    const removed = /* @__PURE__ */ new Set();
    const changed = /* @__PURE__ */ new Set();
    let observer;
    let scheduled = false;
    let destroyed = false;
    function collect(record) {
      if (record.type === "attributes") {
        const target = asElement(record.target);
        if (target) changed.add(target);
        return;
      }
      for (const node of record.addedNodes) queueRoot(added, asElement(node));
      for (const node of record.removedNodes) queueRoot(removed, asElement(node));
    }
    function queueWork(records) {
      for (const record of records) collect(record);
      if (scheduled) return;
      scheduled = true;
      schedule(flush);
    }
    function flush() {
      scheduled = false;
      if (destroyed) return;
      let remaining = WORK_BUDGET;
      remaining = drain(removed, onElementRemoved, remaining);
      remaining = drain(added, onElementAdded, remaining);
      drain(changed, onAttributeChanged, remaining);
      if (added.size + removed.size + changed.size > 0) {
        scheduled = true;
        schedule(flush);
      }
    }
    return {
      watch() {
        if (!createObserver) return;
        destroyed = false;
        observer = createObserver(queueWork);
        observer.observe(root, {
          subtree: true,
          childList: true,
          attributes: true,
          attributeFilter: [ATTR.source, ATTR.on, ATTR.timeline, ATTR.threshold]
        });
      },
      destroy() {
        destroyed = true;
        observer?.disconnect();
        added.clear();
        removed.clear();
        changed.clear();
      }
    };
  }
  function queueRoot(roots, candidate) {
    if (!candidate) return;
    for (const root of roots) {
      if (root.contains(candidate)) return;
      if (candidate.contains(root)) roots.delete(root);
    }
    roots.add(candidate);
  }
  function drain(roots, callback, budget) {
    for (const root of roots) {
      if (budget === 0) break;
      roots.delete(root);
      callback(root);
      budget--;
    }
    return budget;
  }
  function asElement(node) {
    return node.nodeType === 1 ? node : null;
  }
  function scheduleFrame(callback) {
    const requestFrame = globalThis.requestAnimationFrame;
    if (typeof requestFrame === "function") requestFrame(() => callback());
    else queueMicrotask(callback);
  }
  function defaultObserverFactory2() {
    if (typeof MutationObserver === "undefined") return void 0;
    return (callback) => new MutationObserver(callback);
  }

  // src/core/js-params.ts
  var ABSOLUTE_BASIS = {
    viewportWidth: 0,
    viewportHeight: 0,
    percentBasis: 0,
    fontSize: 16,
    rootFontSize: 16
  };
  var STATIC_UNITS = {
    px: 1,
    cm: 96 / 2.54,
    mm: 96 / 25.4,
    q: 96 / 101.6,
    in: 96,
    pt: 96 / 72,
    pc: 16
  };
  var BASIS_UNITS = {
    vh: (b) => b.viewportHeight / 100,
    vw: (b) => b.viewportWidth / 100,
    vmin: (b) => Math.min(b.viewportWidth, b.viewportHeight) / 100,
    vmax: (b) => Math.max(b.viewportWidth, b.viewportHeight) / 100,
    "%": (b) => b.percentBasis / 100,
    em: (b) => b.fontSize,
    rem: (b) => b.rootFontSize,
    ch: (b) => b.fontSize * 0.5,
    ex: (b) => b.fontSize * 0.5
  };
  var NUMBER_WITH_UNIT = /^(-?(?:\d+(?:\.\d+)?|\.\d+))([a-z%]*)$/i;
  function readParams(authored, schema, warn) {
    const out = {};
    for (const [name, spec] of Object.entries(schema)) out[name] = spec.default;
    for (const [name, raw] of Object.entries(authored)) {
      const spec = Object.hasOwn(schema, name) ? schema[name] : void 0;
      if (!spec) {
        warn(`unknown parameter "${name}" (known: ${Object.keys(schema).join(", ") || "none"})`);
        continue;
      }
      const result = validate(raw, spec);
      out[name] = result.value;
      if (!result.ok) {
        warn(`parameter "${name}": ${result.reason} \u2014 got "${raw}", using default "${spec.default}"`);
      }
    }
    return out;
  }
  function toMilliseconds(value, fallback = 0) {
    const parts = NUMBER_WITH_UNIT.exec(value.trim());
    if (!parts) return fallback;
    const amount = Number.parseFloat(parts[1]);
    const unit = parts[2].toLowerCase();
    if (unit === "ms") return amount;
    if (unit === "s") return amount * 1e3;
    return fallback;
  }
  function toPixels(value, basis, fallback = 0) {
    const parts = NUMBER_WITH_UNIT.exec(value.trim());
    if (!parts) return fallback;
    const amount = Number.parseFloat(parts[1]);
    const unit = parts[2].toLowerCase();
    if (unit === "") return amount === 0 ? 0 : fallback;
    const staticFactor = STATIC_UNITS[unit];
    if (staticFactor !== void 0) return amount * staticFactor;
    const basisFactor = BASIS_UNITS[unit];
    return basisFactor ? amount * basisFactor(basis) : fallback;
  }
  function toNumber(value, fallback = 0) {
    const parts = NUMBER_WITH_UNIT.exec(value.trim());
    if (!parts) return fallback;
    const amount = Number.parseFloat(parts[1]);
    const unit = parts[2];
    if (unit === "") return amount;
    if (unit === "%") return amount / 100;
    return fallback;
  }
  var EASING_SPEC = { type: "easing", default: "", cssProperty: "--kui-ease" };
  function timingMs(raw, label, warn) {
    if (raw === void 0) return void 0;
    const ms = toMilliseconds(raw, Number.NaN);
    if (Number.isFinite(ms)) return ms;
    warn(`${label} "${raw}" is not a valid time \u2014 ignored`);
    return void 0;
  }
  function timingEasing(raw, warn) {
    if (raw === void 0) return void 0;
    const result = validate(raw, EASING_SPEC);
    if (result.ok) return result.value;
    warn(`easing "${raw}": ${result.reason} \u2014 ignored`);
    return void 0;
  }
  function readEffectTiming(spec, warn) {
    return {
      durationMs: timingMs(spec.duration, "duration", warn),
      delayMs: timingMs(spec.delay, "delay", warn),
      easing: timingEasing(spec.easing, warn)
    };
  }
  function effectDurationMs(params, fallback) {
    return params.timing.durationMs ?? params.ms("duration", fallback);
  }
  function createParams(values, timing3 = {}) {
    return {
      text: (name, fallback = "") => values[name] ?? fallback,
      ms: (name, fallback = 0) => toMilliseconds(values[name] ?? "", fallback),
      num: (name, fallback = 0) => toNumber(values[name] ?? "", fallback),
      is: (name, value = "true") => (values[name] ?? "") === value,
      timing: timing3
    };
  }
  function readEffectParams(authored, schema, warn, timing3 = {}) {
    return createParams(readParams(authored, schema, warn), timing3);
  }

  // src/core/js-effect-preparer.ts
  function createJsEffectPreparer(options) {
    const { scheduler, rootResolver, capabilities, reporter, respectReducedMotion } = options;
    function contextFor(el, signal, ledger) {
      const doc = el.ownerDocument;
      return {
        doc,
        win: doc.defaultView ?? globalThis,
        scheduler,
        rootFor: rootResolver,
        capabilities,
        invalidate: () => scheduler.invalidate(),
        warn: (message) => reporter.warn(message, el),
        reducedMotion: respectReducedMotion && capabilities.reducedMotion,
        signal,
        style: ledger
      };
    }
    return {
      prepare({ el, plan, signal, ledger }) {
        const instances = [];
        if (plan.jsEffects.length === 0) return instances;
        const ctx = contextFor(el, signal, ledger);
        for (const { spec, resolved } of plan.jsEffects) {
          const prepare = resolved.primitive.prepare;
          if (!prepare) continue;
          const warn = (message) => reporter.warn(message, el);
          const params = readEffectParams(
            { ...resolved.preset.params, ...spec.params },
            resolved.primitive.parameters,
            warn,
            readEffectTiming(spec, warn)
          );
          try {
            instances.push(prepare(el, params, ctx));
          } catch (error) {
            reporter.warn(`"${spec.name}" failed to initialise: ${String(error)}`, el);
          }
        }
        return instances;
      }
    };
  }

  // src/core/parse.ts
  var TIME_RE = /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:ms|s)$/;
  var EASING_FUNCTIONS = ["cubic-bezier(", "steps(", "linear("];
  var ACTIVATIONS2 = /* @__PURE__ */ new Set([
    "load",
    "enter",
    "hover",
    "focus",
    "click",
    "manual"
  ]);
  var EASING_KEYWORDS = /* @__PURE__ */ new Set([
    "linear",
    "ease",
    "ease-in",
    "ease-out",
    "ease-in-out",
    "step-start",
    "step-end",
    "expo-in",
    "expo-out",
    "expo-in-out",
    "back-in",
    "back-out",
    "back-in-out",
    "quart-out",
    "circ-out",
    "spring",
    "bounce"
  ]);
  function splitTopLevel(input, delimiter, warnings = []) {
    const parts = [];
    const scanner = { depth: 0, quote: null, escaped: false };
    let buffer = "";
    for (const char of input) {
      if (isSeparator(char, delimiter, scanner)) {
        if (buffer.trim()) parts.push(buffer.trim());
        buffer = "";
        continue;
      }
      buffer += char;
    }
    if (buffer.trim()) parts.push(buffer.trim());
    if (scanner.quote) warnings.push(`unterminated ${scanner.quote} quote in "${input}"`);
    else if (scanner.depth > 0) warnings.push(`unclosed "(" in "${input}"`);
    return parts;
  }
  function isSeparator(char, delimiter, scanner) {
    if (scanner.quote) return advanceQuote(char, scanner);
    if (char === '"' || char === "'") {
      scanner.quote = char;
      return false;
    }
    if (char === "(") scanner.depth++;
    else if (char === ")") scanner.depth = Math.max(0, scanner.depth - 1);
    if (scanner.depth !== 0) return false;
    return delimiter === " " ? /\s/.test(char) : char === delimiter;
  }
  function advanceQuote(char, scanner) {
    if (scanner.escaped) scanner.escaped = false;
    else if (char === "\\") scanner.escaped = true;
    else if (char === scanner.quote) scanner.quote = null;
    return false;
  }
  function splitPair(token) {
    let depth = 0;
    for (let i = 0; i < token.length; i++) {
      const char = token[i];
      if (char === "(") depth++;
      else if (char === ")") depth = Math.max(0, depth - 1);
      else if (char === ":" && depth === 0) {
        const key = token.slice(0, i).trim();
        const value = unquote(token.slice(i + 1).trim());
        return key && value ? [key, value] : null;
      }
    }
    return null;
  }
  function unquote(value) {
    const first = value[0];
    if ((first === '"' || first === "'") && value.endsWith(first) && value.length > 1) {
      return value.slice(1, -1).replaceAll(`\\${first}`, first);
    }
    return value;
  }
  function classify(token) {
    const pair = splitPair(token);
    if (pair) return { kind: "pair", key: pair[0], value: pair[1] };
    if (TIME_RE.test(token)) return { kind: "time", value: token };
    if (isEasing(token)) return { kind: "easing", value: token };
    return { kind: "unknown", value: token };
  }
  function isEasing(token) {
    if (EASING_KEYWORDS.has(token)) return true;
    return EASING_FUNCTIONS.some((fn) => token.startsWith(fn) && token.endsWith(")"));
  }
  function parse(input) {
    const result = { specs: [], warnings: [] };
    for (const segment of splitTopLevel(input ?? "", ",", result.warnings)) {
      const spec = parseSegment(segment, result);
      if (spec) result.specs.push(spec);
    }
    return result;
  }
  function parseSegment(segment, result) {
    const tokens = splitTopLevel(segment, " ", result.warnings);
    const name = tokens.shift();
    if (splitPair(name)) {
      result.warnings.push(`effect name expected, got "${name}"`);
      return null;
    }
    const spec = { name, params: {} };
    let timeCount = 0;
    for (const raw of tokens) {
      const token = classify(raw);
      if (token.kind === "time") timeCount = applyTime(spec, token.value, timeCount, result.warnings);
      else applyToken(token, spec, segment, result);
    }
    return spec;
  }
  function applyTime(spec, value, seen, warnings) {
    if (seen === 0) spec.duration = value;
    else if (seen === 1) spec.delay = value;
    else warnings.push(`third time value "${value}" ignored (expected duration then delay)`);
    return seen + 1;
  }
  function applyToken(token, spec, segment, result) {
    if (token.kind === "easing") {
      if (spec.easing) result.warnings.push(`duplicate easing "${token.value}" in "${segment}"`);
      spec.easing = token.value;
      return;
    }
    if (token.kind === "unknown") {
      result.warnings.push(
        `unrecognised token "${token.value}" in "${segment}" \u2014 expected [duration] [delay] [easing] or key:value`
      );
      return;
    }
    if (Object.hasOwn(HOISTS, token.key)) {
      HOISTS[token.key](result, token.value);
      return;
    }
    if (token.key in spec.params) {
      result.warnings.push(`duplicate parameter "${token.key}" in "${segment}"`);
    }
    spec.params[token.key] = token.value;
  }
  var HOISTS = {
    on(result, value) {
      if (!ACTIVATIONS2.has(value)) {
        result.warnings.push(`unknown activation "${value}"`);
        return;
      }
      assignOnce(result, "activation", value, "activations");
    },
    timeline(result, value) {
      assignOnce(result, "timeline", value, "timelines");
    },
    threshold(result, value) {
      assignOnce(result, "threshold", value, "thresholds");
    }
  };
  function assignOnce(result, key, value, label) {
    const current = result[key];
    if (current === void 0) {
      result[key] = value;
      return;
    }
    if (current !== value) {
      result.warnings.push(`conflicting ${label} "${String(current)}" and "${String(value)}"`);
    }
  }

  // src/core/scroll-scheduler.ts
  function defaultDeps() {
    const raf = globalThis.requestAnimationFrame;
    if (typeof raf !== "function") {
      return {
        requestFrame: (callback) => globalThis.setTimeout(callback, 16),
        cancelFrame: (handle) => globalThis.clearTimeout(handle)
      };
    }
    return {
      requestFrame: (callback) => raf(callback),
      cancelFrame: (handle) => globalThis.cancelAnimationFrame(handle)
    };
  }
  function createScrollScheduler(deps = defaultDeps()) {
    const entries = /* @__PURE__ */ new Map();
    let epoch = 0;
    let pending = null;
    function schedule(entry) {
      if (entry) entry.dirty = true;
      else for (const other of entries.values()) other.dirty = true;
      if (pending !== null) return;
      pending = deps.requestFrame(runFrame);
    }
    function runFrame() {
      pending = null;
      for (const entry of entries.values()) {
        if (!entry.dirty || entry.subscribers.size === 0) continue;
        entry.dirty = false;
        const frame = { metrics: entry.root.metrics(), epoch };
        for (const subscriber of [...entry.subscribers]) subscriber(frame);
      }
    }
    function attach(root) {
      const existing = entries.get(root.key);
      if (existing) return existing;
      const entry = { root, subscribers: /* @__PURE__ */ new Set(), detach: [], dirty: false };
      entry.detach.push(root.onScroll(() => schedule(entry)));
      entry.detach.push(
        root.onResize(() => {
          epoch++;
          schedule();
        })
      );
      entries.set(root.key, entry);
      return entry;
    }
    function release(entry) {
      if (entry.subscribers.size > 0) return;
      for (const detach of entry.detach) detach();
      entries.delete(entry.root.key);
    }
    return {
      subscribe(root, onFrame) {
        const entry = attach(root);
        entry.subscribers.add(onFrame);
        schedule(entry);
        return () => {
          entry.subscribers.delete(onFrame);
          release(entry);
        };
      },
      invalidate() {
        epoch++;
        schedule();
      },
      rootCount: () => entries.size,
      destroy() {
        if (pending !== null) deps.cancelFrame(pending);
        pending = null;
        for (const entry of entries.values()) {
          entry.subscribers.clear();
          for (const detach of entry.detach) detach();
        }
        entries.clear();
      }
    };
  }
  function windowScrollRoot(win) {
    return {
      key: "window",
      metrics: () => ({
        scrollTop: win.scrollY,
        scrollLeft: win.scrollX,
        viewportWidth: win.innerWidth,
        viewportHeight: win.innerHeight,
        viewportTop: 0,
        viewportLeft: 0
      }),
      onScroll: (handler) => listen(win, "scroll", handler),
      /*
       * The document's own height counts as a resize, not just the window's.
       *
       * `elementScrollRoot` has observed its element's size since it was written, for the reason
       * stated three doc comments down: "images loading, fonts swapping, a container changing size,
       * or content being inserted". Every one of those applies at least as strongly to the page
       * itself, and the page root was the one that only listened for `window.resize` — so on any
       * document with lazy-loaded media below the fold, every cached content offset silently drifted
       * by however much the page grew after it was measured, with no epoch bump to correct it.
       *
       * Measured on `demo/scroll.html` (32,000px of lazy screenshots): the horizontal track's stage
       * moved ~840px between page load and reaching it, which is a third of that effect's whole
       * scroll range. Nothing was wrong with the maths; the number it was doing the maths on was
       * taken before forty images existed.
       */
      onResize: (handler) => observeSize(win.document.documentElement, win, handler)
    };
  }
  function elementScrollRoot(el, win) {
    return {
      key: `el:${rootId(el)}`,
      metrics: () => {
        const rect = el.getBoundingClientRect();
        return {
          scrollTop: el.scrollTop,
          scrollLeft: el.scrollLeft,
          viewportWidth: el.clientWidth,
          viewportHeight: el.clientHeight,
          viewportTop: rect.top,
          viewportLeft: rect.left
        };
      },
      onScroll: (handler) => listen(el, "scroll", handler),
      // Window resize alone misses the cases that actually invalidate a nested scroller: images
      // loading, fonts swapping, a container changing size, or content being inserted.
      onResize: (handler) => observeSize(el, win, handler)
    };
  }
  function listen(target, type, handler) {
    target.addEventListener(type, handler, { passive: true });
    return () => target.removeEventListener(type, handler);
  }
  function observeSize(el, win, handler) {
    const stopWindow = listen(win, "resize", handler);
    if (typeof ResizeObserver === "undefined") return stopWindow;
    const observer = new ResizeObserver(handler);
    observer.observe(el);
    return () => {
      stopWindow();
      observer.disconnect();
    };
  }
  var nextRootId = 0;
  var rootIds = /* @__PURE__ */ new WeakMap();
  function rootId(el) {
    const existing = rootIds.get(el);
    if (existing) return existing;
    const id = String(++nextRootId);
    rootIds.set(el, id);
    return id;
  }
  function createRootResolver(options) {
    const { win } = options;
    const isScrollable = options.isScrollable ?? defaultIsScrollable(win);
    const windowRoot = windowScrollRoot(win);
    return (el) => {
      for (let node = el.parentElement; node; node = node.parentElement) {
        if (isScrollable(node)) return elementScrollRoot(node, win);
      }
      return windowRoot;
    };
  }
  var SCROLLABLE_OVERFLOW = /* @__PURE__ */ new Set(["auto", "scroll", "overlay"]);
  function defaultIsScrollable(win) {
    return (el) => {
      const style = win.getComputedStyle(el);
      const vertical = SCROLLABLE_OVERFLOW.has(style.overflowY) && el.scrollHeight > el.clientHeight;
      const horizontal = SCROLLABLE_OVERFLOW.has(style.overflowX) && el.scrollWidth > el.clientWidth;
      return vertical || horizontal;
    };
  }
  function clamp01(value) {
    if (Number.isNaN(value)) return 0;
    return Math.min(1, Math.max(0, value));
  }
  function createMeasureCache(measure) {
    let cachedEpoch = -1;
    let cached2;
    return {
      read(epoch) {
        if (cachedEpoch !== epoch || cached2 === void 0) {
          cached2 = measure();
          cachedEpoch = epoch;
        }
        return cached2;
      },
      clear() {
        cachedEpoch = -1;
        cached2 = void 0;
      }
    };
  }

  // src/core/play.ts
  function resolveTargets(target, root) {
    if (typeof target === "string") return [...root.querySelectorAll(target)];
    if (target instanceof Element) return [target];
    return [...target];
  }
  function time(value) {
    if (value === void 0) return void 0;
    return typeof value === "number" ? `${value}ms` : value;
  }
  var STRUCTURAL_RE = /[\s,()"']/;
  function quoteIfNeeded(value) {
    if (!STRUCTURAL_RE.test(value)) return value;
    const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
    return `"${escaped}"`;
  }
  function hasTopLevelColon(value) {
    let depth = 0;
    for (const char of value) {
      if (char === "(") depth++;
      else if (char === ")") depth = Math.max(0, depth - 1);
      else if (char === ":" && depth === 0) return true;
    }
    return false;
  }
  function assertBareToken(label, value) {
    const warnings = [];
    const bySpace = splitTopLevel(value, " ", warnings);
    const byComma = splitTopLevel(value, ",", warnings);
    const isSingleToken = bySpace.length === 1 && bySpace[0] === value;
    const safe = warnings.length === 0 && isSingleToken && byComma.length === 1 && !hasTopLevelColon(value);
    if (!safe) {
      throw new Error(
        `play(): ${label} "${value}" cannot be serialized \u2014 it contains a space, comma, colon, quote, or unbalanced parenthesis the parser cannot read back as one token`
      );
    }
  }
  function toAttributeValue(effect, options = {}) {
    assertBareToken("effect", effect);
    const { duration, delay, ease, ...rest } = options;
    delete rest.stagger;
    const parts = [effect];
    const resolvedDelay = time(delay);
    const resolvedDuration = time(duration) ?? (resolvedDelay ? "0ms" : void 0);
    if (resolvedDuration) {
      assertBareToken("duration", resolvedDuration);
      parts.push(resolvedDuration);
    }
    if (resolvedDelay) {
      assertBareToken("delay", resolvedDelay);
      parts.push(resolvedDelay);
    }
    if (ease) {
      assertBareToken("easing", ease);
      parts.push(ease);
    }
    for (const [key, value] of Object.entries(rest)) {
      if (value === void 0) continue;
      assertBareToken("parameter name", key);
      parts.push(`${key}:${quoteIfNeeded(String(value))}`);
    }
    return parts.join(" ");
  }
  function play(request, options = {}) {
    const { animator, root, target, effect } = request;
    const elements = resolveTargets(target, root);
    const stagger = time(options.stagger);
    const source = toAttributeValue(effect, options);
    for (const [index, el] of elements.entries()) {
      if (stagger) {
        ;
        el.style.setProperty("--kui-stagger", stagger);
        el.style.setProperty("--kui-i", String(index));
      }
      animator.reset(el);
      if (!el.hasAttribute(ATTR.on)) el.setAttribute(ATTR.on, "manual");
      el.setAttribute(ATTR.source, source);
      animator.process(el);
      animator.activate(el);
    }
    const instancesOf = (el) => animator.stateOf(el)?.instances ?? [];
    const finished = Promise.all(
      elements.flatMap((el) => instancesOf(el).map((instance) => instance.finished))
    ).then(() => void 0);
    return {
      elements,
      finished,
      cancel() {
        for (const el of elements) for (const instance of instancesOf(el)) instance.cancel();
      },
      finish() {
        for (const el of elements) for (const instance of instancesOf(el)) instance.finish();
      }
    };
  }

  // src/core/reporter.ts
  function consoleReporter() {
    return {
      warn(message, subject) {
        if (subject === void 0) console.warn(`[kuinetic] ${message}`);
        else console.warn(`[kuinetic] ${message}`, subject);
      }
    };
  }
  function silentReporter() {
    return { warn() {
    } };
  }
  function collectingReporter() {
    const messages = [];
    return {
      messages,
      warn(message) {
        messages.push(message);
      }
    };
  }

  // src/core/instances.ts
  function animationsOf(el) {
    const getAnimations = el.getAnimations;
    return typeof getAnimations === "function" ? getAnimations.call(el) : [];
  }
  function ownedAnimationsOf(el, names) {
    return animationsOf(el).filter((animation) => {
      const name = animation.animationName;
      return typeof name === "string" && names.has(name);
    });
  }
  function flushComputedAnimationName(el) {
    return getComputedStyle(el).animationName;
  }
  function restartCssAnimation(el, ledger) {
    const name = el.style.getPropertyValue("animation-name");
    ledger.set("animation-name", "none");
    flushComputedAnimationName(el);
    ledger.set("animation-name", name);
  }
  function createCssInstance(el, ledger, animationNames, scrubbed = false) {
    const ownedNames = new Set(animationNames);
    let settle2;
    let finished = new Promise((resolve) => {
      settle2 = resolve;
    });
    let activatedBefore = false;
    function watch(animations) {
      if (animations.length === 0) {
        settle2?.();
        return;
      }
      void Promise.all(animations.map((a) => a.finished.catch(() => void 0))).then(() => settle2?.());
    }
    return {
      activate() {
        finished = new Promise((resolve) => {
          settle2 = resolve;
        });
        if (scrubbed) {
          settle2?.();
          return;
        }
        let animations = ownedAnimationsOf(el, ownedNames);
        if (!activatedBefore) {
          restartCssAnimation(el, ledger);
          ledger.set("animation-play-state", "running");
          animations = ownedAnimationsOf(el, ownedNames);
        } else {
          const stale = animations.filter((a) => a.playState === "finished");
          if (stale.length > 0) {
            for (const animation of stale) animation.reverse();
          } else {
            ledger.set("animation-play-state", "running");
          }
        }
        activatedBefore = true;
        watch(animations);
      },
      cancel() {
        for (const animation of ownedAnimationsOf(el, ownedNames)) animation.cancel();
        settle2?.();
      },
      finish() {
        for (const animation of ownedAnimationsOf(el, ownedNames)) animation.finish();
        settle2?.();
      },
      get finished() {
        return finished;
      },
      destroy() {
        settle2?.();
      }
    };
  }
  function continuousSetup(cleanup) {
    return { cleanup, continuous: true };
  }
  function cleanupOf(result) {
    if (result === void 0) return void 0;
    return typeof result === "function" ? result : result.cleanup;
  }
  function deferredInstance(setup) {
    let running;
    let settle2;
    let finished = Promise.resolve();
    const teardown = () => {
      cleanupOf(running)?.();
      running = void 0;
      settle2?.();
    };
    return createJsInstance({
      activate() {
        running = setup();
        if (typeof running === "function" || "continuous" in running) return;
        const work = running.finished;
        finished = new Promise((resolve) => {
          settle2 = resolve;
        });
        void work.then(() => settle2?.());
      },
      cancel: teardown,
      finish() {
        if (typeof running === "object" && "finish" in running) running.finish?.();
        settle2?.();
      },
      destroy: teardown,
      finished: () => finished,
      // Only an explicit marker counts. A bare `Cleanup` deliberately does not — see
      // `ContinuousSetup` above for why the two cannot be told apart by shape.
      continuous: () => typeof running === "object" && "continuous" in running
    });
  }
  function deferPrepare(setup) {
    return (...args) => deferredInstance(() => setup(...args));
  }
  function createJsInstance(hooks) {
    let active = false;
    return {
      activate() {
        if (active) return;
        hooks.activate();
        active = true;
      },
      cancel() {
        hooks.cancel?.();
        active = false;
      },
      finish() {
        hooks.finish?.();
      },
      get finished() {
        return hooks.finished?.() ?? Promise.resolve();
      },
      get continuous() {
        return hooks.continuous?.() ?? false;
      },
      destroy() {
        active = false;
        hooks.destroy();
      }
    };
  }

  // src/core/owned-styles.ts
  function createStyleLedger(el) {
    const style = el.style;
    const previous = /* @__PURE__ */ new Map();
    const authoredStyleAttribute = el.hasAttribute("style");
    function remember(property) {
      if (previous.has(property)) return;
      const existing = style.getPropertyValue(property);
      previous.set(property, existing === "" ? void 0 : existing);
    }
    return {
      set(property, value) {
        remember(property);
        style.setProperty(property, value);
      },
      claim: remember,
      restore() {
        for (const [property, value] of previous) {
          if (value === void 0) style.removeProperty(property);
          else style.setProperty(property, value);
        }
        previous.clear();
        if (!authoredStyleAttribute && style.length === 0 && !el.getAttribute("style"))
          el.removeAttribute("style");
      },
      owned: () => [...previous.keys()]
    };
  }
  function createAttributeLedger(el) {
    const previous = /* @__PURE__ */ new Map();
    return {
      set(name, value) {
        if (!previous.has(name)) previous.set(name, el.getAttribute(name));
        el.setAttribute(name, value);
      },
      restore() {
        for (const [name, value] of previous) {
          if (value === null) el.removeAttribute(name);
          else el.setAttribute(name, value);
        }
        previous.clear();
      }
    };
  }

  // src/core/stagger.ts
  function indexStaggerGroup(group) {
    const step = group.getAttribute(ATTR.stagger);
    if (step) group.style.setProperty("--kui-stagger", step);
    let index = 0;
    for (const child of group.children) {
      if (child.hasAttribute(ATTR.source)) {
        ;
        child.style.setProperty("--kui-i", String(index));
        index++;
      }
    }
    ;
    group.style.setProperty("--kui-stagger-count", String(Math.max(index, 1)));
  }
  function applyStagger(root) {
    const selector = `[${ATTR.stagger}]`;
    if (root instanceof Element && root.matches(selector)) indexStaggerGroup(root);
    for (const group of root.querySelectorAll(selector)) indexStaggerGroup(group);
  }

  // src/core/style-plan.ts
  function planStyles(input) {
    const { plan, config, capabilities, respectReducedMotion } = input;
    const reduce = respectReducedMotion && capabilities.reducedMotion;
    const scrubbed = config.timeline === "pin" && plan.supportedTimelines.includes("pin");
    const useNativeTimeline = !scrubbed && supportsTimeline(config.timeline, capabilities) && plan.supportedTimelines.includes(config.timeline);
    const properties = { ...plan.vars, ...plan.declarations };
    Object.assign(properties, timelineProperties(config, capabilities, useNativeTimeline));
    const hasCssAnimation = Object.keys(plan.declarations).length > 0;
    const gate = resolveGate({
      useNativeTimeline,
      scrubbed: scrubbed && hasCssAnimation,
      reduce,
      activation: config.activation,
      // JS effects are gated too. They emit no `animation` declaration, so only the play-state
      // write is skipped — the activation itself still has to be bound, or `on:enter` and
      // `on:click` would silently do nothing for every pinned, dragged, or morphing element.
      hasWork: hasCssAnimation || plan.jsEffects.length > 0,
      hasCssAnimation,
      // A browser lacking standalone translate/rotate/scale support silently ignores any
      // `@keyframes` step written in those properties — the animation never visibly completes. An
      // effect deferred on that promise would sit paused (or, for an entrance reveal, invisible)
      // forever, so it must reach its final state immediately instead, the same fail-open rule
      // already applied under reduced motion.
      unsupportedTransform: needsIndividualTransforms(plan.channels, capabilities)
    });
    if (gate === "deferred" || gate === "scrubbed") properties["animation-play-state"] = "paused";
    return {
      properties,
      attributes: {
        [ATTR.normalized]: plan.fxNames.join(" "),
        [ATTR.rm]: plan.reducedMotion,
        [ATTR.state]: "ready"
      },
      gate,
      activation: gate === "deferred" ? effectiveActivation(config) : null
    };
  }
  function timelineProperties(config, capabilities, useNativeTimeline) {
    if (!useNativeTimeline) return {};
    const properties = {
      "animation-timeline": config.timeline === "scroll" ? "scroll()" : "view()"
    };
    if (capabilities.animationRange) {
      properties["animation-range"] = config.range || (config.timeline === "scroll" ? "0% 100%" : "entry 0% cover 60%");
    }
    return properties;
  }
  function resolveGate(input) {
    if (input.useNativeTimeline) return "native-timeline";
    if (input.scrubbed) return "scrubbed";
    if (!input.hasWork) return "immediate";
    if (input.reduce || input.activation === "load" || input.unsupportedTransform) return "immediate";
    return "deferred";
  }
  function needsIndividualTransforms(channels, capabilities) {
    if (capabilities.individualTransforms) return false;
    return channels.some((c) => c === "translate" || c === "rotate" || c === "scale");
  }
  function supportsTimeline(timeline, capabilities) {
    if (timeline === "view") return capabilities.viewTimeline;
    if (timeline === "scroll") return capabilities.scrollTimeline;
    return false;
  }
  function effectiveActivation(config) {
    if (config.timeline !== "time" && config.activation === "manual") return "enter";
    return config.activation;
  }
  function applyStylePlan(request) {
    const { plan, ledger, attributes } = request;
    for (const [property, value] of Object.entries(plan.properties)) ledger.set(property, value);
    for (const [attribute, value] of Object.entries(plan.attributes)) attributes.set(attribute, value);
    ledger.claim("animation-play-state");
  }

  // src/core/animator.ts
  var CLOAK_WATCHDOG_MS = 3e3;
  function fingerprintOf(attributes) {
    return [attributes.source, attributes.on, attributes.timeline, attributes.threshold].join("\0");
  }
  function isElementNode(node) {
    return typeof Element !== "undefined" && node instanceof Element;
  }
  var Animator = class {
    registry;
    capabilities;
    root;
    reporter;
    binder;
    scheduler;
    rootResolver;
    jsEffectPreparer;
    respectReducedMotion;
    shouldObserve;
    /** Runtime truth. Attributes are for CSS and debugging; they make a poor state machine. */
    states = /* @__PURE__ */ new WeakMap();
    /** Iterable lifecycle index; the WeakMap remains the fast state lookup. */
    liveElements = /* @__PURE__ */ new Set();
    /** Built lazily by `watch()` when not injected, so nothing observes until `start()` needs it. */
    domWatcher;
    started = false;
    constructor(options = {}) {
      const resolved = resolveCollaborators(options);
      this.registry = resolved.registry;
      this.capabilities = resolved.capabilities;
      this.root = resolved.root;
      this.reporter = resolved.reporter;
      this.binder = resolved.binder;
      this.scheduler = resolved.scheduler;
      this.rootResolver = resolved.rootResolver;
      this.jsEffectPreparer = resolved.jsEffectPreparer;
      this.domWatcher = resolved.domWatcher;
      this.respectReducedMotion = resolved.respectReducedMotion;
      this.shouldObserve = resolved.shouldObserve;
    }
    /**
     * Explicit entry point. Importing the library never touches the document, which keeps SSR,
     * hydration, and tests deterministic.
     *
     * @complexity O(n) time in the number of elements scanned.
     * @overallScore 100
     */
    start() {
      if (this.started) return this;
      this.started = true;
      const watchdog = globalThis.setTimeout(() => this.uncloak(), CLOAK_WATCHDOG_MS);
      try {
        this.scan(this.root);
        if (this.shouldObserve) this.watch();
      } finally {
        globalThis.clearTimeout(watchdog);
        this.uncloak();
      }
      return this;
    }
    /**
     * Process every unprocessed element in a subtree, including the root.
     *
     * `querySelectorAll` excludes the root, but an inserted subtree very often carries the
     * attribute on its top node — skipping it silently drops those animations.
     *
     * @param root - Subtree to scan. Defaults to the animator's root.
     * @complexity O(n) time in the subtree size; O(1) extra space.
     * @overallScore 100
     */
    scan(root = this.root) {
      if (!root) return this;
      const selector = `[${ATTR.source}]`;
      if (isElementNode(root) && root.matches(selector)) this.process(root);
      for (const el of root.querySelectorAll(selector)) this.process(el);
      applyStagger(root);
      return this;
    }
    /**
     * Compile and install one element's effects, recompiling if its attribute changed.
     *
     * @param el - Element carrying `data-kui`.
     * @complexity O(e) time in the number of composed effects; O(e) space for the plan.
     * @overallScore 100
     */
    process(el) {
      const attributes = readAttributes(el);
      const fingerprint = fingerprintOf(attributes);
      const existing = this.states.get(el);
      if (existing?.fingerprint === fingerprint) return;
      if (existing) this.release(el);
      const parsed = parse(attributes.source);
      const config = resolveConfig(attributes, parsed);
      const plan = compile(parsed, this.registry, config.timeline);
      config.activation = this.resolveActivation(el, config, plan);
      for (const warning of plan.warnings) this.reporter.warn(warning, el);
      if (plan.fxNames.length === 0) {
        el.setAttribute(ATTR.state, plan.unknown.length > 0 ? "pending" : "failed");
        return;
      }
      this.install({ el, fingerprint, parsed, config, plan });
    }
    /**
     * Apply a compiled plan and bind its activation.
     *
     * @complexity O(e) time in composed effects; O(e) space for retained cleanups.
     * @overallScore 100
     */
    /**
     * Choose the activation, letting a primitive's preference fill in only when the author named
     * none, and warning when an authored activation is not one the effect supports.
     *
     * Declared capability metadata was previously never checked anywhere, which made
     * `supportedActivations` documentation rather than a contract.
     *
     * @complexity O(a) time in supported activations; O(1) space.
     * @overallScore 100
     */
    resolveActivation(el, config, plan) {
      if (!config.activationAuthored) return plan.defaultActivation ?? config.activation;
      const supported = plan.supportedActivations;
      if (supported.length > 0 && !supported.includes(config.activation)) {
        this.reporter.warn(
          `activation "${config.activation}" is not supported by this effect (supports: ${supported.join(", ")})`,
          el
        );
      }
      return config.activation;
    }
    install(request) {
      const { el, fingerprint, parsed, config, plan } = request;
      const stylePlan = planStyles({
        plan,
        config,
        capabilities: this.capabilities,
        respectReducedMotion: this.respectReducedMotion
      });
      const ledger = createStyleLedger(el);
      const attributes = createAttributeLedger(el);
      const controller = new AbortController();
      applyStylePlan({ el, plan: stylePlan, ledger, attributes });
      const state = {
        fingerprint,
        specs: parsed.specs,
        activation: config.activation,
        timeline: config.timeline,
        instances: [],
        ledger,
        attributes,
        controller,
        status: "ready"
      };
      this.states.set(el, state);
      this.liveElements.add(el);
      if (Object.keys(stylePlan.properties).some((property) => property.startsWith("animation-"))) {
        const animationNames = (plan.declarations["animation-name"] ?? "").split(",").map((name) => name.trim()).filter(Boolean);
        state.instances.push(
          createCssInstance(el, ledger, animationNames, stylePlan.gate === "scrubbed")
        );
      }
      state.instances.push(
        ...this.jsEffectPreparer.prepare({ el, plan, signal: controller.signal, ledger })
      );
      this.openGate({ el, state, stylePlan, config, plan });
    }
    /**
     * Decide whether, and when, the effects on this element are allowed to start.
     *
     * The single place any effect begins. Routing both renderers through it is what makes
     * `on:enter`, `on:click`, `manual`, and `reducedMotion: 'disable'` mean the same thing for a
     * pinned section as for a fade — previously JS effects started during `prepare` and honoured
     * none of them.
     *
     * @complexity O(n) time in the number of instances; O(1) space.
     * @overallScore 100
     */
    openGate(request) {
      const { el, state, stylePlan, config, plan } = request;
      const reduce = this.respectReducedMotion && this.capabilities.reducedMotion;
      if (reduce && plan.reducedMotion === "disable") {
        state.status = "finished";
        state.attributes.set(ATTR.state, "finished");
        return;
      }
      if (stylePlan.gate !== "deferred") {
        this.activate(el);
        return;
      }
      const releaseBinding = this.binder.bind(
        el,
        stylePlan.activation,
        config.threshold,
        () => this.activate(el)
      );
      let released = false;
      const releaseOnce = () => {
        if (released) return;
        released = true;
        releaseBinding();
      };
      state.controller.signal.addEventListener("abort", releaseOnce);
      if (stylePlan.activation === "enter") state.releaseActivation = releaseOnce;
    }
    /**
     * Start a deferred animation.
     *
     * A JS-rendered effect's real setup work is postponed until this call — `deferPrepare` in
     * `instances.ts` only wires up an inert instance during `prepare` — so a broken primitive (a bad
     * selector, a malformed param) first throws here, not while the plan was being built. `scan()`
     * reaches this synchronously for every `on:load` element, inside the very loop that processes
     * every other element on the page; an uncaught throw here previously unwound that loop and
     * silently orphaned every element after the broken one — the same blast radius the `__proto__`
     * scan-crash fix closed for a different door. Each instance is isolated so one effect's failure
     * can neither strand a sibling effect on the same element nor abort the rest of the scan.
     *
     * @complexity O(n) time in composed instances; O(1) space.
     * @overallScore 100
     */
    activate(el) {
      const state = this.states.get(el);
      if (!state || state.status === "running") return;
      state.releaseActivation?.();
      state.releaseActivation = void 0;
      state.status = "running";
      state.attributes.set(ATTR.state, "running");
      const started = state.instances.filter((instance) => this.startInstance(instance, el));
      if (started.length === 0 && state.instances.length > 0) {
        state.status = "failed";
        state.attributes.set(ATTR.state, "failed");
        return;
      }
      const timed = started.filter((instance) => !instance.continuous);
      if (timed.length === 0 && started.length > 0) return;
      void Promise.all(timed.map((instance) => instance.finished)).then(() => {
        if (this.states.get(el) !== state || state.status !== "running") return;
        state.status = "finished";
        state.attributes.set(ATTR.state, "finished");
      });
    }
    /**
     * Activate one instance, isolating a throw from its (possibly deferred) setup.
     *
     * @returns Whether the instance actually started — a failed instance is excluded from the
     * `finished` gate in `activate()`, since something that never started can never legitimately
     * finish (see `EffectInstance.finished`'s "resolves, never rejects" contract in `types.ts`).
     * @complexity O(1) time, O(1) space.
     * @overallScore 100
     */
    startInstance(instance, el) {
      try {
        instance.activate();
        return true;
      } catch (error) {
        this.reporter.warn(`effect failed to activate: ${String(error)}`, el);
        return false;
      }
    }
    /**
     * Programmatic entry point. Accepts a selector, an Element, a NodeList, or any iterable, so
     * `getElementById`, `getElementsByClassName`, and `querySelectorAll` all work directly.
     *
     * @complexity O(n) time in selected elements.
     * @overallScore 100
     */
    play(target, effect, options = {}) {
      return play({ animator: this, root: this.root, target, effect }, options);
    }
    /**
     * Remove the opt-in cloak so a stalled or failed initialisation can never leave a page hidden.
     *
     * @complexity O(1) time, O(1) space.
     * @overallScore 100
     */
    uncloak() {
      const doc = isElementNode(this.root) ? this.root.ownerDocument : this.root;
      doc?.documentElement?.removeAttribute(ATTR.cloak);
    }
    stateOf(el) {
      return this.states.get(el);
    }
    /**
     * Tear an element's effects down so the next `process()` reinstalls from scratch.
     *
     * Needed for replay: `process()` short-circuits when the configuration fingerprint is
     * unchanged, so playing the same effect twice was previously a no-op.
     *
     * @complexity O(c) time in retained instances; O(1) space.
     * @overallScore 100
     */
    reset(el) {
      this.release(el);
    }
    /**
     * Tear down one element's effects and clear its library-owned attributes.
     *
     * @complexity O(c) time in retained cleanups; O(1) extra space.
     * @overallScore 100
     */
    release(el) {
      const state = this.states.get(el);
      if (!state) return;
      state.controller.abort();
      for (const instance of state.instances) runQuietly(() => instance.destroy());
      this.states.delete(el);
      this.liveElements.delete(el);
      state.ledger.restore();
      state.attributes.restore();
    }
    /**
     * Tear down every tracked element inside a removed subtree.
     *
     * Scoped to `node`'s own descendants rather than re-scanning `liveElements` against the whole
     * page, so a removal event costs O(removed subtree), not O(every animated element alive
     * anywhere) — `dom-watcher.ts` can queue up to 100 removed roots per frame, and `liveElements`
     * only shrinks on release, so it stays large on a scroll-reveal-heavy page.
     *
     * Membership is checked against `liveElements` (the ground truth) rather than re-querying
     * `[${ATTR.source}]` the way `scan()` does: `dom-watcher.ts`'s `flush()` drains removed roots
     * before attribute-change roots, so if calling code strips `data-kui` and removes the element in
     * the same tick, a selector-based query would already miss it here and leak its teardown.
     *
     * `node` is typed `Element`, not `ParentNode`: `dom-watcher.ts`'s `onElementRemoved` — this
     * method's only caller — is itself typed `(el: Element) => void`, so there is no runtime case
     * where `node` is a `Document`/`DocumentFragment` to guard against.
     *
     * @complexity O(s) time in the removed subtree's element count; O(1) per candidate via the
     * `liveElements` Set lookup.
     * @overallScore 100
     */
    releaseTree(node) {
      if (this.liveElements.has(node)) this.release(node);
      for (const el of node.querySelectorAll("*")) {
        if (this.liveElements.has(el)) this.release(el);
      }
    }
    destroy() {
      this.domWatcher?.destroy();
      for (const el of [...this.liveElements]) this.release(el);
      this.binder.destroy();
      this.scheduler.destroy();
      this.started = false;
    }
    /**
     * Start watching for DOM insertions, removals, and attribute changes.
     *
     * Attribute changes recompile in place; insertions scan; removals tear down so listeners and
     * observers do not outlive their elements.
     *
     * @complexity O(1) time and space to build and start; the watcher's own callback runs O(n) time
     * in the nodes one mutation record carries.
     * @overallScore 100
     */
    watch() {
      this.domWatcher ??= createDomWatcher({
        root: this.root,
        onElementAdded: (el) => this.scan(el),
        onElementRemoved: (el) => this.releaseTree(el),
        onAttributeChanged: (el) => this.process(el)
      });
      this.domWatcher.watch();
    }
  };
  function createAnimator(options = {}) {
    return new Animator(options);
  }
  function resolveCollaborators(options) {
    const root = options.root ?? globalThis.document;
    const capabilities = options.capabilities ?? detect();
    const reporter = options.reporter ?? silentReporter();
    const scheduler = options.scheduler ?? createScrollScheduler();
    const rootResolver = options.rootResolver ?? defaultRootResolver(root);
    const respectReducedMotion = (options.reducedMotion ?? "respect") === "respect";
    return {
      registry: options.registry ?? new Registry(),
      capabilities,
      root,
      reporter,
      binder: options.binder ?? createActivationBinder(),
      scheduler,
      rootResolver,
      jsEffectPreparer: resolveJsEffectPreparer(options.jsEffectPreparer, {
        scheduler,
        rootResolver,
        capabilities,
        reporter,
        respectReducedMotion
      }),
      // Not defaulted here (unlike the other collaborators above): building the real watcher needs
      // `this.scan`/`this.process`/`this.releaseTree`, which don't exist yet inside this free
      // function. `Animator.watch()` builds it lazily instead, so nothing observes — and no
      // `MutationObserver` is ever constructed — unless `shouldObserve` is true and `start()` runs.
      domWatcher: options.domWatcher,
      respectReducedMotion,
      shouldObserve: options.observe ?? false
    };
  }
  function resolveJsEffectPreparer(provided, deps) {
    return provided ?? createJsEffectPreparer(deps);
  }
  function defaultRootResolver(root) {
    const doc = isElementNode(root) ? root.ownerDocument : root;
    const win = doc?.defaultView ?? globalThis;
    return createRootResolver({ win });
  }
  function runQuietly(cleanup) {
    try {
      cleanup();
    } catch {
    }
  }

  // src/core/types.ts
  var CHANNEL = {
    opacity: "opacity",
    translate: "translate",
    scale: "scale",
    rotate: "rotate",
    filter: "filter",
    clip: "clip",
    background: "background",
    color: "color",
    stroke: "stroke",
    text: "text",
    /**
     * Skew is the one transform CSS never gave an independent property to — there is no `skew:`
     * beside `translate:`/`rotate:`/`scale:`, so it can only be written through the `transform`
     * shorthand. That makes it its own channel: anything writing `transform` clobbers the whole
     * shorthand, so every primitive that does is on this channel, whatever the transform is for.
     * `scroll-skew` is one member; `flip-face` (`effects/three-d`) and `flip-3d`
     * (`effects/catalog/core`, the `flip-in-*`/`flip-out-*` family) are the other two — both need
     * the `perspective()` transform *function* for an element to have depth on itself, which
     * likewise only exists inside `transform`.
     */
    skew: "skew"
  };
  function inertInstance(destroy = () => {
  }) {
    return {
      activate() {
      },
      cancel() {
      },
      finish() {
      },
      finished: Promise.resolve(),
      destroy
    };
  }

  // src/effects/shared.ts
  var TRIGGER_DELAY_PARAM = {
    delay: { type: "time", default: "0ms", cssProperty: "--kui-delay" }
  };
  var TIMELINE_AGNOSTIC = ["time", "view", "scroll", "pin"];
  var COMMON = {
    duration: { type: "time", default: "600ms", cssProperty: "--kui-duration" },
    ...TRIGGER_DELAY_PARAM,
    ease: { type: "easing", default: "ease-out", cssProperty: "--kui-ease" },
    stagger: { type: "time", default: "0ms", cssProperty: "--kui-stagger" }
  };
  function cssPrimitive(id, channels, options = {}) {
    return {
      id,
      renderer: "css-keyframes",
      channels,
      parameters: { ...COMMON, ...options.parameters },
      supportedTimelines: options.timelines ?? ["time"],
      supportedActivations: options.activations ?? [
        "load",
        "enter",
        "hover",
        "focus",
        "click",
        "manual"
      ],
      perfClass: options.perfClass ?? "compositor",
      reducedMotion: options.reducedMotion ?? "shorten",
      ...options.defaultActivation ? { defaultActivation: options.defaultActivation } : {}
    };
  }

  // src/effects/catalog/ambient.ts
  var drift = {
    duration: { type: "time", default: "10s", cssProperty: "--kui-duration" },
    ease: { type: "easing", default: "ease-in-out", cssProperty: "--kui-ease" },
    from: { type: "color", default: "", cssProperty: "--kui-ambient-c1" },
    to: { type: "color", default: "", cssProperty: "--kui-ambient-c2" }
  };
  var tint = {
    duration: { type: "time", default: "10s", cssProperty: "--kui-duration" },
    ease: { type: "easing", default: "ease-in-out", cssProperty: "--kui-ease" },
    from: { type: "color", default: "", cssProperty: "--kui-ambient-c1" }
  };
  var float = {
    duration: { type: "time", default: "4s", cssProperty: "--kui-duration" },
    ease: { type: "easing", default: "ease-in-out", cssProperty: "--kui-ease" },
    distance: { type: "length", default: "14px", cssProperty: "--kui-distance" }
  };
  var orbit = {
    duration: { type: "time", default: "3.5s", cssProperty: "--kui-duration" },
    // `linear` by default, unlike every other ambient primitive: a continuous rotation that eases
    // visibly stutters once per revolution, because the ease restarts at each iteration boundary.
    ease: { type: "easing", default: "linear", cssProperty: "--kui-ease" },
    angle: { type: "angle", default: "360deg", cssProperty: "--kui-to-angle" }
  };
  var pulse = {
    duration: { type: "time", default: "2.2s", cssProperty: "--kui-duration" },
    ease: { type: "easing", default: "ease-in-out", cssProperty: "--kui-ease" },
    scale: { type: "number", default: "1.15", cssProperty: "--kui-pulse-scale", finite: true, minimum: 1 }
  };
  var AMBIENT_PRIMITIVES = [
    cssPrimitive("ambient-gradient", [CHANNEL.background], {
      parameters: drift,
      defaultActivation: "load",
      reducedMotion: "disable",
      perfClass: "continuous"
    }),
    /*
     * `gradient-rotate-border` and `gradient-border` are not background fills, and a second
     * primitive is how this catalog says so — the same reason `ambient-tint` exists beside
     * `ambient-gradient` above. Channels are per-primitive, so a different channel set means a
     * different primitive; folding these into `ambient-gradient` would make `gradient-mesh` and
     * `aurora` claim a mask and a box they never touch, and `aurora, pin` would start reporting a
     * conflict that isn't there.
     *
     * What the ring rules actually write (`ambient.css`) beyond the gradient: `mask` +
     * `mask-composite`, which subtract the element's own content box to leave a ring — the same
     * physical property `media-mask` claims under the `'mask'` channel — and `position: relative`
     * plus a `padding` that *is* the ring's thickness, which is a claim on the host's box in the
     * sense `pin` and `background-media` already use `'layout'` for. Declared only as
     * `background`, a `gradient-border, pin-section` pair composed silently while both decided the
     * host's `position`, and `gradient-border, mask-reveal` while both wrote `mask`.
     */
    cssPrimitive("ambient-gradient-ring", [CHANNEL.background, "mask", "layout"], {
      parameters: drift,
      defaultActivation: "load",
      reducedMotion: "disable",
      perfClass: "continuous"
    }),
    cssPrimitive("ambient-tint", [CHANNEL.background], {
      parameters: tint,
      defaultActivation: "load",
      reducedMotion: "disable",
      perfClass: "continuous"
    }),
    cssPrimitive("ambient-float", [CHANNEL.translate], {
      parameters: float,
      defaultActivation: "load",
      reducedMotion: "disable",
      perfClass: "continuous"
    }),
    cssPrimitive("ambient-orbit", [CHANNEL.rotate], {
      parameters: orbit,
      defaultActivation: "load",
      reducedMotion: "disable",
      perfClass: "continuous"
    }),
    cssPrimitive("ambient-pulse", [CHANNEL.scale, CHANNEL.opacity], {
      parameters: pulse,
      defaultActivation: "load",
      reducedMotion: "disable",
      perfClass: "continuous"
    })
  ];
  var AMBIENT_PRESETS = [
    { name: "gradient-mesh", primitive: "ambient-gradient", keyframes: "kui-gradient-mesh" },
    { name: "aurora", primitive: "ambient-gradient", keyframes: "kui-aurora" },
    {
      name: "gradient-rotate-border",
      primitive: "ambient-gradient-ring",
      keyframes: "kui-gradient-rotate-border",
      params: { duration: "6s", ease: "linear" }
    },
    {
      // Not `gradient`: this rule masks its own content box away (`mask-composite: exclude`) to leave
      // a ring, so putting the name on real content deletes the content. `-border` says that out loud,
      // matching `gradient-rotate-border` and `beam-border`.
      name: "gradient-border",
      primitive: "ambient-gradient-ring",
      keyframes: "kui-gradient-border",
      params: { duration: "6s", ease: "linear" }
    },
    {
      name: "noise-overlay",
      primitive: "ambient-tint",
      keyframes: "kui-noise-overlay",
      params: { duration: "650ms", ease: "steps(6)" }
    },
    {
      name: "scanline",
      primitive: "ambient-tint",
      keyframes: "kui-scanline",
      params: { duration: "3.5s", ease: "linear" }
    },
    {
      name: "dot-grid-drift",
      primitive: "ambient-tint",
      keyframes: "kui-dot-grid-drift",
      params: { duration: "16s", ease: "linear" }
    },
    {
      name: "line-grid-drift",
      primitive: "ambient-tint",
      keyframes: "kui-line-grid-drift",
      params: { duration: "16s", ease: "linear" }
    },
    {
      name: "starfield",
      primitive: "ambient-tint",
      keyframes: "kui-starfield",
      params: { duration: "40s", ease: "linear" }
    },
    {
      name: "spotlight-follow",
      primitive: "ambient-tint",
      keyframes: "kui-spotlight-follow",
      params: { duration: "9s" }
    },
    {
      name: "wave-blob",
      primitive: "ambient-tint",
      keyframes: "kui-wave-blob",
      params: { duration: "12s" }
    },
    { name: "float", primitive: "ambient-float", keyframes: "kui-float" },
    {
      name: "bob",
      primitive: "ambient-float",
      keyframes: "kui-bob",
      params: { duration: "2s", distance: "8px" }
    },
    {
      name: "floating-shapes",
      primitive: "ambient-float",
      keyframes: "kui-floating-shapes",
      params: { duration: "6s", distance: "10px" }
    },
    { name: "orbit", primitive: "ambient-orbit", keyframes: "kui-orbit" },
    { name: "glow-pulse", primitive: "ambient-pulse", keyframes: "kui-glow-pulse" }
  ];
  function registerAmbient(registry) {
    return registry.registerPrimitives(AMBIENT_PRIMITIVES).registerPresets(AMBIENT_PRESETS);
  }

  // src/effects/catalog/feedback.ts
  var loop = {
    duration: { type: "time", default: "1.6s", cssProperty: "--kui-duration" },
    ease: { type: "easing", default: "linear", cssProperty: "--kui-ease" }
  };
  var spin = {
    duration: { type: "time", default: "900ms", cssProperty: "--kui-duration" },
    ease: { type: "easing", default: "linear", cssProperty: "--kui-ease" }
  };
  var dotPulse = {
    duration: { type: "time", default: "1.2s", cssProperty: "--kui-duration" },
    ease: { type: "easing", default: "ease-in-out", cssProperty: "--kui-ease" },
    dotSize: { type: "length", default: "8px", cssProperty: "--kui-dot-size" }
  };
  var progressTrack = {
    duration: { type: "time", default: "1.4s", cssProperty: "--kui-duration" },
    ease: { type: "easing", default: "ease-in-out", cssProperty: "--kui-ease" }
  };
  var toast = {
    duration: { type: "time", default: "420ms", cssProperty: "--kui-duration" },
    ease: { type: "easing", default: "back-out", cssProperty: "--kui-ease" },
    distance: { type: "length", default: "24px", cssProperty: "--kui-distance" }
  };
  var shake = {
    duration: { type: "time", default: "500ms", cssProperty: "--kui-duration" },
    ease: { type: "easing", default: "linear", cssProperty: "--kui-ease" }
  };
  var pop = {
    duration: { type: "time", default: "420ms", cssProperty: "--kui-duration" },
    ease: { type: "easing", default: "back-out", cssProperty: "--kui-ease" },
    scale: { type: "number", default: "1.18", cssProperty: "--kui-pop-scale", finite: true, minimum: 1 }
  };
  var ripple = {
    duration: { type: "time", default: "600ms", cssProperty: "--kui-duration" },
    ease: { type: "easing", default: "ease-out", cssProperty: "--kui-ease" },
    spread: { type: "number", default: "4", cssProperty: "--kui-ripple-scale", finite: true, minimum: 1 }
  };
  var confirm = {
    duration: { type: "time", default: "1400ms", cssProperty: "--kui-duration" },
    ease: { type: "easing", default: "linear", cssProperty: "--kui-ease" }
  };
  var pull = {
    distance: { type: "length", default: "36px", cssProperty: "--kui-pull-distance" }
  };
  var FEEDBACK_PRIMITIVES = [
    cssPrimitive("feedback-shimmer", [CHANNEL.background], {
      parameters: loop,
      defaultActivation: "load",
      reducedMotion: "disable",
      perfClass: "continuous"
    }),
    cssPrimitive("feedback-fade", [CHANNEL.opacity], {
      defaultActivation: "manual"
    }),
    cssPrimitive("feedback-spin", [CHANNEL.rotate], {
      parameters: spin,
      defaultActivation: "load",
      reducedMotion: "disable",
      perfClass: "continuous"
    }),
    // Declares every channel the preset's CSS actually paints, not just what the shared keyframe
    // animates: spinner-dots' `[data-kui-fx~='spinner-dots']` rule also sets `background:
    // currentColor` (the dot itself) and `box-shadow` (the other two dots), entirely outside
    // `@keyframes kui-spinner-dots`. Declaring only [scale, opacity] let a composed
    // `background`-writing effect (e.g. gradient-mesh) pass channel-collision detection and then
    // have its gradient silently overwritten by this rule — see css-invariants.test.ts's "CSS
    // static rules" describe block, which now catches this class of omission directly.
    cssPrimitive("feedback-dot-pulse", [CHANNEL.scale, CHANNEL.opacity, CHANNEL.background, "shadow"], {
      parameters: dotPulse,
      defaultActivation: "load",
      reducedMotion: "disable",
      perfClass: "continuous"
    }),
    // Same shape as feedback-dot-pulse above: `[data-kui-fx~='progress-indeterminate']` sets
    // `background: currentColor` unconditionally for the bar itself, outside the keyframe.
    cssPrimitive("feedback-progress-track", [CHANNEL.translate, CHANNEL.scale, CHANNEL.background], {
      parameters: progressTrack,
      defaultActivation: "load",
      reducedMotion: "disable",
      perfClass: "continuous"
    }),
    cssPrimitive("feedback-toast", [CHANNEL.opacity, CHANNEL.translate], {
      parameters: toast,
      defaultActivation: "manual"
    }),
    cssPrimitive("feedback-shake", [CHANNEL.translate], {
      parameters: shake,
      defaultActivation: "manual"
    }),
    cssPrimitive("feedback-wobble", [CHANNEL.translate, CHANNEL.rotate], {
      defaultActivation: "click"
    }),
    // `[data-kui-fx~='ripple']` sets `background: currentColor` unconditionally for the ripple
    // disc itself, outside the keyframe — same gap as feedback-dot-pulse/feedback-progress-track.
    cssPrimitive("feedback-ripple", [CHANNEL.scale, CHANNEL.opacity, CHANNEL.background], {
      parameters: ripple,
      defaultActivation: "click"
    }),
    cssPrimitive("feedback-pop", [CHANNEL.scale], {
      parameters: pop,
      defaultActivation: "manual"
    }),
    // Declares every channel any preset built on it actually paints, not just what the shared
    // keyframes animate: heart-burst's CSS also sets `color`, confetti-burst's also sets
    // `background-image`. Understating this let a composed `background`-writing effect (e.g.
    // gradient-mesh) pass channel-collision detection and silently overwrite confetti-burst's dots.
    cssPrimitive("feedback-burst", [CHANNEL.scale, CHANNEL.opacity, CHANNEL.background, CHANNEL.color], {
      parameters: pop,
      defaultActivation: "click"
    }),
    cssPrimitive("feedback-confirm", [CHANNEL.opacity], {
      parameters: confirm,
      defaultActivation: "click"
    }),
    cssPrimitive("feedback-pull", [CHANNEL.translate], {
      parameters: pull,
      defaultActivation: "manual"
    })
  ];
  var FEEDBACK_PRESETS = [
    { name: "skeleton-shimmer", primitive: "feedback-shimmer", keyframes: "kui-skeleton-shimmer" },
    { name: "skeleton-to-content", primitive: "feedback-fade", keyframes: "kui-skeleton-to-content" },
    { name: "spinner", primitive: "feedback-spin", keyframes: "kui-spinner-spin" },
    { name: "spinner-dots", primitive: "feedback-dot-pulse", keyframes: "kui-spinner-dots" },
    { name: "spinner-ring", primitive: "feedback-spin", keyframes: "kui-spinner-ring-spin" },
    {
      name: "progress-indeterminate",
      primitive: "feedback-progress-track",
      keyframes: "kui-progress-indeterminate"
    },
    { name: "toast-slide-in", primitive: "feedback-toast", keyframes: "kui-toast-slide-in" },
    {
      name: "toast-slide-out",
      primitive: "feedback-toast",
      keyframes: "kui-toast-slide-out",
      params: { ease: "ease-in" }
    },
    { name: "shake-error", primitive: "feedback-shake", keyframes: "kui-shake-error" },
    {
      name: "wobble",
      primitive: "feedback-wobble",
      keyframes: "kui-wobble",
      params: { duration: "600ms", ease: "ease-in-out" }
    },
    { name: "ripple", primitive: "feedback-ripple", keyframes: "kui-ripple" },
    { name: "badge-pop", primitive: "feedback-pop", keyframes: "kui-badge-pop" },
    {
      name: "count-bump",
      primitive: "feedback-pop",
      keyframes: "kui-count-bump",
      params: { duration: "280ms", scale: "1.3" }
    },
    {
      name: "heart-burst",
      primitive: "feedback-burst",
      keyframes: "kui-heart-burst",
      params: { duration: "700ms", scale: "1.4" }
    },
    {
      name: "confetti-burst",
      primitive: "feedback-burst",
      keyframes: "kui-confetti-burst",
      params: { duration: "900ms", scale: "1.15" }
    },
    { name: "copy-confirm", primitive: "feedback-confirm", keyframes: "kui-copy-confirm" },
    {
      name: "pull-to-refresh",
      primitive: "feedback-pull",
      keyframes: "kui-pull-to-refresh",
      params: { duration: "900ms", ease: "ease-out" }
    }
  ];
  function registerFeedback(registry) {
    return registry.registerPrimitives(FEEDBACK_PRIMITIVES).registerPresets(FEEDBACK_PRESETS);
  }

  // src/core/spring.ts
  var DEFAULT_SPRING = {
    stiffness: 180,
    damping: 24,
    mass: 1,
    restVelocity: 0.05,
    restDisplacement: 0.05
  };
  var SUBSTEP = 1 / 240;
  var MAX_STEP = 0.25;
  function stepSpring(state, target, config, dt) {
    let { value, velocity } = state;
    let remaining = Math.min(Math.max(dt, 0), MAX_STEP);
    while (remaining > 0) {
      const step = Math.min(SUBSTEP, remaining);
      const force = -config.stiffness * (value - target) - config.damping * velocity;
      velocity += force / config.mass * step;
      value += velocity * step;
      remaining -= step;
    }
    return { value, velocity };
  }
  function isSettled(state, target, config) {
    return Math.abs(state.velocity) < config.restVelocity && Math.abs(state.value - target) < config.restDisplacement;
  }
  var MAX_SETTLE_MS = 1e4;
  function createSpringRunner(config, onChange, deps) {
    const safeConfig = validConfig(config) ? config : DEFAULT_SPRING;
    if (safeConfig !== config) deps.warn?.("invalid spring configuration; using defaults");
    let state = { value: 0, velocity: 0 };
    let target = 0;
    let handle = null;
    let lastTime = 0;
    let startedAt = 0;
    function frame(time2) {
      handle = null;
      const dt = (time2 - lastTime) / 1e3;
      lastTime = time2;
      state = stepSpring(state, target, safeConfig, dt);
      if (!finiteState(state) || !Number.isFinite(target)) {
        abortRun("spring produced non-finite state");
        return;
      }
      if (time2 - startedAt >= MAX_SETTLE_MS) {
        abortRun(`spring exceeded ${MAX_SETTLE_MS}ms settle budget`);
        return;
      }
      if (isSettled(state, target, safeConfig)) {
        state = { value: target, velocity: 0 };
        onChange(state.value, true);
        return;
      }
      onChange(state.value, false);
      schedule();
    }
    function schedule() {
      if (handle !== null) return;
      handle = deps.requestFrame(frame);
    }
    function start() {
      lastTime = deps.now();
      startedAt = lastTime;
      schedule();
    }
    function abortRun(message) {
      state = { value: Number.isFinite(target) ? target : 0, velocity: 0 };
      deps.warn?.(message);
      onChange(state.value, true);
    }
    return {
      to(next, velocity) {
        target = next;
        if (velocity !== void 0) state = { ...state, velocity };
        start();
      },
      set(value, velocity = 0) {
        state = { value, velocity };
      },
      current: () => ({ ...state }),
      stop() {
        if (handle !== null) deps.cancelFrame(handle);
        handle = null;
      }
    };
  }
  function validConfig(config) {
    return Object.values(config).every(Number.isFinite) && config.stiffness > 0 && config.damping > 0 && config.mass > 0 && config.restVelocity > 0 && config.restDisplacement > 0;
  }
  function finiteState(state) {
    return Number.isFinite(state.value) && Number.isFinite(state.velocity);
  }
  function defaultSpringDeps() {
    const raf = globalThis.requestAnimationFrame;
    if (typeof raf !== "function") {
      return {
        requestFrame: (callback) => globalThis.setTimeout(() => callback(Date.now()), 16),
        cancelFrame: (handle) => globalThis.clearTimeout(handle),
        now: () => Date.now()
      };
    }
    return {
      requestFrame: (callback) => raf(callback),
      cancelFrame: (handle) => globalThis.cancelAnimationFrame(handle),
      now: () => performance.now()
    };
  }

  // src/effects/catalog/interaction-shared.ts
  function centeredOffset(point, size) {
    return {
      x: size.width > 0 ? point.x / size.width - 0.5 : 0,
      y: size.height > 0 ? point.y / size.height - 0.5 : 0
    };
  }
  function tiltAngles(point, size, maxAngleDeg) {
    const centered = centeredOffset(point, size);
    return { rotateY: centered.x * maxAngleDeg * 2, rotateX: -centered.y * maxAngleDeg * 2 };
  }
  function parallaxOffset(point, size, strengthPx) {
    const centered = centeredOffset(point, size);
    return { x: centered.x * strengthPx * 2, y: centered.y * strengthPx * 2 };
  }
  function supportsFineHover(win) {
    return win.matchMedia?.("(hover: hover) and (pointer: fine)").matches ?? true;
  }

  // src/effects/catalog/interaction.ts
  var hoverTiming = {
    duration: { type: "time", default: "220ms", cssProperty: "--kui-duration" },
    ease: { type: "easing", default: "ease-out", cssProperty: "--kui-ease" }
  };
  var liftParams = {
    distance: { type: "length", default: "6px", cssProperty: "--kui-lift-distance" }
  };
  var popParams = {
    scale: { type: "number", default: "1.06", cssProperty: "--kui-pop-scale", finite: true, minimum: 0 }
  };
  var beamParams = {
    color: { type: "color", default: "", cssProperty: "--kui-beam-border-c1" },
    outset: { type: "length", default: "", cssProperty: "--kui-beam-border-outset" }
  };
  function hoverPrimitive(id, channels, extraParams = {}) {
    return {
      id,
      renderer: "javascript",
      channels,
      parameters: { ...hoverTiming, ...extraParams },
      supportedTimelines: ["time"],
      supportedActivations: ["load"],
      defaultActivation: "load",
      perfClass: "compositor",
      // Not 'disable': a translate/box-shadow/rotate hover micro-interaction at this scale is not a
      // vestibular trigger the way parallax or continuous ambient motion is. The real motion lives in
      // CSS transitions and `:hover`-scoped pseudo-element animations rather than this primitive's
      // (here unused) compiled `animation-*` path, so the policy layer shortens it via the
      // `transition-duration` and `::before`/`::after` rules in base.css.
      reducedMotion: "shorten",
      prepare: () => inertInstance()
    };
  }
  var HOVER_PRIMITIVES = [
    hoverPrimitive("lift", ["translate"], liftParams),
    hoverPrimitive("pop", ["scale"], popParams),
    hoverPrimitive("lift-shadow", ["translate", "shadow"], liftParams),
    hoverPrimitive("shine-sweep", ["sweep"]),
    hoverPrimitive("split-flap", ["rotate"]),
    hoverPrimitive("border-draw", ["border"]),
    hoverPrimitive("border-glow", ["shadow"]),
    hoverPrimitive("beam-border", ["border"], beamParams),
    hoverPrimitive("underline-slide", ["scale"]),
    hoverPrimitive("underline-center", ["scale"]),
    hoverPrimitive("icon-wiggle", ["rotate"]),
    hoverPrimitive("icon-spin", ["rotate"]),
    hoverPrimitive("icon-bounce", ["translate"])
  ];
  var HOVER_PRESETS = HOVER_PRIMITIVES.map((primitive) => ({
    name: primitive.id,
    primitive: primitive.id
  }));
  var CONTINUOUS_BORDER_PRIMITIVES = [
    {
      id: "beam-border-auto",
      renderer: "javascript",
      channels: ["border"],
      parameters: { ...hoverTiming, ...beamParams },
      supportedTimelines: ["time"],
      supportedActivations: ["load"],
      defaultActivation: "load",
      perfClass: "compositor",
      reducedMotion: "disable",
      prepare: () => inertInstance()
    }
  ];
  var CONTINUOUS_BORDER_PRESETS = [
    { name: "beam-border-auto", primitive: "beam-border-auto" }
  ];
  var springParams = {
    stiffness: {
      type: "number",
      default: "260",
      cssProperty: "--kui-stiffness",
      finite: true,
      minimum: 1,
      maximum: 1e4
    },
    damping: {
      type: "number",
      default: "26",
      cssProperty: "--kui-damping",
      finite: true,
      minimum: 0.1,
      maximum: 1e3
    },
    mass: {
      type: "number",
      default: "1",
      cssProperty: "--kui-mass",
      finite: true,
      minimum: 0.1
    }
  };
  function pointerPrimitive(id, channels, parameters, prepare) {
    return {
      id,
      renderer: "javascript",
      channels,
      parameters,
      supportedTimelines: ["time", "pointer"],
      supportedActivations: ["load", "manual"],
      defaultActivation: "load",
      perfClass: "continuous",
      // A tilt or cursor-follow effect only exists while the pointer is present; there is no
      // meaningful "shortened" version of tracking a position. `prepare` itself checks
      // `supportsFineHover` and no-ops on touch, which is the coarse-pointer half of this rule.
      reducedMotion: "disable",
      prepare
    };
  }
  function springFrom(params) {
    return {
      ...DEFAULT_SPRING,
      stiffness: params.num("stiffness", DEFAULT_SPRING.stiffness),
      damping: params.num("damping", DEFAULT_SPRING.damping),
      mass: params.num("mass", DEFAULT_SPRING.mass)
    };
  }
  function springDepsFor(ctx) {
    return { ...defaultSpringDeps(), warn: ctx.warn };
  }
  function prepareTilt3d(el, params, ctx) {
    if (!supportsFineHover(ctx.win)) return () => {
    };
    const node = el;
    const maxAngle = params.num("maxAngle", 14);
    const perspective = params.text("perspective", "800px");
    function writeAngles(rotateX, rotateY, transitionMs) {
      ctx.style.set("transition", `transform ${transitionMs}ms ease-out`);
      ctx.style.set(
        "transform",
        `perspective(${perspective}) rotateX(${rotateX.toFixed(2)}deg) rotateY(${rotateY.toFixed(2)}deg)`
      );
    }
    function onMove(event) {
      const rect = node.getBoundingClientRect();
      const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const { rotateX, rotateY } = tiltAngles(point, rect, maxAngle);
      writeAngles(rotateX, rotateY, 100);
    }
    function reset() {
      writeAngles(0, 0, 400);
    }
    function onFocus() {
      writeAngles(-maxAngle / 2, maxAngle / 2, 250);
    }
    node.addEventListener("pointermove", onMove, { passive: true });
    node.addEventListener("pointerleave", reset, { passive: true });
    node.addEventListener("focus", onFocus);
    node.addEventListener("blur", reset);
    return () => {
      node.removeEventListener("pointermove", onMove);
      node.removeEventListener("pointerleave", reset);
      node.removeEventListener("focus", onFocus);
      node.removeEventListener("blur", reset);
    };
  }
  function collectParallaxLayers(node) {
    return [...node.querySelectorAll("[data-depth]")].map((layer) => ({
      ledger: createStyleLedger(layer),
      depth: Number(layer.dataset.depth) || 0
    }));
  }
  function writeParallaxLayers(layers, x, y, transitionMs) {
    for (const layer of layers) {
      layer.ledger.set("transition", `translate ${transitionMs}ms ease-out`);
      layer.ledger.set("translate", `${(x * layer.depth).toFixed(2)}px ${(y * layer.depth).toFixed(2)}px`);
    }
  }
  function prepareTiltParallax(el, params, ctx) {
    if (!supportsFineHover(ctx.win)) return () => {
    };
    const node = el;
    const strength = params.num("strength", 24);
    const layers = collectParallaxLayers(node);
    function onMove(event) {
      const rect = node.getBoundingClientRect();
      const point = { x: event.clientX - rect.left, y: event.clientY - rect.top };
      const offset = parallaxOffset(point, rect, strength);
      writeParallaxLayers(layers, offset.x, offset.y, 120);
    }
    function reset() {
      writeParallaxLayers(layers, 0, 0, 400);
    }
    node.addEventListener("pointermove", onMove, { passive: true });
    node.addEventListener("pointerleave", reset, { passive: true });
    node.addEventListener("focus", reset);
    node.addEventListener("blur", reset);
    return () => {
      node.removeEventListener("pointermove", onMove);
      node.removeEventListener("pointerleave", reset);
      node.removeEventListener("focus", reset);
      node.removeEventListener("blur", reset);
      for (const layer of layers) layer.ledger.restore();
    };
  }
  function writeDotPosition(dot, x, y) {
    dot.style.translate = `${x.toFixed(1)}px ${y.toFixed(1)}px`;
  }
  function createCursorDot(doc, dotClass, labelText) {
    const dot = doc.createElement("span");
    dot.className = `kui-cursor-dot ${dotClass}`;
    dot.setAttribute("aria-hidden", "true");
    if (labelText) dot.textContent = labelText;
    doc.body.append(dot);
    return dot;
  }
  function createCursorRunners(dot, config, deps) {
    const position = { x: 0, y: 0 };
    const onAxis = (axis) => (value) => {
      position[axis] = value;
      writeDotPosition(dot, position.x, position.y);
    };
    return {
      x: createSpringRunner(config, onAxis("x"), deps),
      y: createSpringRunner(config, onAxis("y"), deps)
    };
  }
  function prepareCursorDot(el, params, ctx, dotClass) {
    if (!supportsFineHover(ctx.win)) return () => {
    };
    const doc = el.ownerDocument;
    const node = el;
    const dot = createCursorDot(doc, dotClass, params.text("label", ""));
    const runners = createCursorRunners(dot, springFrom(params), springDepsFor(ctx));
    function show() {
      dot.classList.add("kui-cursor-dot-active");
    }
    function hide() {
      dot.classList.remove("kui-cursor-dot-active");
    }
    function onMove(event) {
      show();
      runners.x.to(event.clientX);
      runners.y.to(event.clientY);
    }
    function onFocus() {
      const rect = node.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      show();
      runners.x.set(cx);
      runners.y.set(cy);
      writeDotPosition(dot, cx, cy);
    }
    node.addEventListener("pointermove", onMove, { passive: true });
    node.addEventListener("pointerleave", hide, { passive: true });
    node.addEventListener("focus", onFocus);
    node.addEventListener("blur", hide);
    return () => {
      node.removeEventListener("pointermove", onMove);
      node.removeEventListener("pointerleave", hide);
      node.removeEventListener("focus", onFocus);
      node.removeEventListener("blur", hide);
      runners.x.stop();
      runners.y.stop();
      dot.remove();
    };
  }
  function prepareSpotlight(el, params, ctx) {
    if (!supportsFineHover(ctx.win)) return () => {
    };
    const node = el;
    if (ctx.win.getComputedStyle(node).position === "static") ctx.style.set("position", "relative");
    function writeSpot(x, y, on) {
      ctx.style.set("--kui-x", x);
      ctx.style.set("--kui-y", y);
      ctx.style.set("--kui-spotlight-opacity", on ? "1" : "0");
    }
    function onMove(event) {
      const rect = node.getBoundingClientRect();
      writeSpot(`${(event.clientX - rect.left).toFixed(1)}px`, `${(event.clientY - rect.top).toFixed(1)}px`, true);
    }
    function hide() {
      writeSpot("50%", "50%", false);
    }
    function onFocus() {
      writeSpot("50%", "50%", true);
    }
    node.addEventListener("pointermove", onMove, { passive: true });
    node.addEventListener("pointerleave", hide, { passive: true });
    node.addEventListener("focus", onFocus);
    node.addEventListener("blur", hide);
    return () => {
      node.removeEventListener("pointermove", onMove);
      node.removeEventListener("pointerleave", hide);
      node.removeEventListener("focus", onFocus);
      node.removeEventListener("blur", hide);
    };
  }
  var tiltParams = {
    maxAngle: { type: "number", default: "14", cssProperty: "--kui-max-angle" },
    perspective: { type: "length", default: "800px", cssProperty: "--kui-perspective" }
  };
  var parallaxParams = {
    strength: { type: "number", default: "24", cssProperty: "--kui-strength" }
  };
  var cursorDotParams = {
    ...springParams,
    label: { type: "text", default: "", cssProperty: "--kui-label" }
  };
  var POINTER_PRIMITIVES = [
    pointerPrimitive("tilt-3d", ["rotate"], tiltParams, deferPrepare(prepareTilt3d)),
    pointerPrimitive("tilt-parallax", ["translate"], parallaxParams, deferPrepare(prepareTiltParallax)),
    pointerPrimitive("cursor-follow", ["translate"], cursorDotParams, deferPrepare(prepareCursorFollow)),
    pointerPrimitive("cursor-lag", ["translate"], cursorDotParams, deferPrepare(prepareCursorLag)),
    pointerPrimitive("cursor-label", ["translate"], cursorDotParams, deferPrepare(prepareCursorLabel)),
    pointerPrimitive("cursor-invert", ["translate"], cursorDotParams, deferPrepare(prepareCursorInvert)),
    pointerPrimitive("cursor-spotlight", ["spotlight"], {}, deferPrepare(prepareSpotlight))
  ];
  function prepareCursorFollow(el, params, ctx) {
    return prepareCursorDot(el, params, ctx, "kui-cursor-dot-follow");
  }
  function prepareCursorLag(el, params, ctx) {
    return prepareCursorDot(el, params, ctx, "kui-cursor-dot-lag");
  }
  function prepareCursorLabel(el, params, ctx) {
    return prepareCursorDot(el, params, ctx, "kui-cursor-dot-label");
  }
  function prepareCursorInvert(el, params, ctx) {
    return prepareCursorDot(el, params, ctx, "kui-cursor-dot-invert");
  }
  var POINTER_PRESETS = [
    { name: "tilt-3d", primitive: "tilt-3d" },
    { name: "tilt-parallax", primitive: "tilt-parallax" },
    { name: "cursor-follow", primitive: "cursor-follow", params: { stiffness: "300", damping: "30" } },
    { name: "cursor-lag", primitive: "cursor-lag", params: { stiffness: "80", damping: "14" } },
    { name: "cursor-label", primitive: "cursor-label", params: { stiffness: "260", damping: "26", label: "View" } },
    { name: "cursor-spotlight", primitive: "cursor-spotlight" },
    { name: "cursor-invert", primitive: "cursor-invert", params: { stiffness: "260", damping: "26" } }
  ];
  var INTERACTION_PRIMITIVES = [
    ...HOVER_PRIMITIVES,
    ...POINTER_PRIMITIVES,
    ...CONTINUOUS_BORDER_PRIMITIVES
  ];
  var INTERACTION_PRESETS = [
    ...HOVER_PRESETS,
    ...POINTER_PRESETS,
    ...CONTINUOUS_BORDER_PRESETS
  ];
  function registerInteraction(registry) {
    return registry.registerPrimitives(INTERACTION_PRIMITIVES).registerPresets(INTERACTION_PRESETS);
  }

  // src/effects/catalog/background-media.ts
  var VIDEO_EXTENSIONS = /* @__PURE__ */ new Set(["mp4", "webm", "mov", "m4v", "ogv"]);
  var VIDEO_PAGE_HOSTS = /* @__PURE__ */ new Set([
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "youtube-nocookie.com",
    "www.youtube-nocookie.com",
    "youtu.be",
    "www.youtu.be"
  ]);
  function normalizeUrl(value) {
    const stripped = value.replace(/[\t\n\r]/g, "");
    let start = 0;
    while (start < stripped.length && stripped.charCodeAt(start) <= 32) start += 1;
    return stripped.slice(start);
  }
  function hostOf(value) {
    const withoutScheme = normalizeUrl(value).replace(/^[a-z][a-z0-9+.-]*:/i, "").replace(/^\/\//, "");
    const end = withoutScheme.search(/[/?#]/);
    const authority = end === -1 ? withoutScheme : withoutScheme.slice(0, end);
    return authority.slice(authority.lastIndexOf("@") + 1).toLowerCase();
  }
  function isVideoPageUrl(value) {
    return VIDEO_PAGE_HOSTS.has(hostOf(value));
  }
  var FOCAL_POINTS = {
    center: "50% 50%",
    top: "50% 0%",
    bottom: "50% 100%",
    left: "0% 50%",
    right: "100% 50%",
    "top-left": "0% 0%",
    "top-right": "100% 0%",
    "bottom-left": "0% 100%",
    "bottom-right": "100% 100%"
  };
  var FOCAL_POINT_NAMES = Object.keys(FOCAL_POINTS);
  function focalPosition(focus) {
    return FOCAL_POINTS[focus] ?? FOCAL_POINTS.center;
  }
  function paintsOverlay(options) {
    return options.overlay !== "transparent" && options.overlayOpacity > 0;
  }
  function isVideoSource(src) {
    const path = src.split("?")[0].split("#")[0];
    const dot = path.lastIndexOf(".");
    if (dot <= path.lastIndexOf("/")) return false;
    return VIDEO_EXTENSIONS.has(path.slice(dot + 1).toLowerCase());
  }
  var ALLOWED_SCHEMES = /* @__PURE__ */ new Set(["http", "https"]);
  function schemeOf(value) {
    const match = /^([a-z][a-z0-9+.-]*):/i.exec(normalizeUrl(value));
    return match ? match[1].toLowerCase() : "";
  }
  function mediaSource(authored, name, ctx) {
    if (!authored) return authored;
    if (isVideoPageUrl(authored)) {
      ctx.warn(
        `background-media "${name}": "${authored}" is a video *page*, not a media file \u2014 a YouTube URL cannot be played by <video> and needs an iframe embed instead. Point "${name}" at an .mp4/.webm file, or use a YouTube facade alongside this effect.`
      );
      return "";
    }
    const scheme = schemeOf(authored);
    if (!scheme || ALLOWED_SCHEMES.has(scheme)) return authored;
    ctx.warn(
      `background-media "${name}": "${scheme}:" URLs are not allowed \u2014 use https:, http:, or a path such as "/media/hero.mp4".`
    );
    return "";
  }
  function styleLayer(node) {
    const { style } = node;
    style.setProperty("position", "absolute");
    style.setProperty("top", "0");
    style.setProperty("left", "0");
    style.setProperty("width", "100%");
    style.setProperty("height", "100%");
    style.setProperty("border-radius", "inherit");
    style.setProperty("pointer-events", "none");
    style.setProperty("z-index", "-1");
  }
  function createOverlay(doc, options) {
    const scrim = doc.createElement("div");
    styleLayer(scrim);
    scrim.style.setProperty("background", options.overlay);
    scrim.style.setProperty("opacity", String(options.overlayOpacity));
    scrim.setAttribute("aria-hidden", "true");
    return scrim;
  }
  function createVideo(doc, options) {
    const video = doc.createElement("video");
    video.muted = true;
    video.setAttribute("muted", "");
    video.playsInline = true;
    video.setAttribute("playsinline", "");
    video.loop = options.loop;
    video.defaultPlaybackRate = options.rate;
    video.playbackRate = options.rate;
    video.preload = "metadata";
    if (options.poster) video.poster = options.poster;
    video.src = options.src;
    return video;
  }
  function play2(video) {
    const started = video.play();
    if (started) void started.catch(() => {
    });
  }
  function startPlayback(video, win, options) {
    if (options.reducedMotion || options.autoplay === "never") return () => {
    };
    if (options.autoplay === "always") {
      play2(video);
      return () => {
        if (!video.paused) video.pause();
      };
    }
    return autoplayInView(video, win);
  }
  function createImage(doc, options) {
    const image = doc.createElement("img");
    image.alt = "";
    image.decoding = "async";
    image.src = options.src;
    return image;
  }
  function autoplayInView(video, win) {
    const Observer = win.IntersectionObserver;
    if (!Observer) return () => {
    };
    const observer = new Observer(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) play2(video);
          else if (!video.paused) video.pause();
        }
      },
      { threshold: 0 }
    );
    observer.observe(video);
    return () => {
      observer.disconnect();
      if (!video.paused) video.pause();
    };
  }
  function installBackgroundMedia(el, ctx, options) {
    const doc = el.ownerDocument;
    const video = isVideoSource(options.src) ? createVideo(doc, options) : null;
    const node = video ?? createImage(doc, options);
    styleLayer(node);
    node.style.setProperty("object-fit", options.fit);
    node.style.setProperty("object-position", options.position);
    node.setAttribute("aria-hidden", "true");
    node.setAttribute("data-kui-background", "");
    el.append(node);
    const overlay = paintsOverlay(options) ? createOverlay(doc, options) : null;
    if (overlay) {
      overlay.setAttribute("data-kui-background-overlay", "");
      el.append(overlay);
    }
    const stopPlayback = video ? startPlayback(video, ctx.win, options) : () => {
    };
    return {
      remove: () => {
        stopPlayback();
        node.remove();
        overlay?.remove();
      }
    };
  }

  // src/effects/catalog/media-shared.ts
  var AXIS_DEGREES = { vertical: 0, horizontal: 90 };
  var UNIT_DEGREES = { deg: 1, grad: 0.9, rad: 180 / Math.PI, turn: 360 };
  var BAND_OVERLAP_PX = 1;
  var STAGE_CLASS = "kui-slat-stage";
  var SLAT_CLASS = "kui-slat-item";
  var GOLDEN_RATIO_CONJUGATE = 0.6180339887498949;
  function slatOrder(index, count, from) {
    if (count <= 1) return 0;
    switch (from) {
      case "start":
        return index;
      case "end":
        return count - 1 - index;
      case "edges":
        return Math.min(index, count - 1 - index);
      case "random-ish":
        return Math.floor(index * GOLDEN_RATIO_CONJUGATE % 1 * count);
      case "alternate":
      default:
        return zigzagRank(index, count);
    }
  }
  function zigzagRank(index, count) {
    const fromStart = index;
    const fromEnd = count - 1 - index;
    const pair = Math.min(fromStart, fromEnd);
    return fromStart <= fromEnd ? pair * 2 : pair * 2 + 1;
  }
  function slatAngleDegrees(authored, axis) {
    const trimmed = authored.trim();
    if (!trimmed) return AXIS_DEGREES[axis];
    const match = /^(-?(?:\d+(?:\.\d+)?|\.\d+))(deg|rad|grad|turn)?$/.exec(trimmed);
    if (!match) return AXIS_DEGREES[axis];
    const value = Number(match[1]);
    if (!Number.isFinite(value)) return AXIS_DEGREES[axis];
    const unit = match[2] ?? "deg";
    const degrees = value * UNIT_DEGREES[unit];
    return (degrees % 180 + 180) % 180;
  }
  function slatTravelVector(angleDegrees) {
    const theta = angleDegrees * Math.PI / 180;
    return { x: -Math.sin(theta), y: Math.cos(theta) };
  }
  function slatBandClip(index, count, angleDegrees, box) {
    const { width, height } = box;
    const theta = angleDegrees * Math.PI / 180;
    const nx = Math.cos(theta);
    const ny = Math.sin(theta);
    const { x: dx, y: dy } = slatTravelVector(angleDegrees);
    const span = Math.abs(nx) * width + Math.abs(ny) * height;
    const centreX = width / 2;
    const centreY = height / 2;
    const step = span / count;
    const near = index * step - span / 2 - BAND_OVERLAP_PX;
    const far = (index + 1) * step - span / 2 + BAND_OVERLAP_PX;
    const reach = width + height;
    const corner = (along, across) => `${(centreX + along * nx + across * dx).toFixed(2)}px ${(centreY + along * ny + across * dy).toFixed(2)}px`;
    return `polygon(${corner(near, reach)}, ${corner(near, -reach)}, ${corner(far, -reach)}, ${corner(far, reach)})`;
  }
  function axisLabel(angleDegrees) {
    if (angleDegrees === 0) return "vertical";
    if (angleDegrees === 90) return "horizontal";
    return "diagonal";
  }
  function syncStageToImage(stage, img, bands) {
    const { slats, angleDegrees } = bands;
    const width = img.offsetWidth;
    const height = img.offsetHeight;
    stage.style.top = `${img.offsetTop}px`;
    stage.style.left = `${img.offsetLeft}px`;
    stage.style.width = `${width}px`;
    stage.style.height = `${height}px`;
    slats.forEach((slat, index) => {
      slat.style.clipPath = slatBandClip(index, slats.length, angleDegrees, { width, height });
    });
  }
  function watchImageBox(stage, img, win, bands) {
    const handler = () => syncStageToImage(stage, img, bands);
    win.addEventListener("resize", handler, { passive: true });
    const stopWindow = () => win.removeEventListener("resize", handler);
    const ResizeObserverCtor = win.ResizeObserver;
    if (!ResizeObserverCtor) return stopWindow;
    const observer = new ResizeObserverCtor(handler);
    observer.observe(img);
    return () => {
      stopWindow();
      observer.disconnect();
    };
  }
  function imagePaintStyle(img, win) {
    const computed = win.getComputedStyle(img);
    const position = computed.objectPosition || "50% 50%";
    const fit = computed.objectFit;
    if (fit === "cover") return { size: "cover", position };
    if (fit === "contain" || fit === "scale-down") return { size: "contain", position };
    if (fit === "none") return { size: "auto", position };
    return { size: "100% 100%", position };
  }
  function installSlatStage(el, doc, win, options) {
    const img = el.querySelector("img");
    if (!img) return null;
    const url = img.currentSrc || img.getAttribute("src") || "";
    if (!url) return null;
    const { count, angleDegrees, from, fold } = options;
    const travel = slatTravelVector(angleDegrees);
    const stage = doc.createElement("div");
    stage.className = STAGE_CLASS;
    stage.setAttribute("aria-hidden", "true");
    stage.dataset.kuiSlatAxis = axisLabel(angleDegrees);
    stage.dataset.kuiSlatAngle = String(angleDegrees);
    stage.dataset.kuiSlatFold = String(fold);
    stage.style.setProperty("--kui-slat-count", String(count));
    stage.style.setProperty("--kui-slat-dx", travel.x.toFixed(4));
    stage.style.setProperty("--kui-slat-dy", travel.y.toFixed(4));
    const paint = imagePaintStyle(img, win);
    const slats = [];
    for (let index = 0; index < count; index++) {
      const slat = doc.createElement("div");
      slat.className = SLAT_CLASS;
      slat.style.setProperty("--kui-slat-index", String(index));
      slat.style.setProperty("--kui-i", String(slatOrder(index, count, from)));
      slat.style.backgroundImage = `url("${url}")`;
      slat.style.backgroundSize = paint.size;
      slat.style.backgroundPosition = paint.position;
      stage.append(slat);
      slats.push(slat);
    }
    el.append(stage);
    const bands = { slats, angleDegrees };
    syncStageToImage(stage, img, bands);
    const stopWatching = watchImageBox(stage, img, win, bands);
    const imageStyles = createStyleLedger(img);
    imageStyles.set("visibility", "hidden");
    return {
      stage,
      slats,
      restore: () => {
        stopWatching();
        imageStyles.restore();
        stage.remove();
      }
    };
  }
  function applySlatTimingVars(stage, params) {
    const { durationMs, delayMs, easing } = params.timing;
    const duration = durationMs === void 0 ? params.text("duration", "500ms") : `${durationMs}ms`;
    const delay = delayMs === void 0 ? params.text("delay", "0ms") : `${delayMs}ms`;
    stage.style.setProperty("--kui-duration", duration);
    stage.style.setProperty("--kui-delay", delay);
    stage.style.setProperty("--kui-ease", easing ?? params.text("ease", "ease-out"));
    stage.style.setProperty("--kui-stagger", params.text("stagger", "60ms"));
  }
  function slatAssembleFinishMs(params, count) {
    if (count === 0) return 0;
    const durationMs = params.timing.durationMs ?? params.ms("duration", 500);
    const delayMs = params.timing.delayMs ?? params.ms("delay", 0);
    const staggerMs = params.ms("stagger", 60);
    return delayMs + (count - 1) * staggerMs + durationMs;
  }

  // src/effects/catalog/media.ts
  var geometry = {
    distance: { type: "length", default: "24px", cssProperty: "--kui-distance" },
    scale: { type: "number", default: "1.12", cssProperty: "--kui-to-scale" }
  };
  var MEDIA_CSS_PRIMITIVES = [
    cssPrimitive("media-wipe", [CHANNEL.clip]),
    cssPrimitive("media-mask", ["mask"], { perfClass: "paint" }),
    // Not `reducedMotion: 'disable'` — that policy means "no finite duration would make sense,
    // because the animation never ends" (see `ambient.ts`/`feedback.ts`), and a Ken Burns pan/zoom
    // is the opposite of that: a one-shot cinematic move with a real, shortenable duration. The demo
    // authors it as `ken-burns 9000ms` (a still image, one slow zoom, then it holds) and
    // `ken-burns 3000ms on:hover` (zooms in while hovered), and its complement `ken-burns-out` is a
    // second one-shot preset for the reverse move — not a `-loop` variant the way `typewriter-loop`
    // or `marquee`/`marquee-scroll-linked` are. `kui-ken-burns`'s keyframe (`scale: 1` to `1.12`,
    // no loop-safe midpoint) is shaped for exactly that: run once, land on the zoomed frame, stay
    // there. `'disable'` here previously looked like the same missing-`--kui-fx-*-iterations` bug as
    // `marquee`/`gradient-shimmer`, but the actual defect was this policy — the default `'shorten'`
    // is correct, so no `--kui-fx-ken-burns-iterations` is needed at all.
    cssPrimitive("media-ken-burns", [CHANNEL.translate, CHANNEL.scale], {
      parameters: geometry
    }),
    cssPrimitive("media-filter", [CHANNEL.filter], {
      defaultActivation: "hover",
      perfClass: "paint"
    }),
    // `geometry.distance` only, not `...geometry`: `kui-blur-up` (media.css) reads `--kui-distance`
    // and `--kui-blur` but never `--kui-to-scale` — this primitive doesn't even declare
    // `CHANNEL.scale`. Spreading the whole shared object used to expose `scale:` as an
    // apparently-valid, silently-inert parameter, the same shape `flip-3d`'s dead `perspective`
    // parameter was (`entrance.css`'s comment on `kui-flip-in-x`).
    cssPrimitive("media-blur-up", [CHANNEL.translate, CHANNEL.filter], {
      parameters: {
        distance: geometry.distance,
        blur: { type: "length", default: "16px", cssProperty: "--kui-blur" }
      },
      perfClass: "paint"
    }),
    // No `defaultActivation` — same convention `core.ts`'s `parallax`/`parallax-scale`/
    // `parallax-rotate`/`scroll-fade`/`desaturate`/`skew`/`progress`/`progress-stroke` already use
    // for every other `timelines: ['view', 'scroll', ...]` primitive. `resolveActivation`
    // (`animator.ts`) only consults `defaultActivation` when the author named no activation, and
    // falls through to `element-config.ts`'s hardcoded `'enter'` when a primitive declares none.
    // Setting it to `'manual'` here (matching `activations: ['manual']`) looked like the obviously
    // correct pairing, but it is what actually broke the effect: `effectiveActivation`
    // (`style-plan.ts`) only converts a stuck `'manual'` into `'enter'` when `config.timeline !==
    // 'time'` — i.e. only once the author has actually written `timeline:view`/`timeline:scroll`.
    // Authored bare (no `timeline:`, the sweep's own probe and the likely first thing anyone
    // tries), `config.timeline` stays the default `'time'`, that conversion never fires, and the
    // element sits at `data-kui-state="ready"` forever — which is also the state
    // `entrance.css`'s `[data-kui-state='ready'] { --kui-distance: 0px !important; }` targets, so
    // every sample read the same permanently-zeroed `--kui-distance`: not a paused animation, a
    // zeroed one. `timeline:view`/`timeline:scroll` usage is unaffected either way, since a native
    // timeline resolves to the `'native-timeline'` gate before activation is even consulted.
    // `geometry.distance` only: `kui-image-parallax-frame` never reads `--kui-to-scale` and this
    // primitive doesn't declare `CHANNEL.scale` — same dead-parameter shape as `media-blur-up` above.
    cssPrimitive("media-parallax-frame", [CHANNEL.translate], {
      parameters: { distance: geometry.distance },
      timelines: ["view", "scroll"],
      activations: ["manual"],
      reducedMotion: "disable"
    }),
    // Its own `scale` parameter, not `geometry`: `kui-lightbox-open` opens from a fixed 0.92, never
    // reading `--kui-to-scale` (or any `distance`, since this primitive doesn't animate position at
    // all) — the whole shared object was dead weight here. Unlike `media-blur-up`/
    // `media-parallax-frame`, this primitive *does* declare `CHANNEL.scale`, so the fix is to wire
    // the keyframe up to a real parameter rather than remove the promise: `--kui-from-scale`, the
    // same name and "starts at this scale, animates to 1" meaning `scale`/`scale-move`
    // (`catalog/core.ts`) already use, so `lightbox-open scale:0.8` now does what it looks like it
    // should. See `kui-lightbox-open` in `media.css`.
    cssPrimitive("media-lightbox", [CHANNEL.opacity, CHANNEL.scale], {
      parameters: { scale: { type: "number", default: "0.92", cssProperty: "--kui-from-scale" } }
    })
  ];
  var MEDIA_CSS_PRESETS = [
    { name: "wipe-up", primitive: "media-wipe", keyframes: "kui-wipe-up", cloak: true },
    { name: "wipe-down", primitive: "media-wipe", keyframes: "kui-wipe-down", cloak: true },
    { name: "wipe-left", primitive: "media-wipe", keyframes: "kui-wipe-left", cloak: true },
    { name: "wipe-right", primitive: "media-wipe", keyframes: "kui-wipe-right", cloak: true },
    { name: "wipe-circle", primitive: "media-wipe", keyframes: "kui-wipe-circle", cloak: true },
    { name: "wipe-diagonal", primitive: "media-wipe", keyframes: "kui-wipe-diagonal", cloak: true },
    { name: "mask-reveal", primitive: "media-mask", keyframes: "kui-mask-reveal", cloak: true },
    { name: "curtain-reveal", primitive: "media-wipe", keyframes: "kui-curtain-reveal", cloak: true },
    { name: "ken-burns", primitive: "media-ken-burns", keyframes: "kui-ken-burns" },
    { name: "ken-burns-out", primitive: "media-ken-burns", keyframes: "kui-ken-burns-out" },
    { name: "blur-up", primitive: "media-blur-up", keyframes: "kui-blur-up", cloak: true },
    { name: "duotone-hover", primitive: "media-filter", keyframes: "kui-duotone-hover" },
    { name: "grayscale-hover", primitive: "media-filter", keyframes: "kui-grayscale-hover" },
    { name: "saturate-hover", primitive: "media-filter", keyframes: "kui-saturate-hover" },
    {
      name: "image-parallax-frame",
      primitive: "media-parallax-frame",
      keyframes: "kui-image-parallax-frame"
    },
    { name: "before-after-wipe", primitive: "media-wipe", keyframes: "kui-before-after-wipe" },
    { name: "lightbox-open", primitive: "media-lightbox", keyframes: "kui-lightbox-open" }
  ];
  var slatParams = {
    slats: {
      type: "number",
      default: "8",
      cssProperty: "--kui-slats",
      minimum: 2,
      maximum: 24,
      integer: true
    },
    axis: {
      type: "keyword",
      default: "vertical",
      cssProperty: "--kui-axis",
      values: ["vertical", "horizontal"]
    },
    /*
     * The general form of `axis:`, in degrees: `0deg` is `axis:vertical`, `90deg` is
     * `axis:horizontal`, and anything between cuts the picture into diagonal bands. An authored
     * angle wins; leaving it off reads `axis:`, so every existing attribute keeps its meaning.
     *
     * `text`, not `angle`, for one reason: `readParams` pre-fills every declared parameter with its
     * schema default, so a typed default is indistinguishable from an authored value and there would
     * be no way to tell `angle:0deg` from "no angle, use the axis". An empty default is only possible
     * on a type that is never written to a stylesheet, which is exactly what `text` is for — and this
     * value never reaches CSS anyway. `slatAngleDegrees` does the parsing and the range clamp.
     */
    angle: { type: "text", default: "", cssProperty: "--kui-slat-angle" },
    from: {
      type: "keyword",
      default: "alternate",
      cssProperty: "--kui-from",
      values: ["alternate", "start", "end", "edges", "random-ish"]
    },
    fold: { type: "keyword", default: "false", cssProperty: "--kui-fold", values: ["true", "false"] },
    duration: { type: "time", default: "500ms", cssProperty: "--kui-duration" },
    ...TRIGGER_DELAY_PARAM,
    ease: { type: "easing", default: "ease-out", cssProperty: "--kui-ease" },
    stagger: { type: "time", default: "60ms", cssProperty: "--kui-stagger" }
  };
  function prepareSlatAssemble(el, params, ctx) {
    const doc = el.ownerDocument;
    const count = Math.min(24, Math.max(2, Math.round(params.num("slats", 8))));
    const axis = params.text("axis", "vertical");
    const angleDegrees = slatAngleDegrees(params.text("angle", ""), axis);
    const from = params.text("from", "alternate");
    const fold = params.is("fold");
    const node = el;
    if (ctx.win.getComputedStyle(node).position === "static") ctx.style.set("position", "relative");
    const built = installSlatStage(el, doc, ctx.win, { count, angleDegrees, from, fold });
    if (!built) return () => {
    };
    const { stage } = built;
    applySlatTimingVars(stage, params);
    stage.classList.add("kui-slat-animating");
    let settle2;
    const finished = new Promise((resolve) => {
      settle2 = resolve;
    });
    let landed = false;
    const land = () => {
      if (landed) return;
      landed = true;
      stage.classList.remove("kui-slat-animating");
      built.restore();
      settle2();
    };
    const timer = ctx.win.setTimeout(land, slatAssembleFinishMs(params, count));
    return {
      cleanup: () => {
        ctx.win.clearTimeout(timer);
        if (landed) return;
        landed = true;
        built.restore();
      },
      finished,
      finish: () => {
        ctx.win.clearTimeout(timer);
        land();
      }
    };
  }
  var backgroundMediaParams = {
    /*
     * `text`, and same-origin-checked at the point of use rather than by the type — identical
     * shape and identical reasoning to `media-scrub`'s own `src` (`scroll-mechanics/primitives.ts`).
     * A URL has no lexical shape to validate against, and `type: 'text'` is the one type that never
     * reaches a stylesheet, which is what makes accepting arbitrary path characters safe.
     */
    src: { type: "text", default: "", cssProperty: "--kui-src" },
    /*
     * The still a `<video>` shows before its first frame decodes. Not optional polish: without it a
     * background clip paints as an empty box for as long as the network takes, and that box is the
     * backdrop to the author's text — the one place on the page where a flash of nothing is most
     * visible. Every background video in this repo's own demo pages is authored with one.
     */
    poster: { type: "text", default: "", cssProperty: "--kui-poster" },
    /*
     * `fill`, `none` and `scale-down` are deliberately absent. `fill` is the only `object-fit` value
     * that distorts — it stretches the picture to the box rather than cropping it — and the standing
     * rule for imagery in this project is to crop, never stretch. The other two leave the media at
     * its intrinsic size inside a box sized to something else, which for a *backdrop* is a gap, not
     * a layout. Adding them would be offering three ways to get a broken background.
     */
    fit: {
      type: "keyword",
      default: "cover",
      cssProperty: "--kui-fit",
      values: ["cover", "contain"]
    },
    /*
     * Which part of the picture a `cover` crop keeps. Nine named points rather than a free
     * `object-position` string, because a free string would have to be `type: 'text'` — the one type
     * that is explicitly never written to a stylesheet (see `core/params.ts`) — and this value is
     * written to one. A keyword list is validated against its own `values`, so the author gets real
     * focal control and the CSS surface stays closed.
     */
    focus: {
      type: "keyword",
      default: "center",
      cssProperty: "--kui-focus",
      values: FOCAL_POINT_NAMES
    },
    /*
     * The scrim. This is the parameter that makes the whole effect usable, because the point of a
     * backdrop here is animated text on top of it, and text over unmodified footage is illegible
     * about half the time — a light frame arrives and the headline vanishes for those seconds.
     *
     * `type: 'color'` so it goes through the same validator every other colour does. `transparent`
     * as the default rather than an empty string for the same reason: `''` is not a colour, and a
     * default that its own type would reject is a lie the schema cannot catch. It is also the honest
     * spelling of "no scrim", and no scrim node is created for it.
     */
    overlay: { type: "color", default: "transparent", cssProperty: "--kui-overlay" },
    /*
     * Separate from the colour rather than folded into it. `overlay:rgb(0 0 0 / 45%)` does parse —
     * the tokenizer is paren-aware — but `overlay:black overlay-opacity:45%` is the spelling someone
     * reaches for while tuning legibility, and tuning is exactly what this value is for.
     */
    "overlay-opacity": { type: "percentage", default: "100%", cssProperty: "--kui-overlay-opacity" },
    /*
     * The opt-out for the play-while-visible behaviour. `in-view` pairs the clip with the viewport
     * and is right for a long section. `always` is for a short hero clip that must never be caught
     * mid-stall by a visibility heuristic. `never` installs the clip and leaves it on its poster,
     * which is also where any mode lands under a reduced-motion preference.
     */
    autoplay: {
      type: "keyword",
      default: "in-view",
      cssProperty: "--kui-autoplay",
      values: ["in-view", "always", "never"]
    },
    /*
     * Bounded at both ends: `0` is a clip that is loaded, decoding, and permanently frozen — worse
     * than `autoplay:never`, which at least says so — and browsers stop honouring rates past roughly
     * 4 anyway, so a larger number is a silent no-op rather than a faster clip.
     */
    rate: {
      type: "number",
      default: "1",
      cssProperty: "--kui-rate",
      finite: true,
      minimum: 0.25,
      maximum: 4
    },
    loop: { type: "keyword", default: "true", cssProperty: "--kui-loop", values: ["true", "false"] }
    /*
     * There is deliberately no `controls:`. The layer this primitive builds paints at `z-index: -1`
     * behind the author's own children, so a native control bar there is focusable by keyboard and
     * occluded by whatever the page happens to put over it — a player you can tab into and cannot
     * see. A clip meant to be controlled is a content `<video controls>` the author writes, not a
     * background one.
     */
  };
  function prepareBackgroundMedia(el, params, ctx) {
    const authored = params.text("src");
    if (!authored) {
      ctx.warn('background-media needs a "src:" \u2014 nothing installed');
      return () => {
      };
    }
    const src = mediaSource(authored, "src", ctx);
    if (!src) return () => {
    };
    const node = el;
    if (ctx.win.getComputedStyle(node).position === "static") ctx.style.set("position", "relative");
    ctx.style.set("isolation", "isolate");
    const layer = installBackgroundMedia(el, ctx, {
      src,
      poster: mediaSource(params.text("poster"), "poster", ctx),
      fit: params.is("fit", "contain") ? "contain" : "cover",
      position: focalPosition(params.text("focus", "center")),
      overlay: params.text("overlay", "transparent"),
      // `num` returns a percentage as a 0–1 ratio, which is exactly what `opacity` takes.
      overlayOpacity: Math.min(1, Math.max(0, params.num("overlay-opacity", 1))),
      autoplay: params.text("autoplay", "in-view"),
      rate: params.num("rate", 1),
      // `!is('loop', 'false')`, not `is('loop')`. Every other read here names its own fallback, and
      // this one has to as well: `is()` takes no fallback argument, so a bare `is('loop')` is only
      // true when something already filled the schema default in. That holds on the animator's path
      // (`readEffectParams` pre-fills every declared parameter) and not on `createParams`, so the
      // positive spelling silently defaulted a true-by-default parameter to false for any caller
      // handing over raw values. Reading it as "loop unless explicitly told not to" states the
      // default at the point of use, where it cannot drift.
      loop: !params.is("loop", "false"),
      reducedMotion: ctx.reducedMotion
    });
    return continuousSetup(layer.remove);
  }
  var MEDIA_JS_PRIMITIVES = [
    {
      id: "slat-assemble",
      renderer: "javascript",
      channels: [CHANNEL.opacity, CHANNEL.translate, CHANNEL.rotate],
      parameters: slatParams,
      supportedTimelines: ["time"],
      supportedActivations: ["load", "enter", "hover", "focus", "click", "manual"],
      defaultActivation: "enter",
      perfClass: "dom-transform",
      // Same reasoning as every JS-rendered primitive in `text.ts`: nothing here declares a CSS
      // `animation-duration` the reduced-motion policy layer could shorten, and `disable` is what
      // stops `installSlatStage`'s DOM surgery from ever running at all under reduced motion — the
      // animator never calls `activate()`, so the wrapped `<img>` is simply left exactly as authored.
      reducedMotion: "disable",
      // Land()ing hands the picture back to the real `<img>` and tears down every slat — see
      // `prepareSlatAssemble`'s `land()`. Declared, not assumed: see `restoresOnFinish`'s own comment
      // in `core/types.ts` for why the catalog's default is the opposite of this.
      restoresOnFinish: true,
      prepare: deferPrepare(prepareSlatAssemble)
    },
    {
      id: "background-media",
      /*
       * `media` is the same word `media-scrub` uses for "this effect owns what the element shows",
       * and it is what makes `background-media, video-scrub` on one element a reported conflict
       * rather than two effects silently fighting over the same picture.
       *
       * `layout` is claimed for the same reason `pin` claims it: preparation writes `position` and
       * `isolation` on the *host*, which is a stacking-context claim on someone else's element. Left
       * undeclared, `background-media, pin-section` composed silently while both decided what
       * `position` the host has — the conflict detector cannot report a claim it was never told about.
       */
      channels: ["media", "layout"],
      renderer: "javascript",
      parameters: backgroundMediaParams,
      // Not a claim to support four timelines — an abstention. A backdrop is not driven by progress
      // of any kind and this primitive never reads `Timeline`; the list exists only so that
      // `data-kui="background-media src:/hero.mp4, parallax"` plus a `timeline:view` survives
      // `compile.ts`'s `intersect`. See `TIMELINE_AGNOSTIC` (`effects/shared.ts`), shared with the
      // scroll-mechanics drivers, which abstain for the same reason.
      supportedTimelines: TIMELINE_AGNOSTIC,
      supportedActivations: ["load", "enter", "manual"],
      /*
       * `'load'`, not the catalog's usual `'enter'`, and this is the difference between working and
       * not. A backdrop is the element's appearance, so gating it on an IntersectionObserver means a
       * section that is already on screen at page load, one in a background tab (no IO callbacks
       * fire at all until the tab is foregrounded), or one whose own box is still zero-area waits an
       * unbounded time to have any background — and unlike a missed reveal, that is a visibly broken
       * page. An author who *wants* a heavy clip deferred can still write `on:enter`.
       */
      defaultActivation: "load",
      perfClass: "paint",
      /*
       * `'shorten'`, unlike every other JS-rendered primitive in this file and in `text.ts`, and
       * deliberately so. `'disable'` means the animator never calls `activate()` under a reduced
       * motion preference, which for an animation is exactly right and for this is not: it would
       * leave the element with no backdrop at all rather than a calmer one. There is no CSS duration
       * here for `'shorten'` to shorten, so the policy is inert and the effect installs normally;
       * `ctx.reducedMotion` is then read inside, where it suppresses the one genuinely motion-y part
       * — a clip's autoplay — and leaves the poster frame standing. See `autoplayInView`.
       */
      reducedMotion: "shorten",
      prepare: deferPrepare(prepareBackgroundMedia)
    }
  ];
  var MEDIA_JS_PRESETS = [
    { name: "slat-assemble", primitive: "slat-assemble", cloak: true },
    /*
     * Two names, one primitive — the alias shape the catalog already uses everywhere (`pin-until`,
     * `pin-spacer` and `stacking-cards` are three names over the one `pin` primitive; six `wipe-*`
     * names share `media-wipe`). A preset row is the alias mechanism, so a second spelling costs a
     * table entry and nothing else: no duplicated implementation to keep in sync, and both names
     * resolve to the same `prepare`.
     *
     * No `cloak` on either: the pre-JS cloak rule hides an element until the runtime installs the
     * effect's from-state, and this element is the author's own content. Cloaking it would blank
     * their text for as long as the bundle takes to arrive, to hide a backdrop that has no
     * from-state at all.
     */
    { name: "bg", primitive: "background-media" },
    { name: "background", primitive: "background-media" }
  ];
  var MEDIA_PRIMITIVES = [...MEDIA_CSS_PRIMITIVES, ...MEDIA_JS_PRIMITIVES];
  var MEDIA_PRESETS = [...MEDIA_CSS_PRESETS, ...MEDIA_JS_PRESETS];
  function registerMedia(registry) {
    return registry.registerPrimitives(MEDIA_PRIMITIVES).registerPresets(MEDIA_PRESETS);
  }

  // src/effects/catalog/subtree-capture.ts
  function captureChildren(el) {
    const authored = Array.from(el.childNodes);
    return () => {
      el.replaceChildren(...authored);
    };
  }

  // src/effects/catalog/numbers-shared.ts
  var SR_ONLY_CLASS = "kui-sr-only";
  var DECORATIVE_CLASS = "kui-count-decorative";
  function installCountLayers(el, doc) {
    const restoreChildren = captureChildren(el);
    const decorative = doc.createElement("span");
    decorative.setAttribute("aria-hidden", "true");
    decorative.className = DECORATIVE_CLASS;
    const srOnly = doc.createElement("span");
    srOnly.className = SR_ONLY_CLASS;
    srOnly.setAttribute("aria-live", "polite");
    el.textContent = "";
    el.append(decorative, srOnly);
    return {
      decorative,
      srOnly,
      restore: restoreChildren
    };
  }
  function easeOutCubic(t) {
    const clamped = Math.min(Math.max(t, 0), 1);
    return 1 - (1 - clamped) ** 3;
  }
  function tweenValue(t, from, to) {
    return from + (to - from) * t;
  }
  function cubicBezier(x1, y1, x2, y2) {
    const cx = 3 * x1;
    const bx = 3 * (x2 - x1) - cx;
    const ax = 1 - cx - bx;
    const cy = 3 * y1;
    const by = 3 * (y2 - y1) - cy;
    const ay = 1 - cy - by;
    const sampleX = (t) => ((ax * t + bx) * t + cx) * t;
    const sampleY = (t) => ((ay * t + by) * t + cy) * t;
    const slopeX = (t) => (3 * ax * t + 2 * bx) * t + cx;
    function solveT(x) {
      let t = x;
      for (let i = 0; i < 8; i++) {
        const slope = slopeX(t);
        if (Math.abs(slope) < 1e-6) break;
        const next = t - (sampleX(t) - x) / slope;
        if (Math.abs(sampleX(next) - x) < 1e-6) return next;
        t = next;
      }
      let lo = 0;
      let hi = 1;
      t = x;
      while (hi - lo > 1e-6) {
        if (sampleX(t) < x) lo = t;
        else hi = t;
        t = (lo + hi) / 2;
      }
      return t;
    }
    return (t) => sampleY(solveT(Math.min(Math.max(t, 0), 1)));
  }
  var EASING_KEYWORDS2 = {
    ease: [0.25, 0.1, 0.25, 1],
    "ease-in": [0.42, 0, 1, 1],
    "ease-out": [0, 0, 0.58, 1],
    "ease-in-out": [0.42, 0, 0.58, 1],
    "expo-in": [0.7, 0, 0.84, 0],
    "expo-out": [0.16, 1, 0.3, 1],
    "expo-in-out": [0.87, 0, 0.13, 1],
    "back-in": [0.36, 0, 0.66, -0.56],
    "back-out": [0.34, 1.56, 0.64, 1],
    "back-in-out": [0.68, -0.6, 0.32, 1.6],
    "quart-out": [0.25, 1, 0.5, 1],
    "circ-out": [0, 0.55, 0.45, 1]
  };
  var CUBIC_BEZIER_FN = /^cubic-bezier\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)$/i;
  function resolveEasing(easing, warn) {
    if (easing === void 0) return easeOutCubic;
    if (easing === "linear") return (t) => Math.min(Math.max(t, 0), 1);
    const keyword = EASING_KEYWORDS2[easing];
    if (keyword) return cubicBezier(...keyword);
    const fn = CUBIC_BEZIER_FN.exec(easing);
    if (fn) return cubicBezier(Number(fn[1]), Number(fn[2]), Number(fn[3]), Number(fn[4]));
    warn(`easing "${easing}" has no JS equivalent for a counter tween \u2014 using the default ease-out`);
    return easeOutCubic;
  }
  var COMPACT_OPTIONS = { notation: "compact", maximumFractionDigits: 1 };
  function formatCount(value, options) {
    const { format, decimals, currency } = options;
    if (format === "currency") {
      return new Intl.NumberFormat(void 0, {
        style: "currency",
        currency,
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals
      }).format(value);
    }
    if (format === "percent") {
      return new Intl.NumberFormat(void 0, {
        style: "percent",
        minimumFractionDigits: decimals,
        maximumFractionDigits: decimals
      }).format(value);
    }
    if (format === "compact") {
      return new Intl.NumberFormat(void 0, COMPACT_OPTIONS).format(value);
    }
    return new Intl.NumberFormat(void 0, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals
    }).format(value);
  }
  function paddedDigits(value, width) {
    return Math.round(Math.max(0, value)).toString().padStart(width, "0");
  }
  function groupDigits(digits) {
    const groups = [];
    for (let end = digits.length; end > 0; end -= 3) {
      groups.unshift(digits.slice(Math.max(0, end - 3), end));
    }
    return groups.join(",");
  }
  function odometerTokens(grouped) {
    return [...grouped].map((char) => ({ char, digit: char >= "0" && char <= "9" }));
  }

  // src/effects/catalog/numbers.ts
  var COUNT_STEP_MS = 16;
  var REDUCED_MOTION_DURATION_MS = 1;
  var countParams = {
    duration: { type: "time", default: "1600ms", cssProperty: "--kui-duration" },
    ...TRIGGER_DELAY_PARAM,
    from: { type: "number", default: "0", cssProperty: "--kui-from" },
    to: { type: "number", default: "100", cssProperty: "--kui-to" },
    decimals: {
      type: "number",
      default: "0",
      cssProperty: "--kui-decimals",
      integer: true,
      minimum: 0,
      maximum: 6
    },
    format: {
      type: "keyword",
      default: "number",
      cssProperty: "--kui-format",
      values: ["number", "currency", "percent", "compact"]
    },
    currency: { type: "text", default: "USD", cssProperty: "--kui-currency" }
  };
  var odometerParams = {
    duration: { type: "time", default: "1600ms", cssProperty: "--kui-duration" },
    ...TRIGGER_DELAY_PARAM,
    from: { type: "number", default: "0", cssProperty: "--kui-from" },
    to: { type: "number", default: "100", cssProperty: "--kui-to" }
  };
  function countPrimitive(id, parameters, prepare) {
    return {
      id,
      renderer: "javascript",
      channels: ["content"],
      parameters,
      supportedTimelines: ["time"],
      supportedActivations: ["load", "enter", "hover", "focus", "click", "manual"],
      defaultActivation: "enter",
      perfClass: "dom-transform",
      // Not 'disable': the animator would then skip activation entirely under reduced motion,
      // leaving the counter permanently blank. `prepareTween` reads `ctx.reducedMotion` itself and
      // collapses the ramp to one effectively-instant tick instead, so the final value still lands.
      reducedMotion: "shorten",
      prepare
    };
  }
  function tweenDurationMs(params, ctx) {
    return ctx.reducedMotion ? REDUCED_MOTION_DURATION_MS : Math.max(0, effectDurationMs(params, 1600));
  }
  function tweenTimingFor(params, ctx) {
    return {
      durationMs: tweenDurationMs(params, ctx),
      // Positional first, then the same-named parameter — the two-spellings rule `effectDurationMs`
      // applies to `duration` just above, now applied to `delay` as well.
      delayMs: Math.max(0, params.timing.delayMs ?? params.ms("delay", 0)),
      easing: resolveEasing(params.timing.easing, ctx.warn)
    };
  }
  function tweenNumber(ctx, tween) {
    const { from, to, durationMs, delayMs, easing, onTick } = tween;
    let elapsed = 0;
    let handle;
    let settle2;
    const finished = new Promise((resolve) => {
      settle2 = resolve;
    });
    const stop = () => {
      ctx.win.clearTimeout(start);
      if (handle !== void 0) ctx.win.clearInterval(handle);
    };
    const tick = () => {
      elapsed += COUNT_STEP_MS;
      const ratio = durationMs <= 0 ? 1 : Math.min(elapsed / durationMs, 1);
      const done = ratio >= 1;
      onTick(tweenValue(easing(ratio), from, to), done);
      if (done) {
        stop();
        settle2();
      }
    };
    const start = ctx.win.setTimeout(() => {
      handle = ctx.win.setInterval(tick, COUNT_STEP_MS);
    }, delayMs);
    return {
      cleanup: stop,
      finished,
      finish: () => {
        stop();
        onTick(to, true);
        settle2();
      }
    };
  }
  function prepareCount(el, params, ctx) {
    const doc = el.ownerDocument;
    const from = params.num("from", 0);
    const to = params.num("to", 100);
    const decimals = Math.max(0, Math.round(params.num("decimals", 0)));
    const format = params.text("format", "number");
    const currency = params.text("currency", "USD");
    const options = { format, decimals, currency };
    const layers = installCountLayers(el, doc);
    layers.decorative.textContent = formatCount(from, options);
    layers.srOnly.textContent = formatCount(from, options);
    const tween = tweenNumber(ctx, {
      from,
      to,
      ...tweenTimingFor(params, ctx),
      onTick: (value, done) => {
        layers.decorative.textContent = formatCount(value, options);
        if (done) layers.srOnly.textContent = formatCount(to, options);
      }
    });
    return {
      cleanup: () => {
        tween.cleanup();
        layers.restore();
      },
      finished: tween.finished,
      finish: tween.finish
    };
  }
  function buildOdometerColumns(container, doc, grouped) {
    const strips = [];
    for (const token of odometerTokens(grouped)) {
      if (!token.digit) {
        container.append(doc.createTextNode(token.char));
        continue;
      }
      const column = doc.createElement("span");
      column.className = "kui-odometer-col";
      const strip = doc.createElement("span");
      strip.className = "kui-odometer-strip";
      for (let digit = 0; digit <= 9; digit++) {
        const row = doc.createElement("span");
        row.textContent = String(digit);
        strip.append(row);
      }
      strip.style.setProperty("--kui-o", token.char);
      column.append(strip);
      container.append(column);
      strips.push(strip);
    }
    return strips;
  }
  function updateOdometerColumns(strips, grouped) {
    let index = 0;
    for (const token of odometerTokens(grouped)) {
      if (!token.digit) continue;
      strips[index]?.style.setProperty("--kui-o", token.char);
      index++;
    }
  }
  function prepareOdometer(el, params, ctx) {
    const doc = el.ownerDocument;
    const from = Math.max(0, params.num("from", 0));
    const to = Math.max(0, params.num("to", 100));
    const width = Math.max(String(Math.round(from)).length, String(Math.round(to)).length);
    const toGrouped = groupDigits(paddedDigits(to, width));
    const fromGrouped = groupDigits(paddedDigits(from, width));
    const layers = installCountLayers(el, doc);
    layers.srOnly.textContent = fromGrouped;
    const strips = buildOdometerColumns(layers.decorative, doc, fromGrouped);
    const tween = tweenNumber(ctx, {
      from,
      to,
      ...tweenTimingFor(params, ctx),
      onTick: (value, done) => {
        updateOdometerColumns(strips, groupDigits(paddedDigits(value, width)));
        if (done) layers.srOnly.textContent = toGrouped;
      }
    });
    return {
      cleanup: () => {
        tween.cleanup();
        layers.restore();
      },
      finished: tween.finished,
      finish: tween.finish
    };
  }
  var COUNT_PRIMITIVES = [
    countPrimitive("count", countParams, deferPrepare(prepareCount)),
    countPrimitive("count-odometer", odometerParams, deferPrepare(prepareOdometer))
  ];
  var COUNT_PRESETS = [
    { name: "count-up", primitive: "count", params: { from: "0", to: "100" } },
    { name: "count-down", primitive: "count", params: { from: "100", to: "0" } },
    {
      name: "count-currency",
      primitive: "count",
      params: { from: "0", to: "4820", format: "currency", currency: "USD", decimals: "0" }
    },
    {
      name: "count-percent",
      primitive: "count",
      params: { from: "0", to: "0.82", format: "percent", decimals: "0" }
    },
    {
      name: "count-compact",
      primitive: "count",
      params: { from: "0", to: "128400", format: "compact" }
    },
    { name: "odometer-roll", primitive: "count-odometer", params: { from: "0", to: "4820" } }
  ];
  var METER_PRIMITIVES = [
    cssPrimitive("stroke-sweep", [CHANNEL.stroke]),
    // `from` gives `progress-bar` a real knob on its start scale — it had none before. `--kui-bar-from`
    // is also what the `[data-kui-fx~='progress-bar'][data-kui-state='ready']` gate in numbers.css
    // neutralizes; see that rule's comment for the on:enter fix this parameter doubles as.
    cssPrimitive("meter-bar", [CHANNEL.scale], {
      parameters: { from: { type: "number", default: "0", cssProperty: "--kui-bar-from" } }
    }),
    cssPrimitive("meter-segments", [CHANNEL.opacity]),
    cssPrimitive("meter-stars", [CHANNEL.clip])
  ];
  var METER_PRESETS = [
    { name: "progress-ring", primitive: "stroke-sweep", keyframes: "kui-progress-ring" },
    { name: "gauge-sweep", primitive: "stroke-sweep", keyframes: "kui-gauge-sweep" },
    { name: "donut-sweep", primitive: "stroke-sweep", keyframes: "kui-donut-sweep" },
    { name: "sparkline-draw", primitive: "stroke-sweep", keyframes: "kui-sparkline-draw" },
    // `cloak: true`: `kui-progress-bar`'s `from { scale: 0 1 }` (numbers.css) is a zero-width box
    // while paused, not just an invisible one — so while it waits it occupies no space in layout at
    // all. Not, despite the tidier story, because an observer refuses to fire on it: Chromium was
    // measured resolving a zero-area target's `intersectionRatio` to `1`. See numbers.css's
    // `[data-kui-fx~='progress-bar'][data-kui-state='ready']` rule for the geometry half of the fix;
    // `cloak` keeps the pre-JS and post-JS "waiting" look the same (invisible) either side of it.
    { name: "progress-bar", primitive: "meter-bar", keyframes: "kui-progress-bar", cloak: true },
    { name: "progress-segments", primitive: "meter-segments", keyframes: "kui-progress-segments" },
    { name: "star-rating-fill", primitive: "meter-stars", keyframes: "kui-star-rating-fill" }
  ];
  var NUMBERS_PRIMITIVES = [...COUNT_PRIMITIVES, ...METER_PRIMITIVES];
  var NUMBERS_PRESETS = [...COUNT_PRESETS, ...METER_PRESETS];
  function registerNumbers(registry) {
    return registry.registerPrimitives(NUMBERS_PRIMITIVES).registerPresets(NUMBERS_PRESETS);
  }

  // src/effects/catalog/text-shared.ts
  var SR_ONLY_CLASS2 = "kui-sr-only";
  var DECORATIVE_CLASS2 = "kui-split-decorative";
  function installSplitLayers(el, doc) {
    const originalText = el.textContent.trim();
    const restoreChildren = captureChildren(el);
    const decorative = doc.createElement("span");
    decorative.setAttribute("aria-hidden", "true");
    decorative.className = DECORATIVE_CLASS2;
    const srOnly = doc.createElement("span");
    srOnly.className = SR_ONLY_CLASS2;
    srOnly.textContent = originalText;
    el.textContent = "";
    el.append(decorative, srOnly);
    return {
      decorative,
      originalText,
      restore: restoreChildren
    };
  }
  function segmentGraphemes(text) {
    const segmenter = new Intl.Segmenter(void 0, { granularity: "grapheme" });
    return Array.from(segmenter.segment(text), (entry) => entry.segment);
  }
  function segmentWords(text) {
    const segmenter = new Intl.Segmenter(void 0, { granularity: "word" });
    return Array.from(segmenter.segment(text), (entry) => ({
      text: entry.segment,
      isWord: entry.isWordLike === true
    }));
  }
  function markItem(el, index, extraClass) {
    el.className = extraClass ? `kui-split-item ${extraClass}` : "kui-split-item";
    el.style.setProperty("--kui-i", String(index));
  }
  function applyStaggerVars(el, params) {
    const { durationMs, delayMs, easing } = params.timing;
    const duration = durationMs === void 0 ? params.text("duration", "500ms") : `${durationMs}ms`;
    const delay = delayMs === void 0 ? params.text("delay", "0ms") : `${delayMs}ms`;
    el.style.setProperty("--kui-duration", duration);
    el.style.setProperty("--kui-delay", delay);
    el.style.setProperty("--kui-ease", easing ?? params.text("ease", "ease-out"));
    el.style.setProperty("--kui-stagger", params.text("stagger", "30ms"));
  }
  function stepMsFor(params, ticks, fallback) {
    const total = params.timing.durationMs;
    if (total === void 0 || ticks <= 0) return params.ms("step", fallback);
    return Math.max(1, total / ticks);
  }
  function splitRevealFinishMs(params, itemCount) {
    if (itemCount === 0) return 0;
    const durationMs = params.timing.durationMs ?? params.ms("duration", 500);
    const delayMs = params.timing.delayMs ?? params.ms("delay", 0);
    const staggerMs = params.ms("stagger", 30);
    return delayMs + (itemCount - 1) * staggerMs + durationMs;
  }
  function createStepRunner(win, options) {
    let settle2;
    const finished = new Promise((resolve) => {
      settle2 = resolve;
    });
    let interval;
    function stop() {
      win.clearTimeout(start);
      if (interval !== void 0) win.clearInterval(interval);
      settle2?.();
    }
    const start = win.setTimeout(() => {
      interval = win.setInterval(() => {
        if (options.tick()) stop();
      }, options.stepMs);
    }, options.delayMs);
    return { finished, stop };
  }
  function appendCharSpans(container, doc, text) {
    const spans = [];
    let index = 0;
    let wordWrapper = null;
    for (const grapheme of segmentGraphemes(text)) {
      if (grapheme.trim() === "") {
        container.append(doc.createTextNode(grapheme));
        wordWrapper = null;
        continue;
      }
      if (!wordWrapper) {
        wordWrapper = doc.createElement("span");
        wordWrapper.className = "kui-split-word";
        container.append(wordWrapper);
      }
      const span = doc.createElement("span");
      markItem(span, index);
      span.textContent = grapheme;
      wordWrapper.append(span);
      spans.push(span);
      index++;
    }
    return spans;
  }
  function appendWordSpans(container, doc, text) {
    const spans = [];
    let index = 0;
    for (const token of segmentWords(text)) {
      if (!token.isWord) {
        container.append(doc.createTextNode(token.text));
        continue;
      }
      const span = doc.createElement("span");
      markItem(span, index);
      span.textContent = token.text;
      container.append(span);
      spans.push(span);
      index++;
    }
    return spans;
  }
  function bucketByLine(container) {
    const buckets = [];
    let currentTop = null;
    for (const node of Array.from(container.childNodes)) {
      if (node instanceof HTMLElement) {
        const top = node.offsetTop;
        if (currentTop === null || Math.abs(top - currentTop) > 1) {
          buckets.push([]);
          currentTop = top;
        }
      } else if (buckets.length === 0) {
        buckets.push([]);
      }
      buckets.at(-1).push(node);
    }
    return buckets;
  }
  function appendLineSpans(container, doc, text) {
    appendWordSpans(container, doc, text);
    const buckets = bucketByLine(container);
    container.replaceChildren();
    return buckets.map((nodes, index) => {
      const line = doc.createElement("span");
      markItem(line, index, "kui-split-line");
      for (const node of nodes) {
        if (node instanceof HTMLElement) {
          node.removeAttribute("class");
          node.style.removeProperty("--kui-i");
        }
        line.append(node);
      }
      container.append(line);
      return line;
    });
  }
  function appendSpansFor(unit, container, doc, text) {
    if (unit === "words") return appendWordSpans(container, doc, text);
    if (unit === "lines") return appendLineSpans(container, doc, text);
    return appendCharSpans(container, doc, text);
  }
  function nextTypeState(state, total, loop2) {
    if (!state.deleting) {
      const index2 = state.index + 1;
      if (index2 < total) return { index: index2, deleting: false, done: false };
      return loop2 ? { index: total, deleting: true, done: false } : { index: total, deleting: false, done: true };
    }
    const index = state.index - 1;
    if (index > 0) return { index, deleting: true, done: false };
    return { index: 0, deleting: false, done: false };
  }
  var SCRAMBLE_CHARSETS = {
    upper: "ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    binary: "01",
    symbols: "!<>-_\\/[]{}=+*^?#~"
  };
  function scrambledFrame(graphemes, resolved, charset, random) {
    return graphemes.map((grapheme, index) => {
      if (index < resolved || grapheme.trim() === "") return grapheme;
      return charset[Math.floor(random() * charset.length)] ?? charset[0] ?? grapheme;
    }).join("");
  }

  // src/effects/catalog/text.ts
  var fontWeightParams = {
    from: { type: "number", default: "100", cssProperty: "--kui-from-weight", minimum: 1, maximum: 1e3 },
    to: { type: "number", default: "800", cssProperty: "--kui-to-weight", minimum: 1, maximum: 1e3 }
  };
  var fontWidthParams = {
    from: { type: "percentage", default: "75%", cssProperty: "--kui-from-width" },
    to: { type: "percentage", default: "125%", cssProperty: "--kui-to-width" }
  };
  var fontSlantParams = {
    from: { type: "angle", default: "0deg", cssProperty: "--kui-from-slant" },
    to: { type: "angle", default: "10deg", cssProperty: "--kui-to-slant" }
  };
  var textSweepParams = {
    color: { type: "color", default: "currentColor", cssProperty: "--kui-sweep-color" }
  };
  var extrudeParams = {
    angle: { type: "angle", default: "-20deg", cssProperty: "--kui-from-angle" },
    distance: { type: "length", default: "32px", cssProperty: "--kui-distance" }
  };
  var TEXT_CSS_PRIMITIVES = [
    // `color`, alongside `background`: both presets' unconditional rule sets `-webkit-text-fill-color:
    // transparent` so the `background-image` gradient shows through the glyphs (the standard
    // gradient-text technique). That is a real claim on the glyph fill, the same physical property
    // `text-outline-fill` animates on its own `color` channel below — without this, the two looked
    // disjoint to the compiler (`background` vs `stroke`+`color`) and composing them would let
    // whichever applied last silently win the glyph fill instead of being flagged as a conflict.
    cssPrimitive("text-shimmer", [CHANNEL.background, CHANNEL.color], { reducedMotion: "disable" }),
    // `gradient-sweep` is the only one of the three `text-sweep`-family presets whose keyframe
    // touches `-webkit-text-fill-color` (see text.css) — `highlight-sweep` and `underline-draw` only
    // paint a `background-image`. Claiming `color` for all three made the compiler reject compositions
    // like `underline-draw, text-outline-fill` as a glyph-fill conflict even though they touch disjoint
    // properties. Split so only the preset that actually claims the fill declares the channel.
    cssPrimitive("text-gradient-sweep", [CHANNEL.background, CHANNEL.color], { parameters: textSweepParams }),
    cssPrimitive("text-sweep", [CHANNEL.background], { parameters: textSweepParams }),
    cssPrimitive("text-outline-fill", [CHANNEL.stroke, CHANNEL.color]),
    cssPrimitive("var-weight", ["font"], { parameters: fontWeightParams }),
    cssPrimitive("var-width", ["font"], { parameters: fontWidthParams }),
    cssPrimitive("var-slant", ["font"], { parameters: fontSlantParams }),
    /*
     * `defaultActivation: 'load'` for the same reason every ambient primitive declares it, and it
     * was missing here: a marquee is continuous motion, so `reducedMotion: 'disable'` is only half
     * the rule `ambient.ts` spells out — the other half is starting on `load` rather than waiting on
     * a scroll-triggered `enter`.
     *
     * Without it, a bare `data-kui="marquee 42s"` resolved to `enter`, which `style-plan.ts`'s
     * `resolveGate` sends down the `deferred` path and stamps `animation-play-state: paused`. It
     * compiled correctly, reported `data-kui-state="ready"`, and never ran — measured on a marquee
     * fully in view, so this was not an observer that had simply not fired yet. Every page carrying
     * one had to know to write `on:load`, which is exactly the kind of thing an author cannot be
     * expected to guess.
     *
     * `marquee-scroll-linked` is unaffected: its position comes from `animation-timeline: scroll()`,
     * not from an activation.
     */
    cssPrimitive("text-marquee", [CHANNEL.translate], {
      timelines: ["time", "scroll"],
      defaultActivation: "load",
      reducedMotion: "disable"
    }),
    cssPrimitive("redaction-reveal", [CHANNEL.clip]),
    cssPrimitive("text-3d-extrude", [CHANNEL.rotate, CHANNEL.translate], { parameters: extrudeParams })
  ];
  var TEXT_CSS_PRESETS = [
    { name: "gradient-shimmer", primitive: "text-shimmer", keyframes: "kui-gradient-shimmer" },
    { name: "gradient-sweep", primitive: "text-gradient-sweep", keyframes: "kui-gradient-sweep" },
    {
      name: "highlight-sweep",
      primitive: "text-sweep",
      keyframes: "kui-highlight-sweep",
      params: { color: "gold" }
    },
    { name: "underline-draw", primitive: "text-sweep", keyframes: "kui-underline-draw" },
    { name: "text-outline-fill", primitive: "text-outline-fill", keyframes: "kui-text-outline-fill" },
    { name: "var-weight", primitive: "var-weight", keyframes: "kui-var-weight" },
    { name: "var-width", primitive: "var-width", keyframes: "kui-var-width" },
    { name: "var-slant", primitive: "var-slant", keyframes: "kui-var-slant" },
    { name: "marquee", primitive: "text-marquee", keyframes: "kui-marquee" },
    { name: "marquee-scroll-linked", primitive: "text-marquee", keyframes: "kui-marquee" },
    { name: "redaction-reveal", primitive: "redaction-reveal", keyframes: "kui-redaction-reveal" },
    { name: "text-3d-extrude", primitive: "text-3d-extrude", keyframes: "kui-text-3d-extrude" }
  ];
  function jsTextPrimitive(id, channels, options) {
    return {
      id,
      renderer: "javascript",
      channels,
      parameters: options.parameters,
      supportedTimelines: ["time"],
      supportedActivations: ["load", "enter", "hover", "focus", "click", "manual"],
      defaultActivation: "enter",
      perfClass: options.perfClass ?? "dom-transform",
      // Every JS-rendered primitive in this catalog is `disable`: none of them declare a CSS
      // `animation-duration` the reduced-motion policy layer could shorten, so `shorten` would be a
      // silent no-op. `disable` is enforced upstream — the animator never calls `activate()` at all
      // — which is the only place that actually works for a timer- or DOM-surgery-driven effect.
      reducedMotion: "disable",
      prepare: options.prepare
    };
  }
  var splitTiming = {
    duration: { type: "time", default: "500ms", cssProperty: "--kui-duration" },
    ...TRIGGER_DELAY_PARAM,
    ease: { type: "easing", default: "ease-out", cssProperty: "--kui-ease" },
    stagger: { type: "time", default: "30ms", cssProperty: "--kui-stagger" },
    unit: {
      type: "keyword",
      default: "chars",
      cssProperty: "--kui-unit",
      values: ["chars", "words", "lines"]
    },
    direction: {
      type: "keyword",
      default: "fade",
      cssProperty: "--kui-direction",
      values: ["fade", "up", "down", "mask"]
    }
  };
  var motionParams = {
    stagger: { type: "time", default: "40ms", cssProperty: "--kui-stagger" },
    // `duration`/`ease` are deliberately *not* declared beside the delay: text.css pins both for
    // wave and jitter on a higher-specificity `[data-kui-split-fx='wave'] .kui-split-item` rule, so
    // declaring them would advertise two knobs that the stylesheet then overrides. `animation-delay`
    // is the one the phase-start rule leaves alone, which is what lets `applyStaggerVars` honour it.
    ...TRIGGER_DELAY_PARAM,
    motion: {
      type: "keyword",
      default: "wave",
      cssProperty: "--kui-motion",
      values: ["wave", "jitter"]
    }
  };
  var typewriterParams = {
    step: { type: "time", default: "55ms", cssProperty: "--kui-step" },
    loop: { type: "keyword", default: "false", cssProperty: "--kui-loop", values: ["true", "false"] },
    ...TRIGGER_DELAY_PARAM
  };
  var scrambleParams = {
    step: { type: "time", default: "40ms", cssProperty: "--kui-step" },
    // `duration` gets no such shared declaration: `stepMsFor` reads its authored-or-not distinction
    // to decide between a whole-effect time and a per-tick `step:`, and a schema default would erase
    // that distinction. A `0ms` delay default has no equivalent problem.
    ...TRIGGER_DELAY_PARAM,
    revealEvery: {
      type: "number",
      default: "2",
      cssProperty: "--kui-reveal-every",
      minimum: 1,
      integer: true
    },
    charset: {
      type: "keyword",
      default: "upper",
      cssProperty: "--kui-charset",
      values: ["upper", "binary", "symbols"]
    }
  };
  var wordCyclerParams = {
    words: { type: "text", default: "", cssProperty: "--kui-words" },
    interval: { type: "time", default: "2200ms", cssProperty: "--kui-interval" },
    // Load-bearing here, not just for symmetry: a cycler has no authored `duration` — `interval:`
    // paces it — so the positional "duration then delay" slot only reached a delay when the author
    // wrote a throwaway first value, `word-cycler 0ms 300ms`.
    ...TRIGGER_DELAY_PARAM
  };
  function prepareSplitText(el, params, ctx) {
    const doc = el.ownerDocument;
    const unit = params.text("unit", "chars");
    const direction = params.text("direction", "fade");
    const layers = installSplitLayers(el, doc);
    layers.decorative.setAttribute("data-kui-split-fx", direction);
    applyStaggerVars(layers.decorative, params);
    const items = appendSpansFor(unit, layers.decorative, doc, layers.originalText);
    let settle2;
    const finished = new Promise((resolve) => {
      settle2 = resolve;
    });
    const timer = ctx.win.setTimeout(settle2, splitRevealFinishMs(params, items.length));
    return {
      cleanup: () => {
        ctx.win.clearTimeout(timer);
        layers.restore();
      },
      finished,
      finish: () => {
        ctx.win.clearTimeout(timer);
        settle2();
      }
    };
  }
  function prepareSplitMotion(el, params) {
    const doc = el.ownerDocument;
    const motion = params.text("motion", "wave");
    const layers = installSplitLayers(el, doc);
    layers.decorative.setAttribute("data-kui-split-fx", motion);
    applyStaggerVars(layers.decorative, params);
    appendCharSpans(layers.decorative, doc, layers.originalText);
    return layers.restore;
  }
  function prepareTypewriter(el, params, ctx) {
    const loop2 = params.is("loop");
    const layers = installSplitLayers(el, el.ownerDocument);
    layers.decorative.classList.add("kui-typewriter");
    const graphemes = segmentGraphemes(layers.originalText);
    let state = { index: 0, deleting: false };
    const render = (count) => {
      layers.decorative.textContent = graphemes.slice(0, count).join("");
    };
    const run = createStepRunner(ctx.win, {
      delayMs: params.timing.delayMs ?? params.ms("delay", 0),
      stepMs: stepMsFor(params, graphemes.length, 55),
      tick: () => {
        const step = nextTypeState(state, graphemes.length, loop2);
        state = step;
        render(step.index);
        return step.done;
      }
    });
    return {
      cleanup: () => {
        run.stop();
        layers.restore();
      },
      finished: run.finished,
      finish: () => {
        run.stop();
        render(graphemes.length);
      }
    };
  }
  function prepareScramble(el, params, ctx) {
    const charset = SCRAMBLE_CHARSETS[params.text("charset", "upper")];
    const revealEvery = Math.max(1, Math.round(params.num("revealEvery", 2)));
    const node = el;
    const authoredMinWidth = node.style.getPropertyValue("min-width");
    const authoredMinHeight = node.style.getPropertyValue("min-height");
    const restRect = el.getBoundingClientRect();
    ctx.style.set("min-width", `${restRect.width}px`);
    ctx.style.set("min-height", `${restRect.height}px`);
    const releaseSizeLock = () => {
      ctx.style.set("min-width", authoredMinWidth);
      ctx.style.set("min-height", authoredMinHeight);
    };
    const layers = installSplitLayers(el, el.ownerDocument);
    layers.decorative.classList.add("kui-scramble");
    const graphemes = segmentGraphemes(layers.originalText);
    let resolved = 0;
    let ticks = 0;
    const render = () => {
      layers.decorative.textContent = scrambledFrame(graphemes, resolved, charset, Math.random);
    };
    render();
    const totalTicks = Math.max(1, graphemes.length * revealEvery);
    const run = createStepRunner(ctx.win, {
      delayMs: params.timing.delayMs ?? params.ms("delay", 0),
      stepMs: stepMsFor(params, totalTicks, Math.max(1, 700 / totalTicks)),
      tick: () => {
        ticks++;
        if (ticks % revealEvery === 0) resolved++;
        render();
        const done = resolved >= graphemes.length;
        if (done) releaseSizeLock();
        return done;
      }
    });
    return {
      cleanup: () => {
        run.stop();
        layers.restore();
        releaseSizeLock();
      },
      finished: run.finished,
      finish: () => {
        run.stop();
        resolved = graphemes.length;
        render();
        releaseSizeLock();
      }
    };
  }
  function prepareWordCycler(el, params, ctx) {
    const words = params.text("words", "").split("|").map((word) => word.trim()).filter(Boolean);
    if (words.length === 0) return () => {
    };
    const restoreChildren = captureChildren(el);
    const swapMs = 150;
    let index = 0;
    el.textContent = words[0];
    const run = createStepRunner(ctx.win, {
      delayMs: params.timing.delayMs ?? params.ms("delay", 0),
      stepMs: params.ms("interval", 2200),
      tick: () => {
        el.classList.add("kui-word-cycler-swap");
        ctx.win.setTimeout(() => {
          index = (index + 1) % words.length;
          el.textContent = words[index];
          el.classList.remove("kui-word-cycler-swap");
        }, swapMs);
        return false;
      }
    });
    return {
      cleanup: () => {
        run.stop();
        el.classList.remove("kui-word-cycler-swap");
        restoreChildren();
      },
      finished: run.finished,
      finish: () => run.stop()
    };
  }
  var TEXT_JS_PRIMITIVES = [
    jsTextPrimitive("split-text", [CHANNEL.opacity, CHANNEL.translate, CHANNEL.clip], {
      parameters: splitTiming,
      prepare: deferPrepare(prepareSplitText)
    }),
    jsTextPrimitive("split-text-motion", [CHANNEL.translate, CHANNEL.rotate], {
      parameters: motionParams,
      prepare: deferPrepare(prepareSplitMotion),
      perfClass: "continuous"
    }),
    jsTextPrimitive("typewriter", [CHANNEL.clip], {
      parameters: typewriterParams,
      prepare: deferPrepare(prepareTypewriter),
      perfClass: "continuous"
    }),
    jsTextPrimitive("scramble-text", ["content"], {
      parameters: scrambleParams,
      prepare: deferPrepare(prepareScramble),
      perfClass: "continuous"
    }),
    jsTextPrimitive("word-cycler", ["content"], {
      parameters: wordCyclerParams,
      prepare: deferPrepare(prepareWordCycler),
      perfClass: "continuous"
    })
  ];
  var CHARS_STAGGER = "30ms";
  var WORDS_STAGGER = "90ms";
  var LINES_STAGGER = "160ms";
  var TEXT_JS_PRESETS = [
    { name: "split-chars", primitive: "split-text", params: { unit: "chars", direction: "fade", stagger: CHARS_STAGGER } },
    { name: "split-words", primitive: "split-text", params: { unit: "words", direction: "fade", stagger: WORDS_STAGGER } },
    { name: "split-lines", primitive: "split-text", params: { unit: "lines", direction: "fade", stagger: LINES_STAGGER } },
    { name: "text-reveal-up", primitive: "split-text", params: { unit: "words", direction: "up", stagger: WORDS_STAGGER }, cloak: true },
    { name: "text-reveal-down", primitive: "split-text", params: { unit: "words", direction: "down", stagger: WORDS_STAGGER }, cloak: true },
    { name: "text-reveal-mask", primitive: "split-text", params: { unit: "lines", direction: "mask", stagger: LINES_STAGGER }, cloak: true },
    { name: "text-wave", primitive: "split-text-motion", params: { motion: "wave" } },
    { name: "text-jitter", primitive: "split-text-motion", params: { motion: "jitter" } },
    { name: "typewriter", primitive: "typewriter", params: { loop: "false" } },
    { name: "typewriter-loop", primitive: "typewriter", params: { loop: "true" } },
    { name: "scramble", primitive: "scramble-text", params: { charset: "upper" } },
    { name: "decode", primitive: "scramble-text", params: { charset: "binary" } },
    { name: "glitch", primitive: "scramble-text", params: { charset: "symbols" } },
    { name: "word-cycler", primitive: "word-cycler" }
  ];
  var TEXT_PRIMITIVES = [...TEXT_CSS_PRIMITIVES, ...TEXT_JS_PRIMITIVES];
  var TEXT_PRESETS = [...TEXT_CSS_PRESETS, ...TEXT_JS_PRESETS];
  function registerText(registry) {
    return registry.registerPrimitives(TEXT_PRIMITIVES).registerPresets(TEXT_PRESETS);
  }

  // src/effects/catalog/index.ts
  function registerCatalog(registry) {
    registerMedia(registry);
    registerText(registry);
    registerAmbient(registry);
    registerFeedback(registry);
    registerNumbers(registry);
    registerInteraction(registry);
    return registry;
  }

  // src/effects/catalog/core.ts
  var distance2 = {
    distance: { type: "length", default: "24px", cssProperty: "--kui-distance" },
    opacity: { type: "number", default: "0", cssProperty: "--kui-from-opacity" }
  };
  var ENTRANCE_TIMELINES = ["time", "view", "scroll", "pin"];
  var PRIMITIVES = [
    // --- entrance / exit -------------------------------------------------------------------
    cssPrimitive("reveal", [CHANNEL.opacity, CHANNEL.translate], { timelines: ENTRANCE_TIMELINES, parameters: distance2 }),
    cssPrimitive("scale", [CHANNEL.scale], {
      timelines: ENTRANCE_TIMELINES,
      parameters: { scale: { type: "number", default: "0.92", cssProperty: "--kui-from-scale" } }
    }),
    // Separate from `scale` because it claims translate as well and so composes differently.
    // `distance.distance` only, not `...distance`: `kui-zoom-in-up`/`-down` (entrance.css) read
    // `--kui-distance` and `--kui-from-scale` but never `--kui-from-opacity` — this primitive
    // doesn't declare `CHANNEL.opacity`. Spreading the whole shared `distance` object used to expose
    // `opacity:` as an apparently-valid, silently-inert parameter (same dead-parameter shape as
    // `flip-3d`'s old `perspective`, fixed above).
    cssPrimitive("scale-move", [CHANNEL.scale, CHANNEL.translate], {
      timelines: ENTRANCE_TIMELINES,
      parameters: {
        distance: distance2.distance,
        scale: { type: "number", default: "0.92", cssProperty: "--kui-from-scale" }
      }
    }),
    cssPrimitive("rotate", [CHANNEL.rotate], {
      timelines: ENTRANCE_TIMELINES,
      parameters: { angle: { type: "angle", default: "-8deg", cssProperty: "--kui-from-angle" } }
    }),
    // `distance.distance` only, not `...distance`: `kui-roll-in`/`-out` (entrance.css) write
    // `rotate`/`translate`, never `opacity` — this primitive doesn't declare `CHANNEL.opacity`. Same
    // dead-parameter shape as `scale-move` above.
    cssPrimitive("roll", [CHANNEL.rotate, CHANNEL.translate], {
      timelines: ENTRANCE_TIMELINES,
      parameters: {
        distance: distance2.distance,
        angle: { type: "angle", default: "-120deg", cssProperty: "--kui-from-angle" }
      }
    }),
    // `skew`, not `rotate`: entrance.css's keyframes write `transform: perspective(...)
    // rotateX/Y(...)`, not the individual `rotate:` property — the `perspective` parameter below
    // used to compile cleanly and do nothing, because nothing read it. See entrance.css's own
    // comment on `kui-flip-in-x` for the fix; `CHANNEL.skew` is this catalog's name for "claims the
    // whole `transform` shorthand" (`core/types.ts`), shared with `scroll-skew` and `flip-face`.
    cssPrimitive("flip-3d", [CHANNEL.skew], {
      timelines: ENTRANCE_TIMELINES,
      parameters: {
        angle: { type: "angle", default: "90deg", cssProperty: "--kui-from-angle" },
        perspective: { type: "length", default: "1200px", cssProperty: "--kui-perspective" }
      }
    }),
    cssPrimitive("blur", [CHANNEL.filter], {
      timelines: ENTRANCE_TIMELINES,
      parameters: { blur: { type: "length", default: "12px", cssProperty: "--kui-blur" } }
    }),
    // Purpose-built combination: one keyframe, so opacity is written once instead of twice.
    cssPrimitive("reveal-blur", [CHANNEL.opacity, CHANNEL.translate, CHANNEL.filter], {
      timelines: ENTRANCE_TIMELINES,
      parameters: { ...distance2, blur: { type: "length", default: "12px", cssProperty: "--kui-blur" } }
    }),
    // --- scroll-linked ---------------------------------------------------------------------
    // These are progress-linked, not time-triggered: they reverse as the user scrolls back.
    // That is by design and is why `timeline:` is a different axis from `on:`.
    // `distance.distance` only, not the whole `distance` object: `kui-parallax-y`/`-x` (scroll.css)
    // write only `translate` — this primitive doesn't declare `CHANNEL.opacity`. Same dead-parameter
    // shape as `scale-move`/`roll` above; `parallax-y`/`parallax-x`/`depth-layer` never read
    // `--kui-from-opacity`.
    cssPrimitive("parallax", [CHANNEL.translate], {
      parameters: { distance: distance2.distance },
      timelines: ["view", "scroll", "pin"],
      activations: ["manual"],
      reducedMotion: "disable",
      perfClass: "compositor"
    }),
    // `from` exists because the resting end was hardcoded (scale 1 / rotate 0deg), which fixed
    // these to "grow slightly" and "tilt slightly" — a scroll-driven element that should sweep in
    // from a quarter-size or from half a turn away had no way to say so. Same `--kui-from-*`
    // properties the entrance primitives already use, so the two stay spellable the same way.
    cssPrimitive("parallax-scale", [CHANNEL.scale], {
      parameters: {
        scale: { type: "number", default: "1.2", cssProperty: "--kui-to-scale" },
        from: { type: "number", default: "1", cssProperty: "--kui-from-scale" }
      },
      timelines: ["view", "scroll", "pin"],
      activations: ["manual"],
      reducedMotion: "disable"
    }),
    cssPrimitive("parallax-rotate", [CHANNEL.rotate], {
      parameters: {
        angle: { type: "angle", default: "12deg", cssProperty: "--kui-to-angle" },
        from: { type: "angle", default: "0deg", cssProperty: "--kui-from-angle" }
      },
      timelines: ["view", "scroll", "pin"],
      activations: ["manual"],
      reducedMotion: "disable"
    }),
    cssPrimitive("scroll-fade", [CHANNEL.opacity], {
      parameters: { opacity: { type: "number", default: "0", cssProperty: "--kui-from-opacity" } },
      timelines: ["view", "scroll", "pin"],
      activations: ["manual"],
      reducedMotion: "disable"
    }),
    // `filter`, not `opacity` — it collides with `blur`, and declaring the real channel is what
    // makes `channels.ts` say so instead of letting the two silently overwrite each other's
    // `filter` declaration.
    cssPrimitive("desaturate", [CHANNEL.filter], {
      parameters: {
        from: { type: "percentage", default: "100%", cssProperty: "--kui-from-grayscale" },
        to: { type: "percentage", default: "0%", cssProperty: "--kui-to-grayscale" }
      },
      timelines: ["view", "scroll", "pin"],
      activations: ["manual"],
      reducedMotion: "disable",
      perfClass: "paint"
    }),
    /*
     * `transform`, not one of the independent transform properties, because CSS never shipped a
     * standalone `skew:`. That is also why `skew` is its own channel rather than folded in with
     * `rotate`: writing `transform` replaces the entire shorthand, so a skew composed with anything
     * else that wrote `transform` would silently win. Nothing else in the catalog does — every other
     * transform in the library goes through `translate`/`rotate`/`scale` — so the shorthand is free.
     */
    cssPrimitive("skew", [CHANNEL.skew], {
      parameters: {
        from: { type: "angle", default: "8deg", cssProperty: "--kui-from-skew" },
        to: { type: "angle", default: "0deg", cssProperty: "--kui-to-skew" }
      },
      timelines: ["view", "scroll", "pin"],
      activations: ["manual"],
      reducedMotion: "disable"
    }),
    cssPrimitive("progress", [CHANNEL.scale], {
      timelines: ["scroll", "view"],
      activations: ["manual"],
      reducedMotion: "disable"
    }),
    // Separate primitive because it writes `stroke-dashoffset`, not `scale` — declaring the
    // wrong channel would let it silently compose with an effect it actually collides with.
    cssPrimitive("progress-stroke", [CHANNEL.stroke], {
      parameters: { length: { type: "number", default: "100", cssProperty: "--kui-path-length" } },
      timelines: ["scroll", "view"],
      activations: ["manual"],
      reducedMotion: "disable",
      perfClass: "paint"
    })
  ];
  var p = (name, primitive, keyframes, params) => ({ name, primitive, keyframes, ...params ? { params } : {} });
  var pIn = (name, primitive, keyframes, params) => ({ ...p(name, primitive, keyframes, params), cloak: true });
  var FADE = [
    pIn("fade-in", "reveal", "kui-in"),
    p("fade-out", "reveal", "kui-out"),
    pIn("fade-up", "reveal", "kui-in-up"),
    pIn("fade-down", "reveal", "kui-in-down"),
    pIn("fade-left", "reveal", "kui-in-left"),
    pIn("fade-right", "reveal", "kui-in-right"),
    p("fade-out-up", "reveal", "kui-out-up"),
    p("fade-out-down", "reveal", "kui-out-down"),
    p("fade-out-left", "reveal", "kui-out-left"),
    p("fade-out-right", "reveal", "kui-out-right")
  ];
  var SLIDE_PARAMS = { distance: "100px", opacity: "1" };
  var SLIDE = [
    pIn("slide-up", "reveal", "kui-in-up", SLIDE_PARAMS),
    pIn("slide-down", "reveal", "kui-in-down", SLIDE_PARAMS),
    pIn("slide-left", "reveal", "kui-in-left", SLIDE_PARAMS),
    pIn("slide-right", "reveal", "kui-in-right", SLIDE_PARAMS),
    p("slide-out-up", "reveal", "kui-out-up", SLIDE_PARAMS),
    p("slide-out-down", "reveal", "kui-out-down", SLIDE_PARAMS),
    p("slide-out-left", "reveal", "kui-out-left", SLIDE_PARAMS),
    p("slide-out-right", "reveal", "kui-out-right", SLIDE_PARAMS)
  ];
  var LOGICAL = [
    pIn("slide-inline-start", "reveal", "kui-in-inline-start", SLIDE_PARAMS),
    pIn("slide-inline-end", "reveal", "kui-in-inline-end", SLIDE_PARAMS),
    pIn("slide-block-start", "reveal", "kui-in-up", SLIDE_PARAMS),
    pIn("slide-block-end", "reveal", "kui-in-down", SLIDE_PARAMS)
  ];
  var ZOOM = [
    pIn("zoom-in", "scale", "kui-zoom-in"),
    p("zoom-out", "scale", "kui-zoom-out"),
    pIn("pop-in", "scale", "kui-zoom-in", { scale: "0.6", ease: "back-out" }),
    p("pop-out", "scale", "kui-zoom-out", { scale: "0.6", ease: "back-in" }),
    pIn("zoom-in-up", "scale-move", "kui-zoom-in-up"),
    pIn("zoom-in-down", "scale-move", "kui-zoom-in-down")
  ];
  var FLIP = [
    pIn("flip-in-x", "flip-3d", "kui-flip-in-x"),
    pIn("flip-in-y", "flip-3d", "kui-flip-in-y"),
    p("flip-out-x", "flip-3d", "kui-flip-out-x"),
    p("flip-out-y", "flip-3d", "kui-flip-out-y")
  ];
  var ROTATE = [
    pIn("rotate-in", "rotate", "kui-rotate-in"),
    p("rotate-out", "rotate", "kui-rotate-out"),
    pIn("rotate-in-left", "rotate", "kui-rotate-in", { angle: "-45deg" }),
    pIn("rotate-in-right", "rotate", "kui-rotate-in", { angle: "45deg" }),
    pIn("roll-in", "roll", "kui-roll-in"),
    p("roll-out", "roll", "kui-roll-out"),
    pIn("swing-in", "rotate", "kui-swing-in", { angle: "-15deg", ease: "back-out" })
  ];
  var BLUR = [
    pIn("blur-in", "blur", "kui-blur-in"),
    p("blur-out", "blur", "kui-blur-out"),
    pIn("fade-blur-up", "reveal-blur", "kui-fade-blur-up"),
    pIn("fade-blur-in", "reveal-blur", "kui-fade-blur-in")
  ];
  var CHARACTER = [
    pIn("bounce-in", "scale", "kui-zoom-in", { scale: "0.3", ease: "bounce" }),
    pIn("bounce-in-up", "reveal", "kui-in-up", { distance: "60px", ease: "back-out" }),
    pIn("bounce-in-down", "reveal", "kui-in-down", { distance: "60px", ease: "back-out" }),
    pIn("back-in-up", "reveal", "kui-in-up", { distance: "120px", ease: "expo-out" }),
    pIn("back-in-down", "reveal", "kui-in-down", { distance: "120px", ease: "expo-out" })
  ];
  var SCROLL = [
    p("parallax-y", "parallax", "kui-parallax-y"),
    p("parallax-x", "parallax", "kui-parallax-x"),
    p("parallax-scale", "parallax-scale", "kui-parallax-scale"),
    p("parallax-rotate", "parallax-rotate", "kui-parallax-rotate"),
    p("depth-layer", "parallax", "kui-parallax-y", { distance: "200px" }),
    p("scroll-fade", "scroll-fade", "kui-scroll-fade"),
    p("scroll-desaturate", "desaturate", "kui-desaturate"),
    p("scroll-skew", "skew", "kui-scroll-skew"),
    p("scroll-progress-bar", "progress", "kui-progress-x"),
    p("scroll-progress-bar-y", "progress", "kui-progress-y"),
    p("scroll-progress-ring", "progress-stroke", "kui-progress-ring"),
    // `reveal-repeat` was removed: it was byte-identical to `reveal-once`, and the activation
    // binder unobserves after first entry, so a repeating reveal is not implementable yet.
    pIn("reveal-once", "reveal", "kui-in-up")
  ];
  var PRESETS = [
    ...FADE,
    ...SLIDE,
    ...LOGICAL,
    ...ZOOM,
    ...FLIP,
    ...ROTATE,
    ...BLUR,
    ...CHARACTER,
    ...SCROLL
  ];
  var COMBOS = [
    [["fade-up", "blur-in"], "fade-blur-up"],
    [["fade-in", "blur-in"], "fade-blur-in"]
  ];
  function registerCore(registry) {
    registry.registerPrimitives(PRIMITIVES).registerPresets(PRESETS);
    for (const [names, preset] of COMBOS) registry.registerCombo(names, preset);
    return registry;
  }

  // src/effects/step-marking.ts
  var STEP_STATE_ATTR = "data-kui-step-state";
  function selectorBreadth(selector, doc) {
    try {
      if (doc.documentElement.matches(selector)) return "document-wide";
      if (doc.body?.matches(selector)) return "document-wide";
      return "ok";
    } catch {
      return "invalid";
    }
  }
  function resolveTarget(selector, ctx, effect) {
    if (!selector) return selector;
    const breadth = selectorBreadth(selector, ctx.doc);
    if (breadth === "invalid") {
      ctx.warn(`${effect} target "${selector}" is not a valid selector and will be ignored`);
      return "";
    }
    if (breadth === "document-wide") {
      ctx.warn(`${effect} target "${selector}" matches the whole document and will be ignored`);
      return "";
    }
    return selector;
  }
  function createStepMarker(resolve) {
    const ledgers = /* @__PURE__ */ new Map();
    return {
      mark(index) {
        const seen = /* @__PURE__ */ new Map();
        for (const node of resolve()) {
          const parent = node.parentElement;
          const position = seen.get(parent) ?? 0;
          seen.set(parent, position + 1);
          let ledger = ledgers.get(node);
          if (!ledger) {
            ledger = createAttributeLedger(node);
            ledgers.set(node, ledger);
          }
          ledger.set(STEP_STATE_ATTR, stepStateFor(position, index));
        }
      },
      restore() {
        for (const ledger of ledgers.values()) ledger.restore();
        ledgers.clear();
      }
    };
  }
  function stepStateFor(position, index) {
    if (position < index) return "before";
    if (position === index) return "active";
    return "after";
  }

  // src/effects/forms/primitives.ts
  var timing = {
    duration: { type: "time", default: "400ms", cssProperty: "--kui-duration" },
    ...TRIGGER_DELAY_PARAM,
    ease: { type: "easing", default: "ease-out", cssProperty: "--kui-ease" }
  };
  var NATIVE_STATE_PRIMITIVE = {
    id: "native-state",
    renderer: "javascript",
    channels: [CHANNEL.translate, CHANNEL.scale, CHANNEL.opacity, CHANNEL.stroke, CHANNEL.color],
    parameters: {},
    supportedTimelines: ["time"],
    supportedActivations: ["load"],
    defaultActivation: "load",
    perfClass: "compositor",
    // Native pseudo-classes drive these and the motion lands on a sibling, not on the control that
    // carries the attribute, so base.css's policy layer enforces this through its sibling
    // `transition-duration` rules rather than the `animation-*` ones.
    reducedMotion: "disable",
    prepare: () => inertInstance()
  };
  function prepareSiblingScale(cssProperty) {
    return (el, params) => {
      const sibling = el.nextElementSibling;
      sibling?.style.setProperty(cssProperty, String(params.num("scale", 1)));
      return () => sibling?.style.removeProperty(cssProperty);
    };
  }
  function siblingScalePrimitive(id, cssProperty) {
    return {
      id,
      renderer: "javascript",
      channels: [CHANNEL.translate, CHANNEL.scale, CHANNEL.opacity, CHANNEL.stroke, CHANNEL.color],
      parameters: { scale: { type: "number", default: "1", cssProperty } },
      supportedTimelines: ["time"],
      supportedActivations: ["load"],
      defaultActivation: "load",
      perfClass: "compositor",
      reducedMotion: "disable",
      prepare: deferPrepare(prepareSiblingScale(cssProperty))
    };
  }
  var TOGGLE_MORPH_PRIMITIVE = siblingScalePrimitive("toggle-morph", "--kui-toggle-scale");
  var RADIO_FILL_PRIMITIVE = siblingScalePrimitive("radio-fill", "--kui-radio-scale");
  var FOCUS_RING_PRIMITIVE = cssPrimitive("focus-ring", ["shadow"], {
    activations: ["focus", "manual"],
    defaultActivation: "focus"
  });
  var VALIDATE_SHAKE_PRIMITIVE = cssPrimitive("validate-shake", [CHANNEL.translate], {
    activations: ["click", "manual"],
    defaultActivation: "click"
  });
  var VALIDATE_CHECK_PRIMITIVE = cssPrimitive("validate-check", [CHANNEL.stroke], {
    activations: ["click", "manual"],
    defaultActivation: "click"
  });
  function jsInputPrimitive(id, channels, parameters, prepare) {
    return {
      id,
      renderer: "javascript",
      channels,
      parameters: { ...timing, ...parameters },
      supportedTimelines: ["time"],
      supportedActivations: ["load"],
      defaultActivation: "load",
      perfClass: "compositor",
      reducedMotion: "disable",
      prepare
    };
  }
  function computeStrength(value) {
    let score = 0;
    if (value.length >= 6) score++;
    if (value.length >= 10) score++;
    if (/[a-z]/.test(value) && /[A-Z]/.test(value)) score++;
    if (/\d/.test(value)) score++;
    if (/[^A-Za-z0-9]/.test(value)) score++;
    return Math.min(4, score);
  }
  function prepareStrengthMeter(el) {
    const input = el;
    const update = () => {
      el.setAttribute("data-kui-strength-level", String(computeStrength(input.value)));
    };
    input.addEventListener("input", update);
    update();
    return () => {
      input.removeEventListener("input", update);
      el.removeAttribute("data-kui-strength-level");
    };
  }
  function prepareRangeFill(el, params, ctx) {
    const input = el;
    const update = () => {
      const min = Number(input.min || "0");
      const max = Number(input.max || "100");
      const pct = max > min ? (Number(input.value) - min) / (max - min) * 100 : 0;
      ctx.style.set("--kui-fill", `${pct.toFixed(2)}%`);
    };
    input.addEventListener("input", update);
    update();
    return () => input.removeEventListener("input", update);
  }
  var STRENGTH_METER_PRIMITIVE = jsInputPrimitive(
    "strength-meter",
    ["meter"],
    {},
    deferPrepare(prepareStrengthMeter)
  );
  var RANGE_FILL_PRIMITIVE = jsInputPrimitive(
    "range-fill",
    [CHANNEL.background],
    {},
    deferPrepare(prepareRangeFill)
  );
  function nextStep(step, total) {
    return total > 0 ? (step + 1) % total : 0;
  }
  function prepareStepProgress(el, params, ctx) {
    const total = Math.max(1, Math.round(params.num("steps", 4)));
    const selector = resolveTarget(params.text("target"), ctx, "step-progress");
    const marker = createStepMarker(
      () => selector ? ctx.doc.querySelectorAll(selector) : el.children
    );
    const self = createAttributeLedger(el);
    let step = 0;
    const render = () => {
      self.set("data-kui-step", String(step));
      marker.mark(step);
    };
    const advance = () => {
      step = nextStep(step, total);
      render();
    };
    el.addEventListener("click", advance);
    render();
    return () => {
      el.removeEventListener("click", advance);
      self.restore();
      marker.restore();
    };
  }
  var STEP_PROGRESS_PRIMITIVE = jsInputPrimitive(
    "step-progress",
    ["state"],
    {
      steps: { type: "number", default: "4", cssProperty: "--kui-steps", minimum: 1, maximum: 20, integer: true },
      target: { type: "text", default: "", cssProperty: "--kui-target" }
    },
    deferPrepare(prepareStepProgress)
  );
  function nextSubmitStage(stage) {
    if (stage === "idle") return "loading";
    if (stage === "loading") return "done";
    return "idle";
  }
  function prepareSubmitFlow(el, params, ctx) {
    const loadMs = params.ms("load", 1200);
    const holdMs = params.ms("hold", 1500);
    let stage = "idle";
    let handle;
    const render = () => el.setAttribute("data-kui-stage", stage);
    const toIdle = () => {
      stage = nextSubmitStage(stage);
      render();
    };
    const toDone = () => {
      stage = nextSubmitStage(stage);
      render();
      handle = ctx.win.setTimeout(toIdle, holdMs);
    };
    const advance = () => {
      if (stage !== "idle") return;
      stage = nextSubmitStage(stage);
      render();
      handle = ctx.win.setTimeout(toDone, loadMs);
    };
    el.addEventListener("click", advance);
    render();
    return () => {
      el.removeEventListener("click", advance);
      if (handle !== void 0) ctx.win.clearTimeout(handle);
      el.removeAttribute("data-kui-stage");
    };
  }
  var SUBMIT_FLOW_PRIMITIVE = jsInputPrimitive(
    "submit-flow",
    ["state"],
    {
      load: { type: "time", default: "1200ms", cssProperty: "--kui-load" },
      hold: { type: "time", default: "1500ms", cssProperty: "--kui-hold" }
    },
    deferPrepare(prepareSubmitFlow)
  );

  // src/effects/forms/index.ts
  var FORMS_PRIMITIVES = [
    NATIVE_STATE_PRIMITIVE,
    FOCUS_RING_PRIMITIVE,
    VALIDATE_SHAKE_PRIMITIVE,
    VALIDATE_CHECK_PRIMITIVE,
    STRENGTH_METER_PRIMITIVE,
    TOGGLE_MORPH_PRIMITIVE,
    RADIO_FILL_PRIMITIVE,
    RANGE_FILL_PRIMITIVE,
    STEP_PROGRESS_PRIMITIVE,
    SUBMIT_FLOW_PRIMITIVE
  ];
  var FORMS_PRESETS = [
    { name: "label-float", primitive: "native-state" },
    { name: "input-underline-grow", primitive: "native-state" },
    { name: "focus-ring-grow", primitive: "focus-ring", keyframes: "kui-focus-ring-grow" },
    { name: "validate-shake", primitive: "validate-shake", keyframes: "kui-validate-shake" },
    { name: "validate-check", primitive: "validate-check", keyframes: "kui-validate-check" },
    { name: "strength-meter", primitive: "strength-meter" },
    { name: "toggle-morph", primitive: "toggle-morph" },
    { name: "checkbox-draw", primitive: "native-state" },
    { name: "radio-fill", primitive: "radio-fill" },
    { name: "range-fill", primitive: "range-fill" },
    { name: "submit-to-spinner-to-check", primitive: "submit-flow" },
    { name: "step-progress", primitive: "step-progress" }
  ];
  function registerForms(registry) {
    return registry.registerPrimitives(FORMS_PRIMITIVES).registerPresets(FORMS_PRESETS);
  }

  // src/core/gesture.ts
  var VELOCITY_WINDOW_MS = 100;
  var MAX_SAMPLES = 12;
  function velocityFrom(samples) {
    const last = samples[samples.length - 1];
    if (!last || samples.length < 2) return { vx: 0, vy: 0 };
    const cutoff = last.time - VELOCITY_WINDOW_MS;
    const first = samples.find((sample) => sample.time >= cutoff) ?? samples[0];
    const span = (last.time - first.time) / 1e3;
    if (span <= 0) return { vx: 0, vy: 0 };
    return { vx: (last.x - first.x) / span, vy: (last.y - first.y) / span };
  }
  function swipeDirection(vector, minVelocity) {
    const { vx, vy } = vector;
    if (Math.abs(vx) < minVelocity && Math.abs(vy) < minVelocity) return null;
    if (Math.abs(vx) >= Math.abs(vy)) return vx > 0 ? "right" : "left";
    return vy > 0 ? "down" : "up";
  }
  function applyAxis(vector, axis) {
    if (axis === "x") return { ...vector, dy: 0, vy: 0 };
    if (axis === "y") return { ...vector, dx: 0, vx: 0 };
    return vector;
  }
  function recognise(el, handlers, options = {}, deps = defaultGestureDeps()) {
    const threshold = options.threshold ?? 4;
    const axis = options.axis ?? "both";
    const swipeVelocity = options.swipeVelocity ?? 300;
    const longPressMs = options.longPressMs ?? 0;
    let samples = [];
    let origin = null;
    let active = false;
    let longPressTimer = null;
    let longPressFired = false;
    function sampleOf(event) {
      return { x: event.clientX, y: event.clientY, time: deps.now() };
    }
    function vectorNow(sample) {
      const start = origin;
      const { vx, vy } = velocityFrom(samples);
      return applyAxis({ dx: sample.x - start.x, dy: sample.y - start.y, vx, vy }, axis);
    }
    function clearLongPress() {
      if (longPressTimer !== null) deps.clearTimer(longPressTimer);
      longPressTimer = null;
    }
    function onDown(event) {
      origin = sampleOf(event);
      samples = [origin];
      active = false;
      longPressFired = false;
      el.setPointerCapture?.(event.pointerId);
      if (longPressMs > 0) {
        longPressTimer = deps.setTimer(() => {
          longPressFired = true;
          handlers.onLongPress?.(origin);
        }, longPressMs);
      }
    }
    function onMove(event) {
      if (!origin) return;
      const sample = sampleOf(event);
      samples.push(sample);
      if (samples.length > MAX_SAMPLES) samples.shift();
      const vector = vectorNow(sample);
      if (!active && Math.hypot(vector.dx, vector.dy) < threshold) return;
      if (!active) {
        active = true;
        clearLongPress();
        handlers.onStart?.(origin);
      }
      handlers.onMove?.(vector, sample);
    }
    function onUp(event) {
      clearLongPress();
      el.releasePointerCapture?.(event.pointerId);
      if (!origin) return;
      const sample = sampleOf(event);
      samples.push(sample);
      const vector = vectorNow(sample);
      if (active) {
        handlers.onEnd?.(vector, sample);
        const direction = swipeDirection(vector, swipeVelocity);
        if (direction) handlers.onSwipe?.(direction, vector);
      } else if (longPressFired) {
        handlers.onEnd?.(vector, sample);
      }
      origin = null;
      active = false;
      longPressFired = false;
      samples = [];
    }
    el.addEventListener("pointerdown", onDown);
    el.addEventListener("pointermove", onMove, { passive: true });
    el.addEventListener("pointerup", onUp, { passive: true });
    el.addEventListener("pointercancel", onUp, { passive: true });
    return () => {
      clearLongPress();
      el.removeEventListener("pointerdown", onDown);
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
    };
  }
  function defaultGestureDeps() {
    return {
      now: () => typeof performance === "undefined" ? Date.now() : performance.now(),
      setTimer: (callback, ms) => globalThis.setTimeout(callback, ms),
      clearTimer: (handle) => globalThis.clearTimeout(handle)
    };
  }
  function rubberBand(offset, limit, tension = 0.55) {
    if (limit <= 0) return 0;
    const sign = Math.sign(offset);
    const magnitude = Math.abs(offset);
    return sign * (1 - 1 / (magnitude / limit / tension + 1)) * limit;
  }

  // src/effects/gestures/primitives.ts
  var springParams2 = {
    stiffness: {
      type: "number",
      default: "180",
      cssProperty: "--kui-stiffness",
      finite: true,
      minimum: 1,
      maximum: 1e4
    },
    damping: {
      type: "number",
      default: "24",
      cssProperty: "--kui-damping",
      finite: true,
      minimum: 0.1,
      maximum: 1e3
    },
    mass: {
      type: "number",
      default: "1",
      cssProperty: "--kui-mass",
      finite: true,
      minimum: 0.1
    }
  };
  function gesturePrimitive(id, channels, parameters, prepare) {
    return {
      id,
      renderer: "javascript",
      channels,
      parameters,
      supportedTimelines: ["time", "pointer"],
      supportedActivations: ["load", "manual"],
      defaultActivation: "load",
      perfClass: "continuous",
      reducedMotion: "disable",
      prepare
    };
  }
  function springFrom2(params) {
    return {
      ...DEFAULT_SPRING,
      stiffness: params.num("stiffness", DEFAULT_SPRING.stiffness),
      damping: params.num("damping", DEFAULT_SPRING.damping),
      mass: params.num("mass", DEFAULT_SPRING.mass)
    };
  }
  function springDeps(ctx) {
    return { ...defaultSpringDeps(), warn: ctx.warn };
  }
  function writeOffset(ctx, x, y) {
    ctx.style.set("translate", `${x.toFixed(2)}px ${y.toFixed(2)}px`);
  }
  function prepareDraggable(el, params, ctx) {
    const config = springFrom2(params);
    const bounds = params.num("bounds", 0);
    const returns = params.is("return");
    const inertia = params.is("inertia");
    const resistance = params.num("resistance", 0.55);
    const momentum = params.num("momentum", 0.2);
    const offset = { x: 0, y: 0 };
    const pickup = { x: 0, y: 0 };
    const deps = springDeps(ctx);
    const runners = {
      x: createSpringRunner(config, (value) => write({ ...offset, x: value }), deps),
      y: createSpringRunner(config, (value) => write({ ...offset, y: value }), deps)
    };
    function write(next) {
      offset.x = next.x;
      offset.y = next.y;
      writeOffset(ctx, offset.x, offset.y);
    }
    const stopRecognising = recognise(
      el,
      {
        onStart() {
          runners.x.stop();
          runners.y.stop();
          pickup.x = offset.x;
          pickup.y = offset.y;
          el.setAttribute("data-kui-dragging", "true");
        },
        onMove(vector) {
          write({
            x: resist(pickup.x + vector.dx, bounds, resistance),
            y: resist(pickup.y + vector.dy, bounds, resistance)
          });
        },
        onEnd(vector) {
          el.setAttribute("data-kui-dragging", "false");
          settle(runners, offset, vector, { returns, inertia, momentum });
        }
      },
      { axis: params.text("axis", "both") }
    );
    ctx.invalidate();
    return () => {
      stopRecognising();
      runners.x.stop();
      runners.y.stop();
      el.removeAttribute("data-kui-dragging");
    };
  }
  function resist(delta, bounds, tension) {
    return bounds > 0 ? rubberBand(delta, bounds, tension) : delta;
  }
  function settle(runners, offset, vector, mode) {
    runners.x.set(offset.x, mode.inertia ? vector.vx : 0);
    runners.y.set(offset.y, mode.inertia ? vector.vy : 0);
    if (mode.returns) {
      runners.x.to(0);
      runners.y.to(0);
      return;
    }
    const carry = mode.inertia ? mode.momentum : 0;
    runners.x.to(offset.x + vector.vx * carry);
    runners.y.to(offset.y + vector.vy * carry);
  }
  function prepareSwipeable(el, params) {
    const stop = recognise(
      el,
      {
        onSwipe(direction) {
          el.setAttribute("data-kui-swipe", direction);
        }
      },
      {
        axis: params.text("axis", "both"),
        swipeVelocity: params.num("velocity", 300)
      }
    );
    return () => {
      stop();
      el.removeAttribute("data-kui-swipe");
    };
  }
  function preparePressable(el, params) {
    const stop = recognise(
      el,
      {
        onLongPress() {
          el.setAttribute("data-kui-pressed", "true");
        },
        onEnd() {
          el.setAttribute("data-kui-pressed", "false");
        }
      },
      { longPressMs: effectDurationMs(params, 500) }
    );
    return () => {
      stop();
      el.removeAttribute("data-kui-pressed");
    };
  }
  function prepareMagnetic(el, params, ctx) {
    const node = el;
    const radius = params.num("radius", 120);
    const strength = params.num("strength", 0.35);
    const config = springFrom2(params);
    const deps = springDeps(ctx);
    const offset = { x: 0, y: 0 };
    const runnerX = createSpringRunner(config, (value) => {
      offset.x = value;
      writeOffset(ctx, offset.x, offset.y);
    }, deps);
    const runnerY = createSpringRunner(config, (value) => {
      offset.y = value;
      writeOffset(ctx, offset.x, offset.y);
    }, deps);
    const onPointerMove = (event) => {
      const box = node.getBoundingClientRect();
      const dx = event.clientX - (box.left + box.width / 2);
      const dy = event.clientY - (box.top + box.height / 2);
      const inRange = Math.hypot(dx, dy) < radius;
      runnerX.to(inRange ? dx * strength : 0);
      runnerY.to(inRange ? dy * strength : 0);
    };
    ctx.win.addEventListener("pointermove", onPointerMove, { passive: true });
    return () => {
      ctx.win.removeEventListener("pointermove", onPointerMove);
      runnerX.stop();
      runnerY.stop();
    };
  }
  var GESTURE_PRIMITIVES = [
    gesturePrimitive(
      "draggable",
      ["translate"],
      {
        ...springParams2,
        axis: { type: "keyword", default: "both", cssProperty: "--kui-axis", values: ["x", "y", "both"] },
        bounds: { type: "number", default: "0", cssProperty: "--kui-bounds" },
        return: {
          type: "keyword",
          default: "false",
          cssProperty: "--kui-return",
          values: ["true", "false"]
        },
        inertia: {
          type: "keyword",
          default: "false",
          cssProperty: "--kui-inertia",
          values: ["true", "false"]
        },
        resistance: {
          type: "number",
          default: "0.55",
          cssProperty: "--kui-resistance",
          finite: true,
          minimum: 0,
          maximum: 1
        },
        momentum: { type: "number", default: "0.2", cssProperty: "--kui-momentum", finite: true }
      },
      deferPrepare(prepareDraggable)
    ),
    gesturePrimitive(
      "swipeable",
      ["state"],
      {
        axis: { type: "keyword", default: "both", cssProperty: "--kui-axis", values: ["x", "y", "both"] },
        velocity: { type: "number", default: "300", cssProperty: "--kui-velocity" }
      },
      deferPrepare(prepareSwipeable)
    ),
    gesturePrimitive(
      "pressable",
      ["state"],
      { duration: { type: "time", default: "500ms", cssProperty: "--kui-duration" } },
      deferPrepare(preparePressable)
    ),
    gesturePrimitive(
      "magnetic",
      ["translate"],
      {
        ...springParams2,
        radius: { type: "number", default: "120", cssProperty: "--kui-radius" },
        strength: { type: "number", default: "0.35", cssProperty: "--kui-strength" }
      },
      deferPrepare(prepareMagnetic)
    )
  ];

  // src/effects/gestures/index.ts
  var GESTURE_PRESETS = [
    { name: "drag", primitive: "draggable" },
    { name: "drag-x", primitive: "draggable", params: { axis: "x" } },
    { name: "drag-y", primitive: "draggable", params: { axis: "y" } },
    { name: "drag-inertia", primitive: "draggable", params: { inertia: "true" } },
    { name: "throwable", primitive: "draggable", params: { inertia: "true", damping: "18" } },
    { name: "elastic-pull", primitive: "draggable", params: { return: "true", bounds: "80" } },
    { name: "rubber-band", primitive: "draggable", params: { return: "true", bounds: "120" } },
    { name: "snap-back", primitive: "draggable", params: { return: "true", stiffness: "260" } },
    { name: "swipe", primitive: "swipeable" },
    { name: "swipe-x", primitive: "swipeable", params: { axis: "x" } },
    { name: "long-press", primitive: "pressable" },
    { name: "magnetic", primitive: "magnetic" },
    { name: "magnetic-snap", primitive: "magnetic", params: { strength: "0.6", radius: "160" } }
  ];
  function registerGestures(registry) {
    return registry.registerPrimitives(GESTURE_PRIMITIVES).registerPresets(GESTURE_PRESETS);
  }

  // src/core/flip.ts
  var EPSILON = 0.5;
  function domMeasure(el) {
    const rect = el.getBoundingClientRect();
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  }
  function domAnimate(el, keyframes, options) {
    const animate = el.animate;
    return typeof animate === "function" ? animate.call(el, keyframes, options) : null;
  }
  function createFlipEngine(deps = {}) {
    const measure = deps.measure ?? domMeasure;
    const animate = deps.animate ?? domAnimate;
    return {
      snapshot(elements) {
        const boxes = /* @__PURE__ */ new Map();
        for (const el of elements) boxes.set(el, measure(el));
        return { boxes };
      },
      play(before, elements, options = {}) {
        const deltas = collectDeltas(before, elements, measure, options.scale ?? false);
        if (deltas.length === 0) {
          return { moved: [], finished: Promise.resolve(), cancel: () => {
          } };
        }
        return runDeltas(deltas, animate, options);
      }
    };
  }
  function collectDeltas(before, elements, measure, scale) {
    const deltas = [];
    for (const el of elements) {
      const first = before.boxes.get(el);
      if (!first) continue;
      const last = measure(el);
      const delta = deltaFor(el, first, last, scale);
      if (delta) deltas.push(delta);
    }
    return deltas;
  }
  function deltaFor(el, first, last, scale) {
    const dx = first.x - last.x;
    const dy = first.y - last.y;
    const sx = scale && last.width > 0 ? first.width / last.width : 1;
    const sy = scale && last.height > 0 ? first.height / last.height : 1;
    const still = Math.abs(dx) < EPSILON && Math.abs(dy) < EPSILON && Math.abs(sx - 1) < 1e-3 && Math.abs(sy - 1) < 1e-3;
    return still ? null : { el, dx, dy, sx, sy };
  }
  function runDeltas(deltas, animate, options) {
    const duration = options.durationMs ?? 400;
    const easing = options.easing ?? "cubic-bezier(0.2, 0, 0, 1)";
    const animations = [];
    for (const { el, dx, dy, sx, sy } of deltas) {
      const animation = animate(
        el,
        [
          { translate: `${dx}px ${dy}px`, scale: `${sx} ${sy}` },
          { translate: "0px 0px", scale: "1 1" }
        ],
        { duration, easing, fill: "none" }
      );
      if (animation) animations.push(animation);
    }
    const finished = Promise.all(
      animations.map((animation) => animation.finished.catch(() => void 0))
    ).then(() => void 0);
    return {
      moved: deltas.map((delta) => delta.el),
      finished,
      cancel() {
        for (const animation of animations) animation.cancel();
      }
    };
  }
  function observeLayout(container, engine, options, observe) {
    let before = engine.snapshot(container.children);
    const cleanup = observe(() => {
      engine.play(before, container.children, options);
      before = engine.snapshot(container.children);
    });
    return cleanup;
  }
  function mutationWatcher(container) {
    return (callback) => {
      if (typeof MutationObserver === "undefined") return () => {
      };
      const observer = new MutationObserver(callback);
      observer.observe(container, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["hidden"]
      });
      return () => observer.disconnect();
    };
  }

  // src/effects/layout/primitives.ts
  var timing2 = {
    duration: { type: "time", default: "400ms", cssProperty: "--kui-duration" },
    ease: { type: "easing", default: "ease-out", cssProperty: "--kui-ease" }
  };
  function layoutPrimitive(id, channels, parameters, prepare) {
    return {
      id,
      renderer: "javascript",
      channels,
      parameters: { ...timing2, ...parameters },
      supportedTimelines: ["time"],
      supportedActivations: ["load", "manual", "click"],
      defaultActivation: "load",
      perfClass: "layout",
      // A layout transition that is merely faster is still a layout transition; under reduced
      // motion the correct behaviour is for elements to appear in place.
      reducedMotion: "disable",
      prepare
    };
  }
  function prepareFlipContainer(el, params) {
    const engine = createFlipEngine();
    return observeLayout(
      el,
      engine,
      {
        durationMs: effectDurationMs(params, 400),
        easing: params.text("ease"),
        scale: params.is("scale")
      },
      mutationWatcher(el)
    );
  }
  function prepareAutoHeight(el, params, ctx) {
    const node = el;
    ctx.style.set("overflow", "hidden");
    ctx.style.claim("height");
    const duration = effectDurationMs(params, 400);
    let animation = null;
    let previous = node.getBoundingClientRect().height;
    const observer = watchAttribute(node, params.text("attribute"), () => {
      animation?.cancel();
      const endpoints = heightEndpoints(node, previous);
      previous = endpoints.to;
      animation = animateHeight(node, endpoints, duration, params.text("ease"));
    });
    ctx.invalidate();
    return () => {
      observer();
      animation?.cancel();
    };
  }
  function heightEndpoints(node, previous) {
    node.style.removeProperty("height");
    const to = node.getBoundingClientRect().height;
    return { from: previous, to };
  }
  function animateHeight(node, endpoints, duration, easing) {
    const animate = node.animate;
    if (typeof animate !== "function") return null;
    return animate.call(
      node,
      [{ height: `${endpoints.from}px` }, { height: `${endpoints.to}px` }],
      { duration, easing, fill: "none" }
    );
  }
  function prepareIndicator(el, params, ctx) {
    const node = el;
    const engine = createFlipEngine();
    const selector = params.text("follow");
    let currentShift = 0;
    const move = () => {
      if (!selector) return;
      const target = ctx.doc.querySelector(selector);
      if (!(target instanceof Element)) return;
      const before = engine.snapshot([node]);
      const box = target.getBoundingClientRect();
      const current = node.getBoundingClientRect();
      const shift = box.left - current.left + currentShift;
      currentShift = shift;
      ctx.style.set("width", `${box.width}px`);
      ctx.style.set("translate", `${shift}px 0`);
      engine.play(before, [node], {
        durationMs: effectDurationMs(params, 400),
        easing: params.text("ease"),
        scale: true
      });
    };
    move();
    return watchAttribute(ctx.doc.documentElement, params.text("attribute"), move);
  }
  function watchAttribute(root, attribute, onChange) {
    if (typeof MutationObserver === "undefined" || !attribute) return () => {
    };
    const observer = new MutationObserver(onChange);
    observer.observe(root, { subtree: true, attributes: true, attributeFilter: [attribute] });
    return () => observer.disconnect();
  }
  var LAYOUT_PRIMITIVES = [
    layoutPrimitive(
      "flip-container",
      ["translate", "scale"],
      {
        scale: {
          type: "keyword",
          default: "false",
          cssProperty: "--kui-flip-scale",
          values: ["true", "false"]
        }
      },
      deferPrepare(prepareFlipContainer)
    ),
    layoutPrimitive(
      "auto-height",
      ["layout"],
      { attribute: { type: "text", default: "data-open", cssProperty: "--kui-attribute" } },
      deferPrepare(prepareAutoHeight)
    ),
    layoutPrimitive(
      "flip-indicator",
      ["translate", "layout"],
      {
        follow: { type: "text", default: "", cssProperty: "--kui-follow" },
        attribute: { type: "text", default: "aria-selected", cssProperty: "--kui-attribute" }
      },
      deferPrepare(prepareIndicator)
    )
  ];

  // src/effects/layout/presets.ts
  var LAYOUT_PRESETS = [
    { name: "flip-reorder", primitive: "flip-container" },
    { name: "flip-filter", primitive: "flip-container" },
    { name: "flip-sort", primitive: "flip-container" },
    { name: "flip-shuffle", primitive: "flip-container" },
    // Cards changing aspect between layouts need their size interpolated, not just their position.
    { name: "grid-to-list", primitive: "flip-container", params: { scale: "true" } },
    { name: "masonry-reflow", primitive: "flip-container" },
    { name: "expand-to-modal", primitive: "flip-container", params: { scale: "true", duration: "500ms" } },
    { name: "accordion-height", primitive: "auto-height" },
    { name: "tab-indicator-slide", primitive: "flip-indicator", params: { duration: "300ms" } }
  ];

  // src/effects/layout/index.ts
  function registerLayout(registry) {
    return registry.registerPrimitives(LAYOUT_PRIMITIVES).registerPresets(LAYOUT_PRESETS);
  }

  // src/effects/navigation/index.ts
  var NAV_CSS_PRIMITIVES = [
    cssPrimitive("nav-reveal", [CHANNEL.opacity, CHANNEL.translate]),
    cssPrimitive("menu-fullscreen", [CHANNEL.clip, CHANNEL.opacity]),
    cssPrimitive("panel-reveal", [CHANNEL.opacity, CHANNEL.translate]),
    cssPrimitive("drawer-slide", [CHANNEL.translate], {
      defaultActivation: "click"
    })
  ];
  var NAV_CSS_PRESETS = [
    { name: "menu-stagger-open", primitive: "nav-reveal", keyframes: "kui-nav-reveal" },
    { name: "menu-fullscreen", primitive: "menu-fullscreen", keyframes: "kui-menu-fullscreen" },
    { name: "dropdown-open", primitive: "panel-reveal", keyframes: "kui-panel-reveal" },
    {
      name: "mega-menu-drop",
      primitive: "panel-reveal",
      keyframes: "kui-panel-reveal",
      params: { duration: "550ms" }
    },
    {
      name: "drawer-slide",
      primitive: "drawer-slide",
      keyframes: "kui-drawer-slide-right"
    }
  ];
  function navPrimitive(id, channels, parameters, prepare) {
    return {
      id,
      renderer: "javascript",
      channels,
      parameters,
      supportedTimelines: ["time"],
      supportedActivations: ["load"],
      defaultActivation: "load",
      perfClass: "compositor",
      // A scroll-position reaction, like the scroll-mechanics category: shortening its "duration"
      // is meaningless because the position, not a clock, drives it.
      reducedMotion: "disable",
      prepare
    };
  }
  function subscribeScrollTop(el, ctx, onScrollTop) {
    return ctx.scheduler.subscribe(ctx.rootFor(el), (frame) => onScrollTop(frame.metrics.scrollTop));
  }
  function prepareHeaderShrink(el, params, ctx) {
    const offset = params.num("offset", 120);
    const state = createAttributeLedger(el);
    const unsubscribe = subscribeScrollTop(el, ctx, (top) => {
      const progress = offset > 0 ? Math.min(1, Math.max(0, top / offset)) : 1;
      ctx.style.set("--kui-shrink", progress.toFixed(4));
      state.set("data-kui-shrunk", String(progress >= 1));
    });
    return () => {
      unsubscribe();
      state.restore();
    };
  }
  function prepareHeaderHide(el, params, ctx) {
    const minDelta = params.num("offset", 8);
    let last = 0;
    const state = createAttributeLedger(el);
    const unsubscribe = subscribeScrollTop(el, ctx, (top) => {
      const delta = top - last;
      if (Math.abs(delta) < minDelta) return;
      state.set("data-kui-hidden", String(delta > 0 && top > minDelta));
      last = top;
    });
    return () => {
      unsubscribe();
      state.restore();
    };
  }
  function prepareBackToTop(el, params, ctx) {
    const offset = params.num("offset", 400);
    const state = createAttributeLedger(el);
    const unsubscribe = subscribeScrollTop(el, ctx, (top) => {
      state.set("data-kui-visible", String(top > offset));
    });
    return () => {
      unsubscribe();
      state.restore();
    };
  }
  var NAV_JS_PRIMITIVES = [
    navPrimitive(
      "header-shrink",
      ["layout"],
      { offset: { type: "number", default: "120", cssProperty: "--kui-offset" } },
      deferPrepare(prepareHeaderShrink)
    ),
    navPrimitive(
      "header-hide-on-scroll",
      [CHANNEL.translate],
      { offset: { type: "number", default: "8", cssProperty: "--kui-offset" } },
      deferPrepare(prepareHeaderHide)
    ),
    navPrimitive(
      "back-to-top-fade",
      [CHANNEL.opacity, CHANNEL.translate],
      { offset: { type: "number", default: "400", cssProperty: "--kui-offset" } },
      deferPrepare(prepareBackToTop)
    )
  ];
  var NAV_JS_PRESETS = [
    { name: "header-shrink", primitive: "header-shrink" },
    { name: "header-hide-on-scroll", primitive: "header-hide-on-scroll" },
    { name: "back-to-top-fade", primitive: "back-to-top-fade" }
  ];
  var NAVIGATION_PRIMITIVES = [...NAV_CSS_PRIMITIVES, ...NAV_JS_PRIMITIVES];
  var NAVIGATION_PRESETS = [...NAV_CSS_PRESETS, ...NAV_JS_PRESETS];
  function registerNavigation(registry) {
    return registry.registerPrimitives(NAVIGATION_PRIMITIVES).registerPresets(NAVIGATION_PRESETS);
  }

  // src/effects/scroll-mechanics/tracker.ts
  var domGeometry = (el) => {
    const rect = el.getBoundingClientRect();
    return { top: rect.top, height: rect.height };
  };
  var domPosition = (el) => {
    const view = el.ownerDocument?.defaultView;
    return view ? view.getComputedStyle(el).position : "static";
  };
  var domOffsetTop = (el) => {
    const view = el.ownerDocument?.defaultView;
    if (!view) return 0;
    const parsed = Number.parseFloat(view.getComputedStyle(el).top);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  function geometrySource(el, positionOf) {
    let outermostSticky = null;
    for (let node = el; node; node = node.parentElement) {
      if (positionOf(node) === "sticky") outermostSticky = node;
    }
    return outermostSticky?.parentElement ?? el;
  }
  function sourceTop(el, box, measure, positionOf) {
    const source = geometrySource(el, positionOf);
    return source === el ? box.top : measure(source).top;
  }
  function trackProgress(el, ctx, options, onProgress) {
    const measure = options.measure ?? domGeometry;
    const positionOf = options.positionOf ?? domPosition;
    const offsetOf = options.offsetOf ?? domOffsetTop;
    let scrollTop = 0;
    let scrollportTop = 0;
    const geometry2 = createMeasureCache(() => {
      const box = measure(el);
      const top = options.contentAnchor ? measure(options.contentAnchor).top - box.height : sourceTop(el, box, measure, positionOf);
      const stickyOffset = options.stickyEl ? offsetOf(options.stickyEl) : 0;
      return { contentTop: top - stickyOffset - scrollportTop + scrollTop, height: box.height };
    });
    return ctx.scheduler.subscribe(ctx.rootFor(el), (frame) => {
      scrollTop = frame.metrics.scrollTop;
      scrollportTop = frame.metrics.viewportTop;
      const box = geometry2.read(frame.epoch);
      const span = resolveDistance(options.distance, { top: 0, height: box.height }, frame);
      onProgress(progressFrom(box.contentTop - scrollTop, span), frame);
    });
  }
  function resolveDistance(distance3, box, frame) {
    if (!distance3) return box.height;
    const basis = {
      viewportWidth: frame.metrics.viewportWidth,
      viewportHeight: frame.metrics.viewportHeight,
      percentBasis: box.height,
      fontSize: 16,
      rootFontSize: 16
    };
    return toPixels(distance3, basis, box.height);
  }
  function progressFrom(top, span) {
    if (span <= 0) return 0;
    return clamp01(-top / span);
  }

  // src/effects/scroll-mechanics/scroll-spy.ts
  function prepareScrollSpy(el, params, ctx) {
    const sectionsAuthored = params.text("sections");
    if (sectionsAuthored) {
      const sectionsSelector = resolveTarget(sectionsAuthored, ctx, "scroll-spy sections");
      return prepareScrollSpyContainer(el, params, ctx, sectionsSelector);
    }
    return prepareScrollSpySingle(el, params, ctx);
  }
  function prepareScrollSpySingle(el, params, ctx) {
    if (params.text("offset-top", "0px") !== "0px") {
      ctx.warn('scroll-spy "offset-top" has no effect without sections: and is ignored here');
    }
    const selector = resolveTarget(params.text("target"), ctx, "scroll-spy");
    const links = /* @__PURE__ */ new Map();
    const self = createAttributeLedger(el);
    let last;
    const untrack = trackProgress(el, ctx, { distance: params.text("distance") }, (progress) => {
      const active = progress > 0 && progress < 1;
      if (active === last) return;
      last = active;
      self.set("data-kui-active", String(active));
      if (selector) markLinks(ctx.doc, selector, active, links);
    });
    return continuousSetup(() => {
      untrack();
      self.restore();
      for (const ledger of links.values()) ledger.restore();
    });
  }
  function markLinks(doc, selector, active, links) {
    for (const link of doc.querySelectorAll(selector)) {
      let ledger = links.get(link);
      if (!ledger) {
        ledger = createAttributeLedger(link);
        links.set(link, ledger);
      }
      ledger.set("data-kui-active", String(active));
    }
  }
  function hrefHash(link) {
    const href = link.getAttribute("href") ?? "";
    const at = href.indexOf("#");
    return at === -1 ? "" : href.slice(at);
  }
  function pairSectionsWithLinks(sections, links, ctx, sectionsSelector) {
    const linksByHash = /* @__PURE__ */ new Map();
    for (const link of links) {
      const hash = hrefHash(link);
      if (hash) linksByHash.set(hash, link);
    }
    const claimed = /* @__PURE__ */ new Set();
    const pairs = sections.map((section) => {
      if (!section.id) {
        ctx.warn(
          `scroll-spy: a section matched by sections:"${sectionsSelector}" has no id and cannot be paired with a link`
        );
        return { section, link: null };
      }
      const hash = `#${section.id}`;
      const link = linksByHash.get(hash) ?? null;
      if (link) claimed.add(hash);
      return { section, link };
    });
    for (const [hash, link] of linksByHash) {
      if (!claimed.has(hash)) {
        ctx.warn(`scroll-spy: link "${link.getAttribute("href")}" matches no section id in sections:"${sectionsSelector}"`);
      }
    }
    return pairs;
  }
  function offsetTopPixels(authored, frame) {
    return toPixels(
      authored,
      {
        viewportWidth: frame.metrics.viewportWidth,
        viewportHeight: frame.metrics.viewportHeight,
        percentBasis: 0,
        fontSize: 16,
        rootFontSize: 16
      },
      0
    );
  }
  function highestReachedIndex(tops, scrollTop, line) {
    let index = -1;
    for (let i = 0; i < tops.length; i++) {
      if (tops[i] - scrollTop - line <= 0) index = i;
    }
    return index;
  }
  function prepareScrollSpyContainer(el, params, ctx, sectionsSelector) {
    if (params.text("distance", "100vh") !== "100vh") {
      ctx.warn('scroll-spy "distance" has no effect with sections: \u2014 each section measures its own height');
    }
    const linksSelector = resolveTarget(params.text("target"), ctx, "scroll-spy target");
    const sections = sectionsSelector ? [...el.querySelectorAll(sectionsSelector)] : [];
    if (sectionsSelector && sections.length === 0) {
      ctx.warn(`scroll-spy sections:"${sectionsSelector}" matched nothing inside this element`);
    }
    const links = linksSelector ? [...el.querySelectorAll(linksSelector)] : [];
    const pairs = pairSectionsWithLinks(sections, links, ctx, sectionsSelector);
    const sectionLedgers = pairs.map((pair) => createAttributeLedger(pair.section));
    const linkLedgers = /* @__PURE__ */ new Map();
    for (const { link } of pairs) {
      if (link && !linkLedgers.has(link)) linkLedgers.set(link, createAttributeLedger(link));
    }
    const offsetAuthored = params.text("offset-top", "0px");
    let scrollTop = 0;
    let scrollportTop = 0;
    const contentTops = createMeasureCache(
      () => pairs.map(({ section }) => domGeometry(section).top - scrollportTop + scrollTop)
    );
    let active = -1;
    function setActive(index, value) {
      const pair = pairs[index];
      sectionLedgers[index].set("data-kui-active", String(value));
      if (pair.link) linkLedgers.get(pair.link).set("data-kui-active", String(value));
    }
    const untrack = ctx.scheduler.subscribe(ctx.rootFor(el), (frame) => {
      scrollTop = frame.metrics.scrollTop;
      scrollportTop = frame.metrics.viewportTop;
      const tops = contentTops.read(frame.epoch);
      const line = offsetTopPixels(offsetAuthored, frame);
      const next = highestReachedIndex(tops, scrollTop, line);
      if (next === active) return;
      if (active !== -1) setActive(active, false);
      if (next !== -1) setActive(next, true);
      active = next;
    });
    return continuousSetup(() => {
      untrack();
      for (const ledger of sectionLedgers) ledger.restore();
      for (const ledger of linkLedgers.values()) ledger.restore();
    });
  }

  // src/effects/scroll-mechanics/primitives.ts
  var PROGRESS_VAR = "--kui-progress";
  var distanceParam = {
    distance: { type: "length", default: "100vh", cssProperty: "--kui-distance" }
  };
  var stickyParams = {
    "offset-top": {
      type: "length",
      default: "var(--kui-pin-offset, 0px)",
      cssProperty: "--kui-offset-top"
    },
    spacer: {
      type: "keyword",
      default: "false",
      cssProperty: "--kui-spacer",
      values: ["true", "false"]
    }
  };
  function installSticky(node, params, ctx) {
    ctx.style.set("position", "sticky");
    ctx.style.set("top", params.text("offset-top", "var(--kui-pin-offset, 0px)"));
    const inserted = params.is("spacer") ? insertSpacer(node, params.text("distance"), ctx) : null;
    return { spacer: inserted?.spacer ?? null, dispose: () => inserted?.remove() };
  }
  function scrollPrimitive(spec) {
    const { id, channels, parameters, prepare, perfClass = "compositor" } = spec;
    return {
      id,
      renderer: "javascript",
      channels,
      parameters,
      // Accepted, never read: these primitives read scroll position themselves and are never driven
      // by an `animation-timeline`. The list exists so that composing the driver with the effects it
      // drives — `data-kui="pin-section distance:200vh, parallax-rotate ... "` plus `timeline:pin` —
      // survives `compile.ts`'s `intersect`. Without it the intersection empties, `style-plan.ts`
      // refuses the timeline, and the scrub silently degrades to a one-shot. See `TIMELINE_AGNOSTIC`
      // (`effects/shared.ts`) for why the name says abstention rather than support.
      supportedTimelines: TIMELINE_AGNOSTIC,
      supportedActivations: ["manual", "load", "enter"],
      defaultActivation: "load",
      perfClass,
      reducedMotion: "disable",
      prepare
    };
  }
  function writeProgress(ctx, progress) {
    ctx.style.set(PROGRESS_VAR, progress.toFixed(4));
  }
  function preparePin(el, params, ctx) {
    const node = el;
    const { dispose: unstick } = installSticky(node, params, ctx);
    const tracked = node.parentElement ?? el;
    const untrack = trackProgress(tracked, ctx, { distance: params.text("distance"), stickyEl: node }, (progress) => {
      writeProgress(ctx, progress);
      el.setAttribute("data-kui-pinned", progress > 0 && progress < 1 ? "true" : "false");
    });
    return continuousSetup(() => {
      untrack();
      unstick();
      el.removeAttribute("data-kui-pinned");
    });
  }
  function insertSpacer(node, distance3, ctx) {
    const spacer = ctx.doc.createElement("div");
    spacer.setAttribute("data-kui-spacer", "");
    spacer.setAttribute("aria-hidden", "true");
    spacer.style.height = distance3;
    spacer.style.pointerEvents = "none";
    node.after(spacer);
    ctx.invalidate();
    return {
      spacer,
      remove: () => {
        spacer.remove();
        ctx.invalidate();
      }
    };
  }
  function prepareProgress(el, params, ctx) {
    const steps = Math.max(0, Math.round(params.num("steps", 0)));
    const selector = resolveTarget(params.text("target"), ctx, "scrollytelling-step");
    const marker = createStepMarker(() => ctx.doc.querySelectorAll(selector));
    const self = createAttributeLedger(el);
    let lastIndex;
    const untrack = trackProgress(el, ctx, { distance: params.text("distance") }, (progress) => {
      writeProgress(ctx, progress);
      if (steps === 0) return;
      const index = Math.min(steps - 1, Math.floor(progress * steps));
      if (index === lastIndex) return;
      lastIndex = index;
      self.set("data-kui-step", String(index));
      ctx.style.set("--kui-step", String(index));
      if (selector) marker.mark(index);
    });
    return continuousSetup(() => {
      untrack();
      self.restore();
      marker.restore();
    });
  }
  function prepareHorizontal(el, params, ctx) {
    const selector = resolveTarget(params.text("target"), ctx, "horizontal-scroll");
    if (!selector) return prepareBareTrack(el, params, ctx);
    const track = el.querySelector(selector);
    if (!track) {
      ctx.warn(`horizontal-scroll target "${selector}" matched nothing inside this element`);
      return () => {
      };
    }
    return prepareManagedTrack(el, track, params, ctx);
  }
  function prepareBareTrack(node, params, ctx) {
    const authored = params.text("travel", "auto");
    const travel = createMeasureCache(() => trackTravel(node, authored, node.ownerDocument));
    return continuousSetup(
      trackProgress(node, ctx, { distance: params.text("distance") }, (progress, frame) => {
        ctx.style.set("translate", `${-progress * travel.read(frame.epoch)}px 0`);
        writeProgress(ctx, progress);
      })
    );
  }
  function prepareManagedTrack(host, track, params, ctx) {
    const offsetTop = params.text("offset-top", "var(--kui-pin-offset, 0px)");
    ctx.style.set("position", "sticky");
    ctx.style.set("top", offsetTop);
    ctx.style.set("height", `calc(100vh - ${offsetTop})`);
    ctx.style.set("overflow", "hidden");
    ctx.style.set("display", "grid");
    ctx.style.set("align-content", "center");
    const { remove: removeSpacer } = insertSpacer(host, params.text("distance"), ctx);
    const rail = createStyleLedger(track);
    rail.set("display", "flex");
    rail.set("width", "max-content");
    const authored = params.text("travel", "auto");
    const travel = createMeasureCache(() => trackTravel(track, authored, track.ownerDocument));
    const tracked = host.parentElement ?? host;
    const untrack = trackProgress(tracked, ctx, { distance: params.text("distance"), stickyEl: host }, (progress, frame) => {
      rail.set("translate", `${-progress * travel.read(frame.epoch)}px 0`);
      writeProgress(ctx, progress);
    });
    return continuousSetup(() => {
      untrack();
      rail.restore();
      removeSpacer();
    });
  }
  function trackTravel(node, authored, doc) {
    if (authored && authored !== "auto") return toPixels(authored, ABSOLUTE_BASIS, 0);
    const selfOverflow = node.scrollWidth - node.clientWidth;
    if (selfOverflow > 0) return selfOverflow;
    const viewportWidth = node.parentElement?.clientWidth || doc.documentElement.clientWidth;
    return Math.max(0, node.scrollWidth - viewportWidth);
  }
  function prepareMediaScrub(el, params, ctx) {
    const managed = params.is("spacer") ? installSticky(el, params, ctx) : null;
    const contentAnchor = managed?.spacer ?? void 0;
    const stickyEl = managed ? el : void 0;
    const selector = resolveTarget(params.text("target"), ctx, "media-scrub");
    const scrub = selector ? prepareTargetScrub(el, params, ctx, { selector, contentAnchor, stickyEl }) : prepareSrcScrub(el, params, ctx, { contentAnchor, stickyEl });
    return continuousSetup(() => {
      scrub();
      managed?.dispose();
    });
  }
  function prepareTargetScrub(el, params, ctx, authored) {
    const { selector, contentAnchor, stickyEl } = authored;
    const marker = createStepMarker(() => ctx.doc.querySelectorAll(selector));
    const frames = Math.max(1, ctx.doc.querySelectorAll(selector).length);
    let lastIndex;
    const untrack = trackProgress(el, ctx, { distance: params.text("distance"), contentAnchor, stickyEl }, (progress) => {
      writeProgress(ctx, progress);
      const index = Math.min(frames - 1, Math.floor(progress * frames));
      if (index === lastIndex) return;
      lastIndex = index;
      marker.mark(index);
    });
    marker.mark(0);
    return () => {
      untrack();
      marker.restore();
    };
  }
  function prepareSrcScrub(el, params, ctx, anchors) {
    const { contentAnchor, stickyEl } = anchors;
    const frames = Math.max(1, Math.round(params.num("frames", 1)));
    const pattern = mediaSrcPattern(params.text("src"), ctx);
    const media = el;
    let lastIndex = -1;
    const untrack = trackProgress(el, ctx, { distance: params.text("distance"), contentAnchor, stickyEl }, (progress) => {
      writeProgress(ctx, progress);
      const index = Math.min(frames - 1, Math.floor(progress * frames));
      if (index === lastIndex) return;
      lastIndex = index;
      applyFrame(media, { index, frames, progress, pattern });
    });
    return untrack;
  }
  function mediaSrcPattern(pattern, ctx) {
    if (!pattern || isSameOriginPath(pattern)) return pattern;
    ctx.warn(`media-scrub "src" must be a same-origin path, got "${pattern}" \u2014 ignoring`);
    return "";
  }
  function applyFrame(media, write) {
    const { index, frames, progress, pattern } = write;
    if (media.tagName === "VIDEO") {
      const duration = Number.isFinite(media.duration) ? media.duration : 0;
      if (duration > 0) media.currentTime = duration * progress;
      return;
    }
    if (media.tagName !== "IMG") return;
    if (pattern) media.src = pattern.replace("{i}", String(index).padStart(String(frames).length, "0"));
  }
  function prepareSmoothScroll(el, params, ctx) {
    ctx.style.set("scroll-behavior", params.text("behavior", "smooth"));
    return () => {
    };
  }
  function prepareSnap(el, params, ctx) {
    const axis = params.is("axis", "x") ? "x" : "y";
    ctx.style.set("scroll-snap-type", `${axis} ${params.text("strictness", "mandatory")}`);
    const selector = resolveTarget(params.text("target"), ctx, "scroll-snap");
    const items = selector ? [...el.querySelectorAll(selector)] : [...el.children];
    if (selector && items.length === 0) {
      ctx.warn(`scroll-snap target "${selector}" matched nothing inside this element`);
    }
    if (selector) installSnapContainer(axis, ctx);
    const childLedgers = items.map((child) => createStyleLedger(child));
    for (const ledger of childLedgers) ledger.set("scroll-snap-align", params.text("align", "start"));
    return () => {
      for (const ledger of childLedgers) ledger.restore();
    };
  }
  function installSnapContainer(axis, ctx) {
    ctx.style.set(axis === "x" ? "overflow-x" : "overflow-y", "auto");
    if (axis === "x") ctx.style.set("display", "flex");
  }
  var SCROLL_PRIMITIVES = [
    scrollPrimitive({
      id: "pin",
      channels: ["layout", "progress"],
      parameters: {
        ...distanceParam,
        ...stickyParams
      },
      prepare: deferPrepare(preparePin),
      perfClass: "layout"
    }),
    scrollPrimitive({
      id: "scroll-progress",
      channels: ["progress"],
      parameters: {
        ...distanceParam,
        steps: { type: "number", default: "0", cssProperty: "--kui-steps" },
        // Same name, same shape and the same validation as scroll-spy's: one `target:` convention
        // across the library rather than a second word for "the elements this effect marks".
        target: { type: "text", default: "", cssProperty: "--kui-target" }
      },
      prepare: deferPrepare(prepareProgress)
    }),
    scrollPrimitive({
      id: "horizontal-track",
      channels: ["translate", "progress"],
      parameters: {
        ...distanceParam,
        travel: { type: "text", default: "auto", cssProperty: "--kui-travel" },
        // Same name, same shape and the same validation as scroll-spy's and media-scrub's: one
        // `target:` convention across the library. Naming the row that moves is also what opts this
        // primitive into owning the stage, the sticky window and the row's layout itself.
        target: { type: "text", default: "", cssProperty: "--kui-target" },
        "offset-top": {
          type: "length",
          default: "var(--kui-pin-offset, 0px)",
          cssProperty: "--kui-offset-top"
        }
      },
      prepare: deferPrepare(prepareHorizontal)
    }),
    scrollPrimitive({
      id: "media-scrub",
      channels: ["media", "progress"],
      parameters: {
        ...distanceParam,
        // A scrub is a hold, so it needs the same two knobs a pin does. Declaring them here is what
        // lets `sequence-scrub` become one attribute with no wrapper at all.
        ...stickyParams,
        frames: { type: "number", default: "1", cssProperty: "--kui-frames" },
        src: { type: "text", default: "", cssProperty: "--kui-src" },
        // The preferred form. `frames:`/`src:` remain for sequences too long to author as tags.
        target: { type: "text", default: "", cssProperty: "--kui-target" }
      },
      prepare: deferPrepare(prepareMediaScrub),
      perfClass: "paint"
    }),
    scrollPrimitive({
      id: "scroll-spy",
      channels: ["state"],
      parameters: {
        // `distance`: the per-section form only. `offset-top`: the container form only. Each is a
        // no-op — warned, not silent — in the other; see `prepareScrollSpySingle` and
        // `prepareScrollSpyContainer`.
        ...distanceParam,
        // Same name and meaning in both forms: the link(s) this instance marks. Per-section, the
        // one link this section names; with `sections:`, every link `target:` matches, each paired
        // to its own section by `href`. See `prepareScrollSpyContainer`.
        target: { type: "text", default: "", cssProperty: "--kui-target" },
        // Presence, not value, selects the container form: authoring this at all switches
        // `prepareScrollSpy` from one-section-per-instance to one-instance-on-the-shared-ancestor.
        sections: { type: "text", default: "", cssProperty: "--kui-sections" },
        "offset-top": { type: "length", default: "0px", cssProperty: "--kui-offset-top" }
      },
      prepare: deferPrepare(prepareScrollSpy)
    }),
    scrollPrimitive({
      id: "smooth-scroll",
      /*
       * Its own channel, not the `'layout'` it used to share with `pin`, `stacking-cards` and
       * `scroll-snap`. The channel model exists to stop two effects fighting over the same CSS
       * property, and this one writes exactly `scroll-behavior` — a property that describes how a
       * *user-or-script-initiated* scroll is performed, and that no other primitive touches.
       *
       * On `'layout'` it made a legitimate pairing impossible. Both `smooth-scroll` and
       * `scroll-snap` have to sit on the document element to have any effect at all — neither
       * `scroll-behavior` nor `scroll-snap-type` is propagated to the viewport from `<body>` — so
       * "apply them to nested elements", the advice the conflict message gives, has no valid
       * nesting to offer here. `data-kui="smooth-scroll-to, scroll-snap-y"` on `<html>` is the
       * ordinary way to ask for smooth anchor jumps on a page that also snaps, and it was refused
       * for a collision that cannot happen: the two write disjoint properties.
       */
      channels: ["scroll-behavior"],
      parameters: {
        behavior: { type: "keyword", default: "smooth", cssProperty: "--kui-scroll-behavior", values: ["smooth", "auto"] }
      },
      prepare: deferPrepare(prepareSmoothScroll),
      perfClass: "layout"
    }),
    scrollPrimitive({
      id: "scroll-snap",
      channels: ["layout"],
      parameters: {
        axis: { type: "keyword", default: "y", cssProperty: "--kui-axis", values: ["x", "y"] },
        strictness: {
          type: "keyword",
          default: "mandatory",
          cssProperty: "--kui-snap-strictness",
          values: ["mandatory", "proximity"]
        },
        align: {
          type: "keyword",
          default: "start",
          cssProperty: "--kui-snap-align",
          values: ["start", "center", "end"]
        },
        // Names the snap items. Also what opts this primitive into owning the scroll container
        // itself — see `installSnapContainer`. Without it, the direct children are the items and
        // the page keeps its own `overflow`, exactly as before.
        target: { type: "text", default: "", cssProperty: "--kui-target" }
      },
      prepare: deferPrepare(prepareSnap),
      perfClass: "layout"
    })
  ];

  // src/effects/scroll-mechanics/presets.ts
  var SCROLL_PRESETS = [
    // --- pinning ---------------------------------------------------------------------------
    // The default carries a spacer: a pin longer than its containing block silently does nothing,
    // and that is the single most common way authors get sticky wrong.
    { name: "pin-section", primitive: "pin", params: { distance: "100vh", spacer: "true" } },
    { name: "pin-until", primitive: "pin", params: { spacer: "false" } },
    { name: "pin-spacer", primitive: "pin", params: { spacer: "true" } },
    // Applied per card; each card sticks at its own offset and the stack builds up naturally.
    { name: "stacking-cards", primitive: "pin", params: { spacer: "false" } },
    // --- progress publishing ---------------------------------------------------------------
    { name: "scroll-progress", primitive: "scroll-progress" },
    { name: "scrollytelling-step", primitive: "scroll-progress", params: { steps: "4" } },
    // --- travel ------------------------------------------------------------------------------
    { name: "horizontal-scroll", primitive: "horizontal-track" },
    // --- media -------------------------------------------------------------------------------
    /*
     * `spacer:true` is what deletes the `.scrub-stage` wrapper a page used to hand-write.
     *
     * It could not be switched on until the tracker stopped measuring against the parent. A scrub
     * makes itself sticky, and `geometrySource` escapes a sticky subtree by taking its parent — so
     * with the wrapper gone the scrub was measured against whatever section contained it. Measured
     * on `demo/scroll.html`: the parent started 926px above the scrub against a 1817px distance, so
     * progress reached 51% before the element had even stuck and half the sequence played off
     * screen. The wrapper was not ceremony; it was the tight box that made the parent honest.
     *
     * `trackProgress`'s `contentAnchor` is the fix. Progress is read from the spacer, which the
     * library inserts, is exactly `distance` tall, is never sticky, and moves with the content — so
     * there is no wrapper to write and nothing to disagree with.
     *
     * `video-scrub` stays off: a video positioned by the page is not asking the library for a box.
     */
    { name: "sequence-scrub", primitive: "media-scrub", params: { spacer: "true" } },
    { name: "video-scrub", primitive: "media-scrub" },
    // --- navigation --------------------------------------------------------------------------
    { name: "scroll-spy", primitive: "scroll-spy" },
    // --- native CSS passthroughs ---------------------------------------------------------------
    { name: "smooth-scroll-to", primitive: "smooth-scroll" },
    { name: "scroll-snap-x", primitive: "scroll-snap", params: { axis: "x" } },
    { name: "scroll-snap-y", primitive: "scroll-snap", params: { axis: "y" } }
  ];

  // src/effects/scroll-mechanics/index.ts
  function registerScrollMechanics(registry) {
    return registry.registerPrimitives(SCROLL_PRIMITIVES).registerPresets(SCROLL_PRESETS);
  }

  // src/core/path-morph.ts
  var COMMAND = /([mlhvcz])|(-?(?:\d+(?:\.\d+)?|\.\d+))/gi;
  var UNSUPPORTED = /[AaSsQqTt]/;
  function parsePath(d) {
    if (UNSUPPORTED.test(d)) {
      return {
        segments: [],
        subpaths: [],
        reason: "arc and shorthand commands (A S Q T) are not supported"
      };
    }
    const tokens = [...d.matchAll(COMMAND)].map((m) => m[1] ?? m[2]);
    const state = {
      subpaths: [],
      open: void 0,
      current: { x: 0, y: 0 },
      start: { x: 0, y: 0 },
      command: ""
    };
    let index = 0;
    while (index < tokens.length) {
      const token = tokens[index];
      if (/[a-z]/i.test(token)) {
        state.command = token;
        if (token.toLowerCase() === "z") closeSubpath(state);
        index++;
        continue;
      }
      if (!state.command) {
        return { segments: [], subpaths: [], reason: "path must start with a command letter" };
      }
      index = consume(tokens, index, state);
    }
    if (state.subpaths.length === 0) {
      return { segments: [], subpaths: [], reason: "no drawable segments" };
    }
    return { segments: state.subpaths.flatMap((sub) => sub.segments), subpaths: state.subpaths };
  }
  function pushSegment(state, segment) {
    if (!state.open) {
      state.open = { segments: [], closed: false };
      state.subpaths.push(state.open);
    }
    state.open.segments.push(segment);
  }
  var ARITY = { m: 2, l: 2, h: 1, v: 1, c: 6, z: 0 };
  function closeSubpath(state) {
    const { current, start, open } = state;
    if (!open) return;
    if (Math.abs(current.x - start.x) >= 1e-6 || Math.abs(current.y - start.y) >= 1e-6) {
      open.segments.push(lineToCubic(current, start));
    }
    open.closed = true;
    state.current = { ...start };
    state.open = void 0;
  }
  function consume(tokens, index, state) {
    const key = state.command.toLowerCase();
    const relative = state.command === key;
    const arity = ARITY[key];
    const args = tokens.slice(index, index + arity).map(Number);
    if (args.length < arity) return tokens.length;
    const next = endpointFor(key, args, state.current, relative);
    if (key === "m") {
      state.current = next;
      state.start = next;
      state.open = void 0;
      state.command = relative ? "l" : "L";
      return index + arity;
    }
    pushSegment(state, straightOrCubic({ key, args, from: state.current, relative }, next));
    state.current = next;
    return index + arity;
  }
  function endpointFor(key, args, current, relative) {
    const base = relative ? current : { x: 0, y: 0 };
    if (key === "h") return { x: base.x + args[0], y: current.y };
    if (key === "v") return { x: current.x, y: base.y + args[0] };
    if (key === "c") return { x: base.x + args[4], y: base.y + args[5] };
    return { x: base.x + args[0], y: base.y + args[1] };
  }
  function straightOrCubic(command, to) {
    const { key, args, from, relative } = command;
    if (key !== "c") return lineToCubic(from, to);
    const base = relative ? from : { x: 0, y: 0 };
    return {
      from,
      c1: { x: base.x + args[0], y: base.y + args[1] },
      c2: { x: base.x + args[2], y: base.y + args[3] },
      to
    };
  }
  function lineToCubic(from, to) {
    return {
      from,
      c1: lerpPoint(from, to, 1 / 3),
      c2: lerpPoint(from, to, 2 / 3),
      to
    };
  }
  function lerp(a, b, t) {
    return a + (b - a) * t;
  }
  function lerpPoint(a, b, t) {
    return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) };
  }
  function splitCubic(segment, t) {
    const p01 = lerpPoint(segment.from, segment.c1, t);
    const p12 = lerpPoint(segment.c1, segment.c2, t);
    const p23 = lerpPoint(segment.c2, segment.to, t);
    const p012 = lerpPoint(p01, p12, t);
    const p123 = lerpPoint(p12, p23, t);
    const mid = lerpPoint(p012, p123, t);
    return [
      { from: segment.from, c1: p01, c2: p012, to: mid },
      { from: mid, c1: p123, c2: p23, to: segment.to }
    ];
  }
  function normaliseCount(segments, target) {
    const out = [...segments];
    while (out.length < target && out.length > 0) {
      let longest = 0;
      for (let i = 1; i < out.length; i++) {
        if (chordLength(out[i]) > chordLength(out[longest])) longest = i;
      }
      const [a, b] = splitCubic(out[longest], 0.5);
      out.splice(longest, 1, a, b);
    }
    return out;
  }
  function chordLength(segment) {
    return Math.hypot(segment.to.x - segment.from.x, segment.to.y - segment.from.y);
  }
  function round(value) {
    return Math.round(value * 100) / 100;
  }
  function subpathsToPathData(subpaths) {
    const parts = [];
    for (const sub of subpaths) {
      const head = sub.segments[0];
      parts.push(`M${round(head.from.x)},${round(head.from.y)}`);
      for (const s of sub.segments) {
        parts.push(
          `C${round(s.c1.x)},${round(s.c1.y)} ${round(s.c2.x)},${round(s.c2.y)} ${round(s.to.x)},${round(s.to.y)}`
        );
      }
      if (sub.closed) parts.push("Z");
    }
    return parts.join(" ");
  }
  function centroidOf(subpath) {
    let x = 0;
    let y = 0;
    for (const s of subpath.segments) {
      x += s.from.x;
      y += s.from.y;
    }
    return { x: x / subpath.segments.length, y: y / subpath.segments.length };
  }
  function collapsedLike(partner) {
    const at = centroidOf(partner);
    return {
      segments: partner.segments.map(() => ({
        from: { ...at },
        c1: { ...at },
        c2: { ...at },
        to: { ...at }
      })),
      closed: partner.closed
    };
  }
  function normaliseSubpaths(a, b) {
    const count = Math.max(a.length, b.length);
    const from = [];
    const to = [];
    for (let i = 0; i < count; i++) {
      const left = a[i] ?? collapsedLike(b[i]);
      const right = b[i] ?? collapsedLike(a[i]);
      const target = Math.max(left.segments.length, right.segments.length);
      const closed = left.closed && right.closed;
      from.push({ segments: normaliseCount(left.segments, target), closed });
      to.push({ segments: normaliseCount(right.segments, target), closed });
    }
    return { from, to };
  }
  function createMorph(fromPath, toPath) {
    const a = parsePath(fromPath);
    const b = parsePath(toPath);
    if (a.reason) return { reason: `start path: ${a.reason}` };
    if (b.reason) return { reason: `end path: ${b.reason}` };
    const { from, to } = normaliseSubpaths(a.subpaths, b.subpaths);
    const count = from.reduce((total, sub) => total + sub.segments.length, 0);
    return {
      morph: {
        segmentCount: count,
        at(t) {
          const clamped = Math.min(1, Math.max(0, t));
          return subpathsToPathData(
            from.map((sub, i) => ({
              segments: sub.segments.map(
                (segment, j) => lerpCubic(segment, to[i].segments[j], clamped)
              ),
              closed: sub.closed
            }))
          );
        }
      }
    };
  }
  function lerpCubic(a, b, t) {
    return {
      from: lerpPoint(a.from, b.from, t),
      c1: lerpPoint(a.c1, b.c1, t),
      c2: lerpPoint(a.c2, b.c2, t),
      to: lerpPoint(a.to, b.to, t)
    };
  }

  // src/effects/svg/index.ts
  function prepareMorph(el, params, ctx) {
    const path = el;
    const startPath = params.text("from") || path.getAttribute("d") || "";
    const { morph, reason } = createMorph(startPath, params.text("to"));
    if (!morph) {
      ctx.warn(`cannot morph: ${reason}`);
      return () => {
      };
    }
    const duration = effectDurationMs(params, 300);
    let frame = 0;
    let cancelled = false;
    const drive = (target) => {
      cancelAnimationFrame(frame);
      const startedAt = performance.now();
      const startValue = current;
      const step = (now) => {
        if (cancelled) return;
        const t = duration > 0 ? Math.min(1, (now - startedAt) / duration) : 1;
        current = startValue + (target - startValue) * t;
        path.setAttribute("d", morph.at(current));
        if (t < 1) frame = requestAnimationFrame(step);
      };
      frame = requestAnimationFrame(step);
    };
    let current = 0;
    const enter = () => drive(1);
    const leave = () => drive(0);
    el.addEventListener("pointerenter", enter, { passive: true });
    el.addEventListener("focusin", enter, { passive: true });
    el.addEventListener("pointerleave", leave, { passive: true });
    el.addEventListener("focusout", leave, { passive: true });
    return () => {
      cancelled = true;
      cancelAnimationFrame(frame);
      el.removeEventListener("pointerenter", enter);
      el.removeEventListener("focusin", enter);
      el.removeEventListener("pointerleave", leave);
      el.removeEventListener("focusout", leave);
      path.setAttribute("d", startPath);
    };
  }
  var PATH_DRAW_PRIMITIVE = cssPrimitive("path-draw", [CHANNEL.stroke], {
    parameters: {
      length: { type: "number", default: "100", cssProperty: "--kui-path-length", finite: true }
    }
  });
  var SHAPE_FILL_PRIMITIVE = cssPrimitive("shape-fill", [CHANNEL.clip]);
  var BAR_GROW_PRIMITIVE = cssPrimitive("bar-grow", [CHANNEL.scale], {
    parameters: { from: { type: "number", default: "0", cssProperty: "--kui-bar-from" } }
  });
  var LOGO_BUILD_PRIMITIVE = cssPrimitive("logo-assemble", [
    CHANNEL.opacity,
    CHANNEL.scale,
    CHANNEL.rotate
  ]);
  var ICON_TOGGLE_PRIMITIVE = {
    id: "icon-toggle",
    renderer: "javascript",
    channels: [CHANNEL.translate, CHANNEL.rotate, CHANNEL.scale, CHANNEL.opacity, CHANNEL.clip],
    parameters: {
      duration: { type: "time", default: "260ms", cssProperty: "--kui-duration" },
      ease: { type: "easing", default: "ease-out", cssProperty: "--kui-ease" }
    },
    supportedTimelines: ["time"],
    supportedActivations: ["load"],
    defaultActivation: "load",
    perfClass: "compositor",
    reducedMotion: "disable",
    prepare: () => inertInstance()
  };
  var SVG_PRIMITIVES = [
    {
      id: "path-morph",
      renderer: "javascript",
      // `d` is its own channel: nothing else in the catalog writes path geometry, so a morph can
      // safely compose with a fade or a rotation on the same element.
      channels: ["path"],
      parameters: {
        from: { type: "text", default: "", cssProperty: "--kui-path-from" },
        to: { type: "text", default: "", cssProperty: "--kui-path-to" },
        duration: { type: "time", default: "300ms", cssProperty: "--kui-duration" }
      },
      supportedTimelines: ["time"],
      supportedActivations: ["hover", "focus", "manual", "load"],
      // The morph attaches its own hover listeners, so it must be wired up on load, not on enter.
      defaultActivation: "load",
      perfClass: "paint",
      reducedMotion: "disable",
      prepare: deferPrepare(prepareMorph)
    },
    PATH_DRAW_PRIMITIVE,
    SHAPE_FILL_PRIMITIVE,
    BAR_GROW_PRIMITIVE,
    LOGO_BUILD_PRIMITIVE,
    ICON_TOGGLE_PRIMITIVE
  ];
  var SVG_PRESETS = [
    { name: "icon-morph", primitive: "path-morph" },
    { name: "blob-morph", primitive: "path-morph", params: { duration: "800ms" } },
    // Stroke draws. One keyframe block each rather than one shared block, matching the
    // progress-ring/gauge-sweep/donut-sweep/sparkline-draw group in numbers.ts: identical bodies
    // today, but each name is free to diverge and a consumer can restyle one without the others.
    { name: "draw-stroke", primitive: "path-draw", keyframes: "kui-draw-stroke", params: { duration: "800ms", ease: "ease-in-out" } },
    { name: "draw-signature", primitive: "path-draw", keyframes: "kui-draw-signature", params: { duration: "1600ms", ease: "ease-in-out" } },
    { name: "draw-underline", primitive: "path-draw", keyframes: "kui-draw-underline", params: { duration: "420ms" } },
    { name: "checkmark-draw", primitive: "path-draw", keyframes: "kui-checkmark-draw", params: { duration: "320ms" } },
    { name: "cross-draw", primitive: "path-draw", keyframes: "kui-cross-draw", params: { duration: "260ms" } },
    { name: "chart-line-draw", primitive: "path-draw", keyframes: "kui-chart-line-draw", params: { duration: "1200ms", ease: "ease-in-out" } },
    { name: "gradient-stroke", primitive: "path-draw", keyframes: "kui-gradient-stroke", params: { duration: "2400ms", ease: "ease-in-out" } },
    // Fills.
    { name: "heart-fill", primitive: "shape-fill", keyframes: "kui-heart-fill", params: { duration: "420ms" } },
    { name: "bookmark-fill", primitive: "shape-fill", keyframes: "kui-bookmark-fill", params: { duration: "360ms" } },
    { name: "chart-area-fill", primitive: "shape-fill", keyframes: "kui-chart-area-fill", params: { duration: "900ms" } },
    // `cloak: true`: `kui-chart-bar-grow`'s `from { scale: 1 0 }` (svg.css) is a zero-height box
    // while paused, not just an invisible one — so it occupies no space in layout for the whole
    // wait. Same defect `fold-panel` has, and the same fix shape: see svg.css's
    // `[data-kui-fx~='chart-bar-grow'][data-kui-state='ready']` rule.
    {
      name: "chart-bar-grow",
      primitive: "bar-grow",
      keyframes: "kui-chart-bar-grow",
      params: { duration: "700ms", ease: "back-out" },
      cloak: true
    },
    { name: "logo-build", primitive: "logo-assemble", keyframes: "kui-logo-build", params: { duration: "520ms", ease: "back-out" } },
    // Icon toggles — no `keyframes`, because their motion is a CSS transition in svg.css keyed off
    // aria state, not a compiled animation. Same shape as forms.ts's native-state presets.
    { name: "hamburger-to-x", primitive: "icon-toggle" },
    { name: "play-to-pause", primitive: "icon-toggle" },
    { name: "plus-to-minus", primitive: "icon-toggle" }
  ];
  function registerSvg(registry) {
    return registry.registerPrimitives(SVG_PRIMITIVES).registerPresets(SVG_PRESETS);
  }

  // src/effects/three-d/index.ts
  var FLIP_CONTROL_SELECTOR = ":scope > .kui-flip-control";
  function prepareCardToggle(el, params, ctx) {
    const trigger = params.text("trigger", "click");
    if (trigger === "click") return () => {
    };
    if (!supportsFineHover(ctx.win)) return () => {
    };
    const control = el.querySelector(FLIP_CONTROL_SELECTOR);
    if (!control) {
      ctx.warn(`flip-card trigger:${trigger} found no direct-child .kui-flip-control \u2014 the card will not flip`);
      return () => {
      };
    }
    const set = (flipped) => control.setAttribute("aria-pressed", String(flipped));
    const isFlipped = () => control.getAttribute("aria-pressed") === "true";
    const onEnter = () => {
      set(trigger === "hover-toggle" ? !isFlipped() : true);
    };
    const onLeave = () => set(false);
    el.addEventListener("pointerenter", onEnter, { passive: true });
    if (trigger === "hover") el.addEventListener("pointerleave", onLeave, { passive: true });
    return () => {
      el.removeEventListener("pointerenter", onEnter);
      el.removeEventListener("pointerleave", onLeave);
    };
  }
  var CARD_TOGGLE_PRIMITIVE = {
    id: "card-toggle",
    renderer: "javascript",
    channels: [CHANNEL.rotate],
    parameters: {
      duration: { type: "time", default: "700ms", cssProperty: "--kui-duration" },
      ease: { type: "easing", default: "ease-in-out", cssProperty: "--kui-ease" },
      perspective: { type: "length", default: "1600px", cssProperty: "--kui-perspective" },
      trigger: {
        type: "keyword",
        default: "click",
        cssProperty: "--kui-flip-trigger",
        values: ["click", "hover", "hover-latch", "hover-toggle"]
      }
    },
    supportedTimelines: ["time"],
    supportedActivations: ["load"],
    defaultActivation: "load",
    perfClass: "compositor",
    reducedMotion: "disable",
    prepare: deferPrepare(prepareCardToggle)
  };
  var THREE_D_PRIMITIVES = [
    // `skew`, not `rotate`: the keyframes in three-d.css write `transform: perspective(...)
    // rotateX/Y(...)`, not the individual `rotate:` property — `perspective` only creates depth for
    // an element's *children*, so giving one of these effects its own depth means reaching for the
    // `perspective()` transform *function*, which only exists inside the `transform` shorthand.
    // `CHANNEL.skew` is this catalog's name for "claims the whole `transform` shorthand"; see the
    // comment on it in `core/types.ts`.
    cssPrimitive("flip-face", [CHANNEL.skew], {
      parameters: {
        angle: { type: "angle", default: "180deg", cssProperty: "--kui-from-angle" },
        perspective: { type: "length", default: "1200px", cssProperty: "--kui-perspective" }
      }
    }),
    cssPrimitive("page-reveal", [CHANNEL.opacity, CHANNEL.translate], {
      parameters: { distance: { type: "length", default: "40px", cssProperty: "--kui-distance" } }
    }),
    cssPrimitive("wipe", [CHANNEL.clip]),
    // `from` gives `loading-bar` a real knob on its start scale — it had none before, unlike
    // `flip-face`'s `angle:` two rows up. `--kui-bar-from` is also what the fold-panel-style
    // `[data-kui-fx~='loading-bar'][data-kui-state='ready']` gate neutralizes in three-d.css; see
    // that rule's comment for the on:enter fix this parameter doubles as.
    cssPrimitive("bar", [CHANNEL.scale], {
      parameters: { from: { type: "number", default: "0", cssProperty: "--kui-bar-from" } }
    }),
    CARD_TOGGLE_PRIMITIVE
  ];
  var THREE_D_PRESETS = [
    // --- 3D & perspective ---
    { name: "card-flip-y", primitive: "flip-face", keyframes: "kui-card-flip-y", cloak: true },
    { name: "card-flip-x", primitive: "flip-face", keyframes: "kui-card-flip-x", cloak: true },
    { name: "cube-rotate", primitive: "flip-face", keyframes: "kui-cube-rotate", params: { angle: "90deg" } },
    {
      name: "book-page-turn",
      primitive: "flip-face",
      keyframes: "kui-book-page-turn",
      params: { angle: "-160deg", duration: "900ms" }
    },
    // `cloak: true`, unlike its `flip-face` siblings above: those are `to`-only keyframes, so their
    // paused/waiting box is the ordinary, untransformed rest state. `fold-panel` is `from`-only —
    // its `rotateX(-90deg)` (three-d.css) *is* the paused box, edge-on and zero-height, so it holds
    // no space in layout for the whole wait; see the
    // `[data-kui-fx~='fold-panel'][data-kui-state='ready']` rule in three-d.css for the other half
    // of that fix. `cloak` only ever hid the pre-JS flash, not this, but adding it here keeps the
    // pre-JS and post-JS "ready" appearances the same (invisible) instead of trading one flash for
    // the other.
    {
      name: "fold-panel",
      primitive: "flip-face",
      keyframes: "kui-fold-panel",
      params: { angle: "-90deg" },
      cloak: true
    },
    // --- page transitions ---
    { name: "page-fade", primitive: "page-reveal", keyframes: "kui-page-fade" },
    { name: "page-slide", primitive: "page-reveal", keyframes: "kui-page-slide" },
    { name: "curtain-wipe", primitive: "wipe", keyframes: "kui-curtain-wipe", params: { duration: "800ms" } },
    // `cloak: true` for the same reason as `fold-panel`: `kui-loading-bar`'s `from { scale: 0 1 }`
    // (three-d.css) is a zero-width box, not just an invisible one — see that file's
    // `[data-kui-fx~='loading-bar'][data-kui-state='ready']` rule.
    { name: "loading-bar", primitive: "bar", keyframes: "kui-loading-bar", cloak: true },
    // No `keyframes`: its motion is a CSS transition in three-d.css keyed off the control's
    // aria-pressed, not a compiled animation. Same shape as the icon toggles in svg.ts.
    { name: "flip-card", primitive: "card-toggle" }
  ];
  function registerThreeD(registry) {
    return registry.registerPrimitives(THREE_D_PRIMITIVES).registerPresets(THREE_D_PRESETS);
  }

  // src/effects/index.ts
  function createRegistry() {
    const registry = new Registry();
    registerCore(registry);
    registerScrollMechanics(registry);
    registerLayout(registry);
    registerSvg(registry);
    registerGestures(registry);
    registerThreeD(registry);
    registerCatalog(registry);
    registerNavigation(registry);
    registerForms(registry);
    return registry;
  }

  // src/index.ts
  function kuinetic(options = {}) {
    return new Animator({ registry: createRegistry(), ...options });
  }
  var src_default = kuinetic;
  return __toCommonJS(src_exports);
})();

;(function () {
  if (!document.getElementById('kuinetic-styles')) {
    var style = document.createElement('style')
    style.id = 'kuinetic-styles'
    style.textContent = "/* src/css/base.css */\n@layer kui.tokens, kui.presets, kui.effects, kui.policy, kui.cloak;\n@layer kui.tokens {\n  :root {\n    --kui-ease-expo-in: cubic-bezier(0.7, 0, 0.84, 0);\n    --kui-ease-expo-out: cubic-bezier(0.16, 1, 0.3, 1);\n    --kui-ease-expo-in-out: cubic-bezier(0.87, 0, 0.13, 1);\n    --kui-ease-back-in: cubic-bezier(0.36, 0, 0.66, -0.56);\n    --kui-ease-back-out: cubic-bezier(0.34, 1.56, 0.64, 1);\n    --kui-ease-back-in-out: cubic-bezier(0.68, -0.6, 0.32, 1.6);\n    --kui-ease-quart-out: cubic-bezier(0.25, 1, 0.5, 1);\n    --kui-ease-circ-out: cubic-bezier(0, 0.55, 0.45, 1);\n    --kui-ease-spring: linear(0, 0.4 12%, 0.9 25%, 1.06 38%, 1.01 62%, 1);\n    --kui-ease-bounce: linear(0, 0.5 10%, 1.2 30%, 0.9 50%, 1.08 68%, 0.97 82%, 1.02 92%, 1);\n  }\n  [data-kui-fx] {\n    --kui-dir: 1;\n    --kui-i: 0;\n  }\n  :dir(rtl) [data-kui-fx] {\n    --kui-dir: -1;\n  }\n}\n@layer kui.policy {\n  html[data-kui-cloak] [data-kui][data-kui-reveal]:not([data-kui-state]) {\n    opacity: 0 !important;\n  }\n  @media (prefers-reduced-motion: reduce) {\n    [data-kui-rm],\n    [data-kui-rm]::before,\n    [data-kui-rm]::after,\n    [data-kui-rm] .kui-odometer-strip,\n    [data-kui-rm][data-kui-fx~=label-float] ~ label,\n    [data-kui-rm][data-kui-fx~=input-underline-grow] ~ .kui-underline,\n    [data-kui-rm][data-kui-fx~=toggle-morph] ~ .kui-track,\n    [data-kui-rm][data-kui-fx~=toggle-morph] ~ .kui-track .kui-thumb,\n    [data-kui-rm][data-kui-fx~=checkbox-draw] ~ svg path,\n    [data-kui-rm][data-kui-fx~=radio-fill] ~ .kui-dot,\n    [data-kui-rm][data-kui-fx~=strength-meter] ~ .kui-meter > *,\n    [data-kui-rm][data-kui-fx~=hamburger-to-x] .kui-bar,\n    [data-kui-rm][data-kui-fx~=play-to-pause] .kui-bar,\n    [data-kui-rm][data-kui-fx~=plus-to-minus] .kui-bar,\n    [data-kui-rm][data-kui-fx~=flip-card] > .kui-face-front,\n    [data-kui-rm][data-kui-fx~=flip-card] > .kui-face-back {\n      transition-duration: 1ms !important;\n      transition-delay: 0ms !important;\n    }\n    [data-kui-rm=shorten],\n    [data-kui-rm=shorten]::before,\n    [data-kui-rm=shorten]::after {\n      animation-duration: 1ms !important;\n      animation-delay: 0ms !important;\n    }\n    [data-kui-rm=crossfade] {\n      animation-name: kui-in !important;\n      animation-duration: 200ms !important;\n    }\n    [data-kui-rm=disable] {\n      animation: none !important;\n      opacity: 1 !important;\n      translate: none !important;\n      scale: none !important;\n      rotate: none !important;\n      filter: none !important;\n    }\n  }\n  @media print {\n    [data-kui-fx],\n    [data-kui-reveal] {\n      animation: none !important;\n      opacity: 1 !important;\n      translate: none !important;\n      scale: none !important;\n      rotate: none !important;\n      filter: none !important;\n    }\n  }\n}\n\n/* src/css/presets.generated.css */\n@layer kui.presets {\n  [data-kui-fx~=accordion-height] {\n    --kui-auto-height-duration: 400ms;\n    --kui-auto-height-ease: ease-out;\n  }\n  [data-kui-fx~=aurora] {\n    --kui-ambient-gradient-duration: 10s;\n    --kui-ambient-gradient-delay: 0ms;\n    --kui-ambient-gradient-ease: ease-in-out;\n  }\n  [data-kui-fx~=back-in-down] {\n    --kui-distance: 120px;\n    --kui-reveal-ease: var(--kui-ease-expo-out, ease-out);\n    --kui-reveal-duration: 600ms;\n    --kui-reveal-delay: 0ms;\n  }\n  [data-kui-fx~=back-in-up] {\n    --kui-distance: 120px;\n    --kui-reveal-ease: var(--kui-ease-expo-out, ease-out);\n    --kui-reveal-duration: 600ms;\n    --kui-reveal-delay: 0ms;\n  }\n  [data-kui-fx~=badge-pop] {\n    --kui-feedback-pop-duration: 420ms;\n    --kui-feedback-pop-delay: 0ms;\n    --kui-feedback-pop-ease: var(--kui-ease-back-out, ease-out);\n  }\n  [data-kui-fx~=beam-border] {\n    --kui-beam-border-duration: 220ms;\n    --kui-beam-border-ease: ease-out;\n  }\n  [data-kui-fx~=beam-border-auto] {\n    --kui-beam-border-auto-duration: 220ms;\n    --kui-beam-border-auto-ease: ease-out;\n  }\n  [data-kui-fx~=before-after-wipe] {\n    --kui-media-wipe-duration: 600ms;\n    --kui-media-wipe-delay: 0ms;\n    --kui-media-wipe-ease: ease-out;\n  }\n  [data-kui-fx~=blob-morph] {\n    --kui-path-morph-duration: 800ms;\n  }\n  [data-kui-fx~=blur-in] {\n    --kui-blur-duration: 600ms;\n    --kui-blur-delay: 0ms;\n    --kui-blur-ease: ease-out;\n  }\n  [data-kui-fx~=blur-out] {\n    --kui-blur-duration: 600ms;\n    --kui-blur-delay: 0ms;\n    --kui-blur-ease: ease-out;\n  }\n  [data-kui-fx~=blur-up] {\n    --kui-media-blur-up-duration: 600ms;\n    --kui-media-blur-up-delay: 0ms;\n    --kui-media-blur-up-ease: ease-out;\n  }\n  [data-kui-fx~=bob] {\n    --kui-ambient-float-duration: 2s;\n    --kui-distance: 8px;\n    --kui-ambient-float-delay: 0ms;\n    --kui-ambient-float-ease: ease-in-out;\n  }\n  [data-kui-fx~=book-page-turn] {\n    --kui-from-angle: -160deg;\n    --kui-flip-face-duration: 900ms;\n    --kui-flip-face-delay: 0ms;\n    --kui-flip-face-ease: ease-out;\n  }\n  [data-kui-fx~=bookmark-fill] {\n    --kui-shape-fill-duration: 360ms;\n    --kui-shape-fill-delay: 0ms;\n    --kui-shape-fill-ease: ease-out;\n  }\n  [data-kui-fx~=border-draw] {\n    --kui-border-draw-duration: 220ms;\n    --kui-border-draw-ease: ease-out;\n  }\n  [data-kui-fx~=border-glow] {\n    --kui-border-glow-duration: 220ms;\n    --kui-border-glow-ease: ease-out;\n  }\n  [data-kui-fx~=bounce-in] {\n    --kui-from-scale: 0.3;\n    --kui-scale-ease: var(--kui-ease-bounce, ease-out);\n    --kui-scale-duration: 600ms;\n    --kui-scale-delay: 0ms;\n  }\n  [data-kui-fx~=bounce-in-down] {\n    --kui-distance: 60px;\n    --kui-reveal-ease: var(--kui-ease-back-out, ease-out);\n    --kui-reveal-duration: 600ms;\n    --kui-reveal-delay: 0ms;\n  }\n  [data-kui-fx~=bounce-in-up] {\n    --kui-distance: 60px;\n    --kui-reveal-ease: var(--kui-ease-back-out, ease-out);\n    --kui-reveal-duration: 600ms;\n    --kui-reveal-delay: 0ms;\n  }\n  [data-kui-fx~=card-flip-x] {\n    --kui-flip-face-duration: 600ms;\n    --kui-flip-face-delay: 0ms;\n    --kui-flip-face-ease: ease-out;\n  }\n  [data-kui-fx~=card-flip-y] {\n    --kui-flip-face-duration: 600ms;\n    --kui-flip-face-delay: 0ms;\n    --kui-flip-face-ease: ease-out;\n  }\n  [data-kui-fx~=chart-area-fill] {\n    --kui-shape-fill-duration: 900ms;\n    --kui-shape-fill-delay: 0ms;\n    --kui-shape-fill-ease: ease-out;\n  }\n  [data-kui-fx~=chart-bar-grow] {\n    --kui-bar-grow-duration: 700ms;\n    --kui-bar-grow-ease: var(--kui-ease-back-out, ease-out);\n    --kui-bar-grow-delay: 0ms;\n  }\n  [data-kui-fx~=chart-line-draw] {\n    --kui-path-draw-duration: 1200ms;\n    --kui-path-draw-ease: ease-in-out;\n    --kui-path-draw-delay: 0ms;\n  }\n  [data-kui-fx~=checkmark-draw] {\n    --kui-path-draw-duration: 320ms;\n    --kui-path-draw-delay: 0ms;\n    --kui-path-draw-ease: ease-out;\n  }\n  [data-kui-fx~=confetti-burst] {\n    --kui-feedback-burst-duration: 900ms;\n    --kui-pop-scale: 1.15;\n    --kui-feedback-burst-delay: 0ms;\n    --kui-feedback-burst-ease: var(--kui-ease-back-out, ease-out);\n  }\n  [data-kui-fx~=copy-confirm] {\n    --kui-feedback-confirm-duration: 1400ms;\n    --kui-feedback-confirm-delay: 0ms;\n    --kui-feedback-confirm-ease: linear;\n  }\n  [data-kui-fx~=count-bump] {\n    --kui-feedback-pop-duration: 280ms;\n    --kui-pop-scale: 1.3;\n    --kui-feedback-pop-delay: 0ms;\n    --kui-feedback-pop-ease: var(--kui-ease-back-out, ease-out);\n  }\n  [data-kui-fx~=count-compact] {\n    --kui-from: 0;\n    --kui-to: 128400;\n    --kui-format: compact;\n    --kui-count-duration: 1600ms;\n    --kui-count-delay: 0ms;\n  }\n  [data-kui-fx~=count-currency] {\n    --kui-from: 0;\n    --kui-to: 4820;\n    --kui-format: currency;\n    --kui-decimals: 0;\n    --kui-count-duration: 1600ms;\n    --kui-count-delay: 0ms;\n  }\n  [data-kui-fx~=count-down] {\n    --kui-from: 100;\n    --kui-to: 0;\n    --kui-count-duration: 1600ms;\n    --kui-count-delay: 0ms;\n  }\n  [data-kui-fx~=count-percent] {\n    --kui-from: 0;\n    --kui-to: 0.82;\n    --kui-format: percent;\n    --kui-decimals: 0;\n    --kui-count-duration: 1600ms;\n    --kui-count-delay: 0ms;\n  }\n  [data-kui-fx~=count-up] {\n    --kui-from: 0;\n    --kui-to: 100;\n    --kui-count-duration: 1600ms;\n    --kui-count-delay: 0ms;\n  }\n  [data-kui-fx~=cross-draw] {\n    --kui-path-draw-duration: 260ms;\n    --kui-path-draw-delay: 0ms;\n    --kui-path-draw-ease: ease-out;\n  }\n  [data-kui-fx~=cube-rotate] {\n    --kui-from-angle: 90deg;\n    --kui-flip-face-duration: 600ms;\n    --kui-flip-face-delay: 0ms;\n    --kui-flip-face-ease: ease-out;\n  }\n  [data-kui-fx~=cursor-follow] {\n    --kui-stiffness: 300;\n    --kui-damping: 30;\n  }\n  [data-kui-fx~=cursor-invert] {\n    --kui-stiffness: 260;\n    --kui-damping: 26;\n  }\n  [data-kui-fx~=cursor-label] {\n    --kui-stiffness: 260;\n    --kui-damping: 26;\n  }\n  [data-kui-fx~=cursor-lag] {\n    --kui-stiffness: 80;\n    --kui-damping: 14;\n  }\n  [data-kui-fx~=curtain-reveal] {\n    --kui-media-wipe-duration: 600ms;\n    --kui-media-wipe-delay: 0ms;\n    --kui-media-wipe-ease: ease-out;\n  }\n  [data-kui-fx~=curtain-wipe] {\n    --kui-wipe-duration: 800ms;\n    --kui-wipe-delay: 0ms;\n    --kui-wipe-ease: ease-out;\n  }\n  [data-kui-fx~=decode] {\n    --kui-charset: binary;\n    --kui-scramble-text-delay: 0ms;\n  }\n  [data-kui-fx~=depth-layer] {\n    --kui-distance: 200px;\n    --kui-parallax-duration: 600ms;\n    --kui-parallax-delay: 0ms;\n    --kui-parallax-ease: ease-out;\n  }\n  [data-kui-fx~=donut-sweep] {\n    --kui-stroke-sweep-duration: 600ms;\n    --kui-stroke-sweep-delay: 0ms;\n    --kui-stroke-sweep-ease: ease-out;\n  }\n  [data-kui-fx~=dot-grid-drift] {\n    --kui-ambient-tint-duration: 16s;\n    --kui-ambient-tint-ease: linear;\n    --kui-ambient-tint-delay: 0ms;\n  }\n  [data-kui-fx~=drag-inertia] {\n    --kui-inertia: true;\n  }\n  [data-kui-fx~=drag-x] {\n    --kui-axis: x;\n  }\n  [data-kui-fx~=drag-y] {\n    --kui-axis: y;\n  }\n  [data-kui-fx~=draw-signature] {\n    --kui-path-draw-duration: 1600ms;\n    --kui-path-draw-ease: ease-in-out;\n    --kui-path-draw-delay: 0ms;\n  }\n  [data-kui-fx~=draw-stroke] {\n    --kui-path-draw-duration: 800ms;\n    --kui-path-draw-ease: ease-in-out;\n    --kui-path-draw-delay: 0ms;\n  }\n  [data-kui-fx~=draw-underline] {\n    --kui-path-draw-duration: 420ms;\n    --kui-path-draw-delay: 0ms;\n    --kui-path-draw-ease: ease-out;\n  }\n  [data-kui-fx~=drawer-slide] {\n    --kui-drawer-slide-duration: 600ms;\n    --kui-drawer-slide-delay: 0ms;\n    --kui-drawer-slide-ease: ease-out;\n  }\n  [data-kui-fx~=dropdown-open] {\n    --kui-panel-reveal-duration: 600ms;\n    --kui-panel-reveal-delay: 0ms;\n    --kui-panel-reveal-ease: ease-out;\n  }\n  [data-kui-fx~=duotone-hover] {\n    --kui-media-filter-duration: 600ms;\n    --kui-media-filter-delay: 0ms;\n    --kui-media-filter-ease: ease-out;\n  }\n  [data-kui-fx~=elastic-pull] {\n    --kui-return: true;\n    --kui-bounds: 80;\n  }\n  [data-kui-fx~=expand-to-modal] {\n    --kui-flip-scale: true;\n    --kui-flip-container-duration: 500ms;\n    --kui-flip-container-ease: ease-out;\n  }\n  [data-kui-fx~=fade-blur-in] {\n    --kui-reveal-blur-duration: 600ms;\n    --kui-reveal-blur-delay: 0ms;\n    --kui-reveal-blur-ease: ease-out;\n  }\n  [data-kui-fx~=fade-blur-up] {\n    --kui-reveal-blur-duration: 600ms;\n    --kui-reveal-blur-delay: 0ms;\n    --kui-reveal-blur-ease: ease-out;\n  }\n  [data-kui-fx~=fade-down] {\n    --kui-reveal-duration: 600ms;\n    --kui-reveal-delay: 0ms;\n    --kui-reveal-ease: ease-out;\n  }\n  [data-kui-fx~=fade-in] {\n    --kui-reveal-duration: 600ms;\n    --kui-reveal-delay: 0ms;\n    --kui-reveal-ease: ease-out;\n  }\n  [data-kui-fx~=fade-left] {\n    --kui-reveal-duration: 600ms;\n    --kui-reveal-delay: 0ms;\n    --kui-reveal-ease: ease-out;\n  }\n  [data-kui-fx~=fade-out] {\n    --kui-reveal-duration: 600ms;\n    --kui-reveal-delay: 0ms;\n    --kui-reveal-ease: ease-out;\n  }\n  [data-kui-fx~=fade-out-down] {\n    --kui-reveal-duration: 600ms;\n    --kui-reveal-delay: 0ms;\n    --kui-reveal-ease: ease-out;\n  }\n  [data-kui-fx~=fade-out-left] {\n    --kui-reveal-duration: 600ms;\n    --kui-reveal-delay: 0ms;\n    --kui-reveal-ease: ease-out;\n  }\n  [data-kui-fx~=fade-out-right] {\n    --kui-reveal-duration: 600ms;\n    --kui-reveal-delay: 0ms;\n    --kui-reveal-ease: ease-out;\n  }\n  [data-kui-fx~=fade-out-up] {\n    --kui-reveal-duration: 600ms;\n    --kui-reveal-delay: 0ms;\n    --kui-reveal-ease: ease-out;\n  }\n  [data-kui-fx~=fade-right] {\n    --kui-reveal-duration: 600ms;\n    --kui-reveal-delay: 0ms;\n    --kui-reveal-ease: ease-out;\n  }\n  [data-kui-fx~=fade-up] {\n    --kui-reveal-duration: 600ms;\n    --kui-reveal-delay: 0ms;\n    --kui-reveal-ease: ease-out;\n  }\n  [data-kui-fx~=flip-card] {\n    --kui-card-toggle-duration: 700ms;\n    --kui-card-toggle-ease: ease-in-out;\n  }\n  [data-kui-fx~=flip-filter] {\n    --kui-flip-container-duration: 400ms;\n    --kui-flip-container-ease: ease-out;\n  }\n  [data-kui-fx~=flip-in-x] {\n    --kui-flip-3d-duration: 600ms;\n    --kui-flip-3d-delay: 0ms;\n    --kui-flip-3d-ease: ease-out;\n  }\n  [data-kui-fx~=flip-in-y] {\n    --kui-flip-3d-duration: 600ms;\n    --kui-flip-3d-delay: 0ms;\n    --kui-flip-3d-ease: ease-out;\n  }\n  [data-kui-fx~=flip-out-x] {\n    --kui-flip-3d-duration: 600ms;\n    --kui-flip-3d-delay: 0ms;\n    --kui-flip-3d-ease: ease-out;\n  }\n  [data-kui-fx~=flip-out-y] {\n    --kui-flip-3d-duration: 600ms;\n    --kui-flip-3d-delay: 0ms;\n    --kui-flip-3d-ease: ease-out;\n  }\n  [data-kui-fx~=flip-reorder] {\n    --kui-flip-container-duration: 400ms;\n    --kui-flip-container-ease: ease-out;\n  }\n  [data-kui-fx~=flip-shuffle] {\n    --kui-flip-container-duration: 400ms;\n    --kui-flip-container-ease: ease-out;\n  }\n  [data-kui-fx~=flip-sort] {\n    --kui-flip-container-duration: 400ms;\n    --kui-flip-container-ease: ease-out;\n  }\n  [data-kui-fx~=float] {\n    --kui-ambient-float-duration: 4s;\n    --kui-ambient-float-delay: 0ms;\n    --kui-ambient-float-ease: ease-in-out;\n  }\n  [data-kui-fx~=floating-shapes] {\n    --kui-ambient-float-duration: 6s;\n    --kui-distance: 10px;\n    --kui-ambient-float-delay: 0ms;\n    --kui-ambient-float-ease: ease-in-out;\n  }\n  [data-kui-fx~=focus-ring-grow] {\n    --kui-focus-ring-duration: 600ms;\n    --kui-focus-ring-delay: 0ms;\n    --kui-focus-ring-ease: ease-out;\n  }\n  [data-kui-fx~=fold-panel] {\n    --kui-from-angle: -90deg;\n    --kui-flip-face-duration: 600ms;\n    --kui-flip-face-delay: 0ms;\n    --kui-flip-face-ease: ease-out;\n  }\n  [data-kui-fx~=gauge-sweep] {\n    --kui-stroke-sweep-duration: 600ms;\n    --kui-stroke-sweep-delay: 0ms;\n    --kui-stroke-sweep-ease: ease-out;\n  }\n  [data-kui-fx~=glitch] {\n    --kui-charset: symbols;\n    --kui-scramble-text-delay: 0ms;\n  }\n  [data-kui-fx~=glow-pulse] {\n    --kui-ambient-pulse-duration: 2.2s;\n    --kui-ambient-pulse-delay: 0ms;\n    --kui-ambient-pulse-ease: ease-in-out;\n  }\n  [data-kui-fx~=gradient-border] {\n    --kui-ambient-gradient-ring-duration: 6s;\n    --kui-ambient-gradient-ring-ease: linear;\n    --kui-ambient-gradient-ring-delay: 0ms;\n  }\n  [data-kui-fx~=gradient-mesh] {\n    --kui-ambient-gradient-duration: 10s;\n    --kui-ambient-gradient-delay: 0ms;\n    --kui-ambient-gradient-ease: ease-in-out;\n  }\n  [data-kui-fx~=gradient-rotate-border] {\n    --kui-ambient-gradient-ring-duration: 6s;\n    --kui-ambient-gradient-ring-ease: linear;\n    --kui-ambient-gradient-ring-delay: 0ms;\n  }\n  [data-kui-fx~=gradient-shimmer] {\n    --kui-text-shimmer-duration: 600ms;\n    --kui-text-shimmer-delay: 0ms;\n    --kui-text-shimmer-ease: ease-out;\n  }\n  [data-kui-fx~=gradient-stroke] {\n    --kui-path-draw-duration: 2400ms;\n    --kui-path-draw-ease: ease-in-out;\n    --kui-path-draw-delay: 0ms;\n  }\n  [data-kui-fx~=gradient-sweep] {\n    --kui-text-gradient-sweep-duration: 600ms;\n    --kui-text-gradient-sweep-delay: 0ms;\n    --kui-text-gradient-sweep-ease: ease-out;\n  }\n  [data-kui-fx~=grayscale-hover] {\n    --kui-media-filter-duration: 600ms;\n    --kui-media-filter-delay: 0ms;\n    --kui-media-filter-ease: ease-out;\n  }\n  [data-kui-fx~=grid-to-list] {\n    --kui-flip-scale: true;\n    --kui-flip-container-duration: 400ms;\n    --kui-flip-container-ease: ease-out;\n  }\n  [data-kui-fx~=hamburger-to-x] {\n    --kui-icon-toggle-duration: 260ms;\n    --kui-icon-toggle-ease: ease-out;\n  }\n  [data-kui-fx~=heart-burst] {\n    --kui-feedback-burst-duration: 700ms;\n    --kui-pop-scale: 1.4;\n    --kui-feedback-burst-delay: 0ms;\n    --kui-feedback-burst-ease: var(--kui-ease-back-out, ease-out);\n  }\n  [data-kui-fx~=heart-fill] {\n    --kui-shape-fill-duration: 420ms;\n    --kui-shape-fill-delay: 0ms;\n    --kui-shape-fill-ease: ease-out;\n  }\n  [data-kui-fx~=highlight-sweep] {\n    --kui-sweep-color: gold;\n    --kui-text-sweep-duration: 600ms;\n    --kui-text-sweep-delay: 0ms;\n    --kui-text-sweep-ease: ease-out;\n  }\n  [data-kui-fx~=icon-bounce] {\n    --kui-icon-bounce-duration: 220ms;\n    --kui-icon-bounce-ease: ease-out;\n  }\n  [data-kui-fx~=icon-morph] {\n    --kui-path-morph-duration: 300ms;\n  }\n  [data-kui-fx~=icon-spin] {\n    --kui-icon-spin-duration: 220ms;\n    --kui-icon-spin-ease: ease-out;\n  }\n  [data-kui-fx~=icon-wiggle] {\n    --kui-icon-wiggle-duration: 220ms;\n    --kui-icon-wiggle-ease: ease-out;\n  }\n  [data-kui-fx~=image-parallax-frame] {\n    --kui-media-parallax-frame-duration: 600ms;\n    --kui-media-parallax-frame-delay: 0ms;\n    --kui-media-parallax-frame-ease: ease-out;\n  }\n  [data-kui-fx~=ken-burns] {\n    --kui-media-ken-burns-duration: 600ms;\n    --kui-media-ken-burns-delay: 0ms;\n    --kui-media-ken-burns-ease: ease-out;\n  }\n  [data-kui-fx~=ken-burns-out] {\n    --kui-media-ken-burns-duration: 600ms;\n    --kui-media-ken-burns-delay: 0ms;\n    --kui-media-ken-burns-ease: ease-out;\n  }\n  [data-kui-fx~=lift] {\n    --kui-lift-duration: 220ms;\n    --kui-lift-ease: ease-out;\n  }\n  [data-kui-fx~=lift-shadow] {\n    --kui-lift-shadow-duration: 220ms;\n    --kui-lift-shadow-ease: ease-out;\n  }\n  [data-kui-fx~=lightbox-open] {\n    --kui-media-lightbox-duration: 600ms;\n    --kui-media-lightbox-delay: 0ms;\n    --kui-media-lightbox-ease: ease-out;\n  }\n  [data-kui-fx~=line-grid-drift] {\n    --kui-ambient-tint-duration: 16s;\n    --kui-ambient-tint-ease: linear;\n    --kui-ambient-tint-delay: 0ms;\n  }\n  [data-kui-fx~=loading-bar] {\n    --kui-bar-duration: 600ms;\n    --kui-bar-delay: 0ms;\n    --kui-bar-ease: ease-out;\n  }\n  [data-kui-fx~=logo-build] {\n    --kui-logo-assemble-duration: 520ms;\n    --kui-logo-assemble-ease: var(--kui-ease-back-out, ease-out);\n    --kui-logo-assemble-delay: 0ms;\n  }\n  [data-kui-fx~=long-press] {\n    --kui-pressable-duration: 500ms;\n  }\n  [data-kui-fx~=magnetic-snap] {\n    --kui-strength: 0.6;\n    --kui-radius: 160;\n  }\n  [data-kui-fx~=marquee] {\n    --kui-text-marquee-duration: 600ms;\n    --kui-text-marquee-delay: 0ms;\n    --kui-text-marquee-ease: ease-out;\n  }\n  [data-kui-fx~=marquee-scroll-linked] {\n    --kui-text-marquee-duration: 600ms;\n    --kui-text-marquee-delay: 0ms;\n    --kui-text-marquee-ease: ease-out;\n  }\n  [data-kui-fx~=mask-reveal] {\n    --kui-media-mask-duration: 600ms;\n    --kui-media-mask-delay: 0ms;\n    --kui-media-mask-ease: ease-out;\n  }\n  [data-kui-fx~=masonry-reflow] {\n    --kui-flip-container-duration: 400ms;\n    --kui-flip-container-ease: ease-out;\n  }\n  [data-kui-fx~=mega-menu-drop] {\n    --kui-panel-reveal-duration: 550ms;\n    --kui-panel-reveal-delay: 0ms;\n    --kui-panel-reveal-ease: ease-out;\n  }\n  [data-kui-fx~=menu-fullscreen] {\n    --kui-menu-fullscreen-duration: 600ms;\n    --kui-menu-fullscreen-delay: 0ms;\n    --kui-menu-fullscreen-ease: ease-out;\n  }\n  [data-kui-fx~=menu-stagger-open] {\n    --kui-nav-reveal-duration: 600ms;\n    --kui-nav-reveal-delay: 0ms;\n    --kui-nav-reveal-ease: ease-out;\n  }\n  [data-kui-fx~=noise-overlay] {\n    --kui-ambient-tint-duration: 650ms;\n    --kui-ambient-tint-ease: steps(6);\n    --kui-ambient-tint-delay: 0ms;\n  }\n  [data-kui-fx~=odometer-roll] {\n    --kui-from: 0;\n    --kui-to: 4820;\n    --kui-count-odometer-duration: 1600ms;\n    --kui-count-odometer-delay: 0ms;\n  }\n  [data-kui-fx~=orbit] {\n    --kui-ambient-orbit-duration: 3.5s;\n    --kui-ambient-orbit-delay: 0ms;\n    --kui-ambient-orbit-ease: linear;\n  }\n  [data-kui-fx~=page-fade] {\n    --kui-page-reveal-duration: 600ms;\n    --kui-page-reveal-delay: 0ms;\n    --kui-page-reveal-ease: ease-out;\n  }\n  [data-kui-fx~=page-slide] {\n    --kui-page-reveal-duration: 600ms;\n    --kui-page-reveal-delay: 0ms;\n    --kui-page-reveal-ease: ease-out;\n  }\n  [data-kui-fx~=parallax-rotate] {\n    --kui-parallax-rotate-duration: 600ms;\n    --kui-parallax-rotate-delay: 0ms;\n    --kui-parallax-rotate-ease: ease-out;\n  }\n  [data-kui-fx~=parallax-scale] {\n    --kui-parallax-scale-duration: 600ms;\n    --kui-parallax-scale-delay: 0ms;\n    --kui-parallax-scale-ease: ease-out;\n  }\n  [data-kui-fx~=parallax-x] {\n    --kui-parallax-duration: 600ms;\n    --kui-parallax-delay: 0ms;\n    --kui-parallax-ease: ease-out;\n  }\n  [data-kui-fx~=parallax-y] {\n    --kui-parallax-duration: 600ms;\n    --kui-parallax-delay: 0ms;\n    --kui-parallax-ease: ease-out;\n  }\n  [data-kui-fx~=pin-section] {\n    --kui-distance: 100vh;\n    --kui-spacer: true;\n  }\n  [data-kui-fx~=pin-spacer] {\n    --kui-spacer: true;\n  }\n  [data-kui-fx~=pin-until] {\n    --kui-spacer: false;\n  }\n  [data-kui-fx~=play-to-pause] {\n    --kui-icon-toggle-duration: 260ms;\n    --kui-icon-toggle-ease: ease-out;\n  }\n  [data-kui-fx~=plus-to-minus] {\n    --kui-icon-toggle-duration: 260ms;\n    --kui-icon-toggle-ease: ease-out;\n  }\n  [data-kui-fx~=pop] {\n    --kui-pop-duration: 220ms;\n    --kui-pop-ease: ease-out;\n  }\n  [data-kui-fx~=pop-in] {\n    --kui-from-scale: 0.6;\n    --kui-scale-ease: var(--kui-ease-back-out, ease-out);\n    --kui-scale-duration: 600ms;\n    --kui-scale-delay: 0ms;\n  }\n  [data-kui-fx~=pop-out] {\n    --kui-from-scale: 0.6;\n    --kui-scale-ease: var(--kui-ease-back-in, ease-out);\n    --kui-scale-duration: 600ms;\n    --kui-scale-delay: 0ms;\n  }\n  [data-kui-fx~=progress-bar] {\n    --kui-meter-bar-duration: 600ms;\n    --kui-meter-bar-delay: 0ms;\n    --kui-meter-bar-ease: ease-out;\n  }\n  [data-kui-fx~=progress-indeterminate] {\n    --kui-feedback-progress-track-duration: 1.4s;\n    --kui-feedback-progress-track-delay: 0ms;\n    --kui-feedback-progress-track-ease: ease-in-out;\n  }\n  [data-kui-fx~=progress-ring] {\n    --kui-stroke-sweep-duration: 600ms;\n    --kui-stroke-sweep-delay: 0ms;\n    --kui-stroke-sweep-ease: ease-out;\n  }\n  [data-kui-fx~=progress-segments] {\n    --kui-meter-segments-duration: 600ms;\n    --kui-meter-segments-delay: 0ms;\n    --kui-meter-segments-ease: ease-out;\n  }\n  [data-kui-fx~=pull-to-refresh] {\n    --kui-feedback-pull-duration: 900ms;\n    --kui-feedback-pull-ease: ease-out;\n    --kui-feedback-pull-delay: 0ms;\n  }\n  [data-kui-fx~=range-fill] {\n    --kui-range-fill-duration: 400ms;\n    --kui-range-fill-delay: 0ms;\n    --kui-range-fill-ease: ease-out;\n  }\n  [data-kui-fx~=redaction-reveal] {\n    --kui-redaction-reveal-duration: 600ms;\n    --kui-redaction-reveal-delay: 0ms;\n    --kui-redaction-reveal-ease: ease-out;\n  }\n  [data-kui-fx~=reveal-once] {\n    --kui-reveal-duration: 600ms;\n    --kui-reveal-delay: 0ms;\n    --kui-reveal-ease: ease-out;\n  }\n  [data-kui-fx~=ripple] {\n    --kui-feedback-ripple-duration: 600ms;\n    --kui-feedback-ripple-delay: 0ms;\n    --kui-feedback-ripple-ease: ease-out;\n  }\n  [data-kui-fx~=roll-in] {\n    --kui-roll-duration: 600ms;\n    --kui-roll-delay: 0ms;\n    --kui-roll-ease: ease-out;\n  }\n  [data-kui-fx~=roll-out] {\n    --kui-roll-duration: 600ms;\n    --kui-roll-delay: 0ms;\n    --kui-roll-ease: ease-out;\n  }\n  [data-kui-fx~=rotate-in] {\n    --kui-rotate-duration: 600ms;\n    --kui-rotate-delay: 0ms;\n    --kui-rotate-ease: ease-out;\n  }\n  [data-kui-fx~=rotate-in-left] {\n    --kui-from-angle: -45deg;\n    --kui-rotate-duration: 600ms;\n    --kui-rotate-delay: 0ms;\n    --kui-rotate-ease: ease-out;\n  }\n  [data-kui-fx~=rotate-in-right] {\n    --kui-from-angle: 45deg;\n    --kui-rotate-duration: 600ms;\n    --kui-rotate-delay: 0ms;\n    --kui-rotate-ease: ease-out;\n  }\n  [data-kui-fx~=rotate-out] {\n    --kui-rotate-duration: 600ms;\n    --kui-rotate-delay: 0ms;\n    --kui-rotate-ease: ease-out;\n  }\n  [data-kui-fx~=rubber-band] {\n    --kui-return: true;\n    --kui-bounds: 120;\n  }\n  [data-kui-fx~=saturate-hover] {\n    --kui-media-filter-duration: 600ms;\n    --kui-media-filter-delay: 0ms;\n    --kui-media-filter-ease: ease-out;\n  }\n  [data-kui-fx~=scanline] {\n    --kui-ambient-tint-duration: 3.5s;\n    --kui-ambient-tint-ease: linear;\n    --kui-ambient-tint-delay: 0ms;\n  }\n  [data-kui-fx~=scramble] {\n    --kui-charset: upper;\n    --kui-scramble-text-delay: 0ms;\n  }\n  [data-kui-fx~=scroll-desaturate] {\n    --kui-desaturate-duration: 600ms;\n    --kui-desaturate-delay: 0ms;\n    --kui-desaturate-ease: ease-out;\n  }\n  [data-kui-fx~=scroll-fade] {\n    --kui-scroll-fade-duration: 600ms;\n    --kui-scroll-fade-delay: 0ms;\n    --kui-scroll-fade-ease: ease-out;\n  }\n  [data-kui-fx~=scroll-progress-bar] {\n    --kui-progress-duration: 600ms;\n    --kui-progress-delay: 0ms;\n    --kui-progress-ease: ease-out;\n  }\n  [data-kui-fx~=scroll-progress-bar-y] {\n    --kui-progress-duration: 600ms;\n    --kui-progress-delay: 0ms;\n    --kui-progress-ease: ease-out;\n  }\n  [data-kui-fx~=scroll-progress-ring] {\n    --kui-progress-stroke-duration: 600ms;\n    --kui-progress-stroke-delay: 0ms;\n    --kui-progress-stroke-ease: ease-out;\n  }\n  [data-kui-fx~=scroll-skew] {\n    --kui-skew-duration: 600ms;\n    --kui-skew-delay: 0ms;\n    --kui-skew-ease: ease-out;\n  }\n  [data-kui-fx~=scroll-snap-x] {\n    --kui-axis: x;\n  }\n  [data-kui-fx~=scroll-snap-y] {\n    --kui-axis: y;\n  }\n  [data-kui-fx~=scrollytelling-step] {\n    --kui-steps: 4;\n  }\n  [data-kui-fx~=sequence-scrub] {\n    --kui-spacer: true;\n  }\n  [data-kui-fx~=shake-error] {\n    --kui-feedback-shake-duration: 500ms;\n    --kui-feedback-shake-delay: 0ms;\n    --kui-feedback-shake-ease: linear;\n  }\n  [data-kui-fx~=shine-sweep] {\n    --kui-shine-sweep-duration: 220ms;\n    --kui-shine-sweep-ease: ease-out;\n  }\n  [data-kui-fx~=skeleton-shimmer] {\n    --kui-feedback-shimmer-duration: 1.6s;\n    --kui-feedback-shimmer-delay: 0ms;\n    --kui-feedback-shimmer-ease: linear;\n  }\n  [data-kui-fx~=skeleton-to-content] {\n    --kui-feedback-fade-duration: 600ms;\n    --kui-feedback-fade-delay: 0ms;\n    --kui-feedback-fade-ease: ease-out;\n  }\n  [data-kui-fx~=slat-assemble] {\n    --kui-slat-assemble-duration: 500ms;\n    --kui-slat-assemble-delay: 0ms;\n    --kui-slat-assemble-ease: ease-out;\n  }\n  [data-kui-fx~=slide-block-end] {\n    --kui-distance: 100px;\n    --kui-from-opacity: 1;\n    --kui-reveal-duration: 600ms;\n    --kui-reveal-delay: 0ms;\n    --kui-reveal-ease: ease-out;\n  }\n  [data-kui-fx~=slide-block-start] {\n    --kui-distance: 100px;\n    --kui-from-opacity: 1;\n    --kui-reveal-duration: 600ms;\n    --kui-reveal-delay: 0ms;\n    --kui-reveal-ease: ease-out;\n  }\n  [data-kui-fx~=slide-down] {\n    --kui-distance: 100px;\n    --kui-from-opacity: 1;\n    --kui-reveal-duration: 600ms;\n    --kui-reveal-delay: 0ms;\n    --kui-reveal-ease: ease-out;\n  }\n  [data-kui-fx~=slide-inline-end] {\n    --kui-distance: 100px;\n    --kui-from-opacity: 1;\n    --kui-reveal-duration: 600ms;\n    --kui-reveal-delay: 0ms;\n    --kui-reveal-ease: ease-out;\n  }\n  [data-kui-fx~=slide-inline-start] {\n    --kui-distance: 100px;\n    --kui-from-opacity: 1;\n    --kui-reveal-duration: 600ms;\n    --kui-reveal-delay: 0ms;\n    --kui-reveal-ease: ease-out;\n  }\n  [data-kui-fx~=slide-left] {\n    --kui-distance: 100px;\n    --kui-from-opacity: 1;\n    --kui-reveal-duration: 600ms;\n    --kui-reveal-delay: 0ms;\n    --kui-reveal-ease: ease-out;\n  }\n  [data-kui-fx~=slide-out-down] {\n    --kui-distance: 100px;\n    --kui-from-opacity: 1;\n    --kui-reveal-duration: 600ms;\n    --kui-reveal-delay: 0ms;\n    --kui-reveal-ease: ease-out;\n  }\n  [data-kui-fx~=slide-out-left] {\n    --kui-distance: 100px;\n    --kui-from-opacity: 1;\n    --kui-reveal-duration: 600ms;\n    --kui-reveal-delay: 0ms;\n    --kui-reveal-ease: ease-out;\n  }\n  [data-kui-fx~=slide-out-right] {\n    --kui-distance: 100px;\n    --kui-from-opacity: 1;\n    --kui-reveal-duration: 600ms;\n    --kui-reveal-delay: 0ms;\n    --kui-reveal-ease: ease-out;\n  }\n  [data-kui-fx~=slide-out-up] {\n    --kui-distance: 100px;\n    --kui-from-opacity: 1;\n    --kui-reveal-duration: 600ms;\n    --kui-reveal-delay: 0ms;\n    --kui-reveal-ease: ease-out;\n  }\n  [data-kui-fx~=slide-right] {\n    --kui-distance: 100px;\n    --kui-from-opacity: 1;\n    --kui-reveal-duration: 600ms;\n    --kui-reveal-delay: 0ms;\n    --kui-reveal-ease: ease-out;\n  }\n  [data-kui-fx~=slide-up] {\n    --kui-distance: 100px;\n    --kui-from-opacity: 1;\n    --kui-reveal-duration: 600ms;\n    --kui-reveal-delay: 0ms;\n    --kui-reveal-ease: ease-out;\n  }\n  [data-kui-fx~=snap-back] {\n    --kui-return: true;\n    --kui-stiffness: 260;\n  }\n  [data-kui-fx~=sparkline-draw] {\n    --kui-stroke-sweep-duration: 600ms;\n    --kui-stroke-sweep-delay: 0ms;\n    --kui-stroke-sweep-ease: ease-out;\n  }\n  [data-kui-fx~=spinner] {\n    --kui-feedback-spin-duration: 900ms;\n    --kui-feedback-spin-delay: 0ms;\n    --kui-feedback-spin-ease: linear;\n  }\n  [data-kui-fx~=spinner-dots] {\n    --kui-feedback-dot-pulse-duration: 1.2s;\n    --kui-feedback-dot-pulse-delay: 0ms;\n    --kui-feedback-dot-pulse-ease: ease-in-out;\n  }\n  [data-kui-fx~=spinner-ring] {\n    --kui-feedback-spin-duration: 900ms;\n    --kui-feedback-spin-delay: 0ms;\n    --kui-feedback-spin-ease: linear;\n  }\n  [data-kui-fx~=split-chars] {\n    --kui-unit: chars;\n    --kui-direction: fade;\n    --kui-stagger: 30ms;\n    --kui-split-text-duration: 500ms;\n    --kui-split-text-delay: 0ms;\n    --kui-split-text-ease: ease-out;\n  }\n  [data-kui-fx~=split-flap] {\n    --kui-split-flap-duration: 220ms;\n    --kui-split-flap-ease: ease-out;\n  }\n  [data-kui-fx~=split-lines] {\n    --kui-unit: lines;\n    --kui-direction: fade;\n    --kui-stagger: 160ms;\n    --kui-split-text-duration: 500ms;\n    --kui-split-text-delay: 0ms;\n    --kui-split-text-ease: ease-out;\n  }\n  [data-kui-fx~=split-words] {\n    --kui-unit: words;\n    --kui-direction: fade;\n    --kui-stagger: 90ms;\n    --kui-split-text-duration: 500ms;\n    --kui-split-text-delay: 0ms;\n    --kui-split-text-ease: ease-out;\n  }\n  [data-kui-fx~=spotlight-follow] {\n    --kui-ambient-tint-duration: 9s;\n    --kui-ambient-tint-delay: 0ms;\n    --kui-ambient-tint-ease: ease-in-out;\n  }\n  [data-kui-fx~=stacking-cards] {\n    --kui-spacer: false;\n  }\n  [data-kui-fx~=star-rating-fill] {\n    --kui-meter-stars-duration: 600ms;\n    --kui-meter-stars-delay: 0ms;\n    --kui-meter-stars-ease: ease-out;\n  }\n  [data-kui-fx~=starfield] {\n    --kui-ambient-tint-duration: 40s;\n    --kui-ambient-tint-ease: linear;\n    --kui-ambient-tint-delay: 0ms;\n  }\n  [data-kui-fx~=step-progress] {\n    --kui-step-progress-duration: 400ms;\n    --kui-step-progress-delay: 0ms;\n    --kui-step-progress-ease: ease-out;\n  }\n  [data-kui-fx~=strength-meter] {\n    --kui-strength-meter-duration: 400ms;\n    --kui-strength-meter-delay: 0ms;\n    --kui-strength-meter-ease: ease-out;\n  }\n  [data-kui-fx~=submit-to-spinner-to-check] {\n    --kui-submit-flow-duration: 400ms;\n    --kui-submit-flow-delay: 0ms;\n    --kui-submit-flow-ease: ease-out;\n  }\n  [data-kui-fx~=swing-in] {\n    --kui-from-angle: -15deg;\n    --kui-rotate-ease: var(--kui-ease-back-out, ease-out);\n    --kui-rotate-duration: 600ms;\n    --kui-rotate-delay: 0ms;\n  }\n  [data-kui-fx~=swipe-x] {\n    --kui-axis: x;\n  }\n  [data-kui-fx~=tab-indicator-slide] {\n    --kui-flip-indicator-duration: 300ms;\n    --kui-flip-indicator-ease: ease-out;\n  }\n  [data-kui-fx~=text-3d-extrude] {\n    --kui-text-3d-extrude-duration: 600ms;\n    --kui-text-3d-extrude-delay: 0ms;\n    --kui-text-3d-extrude-ease: ease-out;\n  }\n  [data-kui-fx~=text-jitter] {\n    --kui-motion: jitter;\n    --kui-split-text-motion-delay: 0ms;\n  }\n  [data-kui-fx~=text-outline-fill] {\n    --kui-text-outline-fill-duration: 600ms;\n    --kui-text-outline-fill-delay: 0ms;\n    --kui-text-outline-fill-ease: ease-out;\n  }\n  [data-kui-fx~=text-reveal-down] {\n    --kui-unit: words;\n    --kui-direction: down;\n    --kui-stagger: 90ms;\n    --kui-split-text-duration: 500ms;\n    --kui-split-text-delay: 0ms;\n    --kui-split-text-ease: ease-out;\n  }\n  [data-kui-fx~=text-reveal-mask] {\n    --kui-unit: lines;\n    --kui-direction: mask;\n    --kui-stagger: 160ms;\n    --kui-split-text-duration: 500ms;\n    --kui-split-text-delay: 0ms;\n    --kui-split-text-ease: ease-out;\n  }\n  [data-kui-fx~=text-reveal-up] {\n    --kui-unit: words;\n    --kui-direction: up;\n    --kui-stagger: 90ms;\n    --kui-split-text-duration: 500ms;\n    --kui-split-text-delay: 0ms;\n    --kui-split-text-ease: ease-out;\n  }\n  [data-kui-fx~=text-wave] {\n    --kui-motion: wave;\n    --kui-split-text-motion-delay: 0ms;\n  }\n  [data-kui-fx~=throwable] {\n    --kui-inertia: true;\n    --kui-damping: 18;\n  }\n  [data-kui-fx~=toast-slide-in] {\n    --kui-feedback-toast-duration: 420ms;\n    --kui-feedback-toast-delay: 0ms;\n    --kui-feedback-toast-ease: var(--kui-ease-back-out, ease-out);\n  }\n  [data-kui-fx~=toast-slide-out] {\n    --kui-feedback-toast-ease: ease-in;\n    --kui-feedback-toast-duration: 420ms;\n    --kui-feedback-toast-delay: 0ms;\n  }\n  [data-kui-fx~=typewriter] {\n    --kui-loop: false;\n    --kui-typewriter-delay: 0ms;\n  }\n  [data-kui-fx~=typewriter-loop] {\n    --kui-loop: true;\n    --kui-typewriter-delay: 0ms;\n  }\n  [data-kui-fx~=underline-center] {\n    --kui-underline-center-duration: 220ms;\n    --kui-underline-center-ease: ease-out;\n  }\n  [data-kui-fx~=underline-draw] {\n    --kui-text-sweep-duration: 600ms;\n    --kui-text-sweep-delay: 0ms;\n    --kui-text-sweep-ease: ease-out;\n  }\n  [data-kui-fx~=underline-slide] {\n    --kui-underline-slide-duration: 220ms;\n    --kui-underline-slide-ease: ease-out;\n  }\n  [data-kui-fx~=validate-check] {\n    --kui-validate-check-duration: 600ms;\n    --kui-validate-check-delay: 0ms;\n    --kui-validate-check-ease: ease-out;\n  }\n  [data-kui-fx~=validate-shake] {\n    --kui-validate-shake-duration: 600ms;\n    --kui-validate-shake-delay: 0ms;\n    --kui-validate-shake-ease: ease-out;\n  }\n  [data-kui-fx~=var-slant] {\n    --kui-var-slant-duration: 600ms;\n    --kui-var-slant-delay: 0ms;\n    --kui-var-slant-ease: ease-out;\n  }\n  [data-kui-fx~=var-weight] {\n    --kui-var-weight-duration: 600ms;\n    --kui-var-weight-delay: 0ms;\n    --kui-var-weight-ease: ease-out;\n  }\n  [data-kui-fx~=var-width] {\n    --kui-var-width-duration: 600ms;\n    --kui-var-width-delay: 0ms;\n    --kui-var-width-ease: ease-out;\n  }\n  [data-kui-fx~=wave-blob] {\n    --kui-ambient-tint-duration: 12s;\n    --kui-ambient-tint-delay: 0ms;\n    --kui-ambient-tint-ease: ease-in-out;\n  }\n  [data-kui-fx~=wipe-circle] {\n    --kui-media-wipe-duration: 600ms;\n    --kui-media-wipe-delay: 0ms;\n    --kui-media-wipe-ease: ease-out;\n  }\n  [data-kui-fx~=wipe-diagonal] {\n    --kui-media-wipe-duration: 600ms;\n    --kui-media-wipe-delay: 0ms;\n    --kui-media-wipe-ease: ease-out;\n  }\n  [data-kui-fx~=wipe-down] {\n    --kui-media-wipe-duration: 600ms;\n    --kui-media-wipe-delay: 0ms;\n    --kui-media-wipe-ease: ease-out;\n  }\n  [data-kui-fx~=wipe-left] {\n    --kui-media-wipe-duration: 600ms;\n    --kui-media-wipe-delay: 0ms;\n    --kui-media-wipe-ease: ease-out;\n  }\n  [data-kui-fx~=wipe-right] {\n    --kui-media-wipe-duration: 600ms;\n    --kui-media-wipe-delay: 0ms;\n    --kui-media-wipe-ease: ease-out;\n  }\n  [data-kui-fx~=wipe-up] {\n    --kui-media-wipe-duration: 600ms;\n    --kui-media-wipe-delay: 0ms;\n    --kui-media-wipe-ease: ease-out;\n  }\n  [data-kui-fx~=wobble] {\n    --kui-feedback-wobble-duration: 600ms;\n    --kui-feedback-wobble-ease: ease-in-out;\n    --kui-feedback-wobble-delay: 0ms;\n  }\n  [data-kui-fx~=word-cycler] {\n    --kui-word-cycler-delay: 0ms;\n  }\n  [data-kui-fx~=zoom-in] {\n    --kui-scale-duration: 600ms;\n    --kui-scale-delay: 0ms;\n    --kui-scale-ease: ease-out;\n  }\n  [data-kui-fx~=zoom-in-down] {\n    --kui-scale-move-duration: 600ms;\n    --kui-scale-move-delay: 0ms;\n    --kui-scale-move-ease: ease-out;\n  }\n  [data-kui-fx~=zoom-in-up] {\n    --kui-scale-move-duration: 600ms;\n    --kui-scale-move-delay: 0ms;\n    --kui-scale-move-ease: ease-out;\n  }\n  [data-kui-fx~=zoom-out] {\n    --kui-scale-duration: 600ms;\n    --kui-scale-delay: 0ms;\n    --kui-scale-ease: ease-out;\n  }\n}\n@layer kui.cloak {\n  html[data-kui-cloak] [data-kui~=back-in-down]:not([data-kui-state]),\n  html[data-kui-cloak] [data-kui~=back-in-up]:not([data-kui-state]),\n  html[data-kui-cloak] [data-kui~=blur-in]:not([data-kui-state]),\n  html[data-kui-cloak] [data-kui~=blur-up]:not([data-kui-state]),\n  html[data-kui-cloak] [data-kui~=bounce-in]:not([data-kui-state]),\n  html[data-kui-cloak] [data-kui~=bounce-in-down]:not([data-kui-state]),\n  html[data-kui-cloak] [data-kui~=bounce-in-up]:not([data-kui-state]),\n  html[data-kui-cloak] [data-kui~=card-flip-x]:not([data-kui-state]),\n  html[data-kui-cloak] [data-kui~=card-flip-y]:not([data-kui-state]),\n  html[data-kui-cloak] [data-kui~=chart-bar-grow]:not([data-kui-state]),\n  html[data-kui-cloak] [data-kui~=curtain-reveal]:not([data-kui-state]),\n  html[data-kui-cloak] [data-kui~=fade-blur-in]:not([data-kui-state]),\n  html[data-kui-cloak] [data-kui~=fade-blur-up]:not([data-kui-state]),\n  html[data-kui-cloak] [data-kui~=fade-down]:not([data-kui-state]),\n  html[data-kui-cloak] [data-kui~=fade-in]:not([data-kui-state]),\n  html[data-kui-cloak] [data-kui~=fade-left]:not([data-kui-state]),\n  html[data-kui-cloak] [data-kui~=fade-right]:not([data-kui-state]),\n  html[data-kui-cloak] [data-kui~=fade-up]:not([data-kui-state]),\n  html[data-kui-cloak] [data-kui~=flip-in-x]:not([data-kui-state]),\n  html[data-kui-cloak] [data-kui~=flip-in-y]:not([data-kui-state]),\n  html[data-kui-cloak] [data-kui~=fold-panel]:not([data-kui-state]),\n  html[data-kui-cloak] [data-kui~=loading-bar]:not([data-kui-state]),\n  html[data-kui-cloak] [data-kui~=mask-reveal]:not([data-kui-state]),\n  html[data-kui-cloak] [data-kui~=pop-in]:not([data-kui-state]),\n  html[data-kui-cloak] [data-kui~=progress-bar]:not([data-kui-state]),\n  html[data-kui-cloak] [data-kui~=reveal-once]:not([data-kui-state]),\n  html[data-kui-cloak] [data-kui~=roll-in]:not([data-kui-state]),\n  html[data-kui-cloak] [data-kui~=rotate-in]:not([data-kui-state]),\n  html[data-kui-cloak] [data-kui~=rotate-in-left]:not([data-kui-state]),\n  html[data-kui-cloak] [data-kui~=rotate-in-right]:not([data-kui-state]),\n  html[data-kui-cloak] [data-kui~=slat-assemble]:not([data-kui-state]),\n  html[data-kui-cloak] [data-kui~=slide-block-end]:not([data-kui-state]),\n  html[data-kui-cloak] [data-kui~=slide-block-start]:not([data-kui-state]),\n  html[data-kui-cloak] [data-kui~=slide-down]:not([data-kui-state]),\n  html[data-kui-cloak] [data-kui~=slide-inline-end]:not([data-kui-state]),\n  html[data-kui-cloak] [data-kui~=slide-inline-start]:not([data-kui-state]),\n  html[data-kui-cloak] [data-kui~=slide-left]:not([data-kui-state]),\n  html[data-kui-cloak] [data-kui~=slide-right]:not([data-kui-state]),\n  html[data-kui-cloak] [data-kui~=slide-up]:not([data-kui-state]),\n  html[data-kui-cloak] [data-kui~=swing-in]:not([data-kui-state]),\n  html[data-kui-cloak] [data-kui~=text-reveal-down]:not([data-kui-state]),\n  html[data-kui-cloak] [data-kui~=text-reveal-mask]:not([data-kui-state]),\n  html[data-kui-cloak] [data-kui~=text-reveal-up]:not([data-kui-state]),\n  html[data-kui-cloak] [data-kui~=wipe-circle]:not([data-kui-state]),\n  html[data-kui-cloak] [data-kui~=wipe-diagonal]:not([data-kui-state]),\n  html[data-kui-cloak] [data-kui~=wipe-down]:not([data-kui-state]),\n  html[data-kui-cloak] [data-kui~=wipe-left]:not([data-kui-state]),\n  html[data-kui-cloak] [data-kui~=wipe-right]:not([data-kui-state]),\n  html[data-kui-cloak] [data-kui~=wipe-up]:not([data-kui-state]),\n  html[data-kui-cloak] [data-kui~=zoom-in]:not([data-kui-state]),\n  html[data-kui-cloak] [data-kui~=zoom-in-down]:not([data-kui-state]),\n  html[data-kui-cloak] [data-kui~=zoom-in-up]:not([data-kui-state]) {\n    opacity: 0;\n    animation: kui-cloak-release 1ms linear 2s forwards;\n  }\n  @keyframes kui-cloak-release {\n    to {\n      opacity: 1;\n    }\n  }\n  @media (prefers-reduced-motion: reduce) {\n    html[data-kui-cloak] [data-kui~=back-in-down]:not([data-kui-state]),\n    html[data-kui-cloak] [data-kui~=back-in-up]:not([data-kui-state]),\n    html[data-kui-cloak] [data-kui~=blur-in]:not([data-kui-state]),\n    html[data-kui-cloak] [data-kui~=blur-up]:not([data-kui-state]),\n    html[data-kui-cloak] [data-kui~=bounce-in]:not([data-kui-state]),\n    html[data-kui-cloak] [data-kui~=bounce-in-down]:not([data-kui-state]),\n    html[data-kui-cloak] [data-kui~=bounce-in-up]:not([data-kui-state]),\n    html[data-kui-cloak] [data-kui~=card-flip-x]:not([data-kui-state]),\n    html[data-kui-cloak] [data-kui~=card-flip-y]:not([data-kui-state]),\n    html[data-kui-cloak] [data-kui~=chart-bar-grow]:not([data-kui-state]),\n    html[data-kui-cloak] [data-kui~=curtain-reveal]:not([data-kui-state]),\n    html[data-kui-cloak] [data-kui~=fade-blur-in]:not([data-kui-state]),\n    html[data-kui-cloak] [data-kui~=fade-blur-up]:not([data-kui-state]),\n    html[data-kui-cloak] [data-kui~=fade-down]:not([data-kui-state]),\n    html[data-kui-cloak] [data-kui~=fade-in]:not([data-kui-state]),\n    html[data-kui-cloak] [data-kui~=fade-left]:not([data-kui-state]),\n    html[data-kui-cloak] [data-kui~=fade-right]:not([data-kui-state]),\n    html[data-kui-cloak] [data-kui~=fade-up]:not([data-kui-state]),\n    html[data-kui-cloak] [data-kui~=flip-in-x]:not([data-kui-state]),\n    html[data-kui-cloak] [data-kui~=flip-in-y]:not([data-kui-state]),\n    html[data-kui-cloak] [data-kui~=fold-panel]:not([data-kui-state]),\n    html[data-kui-cloak] [data-kui~=loading-bar]:not([data-kui-state]),\n    html[data-kui-cloak] [data-kui~=mask-reveal]:not([data-kui-state]),\n    html[data-kui-cloak] [data-kui~=pop-in]:not([data-kui-state]),\n    html[data-kui-cloak] [data-kui~=progress-bar]:not([data-kui-state]),\n    html[data-kui-cloak] [data-kui~=reveal-once]:not([data-kui-state]),\n    html[data-kui-cloak] [data-kui~=roll-in]:not([data-kui-state]),\n    html[data-kui-cloak] [data-kui~=rotate-in]:not([data-kui-state]),\n    html[data-kui-cloak] [data-kui~=rotate-in-left]:not([data-kui-state]),\n    html[data-kui-cloak] [data-kui~=rotate-in-right]:not([data-kui-state]),\n    html[data-kui-cloak] [data-kui~=slat-assemble]:not([data-kui-state]),\n    html[data-kui-cloak] [data-kui~=slide-block-end]:not([data-kui-state]),\n    html[data-kui-cloak] [data-kui~=slide-block-start]:not([data-kui-state]),\n    html[data-kui-cloak] [data-kui~=slide-down]:not([data-kui-state]),\n    html[data-kui-cloak] [data-kui~=slide-inline-end]:not([data-kui-state]),\n    html[data-kui-cloak] [data-kui~=slide-inline-start]:not([data-kui-state]),\n    html[data-kui-cloak] [data-kui~=slide-left]:not([data-kui-state]),\n    html[data-kui-cloak] [data-kui~=slide-right]:not([data-kui-state]),\n    html[data-kui-cloak] [data-kui~=slide-up]:not([data-kui-state]),\n    html[data-kui-cloak] [data-kui~=swing-in]:not([data-kui-state]),\n    html[data-kui-cloak] [data-kui~=text-reveal-down]:not([data-kui-state]),\n    html[data-kui-cloak] [data-kui~=text-reveal-mask]:not([data-kui-state]),\n    html[data-kui-cloak] [data-kui~=text-reveal-up]:not([data-kui-state]),\n    html[data-kui-cloak] [data-kui~=wipe-circle]:not([data-kui-state]),\n    html[data-kui-cloak] [data-kui~=wipe-diagonal]:not([data-kui-state]),\n    html[data-kui-cloak] [data-kui~=wipe-down]:not([data-kui-state]),\n    html[data-kui-cloak] [data-kui~=wipe-left]:not([data-kui-state]),\n    html[data-kui-cloak] [data-kui~=wipe-right]:not([data-kui-state]),\n    html[data-kui-cloak] [data-kui~=wipe-up]:not([data-kui-state]),\n    html[data-kui-cloak] [data-kui~=zoom-in]:not([data-kui-state]),\n    html[data-kui-cloak] [data-kui~=zoom-in-down]:not([data-kui-state]),\n    html[data-kui-cloak] [data-kui~=zoom-in-up]:not([data-kui-state]) {\n      opacity: 1;\n      animation: none;\n    }\n  }\n}\n\n/* src/css/entrance.css */\n@layer kui.effects {\n  @keyframes kui-in {\n    from {\n      opacity: var(--kui-from-opacity, 0);\n    }\n  }\n  @keyframes kui-out {\n    to {\n      opacity: 0;\n    }\n  }\n  @keyframes kui-in-up {\n    from {\n      opacity: var(--kui-from-opacity, 0);\n      translate: 0 var(--kui-distance, 24px);\n    }\n  }\n  @keyframes kui-in-down {\n    from {\n      opacity: var(--kui-from-opacity, 0);\n      translate: 0 calc(var(--kui-distance, 24px) * -1);\n    }\n  }\n  @keyframes kui-in-left {\n    from {\n      opacity: var(--kui-from-opacity, 0);\n      translate: var(--kui-distance, 24px) 0;\n    }\n  }\n  @keyframes kui-in-right {\n    from {\n      opacity: var(--kui-from-opacity, 0);\n      translate: calc(var(--kui-distance, 24px) * -1) 0;\n    }\n  }\n  @keyframes kui-out-up {\n    to {\n      opacity: 0;\n      translate: 0 calc(var(--kui-distance, 24px) * -1);\n    }\n  }\n  @keyframes kui-out-down {\n    to {\n      opacity: 0;\n      translate: 0 var(--kui-distance, 24px);\n    }\n  }\n  @keyframes kui-out-left {\n    to {\n      opacity: 0;\n      translate: calc(var(--kui-distance, 24px) * -1) 0;\n    }\n  }\n  @keyframes kui-out-right {\n    to {\n      opacity: 0;\n      translate: var(--kui-distance, 24px) 0;\n    }\n  }\n  @keyframes kui-in-inline-start {\n    from {\n      opacity: var(--kui-from-opacity, 0);\n      translate: calc(var(--kui-distance, 24px) * var(--kui-dir, 1)) 0;\n    }\n  }\n  @keyframes kui-in-inline-end {\n    from {\n      opacity: var(--kui-from-opacity, 0);\n      translate: calc(var(--kui-distance, 24px) * var(--kui-dir, 1) * -1) 0;\n    }\n  }\n  [data-kui-state=ready] {\n    --kui-distance: 0px !important;\n  }\n  @keyframes kui-zoom-in {\n    from {\n      scale: var(--kui-from-scale, 0.92);\n    }\n  }\n  @keyframes kui-zoom-out {\n    to {\n      scale: var(--kui-from-scale, 0.92);\n    }\n  }\n  @keyframes kui-zoom-in-up {\n    from {\n      scale: var(--kui-from-scale, 0.92);\n      translate: 0 var(--kui-distance, 24px);\n    }\n  }\n  @keyframes kui-zoom-in-down {\n    from {\n      scale: var(--kui-from-scale, 0.92);\n      translate: 0 calc(var(--kui-distance, 24px) * -1);\n    }\n  }\n  @keyframes kui-flip-in-x {\n    from {\n      transform: perspective(var(--kui-perspective, 1200px)) rotateX(var(--kui-from-angle, 90deg));\n    }\n  }\n  @keyframes kui-flip-in-y {\n    from {\n      transform: perspective(var(--kui-perspective, 1200px)) rotateY(var(--kui-from-angle, 90deg));\n    }\n  }\n  @keyframes kui-flip-out-x {\n    to {\n      transform: perspective(var(--kui-perspective, 1200px)) rotateX(var(--kui-from-angle, 90deg));\n    }\n  }\n  @keyframes kui-flip-out-y {\n    to {\n      transform: perspective(var(--kui-perspective, 1200px)) rotateY(var(--kui-from-angle, 90deg));\n    }\n  }\n  @keyframes kui-rotate-in {\n    from {\n      rotate: var(--kui-from-angle, -8deg);\n    }\n  }\n  @keyframes kui-rotate-out {\n    to {\n      rotate: var(--kui-from-angle, -8deg);\n    }\n  }\n  @keyframes kui-swing-in {\n    from {\n      rotate: var(--kui-from-angle, -15deg);\n    }\n  }\n  @keyframes kui-roll-in {\n    from {\n      rotate: var(--kui-from-angle, -120deg);\n      translate: calc(var(--kui-distance, 24px) * -1) 0;\n    }\n  }\n  @keyframes kui-roll-out {\n    to {\n      rotate: var(--kui-from-angle, -120deg);\n      translate: var(--kui-distance, 24px) 0;\n    }\n  }\n  @keyframes kui-blur-in {\n    from {\n      filter: blur(var(--kui-blur, 12px));\n    }\n  }\n  @keyframes kui-blur-out {\n    to {\n      filter: blur(var(--kui-blur, 12px));\n    }\n  }\n  @keyframes kui-fade-blur-up {\n    from {\n      opacity: var(--kui-from-opacity, 0);\n      translate: 0 var(--kui-distance, 24px);\n      filter: blur(var(--kui-blur, 12px));\n    }\n  }\n  @keyframes kui-fade-blur-in {\n    from {\n      opacity: var(--kui-from-opacity, 0);\n      filter: blur(var(--kui-blur, 12px));\n    }\n  }\n  [data-kui-fx*=flip-] {\n    transform-style: preserve-3d;\n  }\n  [data-kui-fx~=flip-in-x][data-kui-state=ready],\n  [data-kui-fx~=flip-in-y][data-kui-state=ready] {\n    --kui-from-angle: 0deg !important;\n    opacity: 0;\n  }\n  [data-kui-fx~=rotate-in][data-kui-state=ready],\n  [data-kui-fx~=rotate-in-left][data-kui-state=ready],\n  [data-kui-fx~=rotate-in-right][data-kui-state=ready],\n  [data-kui-fx~=swing-in][data-kui-state=ready],\n  [data-kui-fx~=roll-in][data-kui-state=ready] {\n    --kui-from-angle: 0deg !important;\n    opacity: 0;\n  }\n}\n\n/* src/css/scroll.css */\n@layer kui.effects {\n  @keyframes kui-parallax-y {\n    from {\n      translate: 0 calc(var(--kui-distance, 100px) * -1);\n    }\n    to {\n      translate: 0 var(--kui-distance, 100px);\n    }\n  }\n  @keyframes kui-parallax-x {\n    from {\n      translate: calc(var(--kui-distance, 100px) * -1) 0;\n    }\n    to {\n      translate: var(--kui-distance, 100px) 0;\n    }\n  }\n  @keyframes kui-parallax-scale {\n    from {\n      scale: var(--kui-from-scale, 1);\n    }\n    to {\n      scale: var(--kui-to-scale, 1.2);\n    }\n  }\n  @keyframes kui-parallax-rotate {\n    from {\n      rotate: var(--kui-from-angle, 0deg);\n    }\n    to {\n      rotate: var(--kui-to-angle, 12deg);\n    }\n  }\n  @keyframes kui-scroll-fade {\n    from {\n      opacity: var(--kui-from-opacity, 0);\n    }\n    to {\n      opacity: 1;\n    }\n  }\n  @keyframes kui-desaturate {\n    from {\n      filter: grayscale(var(--kui-from-grayscale, 100%));\n    }\n    to {\n      filter: grayscale(var(--kui-to-grayscale, 0%));\n    }\n  }\n  @keyframes kui-scroll-skew {\n    from {\n      transform: skewY(var(--kui-from-skew, 8deg));\n    }\n    to {\n      transform: skewY(var(--kui-to-skew, 0deg));\n    }\n  }\n  @keyframes kui-progress-x {\n    from {\n      scale: 0 1;\n    }\n    to {\n      scale: 1 1;\n    }\n  }\n  @keyframes kui-progress-y {\n    from {\n      scale: 1 0;\n    }\n    to {\n      scale: 1 1;\n    }\n  }\n  @keyframes kui-progress-ring {\n    from {\n      stroke-dashoffset: var(--kui-path-length, 100);\n    }\n    to {\n      stroke-dashoffset: 0;\n    }\n  }\n  [data-kui-fx~=scroll-progress-bar] {\n    transform-origin: left center;\n  }\n  [data-kui-fx~=scroll-progress-ring] {\n    stroke-dasharray: var(--kui-path-length, 100);\n  }\n  [data-kui-fx~=sequence-scrub]:has(> [data-kui-step-state]),\n  [data-kui-fx~=video-scrub]:has(> [data-kui-step-state]),\n  .kui-frame-stack {\n    position: relative;\n  }\n  [data-kui-fx~=sequence-scrub] > [data-kui-step-state],\n  [data-kui-fx~=video-scrub] > [data-kui-step-state],\n  .kui-frame-stack > [data-kui-step-state] {\n    position: absolute;\n    inset: 0;\n    width: 100%;\n    height: 100%;\n    object-fit: cover;\n    opacity: 0;\n  }\n  [data-kui-fx~=sequence-scrub] > [data-kui-step-state=active],\n  [data-kui-fx~=video-scrub] > [data-kui-step-state=active],\n  .kui-frame-stack > [data-kui-step-state=active] {\n    opacity: 1;\n  }\n  @supports (animation-timeline: view()) {\n    [data-kui-timeline] {\n      animation-range: var(--kui-range, entry 0% cover 60%);\n    }\n  }\n}\n\n/* src/css/three-d.css */\n@layer kui.effects {\n  @keyframes kui-card-flip-y {\n    to {\n      transform: perspective(var(--kui-perspective, 1200px)) rotateY(var(--kui-from-angle, 180deg));\n    }\n  }\n  @keyframes kui-card-flip-x {\n    to {\n      transform: perspective(var(--kui-perspective, 1200px)) rotateX(var(--kui-from-angle, 180deg));\n    }\n  }\n  @keyframes kui-cube-rotate {\n    to {\n      transform: perspective(var(--kui-perspective, 1200px)) rotateY(var(--kui-from-angle, 90deg));\n    }\n  }\n  @keyframes kui-book-page-turn {\n    to {\n      transform: perspective(var(--kui-perspective, 1200px)) rotateY(var(--kui-from-angle, -160deg));\n    }\n  }\n  @keyframes kui-fold-panel {\n    from {\n      transform: perspective(var(--kui-perspective, 1200px)) rotateX(var(--kui-from-angle, -90deg));\n    }\n  }\n  [data-kui-fx~=card-flip-x],\n  [data-kui-fx~=card-flip-y],\n  [data-kui-fx~=cube-rotate],\n  [data-kui-fx~=book-page-turn],\n  [data-kui-fx~=fold-panel] {\n    transform-style: preserve-3d;\n    perspective: var(--kui-perspective, 1200px);\n  }\n  [data-kui-fx~=card-flip-x]:not(:has(> :nth-child(2))),\n  [data-kui-fx~=card-flip-y]:not(:has(> :nth-child(2))) {\n    --kui-from-angle: 360deg;\n  }\n  [data-kui-fx~=card-flip-x]:has(> :nth-child(2)),\n  [data-kui-fx~=card-flip-y]:has(> :nth-child(2)) {\n    display: grid;\n  }\n  [data-kui-fx~=card-flip-x]:has(> :nth-child(2)) > :first-child,\n  [data-kui-fx~=card-flip-x]:has(> :nth-child(2)) > :nth-child(2),\n  [data-kui-fx~=card-flip-y]:has(> :nth-child(2)) > :first-child,\n  [data-kui-fx~=card-flip-y]:has(> :nth-child(2)) > :nth-child(2) {\n    grid-area: 1 / 1;\n    backface-visibility: hidden;\n  }\n  [data-kui-fx~=card-flip-x]:has(> :nth-child(2)) > :nth-child(2) {\n    rotate: x 180deg;\n  }\n  [data-kui-fx~=card-flip-y]:has(> :nth-child(2)) > :nth-child(2) {\n    rotate: y 180deg;\n  }\n  [data-kui-fx~=book-page-turn] {\n    transform-origin: left center;\n  }\n  [data-kui-fx~=fold-panel] {\n    transform-origin: top center;\n  }\n  [data-kui-fx~=fold-panel][data-kui-state=ready] {\n    --kui-from-angle: 0deg !important;\n    opacity: 0;\n  }\n  @keyframes kui-page-fade {\n    from {\n      opacity: 0;\n    }\n  }\n  @keyframes kui-page-slide {\n    from {\n      opacity: 0;\n      translate: 0 var(--kui-distance, 40px);\n    }\n  }\n  @keyframes kui-curtain-wipe {\n    from {\n      clip-path: inset(0 0 100% 0);\n    }\n    to {\n      clip-path: inset(0 0 0 0);\n    }\n  }\n  @keyframes kui-loading-bar {\n    from {\n      scale: var(--kui-bar-from, 0) 1;\n    }\n  }\n  [data-kui-fx~=loading-bar] {\n    transform-origin: left center;\n  }\n  [data-kui-fx~=loading-bar][data-kui-state=ready] {\n    --kui-bar-from: 1 !important;\n    opacity: 0;\n  }\n  [data-kui-fx~=flip-card] {\n    display: grid;\n    perspective: var(--kui-perspective, 1600px);\n  }\n  [data-kui-fx~=flip-card] > .kui-face-front,\n  [data-kui-fx~=flip-card] > .kui-face-back {\n    grid-area: 1 / 1;\n    backface-visibility: hidden;\n    transition: rotate var(--kui-card-toggle-duration, 700ms) var(--kui-card-toggle-ease, ease-in-out);\n  }\n  [data-kui-fx~=flip-card] > .kui-face-front {\n    rotate: y 0deg;\n  }\n  [data-kui-fx~=flip-card] > .kui-face-back {\n    rotate: y 180deg;\n  }\n  [data-kui-fx~=flip-card]:has(> .kui-flip-control[aria-pressed=true]) > .kui-face-front {\n    rotate: y -180deg;\n  }\n  [data-kui-fx~=flip-card]:has(> .kui-flip-control[aria-pressed=true]) > .kui-face-back {\n    rotate: y 0deg;\n  }\n  [data-kui~=flip-card] {\n    display: grid;\n    perspective: var(--kui-perspective, 1600px);\n  }\n  [data-kui~=flip-card] > .kui-face-front,\n  [data-kui~=flip-card] > .kui-face-back {\n    grid-area: 1 / 1;\n    backface-visibility: hidden;\n  }\n  [data-kui~=flip-card] > .kui-face-front {\n    rotate: y 0deg;\n  }\n  [data-kui~=flip-card] > .kui-face-back {\n    rotate: y 180deg;\n  }\n}\n\n/* src/css/media.css */\n@layer kui.effects {\n  @keyframes kui-wipe-up {\n    from {\n      clip-path: inset(100% 0 0);\n    }\n    to {\n      clip-path: inset(0 0 0);\n    }\n  }\n  @keyframes kui-wipe-down {\n    from {\n      clip-path: inset(0 0 100%);\n    }\n    to {\n      clip-path: inset(0 0 0);\n    }\n  }\n  @keyframes kui-wipe-left {\n    from {\n      clip-path: inset(0 100% 0 0);\n    }\n    to {\n      clip-path: inset(0 0 0 0);\n    }\n  }\n  @keyframes kui-wipe-right {\n    from {\n      clip-path: inset(0 0 0 100%);\n    }\n    to {\n      clip-path: inset(0 0 0 0);\n    }\n  }\n  @keyframes kui-wipe-circle {\n    from {\n      clip-path: circle(0 at 50% 50%);\n    }\n    to {\n      clip-path: circle(75% at 50% 50%);\n    }\n  }\n  @keyframes kui-wipe-diagonal {\n    from {\n      clip-path: polygon(0 0, 0 0, 0 0);\n    }\n    to {\n      clip-path: polygon(0 0, 200% 0, 0 200%);\n    }\n  }\n  @keyframes kui-curtain-reveal {\n    from {\n      clip-path: inset(0 50%);\n    }\n    to {\n      clip-path: inset(0 0);\n    }\n  }\n  @keyframes kui-before-after-wipe {\n    from {\n      clip-path: inset(0 100% 0 0);\n    }\n    to {\n      clip-path: inset(0 0 0 0);\n    }\n  }\n  @keyframes kui-mask-reveal {\n    from {\n      mask-position: 100% 0;\n    }\n    to {\n      mask-position: 0 0;\n    }\n  }\n  [data-kui-fx~=mask-reveal] {\n    mask-image:\n      linear-gradient(\n        90deg,\n        #000 0 45%,\n        transparent 55% 100%);\n    mask-size: 220% 100%;\n  }\n  @keyframes kui-ken-burns {\n    from {\n      scale: 1;\n      translate: 0 0;\n    }\n    to {\n      scale: var(--kui-to-scale, 1.12);\n      translate: var(--kui-distance, 24px) calc(var(--kui-distance, 24px) * -0.5);\n    }\n  }\n  @keyframes kui-ken-burns-out {\n    from {\n      scale: var(--kui-to-scale, 1.12);\n      translate: calc(var(--kui-distance, 24px) * -1) 0;\n    }\n    to {\n      scale: 1;\n      translate: 0 0;\n    }\n  }\n  @keyframes kui-blur-up {\n    from {\n      translate: 0 var(--kui-distance, 24px);\n      filter: blur(var(--kui-blur, 16px));\n    }\n    to {\n      translate: 0 0;\n      filter: blur(0);\n    }\n  }\n  @keyframes kui-duotone-hover {\n    from {\n      filter: grayscale(1) sepia(0.7) hue-rotate(330deg) saturate(2);\n    }\n    to {\n      filter: none;\n    }\n  }\n  @keyframes kui-grayscale-hover {\n    from {\n      filter: grayscale(1);\n    }\n    to {\n      filter: grayscale(0);\n    }\n  }\n  @keyframes kui-saturate-hover {\n    from {\n      filter: saturate(0.45);\n    }\n    to {\n      filter: saturate(1.35);\n    }\n  }\n  @keyframes kui-image-parallax-frame {\n    from {\n      translate: 0 calc(var(--kui-distance, 24px) * -1);\n    }\n    to {\n      translate: 0 var(--kui-distance, 24px);\n    }\n  }\n  @keyframes kui-lightbox-open {\n    from {\n      opacity: 0;\n      scale: var(--kui-from-scale, 0.92);\n    }\n    to {\n      opacity: 1;\n      scale: 1;\n    }\n  }\n  @media (pointer: coarse) {\n    [data-kui-fx~=duotone-hover]:active,\n    [data-kui-fx~=grayscale-hover]:active,\n    [data-kui-fx~=saturate-hover]:active {\n      filter: none;\n    }\n  }\n  .kui-slat-stage {\n    position: absolute;\n    overflow: clip;\n  }\n  .kui-slat-item {\n    position: absolute;\n    inset: 0;\n    background-repeat: no-repeat;\n    background-size: 100% 100%;\n    animation-duration: var(--kui-duration, 500ms);\n    animation-delay: calc(var(--kui-delay, 0ms) + var(--kui-i, 0) * var(--kui-stagger, 60ms));\n    animation-timing-function: var(--kui-ease, ease-out);\n    animation-fill-mode: both;\n  }\n  .kui-slat-stage.kui-slat-animating .kui-slat-item {\n    will-change: transform;\n  }\n  .kui-slat-item:nth-child(odd) {\n    --kui-slat-sign: -1;\n  }\n  .kui-slat-item:nth-child(even) {\n    --kui-slat-sign: 1;\n  }\n  .kui-slat-stage[data-kui-slat-fold=true] {\n    perspective: 1200px;\n  }\n  .kui-slat-stage:not([data-kui-slat-fold=true]) .kui-slat-item {\n    animation-name: kui-slat-assemble;\n  }\n  .kui-slat-stage[data-kui-slat-fold=true] .kui-slat-item {\n    animation-name: kui-slat-assemble-fold;\n  }\n  @keyframes kui-slat-assemble {\n    from {\n      opacity: 0;\n      translate: calc(var(--kui-slat-sign, 1) * var(--kui-slat-dx, 0) * 38%) calc(var(--kui-slat-sign, 1) * var(--kui-slat-dy, 1) * 38%);\n    }\n    12% {\n      opacity: 1;\n    }\n    to {\n      opacity: 1;\n      translate: 0 0;\n    }\n  }\n  @keyframes kui-slat-assemble-fold {\n    from {\n      opacity: 0;\n      translate: calc(var(--kui-slat-sign, 1) * var(--kui-slat-dx, 0) * 38%) calc(var(--kui-slat-sign, 1) * var(--kui-slat-dy, 1) * 38%);\n      rotate: var(--kui-slat-dx, 0) var(--kui-slat-dy, 1) 0 calc(var(--kui-slat-sign, 1) * 38deg);\n    }\n    12% {\n      opacity: 1;\n    }\n    to {\n      opacity: 1;\n      translate: 0 0;\n      rotate: var(--kui-slat-dx, 0) var(--kui-slat-dy, 1) 0 0deg;\n    }\n  }\n}\n\n/* src/css/text.css */\n@layer kui.effects {\n  .kui-sr-only {\n    position: absolute;\n    width: 1px;\n    height: 1px;\n    padding: 0;\n    margin: -1px;\n    overflow: hidden;\n    clip-path: inset(50%);\n    white-space: nowrap;\n    border: 0;\n  }\n  .kui-split-decorative {\n    display: inline;\n  }\n  .kui-split-item {\n    display: inline-block;\n    animation-duration: var(--kui-duration, 500ms);\n    animation-delay: calc(var(--kui-delay, 0ms) + var(--kui-i, 0) * var(--kui-stagger, 30ms));\n    animation-timing-function: var(--kui-ease, ease-out);\n    animation-fill-mode: both;\n  }\n  .kui-split-word {\n    display: inline-block;\n  }\n  .kui-split-line {\n    display: block;\n  }\n  [data-kui-split-fx=fade] .kui-split-item {\n    animation-name: kui-split-reveal-fade;\n  }\n  [data-kui-split-fx=up] .kui-split-item {\n    animation-name: kui-split-reveal-up;\n  }\n  [data-kui-split-fx=down] .kui-split-item {\n    animation-name: kui-split-reveal-down;\n  }\n  [data-kui-split-fx=mask] .kui-split-item {\n    animation-name: kui-split-reveal-mask;\n    padding-block: var(--kui-mask-bleed, 0px);\n    margin-block: calc(-1 * var(--kui-mask-bleed, 0px));\n  }\n  @keyframes kui-split-reveal-fade {\n    from {\n      opacity: 0;\n    }\n  }\n  @keyframes kui-split-reveal-up {\n    from {\n      opacity: 0;\n      translate: 0 0.6em;\n    }\n  }\n  @keyframes kui-split-reveal-down {\n    from {\n      opacity: 0;\n      translate: 0 -0.6em;\n    }\n  }\n  @keyframes kui-split-reveal-mask {\n    from {\n      opacity: 0;\n      clip-path: inset(0 0 100% 0);\n    }\n    to {\n      clip-path: inset(0 0 0 0);\n    }\n  }\n  [data-kui-split-fx=wave] .kui-split-item {\n    animation-name: kui-split-wave;\n    animation-duration: 1400ms;\n    animation-iteration-count: infinite;\n    animation-timing-function: ease-in-out;\n  }\n  [data-kui-split-fx=jitter] .kui-split-item {\n    animation-name: kui-split-jitter;\n    animation-duration: 220ms;\n    animation-iteration-count: infinite;\n    animation-timing-function: ease-in-out;\n    animation-direction: alternate;\n  }\n  @keyframes kui-split-wave {\n    0%, 100% {\n      translate: 0 0;\n    }\n    50% {\n      translate: 0 -0.35em;\n    }\n  }\n  @keyframes kui-split-jitter {\n    from {\n      translate: 0 0;\n      rotate: 0deg;\n    }\n    to {\n      translate: 0 0.08em;\n      rotate: 3deg;\n    }\n  }\n  .kui-typewriter::after {\n    content: \"\";\n    display: inline-block;\n    width: 0.08em;\n    margin-inline-start: 0.05em;\n    height: 1em;\n    vertical-align: -0.15em;\n    background: currentColor;\n    animation: kui-caret-blink 1s steps(1) infinite;\n  }\n  @keyframes kui-caret-blink {\n    50% {\n      opacity: 0;\n    }\n  }\n  .kui-scramble {\n    font-variant-numeric: tabular-nums;\n  }\n  [data-kui-fx~=word-cycler] {\n    display: inline-block;\n    transition: opacity 150ms ease-out;\n  }\n  [data-kui-fx~=word-cycler].kui-word-cycler-swap {\n    opacity: 0;\n  }\n  [data-kui-fx~=gradient-shimmer] {\n    background-image:\n      linear-gradient(\n        100deg,\n        currentColor 40%,\n        color-mix(in srgb, currentColor 35%, transparent) 50%,\n        currentColor 60%);\n    background-size: 220% 100%;\n    -webkit-background-clip: text;\n    background-clip: text;\n    -webkit-text-fill-color: transparent;\n    --kui-fx-gradient-shimmer-iterations: infinite;\n  }\n  @keyframes kui-gradient-shimmer {\n    from {\n      background-position: 200% 0;\n    }\n    to {\n      background-position: -200% 0;\n    }\n  }\n  [data-kui-fx~=gradient-sweep] {\n    background-image:\n      linear-gradient(\n        100deg,\n        transparent 30%,\n        color-mix(in srgb, var(--kui-sweep-color, currentColor) 70%, transparent) 50%,\n        transparent 70%);\n    background-size: 260% 100%;\n    -webkit-background-clip: text;\n    background-clip: text;\n    -webkit-text-fill-color: transparent;\n  }\n  @keyframes kui-gradient-sweep {\n    from {\n      background-position: 220% 0;\n    }\n    to {\n      background-position: -60% 0;\n    }\n  }\n  [data-kui-fx~=highlight-sweep] {\n    background-image: linear-gradient(90deg, color-mix(in srgb, var(--kui-sweep-color, currentColor) 55%, transparent) 0 100%);\n    background-repeat: no-repeat;\n    background-size: 0% 100%;\n    padding: 0 0.05em;\n  }\n  @keyframes kui-highlight-sweep {\n    to {\n      background-size: 100% 100%;\n    }\n  }\n  [data-kui-fx~=underline-draw] {\n    background-image: linear-gradient(var(--kui-sweep-color, currentColor), var(--kui-sweep-color, currentColor));\n    background-repeat: no-repeat;\n    background-position: 0 100%;\n    background-size: 0% 2px;\n    padding-bottom: 0.15em;\n  }\n  @keyframes kui-underline-draw {\n    to {\n      background-size: 100% 2px;\n    }\n  }\n  [data-kui-fx~=text-outline-fill] {\n    -webkit-text-stroke: 1px currentColor;\n    -webkit-text-fill-color: transparent;\n  }\n  @keyframes kui-text-outline-fill {\n    to {\n      -webkit-text-fill-color: currentColor;\n    }\n  }\n  @keyframes kui-var-weight {\n    from {\n      font-weight: var(--kui-from-weight, 100);\n    }\n    to {\n      font-weight: var(--kui-to-weight, 800);\n    }\n  }\n  @keyframes kui-var-width {\n    from {\n      font-stretch: var(--kui-from-width, 75%);\n    }\n    to {\n      font-stretch: var(--kui-to-width, 125%);\n    }\n  }\n  @keyframes kui-var-slant {\n    from {\n      font-style: oblique var(--kui-from-slant, 0deg);\n    }\n    to {\n      font-style: oblique var(--kui-to-slant, 10deg);\n    }\n  }\n  [data-kui-fx~=marquee],\n  [data-kui-fx~=marquee-scroll-linked] {\n    display: flex;\n    width: max-content;\n    will-change: translate;\n  }\n  [data-kui-fx~=marquee] {\n    --kui-fx-marquee-iterations: infinite;\n  }\n  @keyframes kui-marquee {\n    to {\n      translate: -50% 0;\n    }\n  }\n  @property --kui-redaction-x { syntax: \"<percentage>\"; inherits: true; initial-value: 0%; }\n  [data-kui-fx~=redaction-reveal] {\n    position: relative;\n    display: inline-block;\n  }\n  [data-kui-fx~=redaction-reveal]::before {\n    content: \"\";\n    position: absolute;\n    inset: 0;\n    background: var(--kui-bar-color, #111);\n    clip-path: inset(0 0 0 var(--kui-redaction-x));\n  }\n  @keyframes kui-redaction-reveal {\n    to {\n      --kui-redaction-x: 100%;\n    }\n  }\n  [data-kui-fx~=text-3d-extrude] {\n    display: inline-block;\n    text-shadow:\n      1px 1px 0 color-mix(in srgb, currentColor 70%, transparent),\n      2px 2px 0 color-mix(in srgb, currentColor 60%, transparent),\n      3px 3px 0 color-mix(in srgb, currentColor 50%, transparent),\n      4px 4px 0 color-mix(in srgb, currentColor 40%, transparent),\n      5px 5px 0 color-mix(in srgb, currentColor 30%, transparent),\n      6px 6px 8px rgb(0 0 0 / 0.35);\n  }\n  @keyframes kui-text-3d-extrude {\n    from {\n      rotate: var(--kui-from-angle, -20deg);\n      translate: 0 var(--kui-distance, 32px);\n    }\n    to {\n      rotate: 0deg;\n      translate: 0 0;\n    }\n  }\n}\n\n/* src/css/navigation.css */\n@layer kui.effects {\n  @keyframes kui-nav-reveal {\n    from {\n      opacity: 0;\n      translate: 0 var(--kui-distance, 16px);\n    }\n  }\n  @keyframes kui-menu-fullscreen {\n    from {\n      opacity: 0;\n      clip-path: circle(0% at var(--kui-origin, 100% 0%));\n    }\n    to {\n      opacity: 1;\n      clip-path: circle(150% at var(--kui-origin, 100% 0%));\n    }\n  }\n  @keyframes kui-panel-reveal {\n    from {\n      opacity: 0;\n      translate: 0 calc(var(--kui-distance, 10px) * -1);\n    }\n  }\n  @keyframes kui-drawer-slide-right {\n    from {\n      translate: 100% 0;\n    }\n  }\n  [data-kui-fx~=header-shrink] {\n    --kui-shrink: 0;\n    padding-block: calc(1.4rem - 0.7rem * var(--kui-shrink, 0));\n    font-size: calc(1rem - 0.15rem * var(--kui-shrink, 0));\n    transition:\n      padding-block 200ms ease-out,\n      font-size 200ms ease-out,\n      box-shadow 200ms ease-out;\n  }\n  [data-kui-fx~=header-shrink][data-kui-shrunk=true] {\n    box-shadow: 0 2px 10px rgb(0 0 0 / 0.12);\n  }\n  [data-kui-fx~=header-hide-on-scroll] {\n    transition: translate 220ms ease-out;\n  }\n  [data-kui-fx~=header-hide-on-scroll][data-kui-hidden=true] {\n    translate: 0 -100%;\n  }\n  [data-kui-fx~=back-to-top-fade] {\n    opacity: 0;\n    translate: 0 12px;\n    pointer-events: none;\n    transition: opacity 200ms ease-out, translate 200ms ease-out;\n  }\n  [data-kui-fx~=back-to-top-fade][data-kui-visible=true] {\n    opacity: 1;\n    translate: 0 0;\n    pointer-events: auto;\n  }\n}\n\n/* src/css/forms.css */\n@layer kui.effects {\n  [data-kui-fx~=label-float] ~ label {\n    transition: translate 180ms ease-out, scale 180ms ease-out;\n    transform-origin: left center;\n  }\n  [data-kui-fx~=label-float]:focus ~ label,\n  [data-kui-fx~=label-float]:not(:placeholder-shown) ~ label {\n    translate: 0 -1.35rem;\n    scale: 0.82;\n  }\n  [data-kui-fx~=input-underline-grow] ~ .kui-underline {\n    display: block;\n    height: 2px;\n    background: currentColor;\n    scale: 0 1;\n    transform-origin: left center;\n    transition: scale 220ms ease-out;\n  }\n  [data-kui-fx~=input-underline-grow]:focus ~ .kui-underline {\n    scale: 1 1;\n  }\n  @keyframes kui-focus-ring-grow {\n    from {\n      box-shadow: 0 0 0 0 var(--kui-ring-color, rgb(210 105 30 / 0.55));\n    }\n    to {\n      box-shadow: 0 0 0 5px var(--kui-ring-color, rgb(210 105 30 / 0.55));\n    }\n  }\n  @keyframes kui-validate-shake {\n    10%, 90% {\n      translate: -1px 0;\n    }\n    20%, 80% {\n      translate: 2px 0;\n    }\n    30%, 50%, 70% {\n      translate: -4px 0;\n    }\n    40%, 60% {\n      translate: 4px 0;\n    }\n  }\n  [data-kui-fx~=validate-check] {\n    stroke-dasharray: 24;\n    stroke-dashoffset: 24;\n  }\n  @keyframes kui-validate-check {\n    to {\n      stroke-dashoffset: 0;\n    }\n  }\n  [data-kui-fx~=strength-meter] ~ .kui-meter > * {\n    background: var(--kui-meter-off, currentColor);\n    opacity: 0.2;\n    transition: opacity 200ms ease-out, background-color 200ms ease-out;\n  }\n  [data-kui-fx~=strength-meter][data-kui-strength-level=\"1\"] ~ .kui-meter > *:nth-child(-n+1),\n  [data-kui-fx~=strength-meter][data-kui-strength-level=\"2\"] ~ .kui-meter > *:nth-child(-n+2),\n  [data-kui-fx~=strength-meter][data-kui-strength-level=\"3\"] ~ .kui-meter > *:nth-child(-n+3),\n  [data-kui-fx~=strength-meter][data-kui-strength-level=\"4\"] ~ .kui-meter > *:nth-child(-n+4),\n  [data-kui-fx~=strength-meter][data-kui-strength-level=\"5\"] ~ .kui-meter > *:nth-child(-n+5),\n  [data-kui-fx~=strength-meter][data-kui-strength-level=\"6\"] ~ .kui-meter > *:nth-child(-n+6),\n  [data-kui-fx~=strength-meter][data-kui-strength-level=\"7\"] ~ .kui-meter > *:nth-child(-n+7),\n  [data-kui-fx~=strength-meter][data-kui-strength-level=\"8\"] ~ .kui-meter > *:nth-child(-n+8),\n  [data-kui-fx~=strength-meter][data-kui-strength-level=\"9\"] ~ .kui-meter > *:nth-child(-n+9),\n  [data-kui-fx~=strength-meter][data-kui-strength-level=\"10\"] ~ .kui-meter > *:nth-child(-n+10),\n  [data-kui-fx~=strength-meter][data-kui-strength-level=\"11\"] ~ .kui-meter > *:nth-child(-n+11),\n  [data-kui-fx~=strength-meter][data-kui-strength-level=\"12\"] ~ .kui-meter > *:nth-child(-n+12),\n  [data-kui-fx~=strength-meter][data-kui-strength-level=\"13\"] ~ .kui-meter > *:nth-child(-n+13),\n  [data-kui-fx~=strength-meter][data-kui-strength-level=\"14\"] ~ .kui-meter > *:nth-child(-n+14),\n  [data-kui-fx~=strength-meter][data-kui-strength-level=\"15\"] ~ .kui-meter > *:nth-child(-n+15),\n  [data-kui-fx~=strength-meter][data-kui-strength-level=\"16\"] ~ .kui-meter > *:nth-child(-n+16),\n  [data-kui-fx~=strength-meter][data-kui-strength-level=\"17\"] ~ .kui-meter > *:nth-child(-n+17),\n  [data-kui-fx~=strength-meter][data-kui-strength-level=\"18\"] ~ .kui-meter > *:nth-child(-n+18),\n  [data-kui-fx~=strength-meter][data-kui-strength-level=\"19\"] ~ .kui-meter > *:nth-child(-n+19),\n  [data-kui-fx~=strength-meter][data-kui-strength-level=\"20\"] ~ .kui-meter > *:nth-child(-n+20) {\n    opacity: 1;\n    background: var(--kui-meter-on, #2e9e5b);\n  }\n  [data-kui-fx~=toggle-morph] ~ .kui-track {\n    display: inline-block;\n    width: calc(40px * var(--kui-toggle-scale, 1));\n    height: calc(22px * var(--kui-toggle-scale, 1));\n    border-radius: 999px;\n    background: var(--muted, #9a8d80);\n    transition: background-color 200ms ease-out;\n    position: relative;\n  }\n  [data-kui-fx~=toggle-morph] ~ .kui-track .kui-thumb {\n    position: absolute;\n    top: calc(2px * var(--kui-toggle-scale, 1));\n    left: calc(2px * var(--kui-toggle-scale, 1));\n    width: calc(18px * var(--kui-toggle-scale, 1));\n    height: calc(18px * var(--kui-toggle-scale, 1));\n    border-radius: 50%;\n    background: var(--kui-thumb-color, #fff);\n    translate: 0 0;\n    transition: translate 200ms ease-out;\n  }\n  [data-kui-fx~=toggle-morph]:checked ~ .kui-track {\n    background: var(--accent, #d2691e);\n  }\n  [data-kui-fx~=toggle-morph]:checked ~ .kui-track .kui-thumb {\n    translate: calc(18px * var(--kui-toggle-scale, 1)) 0;\n  }\n  [data-kui-fx~=checkbox-draw] ~ svg path {\n    stroke-dasharray: 24;\n    stroke-dashoffset: 24;\n    transition: stroke-dashoffset 220ms ease-out;\n  }\n  [data-kui-fx~=checkbox-draw]:checked ~ svg path {\n    stroke-dashoffset: 0;\n  }\n  [data-kui-fx~=radio-fill] ~ .kui-dot {\n    display: inline-block;\n    width: calc(10px * var(--kui-radio-scale, 1));\n    height: calc(10px * var(--kui-radio-scale, 1));\n    border-radius: 50%;\n    background: var(--accent, #d2691e);\n    scale: 0;\n    transition: scale 180ms ease-out;\n  }\n  [data-kui-fx~=radio-fill]:checked ~ .kui-dot {\n    scale: 1;\n  }\n  [data-kui-fx~=range-fill] {\n    --kui-fill: 0%;\n    accent-color: var(--accent, #d2691e);\n    background:\n      linear-gradient(\n        to right,\n        var(--accent, #d2691e) var(--kui-fill, 0%),\n        var(--border, #2a2422) var(--kui-fill, 0%));\n    height: 4px;\n    border-radius: 999px;\n    appearance: none;\n    outline: none;\n  }\n  [data-kui-fx~=submit-to-spinner-to-check] .kui-stage-idle,\n  [data-kui-fx~=submit-to-spinner-to-check] .kui-stage-loading,\n  [data-kui-fx~=submit-to-spinner-to-check] .kui-stage-done {\n    display: none;\n  }\n  [data-kui-fx~=submit-to-spinner-to-check][data-kui-stage=idle] .kui-stage-idle,\n  [data-kui-fx~=submit-to-spinner-to-check][data-kui-stage=loading] .kui-stage-loading,\n  [data-kui-fx~=submit-to-spinner-to-check][data-kui-stage=done] .kui-stage-done {\n    display: inline-flex;\n  }\n  [data-kui-fx~=submit-to-spinner-to-check] .kui-spinner {\n    width: 1em;\n    height: 1em;\n    border-radius: 50%;\n    border: 2px solid currentColor;\n    border-top-color: transparent;\n    animation: kui-spin 700ms linear infinite;\n  }\n  @keyframes kui-spin {\n    to {\n      rotate: 360deg;\n    }\n  }\n  [data-kui-fx~=step-progress] {\n    cursor: pointer;\n  }\n  [data-kui-fx~=step-progress] > [data-kui-step-state],\n  .kui-step-track > [data-kui-step-state] {\n    background: var(--muted, #9a8d80);\n    opacity: 0.35;\n    transition: opacity 200ms ease-out, background-color 200ms ease-out;\n  }\n  [data-kui-fx~=step-progress] > [data-kui-step-state=before],\n  [data-kui-fx~=step-progress] > [data-kui-step-state=active],\n  .kui-step-track > [data-kui-step-state=before],\n  .kui-step-track > [data-kui-step-state=active] {\n    opacity: 1;\n    background: var(--accent, #d2691e);\n  }\n}\n\n/* src/css/ambient.css */\n@layer kui.effects {\n  [data-kui-fx~=gradient-mesh] {\n    background-image:\n      radial-gradient(\n        at 15% 20%,\n        color-mix(in srgb, var(--kui-ambient-c1, var(--kui-c1, #7c3aed)) 55%, transparent),\n        transparent 55%),\n      radial-gradient(\n        at 85% 15%,\n        color-mix(in srgb, var(--kui-ambient-c2, var(--kui-c2, #06b6d4)) 50%, transparent),\n        transparent 55%),\n      radial-gradient(\n        at 50% 85%,\n        color-mix(in srgb, var(--kui-ambient-c3, var(--kui-c3, #f97316)) 45%, transparent),\n        transparent 55%);\n    background-size: 200% 200%;\n    --kui-fx-gradient-mesh-iterations: infinite;\n  }\n  @keyframes kui-gradient-mesh {\n    0%, 100% {\n      background-position:\n        0% 0%,\n        100% 0%,\n        50% 100%;\n    }\n    50% {\n      background-position:\n        25% 35%,\n        75% 30%,\n        35% 70%;\n    }\n  }\n  [data-kui-fx~=aurora] {\n    background-image:\n      linear-gradient(\n        120deg,\n        color-mix(in srgb, var(--kui-ambient-c1, var(--kui-c1, #34d399)) 45%, transparent),\n        transparent 45%),\n      linear-gradient(\n        240deg,\n        color-mix(in srgb, var(--kui-ambient-c2, var(--kui-c2, #60a5fa)) 45%, transparent),\n        transparent 45%),\n      linear-gradient(\n        0deg,\n        color-mix(in srgb, var(--kui-ambient-c3, var(--kui-c3, #c084fc)) 40%, transparent),\n        transparent 50%);\n    background-size: 260% 260%;\n    --kui-fx-aurora-iterations: infinite;\n  }\n  @keyframes kui-aurora {\n    0%, 100% {\n      background-position:\n        0% 50%,\n        100% 50%,\n        50% 0%;\n    }\n    50% {\n      background-position:\n        60% 30%,\n        40% 70%,\n        55% 60%;\n    }\n  }\n  [data-kui-fx~=wave-blob] {\n    background-image:\n      radial-gradient(\n        circle,\n        color-mix(in srgb, var(--kui-ambient-c1, var(--kui-c1, #22d3ee)) 50%, transparent),\n        transparent 60%);\n    background-size: 140% 140%;\n    background-repeat: no-repeat;\n    --kui-fx-wave-blob-iterations: infinite;\n  }\n  @keyframes kui-wave-blob {\n    0%, 100% {\n      background-position: 20% 30%;\n      background-size: 140% 140%;\n    }\n    33% {\n      background-position: 70% 20%;\n      background-size: 160% 160%;\n    }\n    66% {\n      background-position: 50% 75%;\n      background-size: 120% 120%;\n    }\n  }\n  [data-kui-fx~=spotlight-follow] {\n    background-image:\n      radial-gradient(\n        circle,\n        color-mix(in srgb, var(--kui-ambient-c1, var(--kui-c1, #fde68a)) 65%, transparent),\n        transparent 65%);\n    background-size: 55% 55%;\n    background-repeat: no-repeat;\n    --kui-fx-spotlight-follow-iterations: infinite;\n  }\n  @keyframes kui-spotlight-follow {\n    0%, 100% {\n      background-position: 10% 15%;\n    }\n    25% {\n      background-position: 85% 20%;\n    }\n    50% {\n      background-position: 80% 80%;\n    }\n    75% {\n      background-position: 15% 75%;\n    }\n  }\n  [data-kui-fx~=gradient-rotate-border] {\n    position: relative;\n    background-image:\n      linear-gradient(\n        90deg,\n        var(--kui-ambient-c1, var(--kui-c1, #f472b6)),\n        var(--kui-ambient-c2, var(--kui-c2, #60a5fa)),\n        var(--kui-ambient-c3, var(--kui-c3, #34d399)),\n        var(--kui-ambient-c4, var(--kui-c4, #fbbf24)),\n        var(--kui-ambient-c1, var(--kui-c1, #f472b6)));\n    background-size: 300% 100%;\n    padding: 3px;\n    mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);\n    mask-composite: exclude;\n    -webkit-mask-composite: xor;\n    --kui-fx-gradient-rotate-border-iterations: infinite;\n  }\n  @keyframes kui-gradient-rotate-border {\n    from {\n      background-position: 0% 50%;\n    }\n    to {\n      background-position: 300% 50%;\n    }\n  }\n  [data-kui-fx~=gradient-border] {\n    position: relative;\n    background-image:\n      linear-gradient(\n        90deg,\n        var(--kui-ambient-c1, var(--kui-c1, #7c3aed)),\n        var(--kui-ambient-c2, var(--kui-c2, #fbbf24)),\n        var(--kui-ambient-c1, var(--kui-c1, #7c3aed)));\n    background-size: 300% 100%;\n    padding: var(--kui-gradient-border-width, 3px);\n    mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);\n    mask-composite: exclude;\n    -webkit-mask-composite: xor;\n    --kui-fx-gradient-border-iterations: infinite;\n  }\n  @keyframes kui-gradient-border {\n    from {\n      background-position: 0% 50%;\n    }\n    to {\n      background-position: 300% 50%;\n    }\n  }\n  [data-kui-fx~=noise-overlay] {\n    background-image:\n      repeating-radial-gradient(\n        circle at 0 0,\n        color-mix(in srgb, var(--kui-ambient-c1, var(--kui-c1, currentColor)) 30%, transparent) 0,\n        transparent 1.4px,\n        transparent 3px);\n    background-size: 5px 5px;\n    --kui-fx-noise-overlay-iterations: infinite;\n  }\n  @keyframes kui-noise-overlay {\n    0% {\n      background-position: 0 0;\n    }\n    20% {\n      background-position: -3px 1px;\n    }\n    40% {\n      background-position: 2px -2px;\n    }\n    60% {\n      background-position: -1px 3px;\n    }\n    80% {\n      background-position: 3px 2px;\n    }\n    100% {\n      background-position: 0 0;\n    }\n  }\n  [data-kui-fx~=scanline] {\n    background-image:\n      linear-gradient(\n        to bottom,\n        transparent,\n        color-mix(in srgb, var(--kui-ambient-c1, var(--kui-c1, currentColor)) 35%, transparent) 50%,\n        transparent);\n    background-size: 100% 220%;\n    background-repeat: no-repeat;\n    --kui-fx-scanline-iterations: infinite;\n  }\n  @keyframes kui-scanline {\n    from {\n      background-position: 0 -120%;\n    }\n    to {\n      background-position: 0 120%;\n    }\n  }\n  [data-kui-fx~=dot-grid-drift] {\n    background-image:\n      radial-gradient(\n        circle,\n        color-mix(in srgb, var(--kui-ambient-c1, var(--kui-c1, currentColor)) 45%, transparent) 1.5px,\n        transparent 1.5px);\n    background-size: 22px 22px;\n    --kui-fx-dot-grid-drift-iterations: infinite;\n  }\n  @keyframes kui-dot-grid-drift {\n    from {\n      background-position: 0 0;\n    }\n    to {\n      background-position: 22px 22px;\n    }\n  }\n  [data-kui-fx~=line-grid-drift] {\n    background-image:\n      repeating-linear-gradient(\n        0deg,\n        color-mix(in srgb, var(--kui-ambient-c1, var(--kui-c1, currentColor)) 30%, transparent) 0 1px,\n        transparent 1px 26px),\n      repeating-linear-gradient(\n        90deg,\n        color-mix(in srgb, var(--kui-ambient-c1, var(--kui-c1, currentColor)) 30%, transparent) 0 1px,\n        transparent 1px 26px);\n    --kui-fx-line-grid-drift-iterations: infinite;\n  }\n  @keyframes kui-line-grid-drift {\n    from {\n      background-position: 0 0, 0 0;\n    }\n    to {\n      background-position: 0 26px, 26px 0;\n    }\n  }\n  [data-kui-fx~=starfield] {\n    background-image:\n      radial-gradient(\n        1px 1px at 10% 20%,\n        color-mix(in srgb, var(--kui-ambient-c1, var(--kui-c1, #ffffff)) 90%, transparent),\n        transparent),\n      radial-gradient(\n        1px 1px at 70% 60%,\n        color-mix(in srgb, var(--kui-ambient-c1, var(--kui-c1, #ffffff)) 70%, transparent),\n        transparent),\n      radial-gradient(\n        1.5px 1.5px at 40% 80%,\n        color-mix(in srgb, var(--kui-ambient-c1, var(--kui-c1, #ffffff)) 85%, transparent),\n        transparent),\n      radial-gradient(\n        1px 1px at 90% 30%,\n        color-mix(in srgb, var(--kui-ambient-c1, var(--kui-c1, #ffffff)) 60%, transparent),\n        transparent),\n      radial-gradient(\n        1.5px 1.5px at 25% 55%,\n        color-mix(in srgb, var(--kui-ambient-c1, var(--kui-c1, #ffffff)) 80%, transparent),\n        transparent);\n    background-size: 220px 220px;\n    background-repeat: repeat;\n    --kui-fx-starfield-iterations: infinite;\n  }\n  @keyframes kui-starfield {\n    from {\n      background-position:\n        0 0,\n        0 0,\n        0 0,\n        0 0,\n        0 0;\n    }\n    to {\n      background-position:\n        220px 90px,\n        -160px 220px,\n        90px -140px,\n        -220px -90px,\n        140px 160px;\n    }\n  }\n  [data-kui-fx~=orbit] {\n    --kui-fx-orbit-iterations: infinite;\n  }\n  @keyframes kui-orbit {\n    to {\n      rotate: var(--kui-to-angle, 360deg);\n    }\n  }\n  [data-kui-fx~=float] {\n    --kui-fx-float-iterations: infinite;\n  }\n  @keyframes kui-float {\n    0%, 100% {\n      translate: 0 0;\n    }\n    50% {\n      translate: 0 calc(var(--kui-distance, 14px) * -1);\n    }\n  }\n  [data-kui-fx~=bob] {\n    --kui-fx-bob-iterations: infinite;\n  }\n  @keyframes kui-bob {\n    0%, 100% {\n      translate: 0 0;\n    }\n    50% {\n      translate: 0 calc(var(--kui-distance, 8px) * -1);\n    }\n  }\n  [data-kui-fx~=floating-shapes] {\n    --kui-fx-floating-shapes-iterations: infinite;\n  }\n  @keyframes kui-floating-shapes {\n    0%, 100% {\n      translate: 0 0;\n    }\n    33% {\n      translate: calc(var(--kui-distance, 10px) * 0.6) calc(var(--kui-distance, 10px) * -1);\n    }\n    66% {\n      translate: calc(var(--kui-distance, 10px) * -0.6) calc(var(--kui-distance, 10px) * -0.4);\n    }\n  }\n  [data-kui-fx~=glow-pulse] {\n    --kui-fx-glow-pulse-iterations: infinite;\n  }\n  @keyframes kui-glow-pulse {\n    0%, 100% {\n      scale: 1;\n      opacity: 0.6;\n    }\n    50% {\n      scale: var(--kui-pulse-scale, 1.15);\n      opacity: 1;\n    }\n  }\n}\n\n/* src/css/feedback.css */\n@layer kui.effects {\n  [data-kui-fx~=skeleton-shimmer] {\n    background-color: var(--kui-skeleton-base, #2a2422);\n    background-image:\n      linear-gradient(\n        100deg,\n        transparent 30%,\n        color-mix(in srgb, var(--kui-skeleton-highlight, #ffffff) 18%, transparent) 50%,\n        transparent 70%);\n    background-size: 200% 100%;\n    --kui-fx-skeleton-shimmer-iterations: infinite;\n  }\n  @keyframes kui-skeleton-shimmer {\n    from {\n      background-position: 150% 0;\n    }\n    to {\n      background-position: -50% 0;\n    }\n  }\n  @keyframes kui-skeleton-to-content {\n    from {\n      opacity: 0;\n    }\n  }\n  [data-kui-fx~=spinner] {\n    display: inline-block;\n    width: var(--kui-spinner-size, 28px);\n    height: var(--kui-spinner-size, 28px);\n    border-radius: 50%;\n    border: 3px solid color-mix(in srgb, currentColor 20%, transparent);\n    border-top-color: currentColor;\n    --kui-fx-spinner-iterations: infinite;\n  }\n  @keyframes kui-spinner-spin {\n    to {\n      rotate: 360deg;\n    }\n  }\n  [data-kui-fx~=spinner-ring] {\n    display: inline-block;\n    width: var(--kui-spinner-size, 28px);\n    height: var(--kui-spinner-size, 28px);\n    border-radius: 50%;\n    border: 3px dashed color-mix(in srgb, currentColor 55%, transparent);\n    --kui-fx-spinner-ring-iterations: infinite;\n  }\n  @keyframes kui-spinner-ring-spin {\n    to {\n      rotate: 360deg;\n    }\n  }\n  [data-kui-fx~=spinner-dots] {\n    display: inline-block;\n    width: var(--kui-dot-size, 8px);\n    height: var(--kui-dot-size, 8px);\n    border-radius: 50%;\n    background: currentColor;\n    box-shadow: calc(var(--kui-dot-size, 8px) * -2) 0 currentColor, calc(var(--kui-dot-size, 8px) * 2) 0 currentColor;\n    --kui-fx-spinner-dots-iterations: infinite;\n  }\n  @keyframes kui-spinner-dots {\n    0%, 80%, 100% {\n      scale: 0.7;\n      opacity: 0.5;\n    }\n    40% {\n      scale: 1.15;\n      opacity: 1;\n    }\n  }\n  [data-kui-fx~=progress-indeterminate] {\n    transform-origin: 0% 50%;\n    background: currentColor;\n    border-radius: inherit;\n    --kui-fx-progress-indeterminate-iterations: infinite;\n  }\n  @keyframes kui-progress-indeterminate {\n    0% {\n      translate: -100% 0;\n      scale: 0.4 1;\n    }\n    50% {\n      scale: 1 1;\n    }\n    100% {\n      translate: 100% 0;\n      scale: 0.4 1;\n    }\n  }\n  @keyframes kui-toast-slide-in {\n    from {\n      opacity: 0;\n      translate: 0 var(--kui-distance, 24px);\n    }\n    to {\n      opacity: 1;\n      translate: 0 0;\n    }\n  }\n  @keyframes kui-toast-slide-out {\n    from {\n      opacity: 1;\n      translate: 0 0;\n    }\n    to {\n      opacity: 0;\n      translate: 0 var(--kui-distance, 24px);\n    }\n  }\n  @keyframes kui-shake-error {\n    10%, 90% {\n      translate: -1px 0;\n    }\n    20%, 80% {\n      translate: 2px 0;\n    }\n    30%, 50%, 70% {\n      translate: -4px 0;\n    }\n    40%, 60% {\n      translate: 4px 0;\n    }\n  }\n  @keyframes kui-wobble {\n    0% {\n      translate: 0 0;\n      rotate: 0deg;\n    }\n    15% {\n      translate: -6px 0;\n      rotate: -6deg;\n    }\n    30% {\n      translate: 4px 0;\n      rotate: 4deg;\n    }\n    45% {\n      translate: -3px 0;\n      rotate: -3deg;\n    }\n    60% {\n      translate: 2px 0;\n      rotate: 2deg;\n    }\n    75% {\n      translate: -1px 0;\n      rotate: -1deg;\n    }\n    100% {\n      translate: 0 0;\n      rotate: 0deg;\n    }\n  }\n  [data-kui-fx~=ripple] {\n    border-radius: 50%;\n    background: currentColor;\n    transform-origin: center;\n  }\n  @keyframes kui-ripple {\n    from {\n      scale: 0.2;\n      opacity: 0.6;\n    }\n    to {\n      scale: var(--kui-ripple-scale, 4);\n      opacity: 0;\n    }\n  }\n  @keyframes kui-badge-pop {\n    0% {\n      scale: 0.4;\n    }\n    60% {\n      scale: var(--kui-pop-scale, 1.18);\n    }\n    100% {\n      scale: 1;\n    }\n  }\n  @keyframes kui-count-bump {\n    0%, 100% {\n      scale: 1;\n    }\n    50% {\n      scale: var(--kui-pop-scale, 1.18);\n    }\n  }\n  [data-kui-fx~=heart-burst] {\n    color: var(--kui-heart-color, #f43f5e);\n  }\n  @keyframes kui-heart-burst {\n    0% {\n      scale: 1;\n    }\n    30% {\n      scale: var(--kui-pop-scale, 1.18);\n    }\n    55% {\n      scale: 0.9;\n    }\n    100% {\n      scale: 1;\n    }\n  }\n  [data-kui-fx~=confetti-burst] {\n    background-image:\n      radial-gradient(\n        circle at 20% 20%,\n        var(--kui-c1, #f43f5e) 0 3px,\n        transparent 3px),\n      radial-gradient(\n        circle at 75% 15%,\n        var(--kui-c2, #fbbf24) 0 3px,\n        transparent 3px),\n      radial-gradient(\n        circle at 50% 75%,\n        var(--kui-c3, #34d399) 0 3px,\n        transparent 3px),\n      radial-gradient(\n        circle at 85% 65%,\n        var(--kui-c4, #60a5fa) 0 3px,\n        transparent 3px),\n      radial-gradient(\n        circle at 15% 65%,\n        var(--kui-c5, #c084fc) 0 3px,\n        transparent 3px);\n    background-repeat: no-repeat;\n  }\n  @keyframes kui-confetti-burst {\n    0% {\n      scale: 0.6;\n      opacity: 0;\n    }\n    40% {\n      scale: var(--kui-pop-scale, 1.18);\n      opacity: 1;\n    }\n    100% {\n      scale: 1;\n      opacity: 1;\n    }\n  }\n  @keyframes kui-copy-confirm {\n    0% {\n      opacity: 0;\n    }\n    15% {\n      opacity: 1;\n    }\n    85% {\n      opacity: 1;\n    }\n    100% {\n      opacity: 0;\n    }\n  }\n  @keyframes kui-pull-to-refresh {\n    0% {\n      translate: 0 0;\n    }\n    45% {\n      translate: 0 var(--kui-pull-distance, 36px);\n    }\n    100% {\n      translate: 0 0;\n    }\n  }\n}\n\n/* src/css/numbers.css */\n@layer kui.effects {\n  @keyframes kui-progress-ring {\n    from {\n      stroke-dashoffset: var(--kui-path-length, 100);\n    }\n    to {\n      stroke-dashoffset: 0;\n    }\n  }\n  @keyframes kui-gauge-sweep {\n    from {\n      stroke-dashoffset: var(--kui-path-length, 100);\n    }\n    to {\n      stroke-dashoffset: 0;\n    }\n  }\n  @keyframes kui-donut-sweep {\n    from {\n      stroke-dashoffset: var(--kui-path-length, 100);\n    }\n    to {\n      stroke-dashoffset: 0;\n    }\n  }\n  @keyframes kui-sparkline-draw {\n    from {\n      stroke-dashoffset: var(--kui-path-length, 1000);\n    }\n    to {\n      stroke-dashoffset: 0;\n    }\n  }\n  [data-kui-fx~=progress-ring],\n  [data-kui-fx~=gauge-sweep],\n  [data-kui-fx~=donut-sweep],\n  [data-kui-fx~=sparkline-draw] {\n    stroke-dasharray: var(--kui-path-length, 100);\n    fill: none;\n  }\n  @keyframes kui-progress-bar {\n    from {\n      scale: var(--kui-bar-from, 0) 1;\n    }\n    to {\n      scale: 1 1;\n    }\n  }\n  [data-kui-fx~=progress-bar] {\n    transform-origin: left center;\n  }\n  [data-kui-fx~=progress-bar][data-kui-state=ready] {\n    --kui-bar-from: 1 !important;\n    opacity: 0;\n  }\n  @keyframes kui-progress-segments {\n    from {\n      opacity: 0.18;\n    }\n    to {\n      opacity: 1;\n    }\n  }\n  @keyframes kui-star-rating-fill {\n    from {\n      clip-path: inset(0 100% 0 0);\n    }\n    to {\n      clip-path: inset(0 calc(100% - var(--kui-fill, 100%)) 0 0);\n    }\n  }\n  .kui-count-decorative {\n    display: inline-flex;\n    align-items: baseline;\n  }\n  .kui-odometer-col {\n    display: inline-block;\n    overflow: hidden;\n    height: 1em;\n    line-height: 1;\n    vertical-align: baseline;\n  }\n  .kui-odometer-strip {\n    display: flex;\n    flex-direction: column;\n    translate: 0 calc(var(--kui-o, 0) * -1em);\n    transition: translate 220ms ease-out;\n  }\n  .kui-odometer-strip > span {\n    height: 1em;\n    line-height: 1;\n  }\n}\n\n/* src/css/interaction.css */\n@layer kui.effects {\n  @property --kui-border-angle { syntax: \"<angle>\"; inherits: false; initial-value: 0deg; }\n  @property --kui-border-pct { syntax: \"<percentage>\"; inherits: false; initial-value: 0%; }\n  [data-kui-fx~=lift] {\n    transition: translate var(--kui-lift-duration, 220ms) var(--kui-lift-ease, ease-out);\n  }\n  [data-kui-fx~=lift]:focus-visible {\n    translate: 0 calc(var(--kui-lift-distance, 6px) * -1);\n  }\n  [data-kui-fx~=pop] {\n    transition: scale var(--kui-pop-duration, 220ms) var(--kui-pop-ease, ease-out);\n  }\n  [data-kui-fx~=pop]:focus-visible {\n    scale: var(--kui-pop-scale, 1.06);\n  }\n  [data-kui-fx~=lift-shadow] {\n    transition: translate var(--kui-lift-shadow-duration, 220ms) var(--kui-lift-shadow-ease, ease-out), box-shadow var(--kui-lift-shadow-duration, 220ms) var(--kui-lift-shadow-ease, ease-out);\n  }\n  [data-kui-fx~=lift-shadow]:focus-visible {\n    translate: 0 calc(var(--kui-lift-distance, 6px) * -1);\n    box-shadow: 0 14px 28px -12px rgb(0 0 0 / 0.45);\n  }\n  [data-kui-fx~=shine-sweep] {\n    position: relative;\n    overflow: hidden;\n  }\n  [data-kui-fx~=shine-sweep]::after {\n    content: \"\";\n    position: absolute;\n    inset: 0;\n    background:\n      linear-gradient(\n        115deg,\n        transparent 40%,\n        var(--kui-c1, rgb(255 255 255 / 0.35)) 50%,\n        transparent 60%);\n    background-size: 220% 100%;\n    background-position: 120% 0;\n    pointer-events: none;\n  }\n  [data-kui-fx~=shine-sweep]:focus-visible::after {\n    animation: kui-shine-sweep var(--kui-shine-sweep-duration, 700ms) var(--kui-shine-sweep-ease, ease-out);\n  }\n  @keyframes kui-shine-sweep {\n    from {\n      background-position: 120% 0;\n    }\n    to {\n      background-position: -20% 0;\n    }\n  }\n  [data-kui-fx~=split-flap] {\n    display: inline-block;\n    perspective: 600px;\n    backface-visibility: hidden;\n  }\n  [data-kui-fx~=split-flap]:focus-visible {\n    animation: kui-split-flap var(--kui-split-flap-duration, 600ms) var(--kui-split-flap-ease, ease-in-out);\n  }\n  @keyframes kui-split-flap {\n    from {\n      rotate: x 0deg;\n    }\n    to {\n      rotate: x 360deg;\n    }\n  }\n  [data-kui-fx~=border-draw] {\n    border: 2px solid transparent;\n    border-image-slice: 1;\n    border-image-source:\n      conic-gradient(\n        from -90deg,\n        var(--kui-border-draw-color, var(--accent, #d2691e)) 0 var(--kui-border-pct, 0%),\n        transparent 0);\n    transition: --kui-border-pct var(--kui-border-draw-duration, 500ms) var(--kui-border-draw-ease, ease-out);\n  }\n  [data-kui-fx~=border-draw]:focus-visible {\n    --kui-border-pct: 100%;\n  }\n  [data-kui-fx~=border-glow] {\n    transition: box-shadow var(--kui-border-glow-duration, 260ms) var(--kui-border-glow-ease, ease-out);\n  }\n  [data-kui-fx~=border-glow]:focus-visible {\n    box-shadow: 0 0 0 3px var(--kui-border-glow-color, var(--accent, #d2691e));\n  }\n  [data-kui-fx~=beam-border],\n  [data-kui-fx~=beam-border-auto] {\n    position: relative;\n  }\n  [data-kui-fx~=beam-border]::before,\n  [data-kui-fx~=beam-border-auto]::before {\n    content: \"\";\n    position: absolute;\n    inset: calc(-1 * var(--kui-beam-border-outset, 0px));\n    border-radius: inherit;\n    padding: var(--kui-beam-border-width, 3px);\n    background:\n      conic-gradient(\n        from var(--kui-border-angle, 0deg),\n        transparent 0deg,\n        transparent 260deg,\n        var(--kui-beam-border-c1, #ff5f6d) 282deg,\n        var(--kui-beam-border-c2, var(--kui-beam-border-c1, #ffc371)) 306deg,\n        var(--kui-beam-border-c3, var(--kui-beam-border-c1, #4facfe)) 330deg,\n        var(--kui-beam-border-c4, var(--kui-beam-border-c1, #a855f7)) 354deg,\n        transparent 360deg);\n    -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);\n    -webkit-mask-composite: xor;\n    mask-composite: exclude;\n    opacity: 0;\n    pointer-events: none;\n    transition: opacity var(--kui-beam-border-fade-duration, 200ms) ease-out;\n  }\n  [data-kui-fx~=beam-border]:focus-visible::before {\n    opacity: 1;\n    animation: kui-beam-rotate var(--kui-beam-border-duration, 4260ms) linear infinite;\n  }\n  [data-kui-fx~=beam-border-auto]::before {\n    opacity: 1;\n    animation: kui-beam-rotate var(--kui-beam-border-auto-duration, 4260ms) linear infinite;\n  }\n  @keyframes kui-beam-rotate {\n    to {\n      --kui-border-angle: 360deg;\n    }\n  }\n  @media (prefers-reduced-motion: reduce) {\n    [data-kui-fx~=beam-border]:focus-visible::before,\n    [data-kui-fx~=beam-border-auto]::before {\n      animation: none;\n      --kui-border-angle: 45deg;\n    }\n  }\n  [data-kui-fx~=underline-slide] {\n    position: relative;\n    text-decoration: none;\n  }\n  [data-kui-fx~=underline-slide]::after {\n    content: \"\";\n    position: absolute;\n    left: 0;\n    right: 0;\n    bottom: -0.15em;\n    height: 0.08em;\n    background: currentcolor;\n    scale: 0 1;\n    transform-origin: left center;\n    transition: scale var(--kui-underline-slide-duration, 260ms) var(--kui-underline-slide-ease, ease-out);\n  }\n  [data-kui-fx~=underline-slide]:focus-visible::after {\n    scale: 1 1;\n  }\n  [data-kui-fx~=underline-center] {\n    position: relative;\n    text-decoration: none;\n  }\n  [data-kui-fx~=underline-center]::after {\n    content: \"\";\n    position: absolute;\n    left: 0;\n    right: 0;\n    bottom: -0.15em;\n    height: 0.08em;\n    background: currentcolor;\n    scale: 0 1;\n    transform-origin: center;\n    transition: scale var(--kui-underline-center-duration, 260ms) var(--kui-underline-center-ease, ease-out);\n  }\n  [data-kui-fx~=underline-center]:focus-visible::after {\n    scale: 1 1;\n  }\n  [data-kui-fx~=icon-wiggle]:focus-visible {\n    animation: kui-icon-wiggle var(--kui-icon-wiggle-duration, 500ms) var(--kui-icon-wiggle-ease, ease-in-out);\n  }\n  @keyframes kui-icon-wiggle {\n    0%, 100% {\n      rotate: 0deg;\n    }\n    20% {\n      rotate: -12deg;\n    }\n    40% {\n      rotate: 10deg;\n    }\n    60% {\n      rotate: -6deg;\n    }\n    80% {\n      rotate: 4deg;\n    }\n  }\n  [data-kui-fx~=icon-spin]:focus-visible {\n    animation: kui-icon-spin var(--kui-icon-spin-duration, 700ms) linear;\n  }\n  @keyframes kui-icon-spin {\n    from {\n      rotate: 0deg;\n    }\n    to {\n      rotate: 360deg;\n    }\n  }\n  [data-kui-fx~=icon-bounce]:focus-visible {\n    animation: kui-icon-bounce var(--kui-icon-bounce-duration, 500ms) var(--kui-icon-bounce-ease, ease-out);\n  }\n  @keyframes kui-icon-bounce {\n    0%, 100% {\n      translate: 0 0;\n    }\n    30% {\n      translate: 0 -7px;\n    }\n    55% {\n      translate: 0 1px;\n    }\n    75% {\n      translate: 0 -3px;\n    }\n  }\n  @media (hover: hover) and (pointer: fine) {\n    [data-kui-fx~=lift]:hover {\n      translate: 0 calc(var(--kui-lift-distance, 6px) * -1);\n    }\n    [data-kui-fx~=pop]:hover {\n      scale: var(--kui-pop-scale, 1.06);\n    }\n    [data-kui-fx~=lift-shadow]:hover {\n      translate: 0 calc(var(--kui-lift-distance, 6px) * -1);\n      box-shadow: 0 14px 28px -12px rgb(0 0 0 / 0.45);\n    }\n    [data-kui-fx~=shine-sweep]:hover::after {\n      animation: kui-shine-sweep var(--kui-shine-sweep-duration, 700ms) var(--kui-shine-sweep-ease, ease-out);\n    }\n    [data-kui-fx~=split-flap]:hover {\n      animation: kui-split-flap var(--kui-split-flap-duration, 600ms) var(--kui-split-flap-ease, ease-in-out);\n    }\n    [data-kui-fx~=border-draw]:hover {\n      --kui-border-pct: 100%;\n    }\n    [data-kui-fx~=border-glow]:hover {\n      box-shadow: 0 0 0 3px var(--kui-border-glow-color, var(--accent, #d2691e));\n    }\n    [data-kui-fx~=beam-border]:hover::before {\n      opacity: 1;\n      animation: kui-beam-rotate var(--kui-beam-border-duration, 4260ms) linear infinite;\n    }\n    [data-kui-fx~=underline-slide]:hover::after {\n      scale: 1 1;\n    }\n    [data-kui-fx~=underline-center]:hover::after {\n      scale: 1 1;\n    }\n    [data-kui-fx~=icon-wiggle]:hover {\n      animation: kui-icon-wiggle var(--kui-icon-wiggle-duration, 500ms) var(--kui-icon-wiggle-ease, ease-in-out);\n    }\n    [data-kui-fx~=icon-spin]:hover {\n      animation: kui-icon-spin var(--kui-icon-spin-duration, 700ms) linear;\n    }\n    [data-kui-fx~=icon-bounce]:hover {\n      animation: kui-icon-bounce var(--kui-icon-bounce-duration, 500ms) var(--kui-icon-bounce-ease, ease-out);\n    }\n  }\n  [data-kui-fx~=tilt-3d],\n  [data-kui-fx~=tilt-parallax] {\n    transform-style: preserve-3d;\n  }\n  [data-kui-fx~=cursor-spotlight]::before {\n    content: \"\";\n    position: absolute;\n    inset: 0;\n    border-radius: inherit;\n    pointer-events: none;\n    opacity: var(--kui-spotlight-opacity, 0);\n    transition: opacity 200ms ease-out;\n    background:\n      radial-gradient(\n        circle 160px at var(--kui-x, 50%) var(--kui-y, 50%),\n        color-mix(in srgb, var(--accent, #d2691e) 30%, transparent),\n        transparent 70%);\n  }\n  .kui-cursor-dot {\n    position: fixed;\n    top: 0;\n    left: 0;\n    z-index: 9999;\n    display: grid;\n    place-items: center;\n    pointer-events: none;\n    opacity: 0;\n    transition: opacity 160ms ease-out;\n  }\n  .kui-cursor-dot-active {\n    opacity: 1;\n  }\n  .kui-cursor-dot-follow,\n  .kui-cursor-dot-lag,\n  .kui-cursor-dot-invert {\n    width: 14px;\n    height: 14px;\n    margin: -7px 0 0 -7px;\n    border-radius: 50%;\n    background: var(--accent, #d2691e);\n  }\n  .kui-cursor-dot-invert {\n    background: var(--kui-invert-color, #fff);\n    mix-blend-mode: difference;\n  }\n  .kui-cursor-dot-label {\n    margin: -1.4em 0 0 -1.4em;\n    padding: 0.4em 0.8em;\n    border-radius: 999px;\n    background: var(--accent, #d2691e);\n    color: var(--kui-label-color, #fff);\n    font-size: 0.75rem;\n    font-family:\n      ui-monospace,\n      Menlo,\n      monospace;\n    white-space: nowrap;\n  }\n  @media (pointer: coarse) {\n    .kui-cursor-dot {\n      display: none;\n    }\n  }\n}\n\n/* src/css/layout.css */\n@layer kui.effects {\n  [data-kui-fx~=accordion-height] {\n    overflow: hidden;\n  }\n  [data-kui-fx~=accordion-height]:not([data-open]) {\n    height: 0;\n  }\n}\n\n/* src/css/svg.css */\n@layer kui.effects {\n  @keyframes kui-draw-stroke {\n    from {\n      stroke-dashoffset: var(--kui-path-length, 100);\n    }\n    to {\n      stroke-dashoffset: 0;\n    }\n  }\n  @keyframes kui-draw-signature {\n    from {\n      stroke-dashoffset: var(--kui-path-length, 100);\n    }\n    to {\n      stroke-dashoffset: 0;\n    }\n  }\n  @keyframes kui-draw-underline {\n    from {\n      stroke-dashoffset: var(--kui-path-length, 100);\n    }\n    to {\n      stroke-dashoffset: 0;\n    }\n  }\n  @keyframes kui-checkmark-draw {\n    from {\n      stroke-dashoffset: var(--kui-path-length, 100);\n    }\n    to {\n      stroke-dashoffset: 0;\n    }\n  }\n  @keyframes kui-cross-draw {\n    from {\n      stroke-dashoffset: var(--kui-path-length, 100);\n    }\n    to {\n      stroke-dashoffset: 0;\n    }\n  }\n  @keyframes kui-chart-line-draw {\n    from {\n      stroke-dashoffset: var(--kui-path-length, 100);\n    }\n    to {\n      stroke-dashoffset: 0;\n    }\n  }\n  [data-kui-fx~=draw-stroke],\n  [data-kui-fx~=draw-signature],\n  [data-kui-fx~=draw-underline],\n  [data-kui-fx~=checkmark-draw],\n  [data-kui-fx~=cross-draw],\n  [data-kui-fx~=chart-line-draw] {\n    stroke-dasharray: var(--kui-path-length, 100);\n    fill: none;\n  }\n  @keyframes kui-gradient-stroke {\n    from {\n      stroke: var(--kui-stroke-from, currentColor);\n    }\n    50% {\n      stroke: var(--kui-stroke-via, currentColor);\n    }\n    to {\n      stroke: var(--kui-stroke-to, currentColor);\n    }\n  }\n  [data-kui-fx~=gradient-stroke] {\n    --kui-fx-gradient-stroke-iterations: infinite;\n  }\n  @keyframes kui-heart-fill {\n    from {\n      clip-path: inset(100% 0 0 0);\n    }\n    to {\n      clip-path: inset(0 0 0 0);\n    }\n  }\n  @keyframes kui-bookmark-fill {\n    from {\n      clip-path: inset(100% 0 0 0);\n    }\n    to {\n      clip-path: inset(0 0 0 0);\n    }\n  }\n  @keyframes kui-chart-area-fill {\n    from {\n      clip-path: inset(0 100% 0 0);\n    }\n    to {\n      clip-path: inset(0 0 0 0);\n    }\n  }\n  @keyframes kui-chart-bar-grow {\n    from {\n      scale: 1 var(--kui-bar-from, 0);\n    }\n    to {\n      scale: 1 1;\n    }\n  }\n  [data-kui-fx~=chart-bar-grow] {\n    transform-origin: bottom center;\n  }\n  [data-kui-fx~=chart-bar-grow][data-kui-state=ready] {\n    --kui-bar-from: 1 !important;\n    opacity: 0;\n  }\n  @keyframes kui-logo-build {\n    from {\n      opacity: 0;\n      scale: 0.62;\n      rotate: -8deg;\n    }\n    to {\n      opacity: 1;\n      scale: 1;\n      rotate: 0deg;\n    }\n  }\n  [data-kui-fx~=hamburger-to-x] .kui-bar {\n    transition:\n      translate var(--kui-icon-toggle-duration, 260ms) var(--kui-icon-toggle-ease, ease-out),\n      rotate var(--kui-icon-toggle-duration, 260ms) var(--kui-icon-toggle-ease, ease-out),\n      opacity var(--kui-icon-toggle-duration, 260ms) var(--kui-icon-toggle-ease, ease-out);\n  }\n  [data-kui-fx~=hamburger-to-x][aria-expanded=true] .kui-bar:nth-child(1) {\n    translate: 0 var(--kui-bar-gap, 6px);\n    rotate: 45deg;\n  }\n  [data-kui-fx~=hamburger-to-x][aria-expanded=true] .kui-bar:nth-child(2) {\n    opacity: 0;\n  }\n  [data-kui-fx~=hamburger-to-x][aria-expanded=true] .kui-bar:nth-child(3) {\n    translate: 0 calc(var(--kui-bar-gap, 6px) * -1);\n    rotate: -45deg;\n  }\n  [data-kui-fx~=play-to-pause] .kui-bar {\n    transition: translate var(--kui-icon-toggle-duration, 260ms) var(--kui-icon-toggle-ease, ease-out), clip-path var(--kui-icon-toggle-duration, 260ms) var(--kui-icon-toggle-ease, ease-out);\n  }\n  [data-kui-fx~=play-to-pause]:not([aria-pressed=true]) .kui-bar:nth-child(1) {\n    translate: var(--kui-bar-gap, 4px) 0;\n    clip-path: polygon(0 0, 100% 25%, 100% 75%, 0 100%);\n  }\n  [data-kui-fx~=play-to-pause]:not([aria-pressed=true]) .kui-bar:nth-child(2) {\n    translate: calc(var(--kui-bar-gap, 4px) * -1) 0;\n    clip-path: polygon(0 25%, 100% 50%, 100% 50%, 0 75%);\n  }\n  [data-kui-fx~=plus-to-minus] {\n    transition: rotate var(--kui-icon-toggle-duration, 260ms) var(--kui-icon-toggle-ease, ease-out);\n  }\n  [data-kui-fx~=plus-to-minus] .kui-bar {\n    transition: scale var(--kui-icon-toggle-duration, 260ms) var(--kui-icon-toggle-ease, ease-out);\n  }\n  [data-kui-fx~=plus-to-minus] .kui-bar:nth-child(2) {\n    rotate: 90deg;\n  }\n  [data-kui-fx~=plus-to-minus][aria-expanded=true] {\n    rotate: 90deg;\n  }\n  [data-kui-fx~=plus-to-minus][aria-expanded=true] .kui-bar:nth-child(1) {\n    scale: 0;\n  }\n}\n\n/* src/css/index.css */\n"
    document.head.appendChild(style)
  }
  window.__kuinetic = kuinetic.kuinetic({ observe: true }).start()
})()
