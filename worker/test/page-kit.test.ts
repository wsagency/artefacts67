import test from "node:test";
import assert from "node:assert/strict";
import { gzipSync } from "node:zlib";
import { parseLocalizedNumber } from "../../frontend/src/page-numbers.js";
import { PAGE_KIT_CSS, PAGE_KIT_RUNTIME } from "../../frontend/src/page-kit.js";
import { openArtifact, PAGE_KIT_RUNTIME as EXPORTED_RUNTIME } from "../../frontend/src/artifact-runtime.js";

import { PLATFORM_THEMES } from "../../frontend/src/platform-themes.js";
const layers = ["kit", "theme", "recipes", "artefact", "object"];
const variants = ["hero", "band", "split", "feature", "grid", "full-bleed", "timeline", "steps"];
const tones = ["accent", "muted", "inverse", "info", "ok", "warn", "crit"];

interface TestEvent { type: string; target?: TestNode; currentTarget?: TestNode; defaultPrevented?: boolean; preventDefault?(): void }
class TestNode {
  readonly attrs = new Map<string, string>();
  readonly childNodes: TestNode[] = [];
  readonly dataset: Record<string, string> = {};
  readonly listeners = new Map<string, Set<(event: TestEvent) => void>>();
  parentNode: TestNode | null = null;
  ownerDocument: TestDocument;
  nodeType = 1;
  nodeName: string;
  tagName: string;
  isConnected = false;
  type = "";
  get name(): string { return this.getAttribute("name") ?? ""; }
  set name(value: string) { this.setAttribute("name", value); }
  value = "";
  checked = false;
  required = false;
  multiple = false;
  maxLength = -1;
  min = "";
  max = "";
  step = "";
  scope = "";
  ready?: Promise<void>;
  accept = "";
  files: Array<{ name: string; size: number }> = [];
  private text = "";
  constructor(tagName: string, ownerDocument: TestDocument) {
    this.tagName = tagName.toUpperCase();
    this.nodeName = this.tagName;
    this.ownerDocument = ownerDocument;
  }
  get children(): TestNode[] { return this.childNodes.filter(child => child.nodeType === 1); }
  get cells(): TestNode[] { return this.children.filter(child => child.tagName === "TD" || child.tagName === "TH"); }
  get id(): string { return this.getAttribute("id") ?? ""; }
  set id(value: string) { this.setAttribute("id", value); }
  get href(): string { return this.getAttribute("href") ?? ""; }
  set href(value: string) { this.setAttribute("href", value); }
  get disabled(): boolean { return this.hasAttribute("disabled"); }
  set disabled(value: boolean) { if (value) this.setAttribute("disabled", ""); else this.removeAttribute("disabled"); }
  get hidden(): boolean { return this.hasAttribute("hidden"); }
  set hidden(value: boolean) { if (value) this.setAttribute("hidden", ""); else this.removeAttribute("hidden"); }
  get selected(): boolean { return this.hasAttribute("selected"); }
  set selected(value: boolean) { if (value) this.setAttribute("selected", ""); else this.removeAttribute("selected"); }
  get textContent(): string { return this.text + this.childNodes.map(child => child.textContent).join(""); }
  set textContent(value: string) { this.text = String(value); this.replaceChildren(); }
  setAttribute(name: string, value: string): void { this.attrs.set(name, value); }
  getAttribute(name: string): string | null { return this.attrs.get(name) ?? null; }
  hasAttribute(name: string): boolean { return this.attrs.has(name); }
  removeAttribute(name: string): void { this.attrs.delete(name); }
  append(...nodes: TestNode[]): void { for (const node of nodes) this.attach(node, false); }
  prepend(...nodes: TestNode[]): void { for (const node of [...nodes].reverse()) this.attach(node, true); }
  replaceChildren(...nodes: TestNode[]): void {
    for (const child of this.childNodes) { child.parentNode = null; child.setConnected(false); }
    this.childNodes.length = 0;
    for (const node of nodes) this.attach(node, false);
  }
  private setConnected(connected: boolean): void {
    this.isConnected = connected;
    for (const child of this.childNodes) child.setConnected(connected);
  }
  private attach(node: TestNode, first: boolean): void {
    node.parentNode?.childNodes.splice(node.parentNode.childNodes.indexOf(node), 1);
    node.parentNode = this;
    node.setConnected(this.isConnected);
    if (first) this.childNodes.unshift(node); else this.childNodes.push(node);
  }
  matches(selector: string): boolean {
    const parts = selector.trim().split(/\s+/);
    const simple = (node: TestNode, value: string): boolean => {
      const match = /^(?:([a-z][a-z0-9-]*))?(?:\[([a-z0-9-]+)(?:=["']([^"']*)["'])?\])?$/i.exec(value);
      return Boolean(match && (!match[1] || node.tagName.toLowerCase() === match[1].toLowerCase()) &&
        (!match[2] || (match[3] === undefined ? node.hasAttribute(match[2]) : node.getAttribute(match[2]) === match[3])));
    };
    if (!simple(this, parts.at(-1)!)) return false;
    let ancestor = this.parentNode;
    for (let index = parts.length - 2; index >= 0; index--) {
      while (ancestor && !simple(ancestor, parts[index]!)) ancestor = ancestor.parentNode;
      if (!ancestor) return false;
      ancestor = ancestor.parentNode;
    }
    return true;
  }
  closest(selector: string): TestNode | null {
    for (let node: TestNode | null = this; node; node = node.parentNode) if (node.matches(selector)) return node;
    return null;
  }
  querySelectorAll(selector: string): TestNode[] {
    const selectors = selector.split(",").map(value => value.trim());
    return this.childNodes.flatMap(child => [
      ...(selectors.some(value => child.matches(value)) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);
  }
  querySelector(selector: string): TestNode | null { return this.querySelectorAll(selector)[0] ?? null; }
  addEventListener(type: string, listener: (event: TestEvent) => void): void {
    const handlers = this.listeners.get(type) ?? new Set<(event: TestEvent) => void>();
    handlers.add(listener);
    this.listeners.set(type, handlers);
  }
  removeEventListener(type: string, listener: (event: TestEvent) => void): void { this.listeners.get(type)?.delete(listener); }
  dispatchEvent(event: TestEvent): boolean {
    event.target ??= this;
    event.currentTarget = this;
    for (const listener of this.listeners.get(event.type) ?? []) listener.call(this, event);
    return !event.defaultPrevented;
  }
  remove(): void {
    if (this.parentNode) this.parentNode.childNodes.splice(this.parentNode.childNodes.indexOf(this), 1);
    this.parentNode = null;
    this.setConnected(false);
  }
  focus(): void { this.ownerDocument.activeElement = this; }
}

class TestDocument extends TestNode {
  readonly body = new TestNode("body", this);
  readonly readyState = "complete";
  activeElement: TestNode | null = null;
  constructor() { super("#document", null as unknown as TestDocument); this.ownerDocument = this; this.isConnected = true; this.body.isConnected = true; this.body.setAttribute("lang", "en"); this.append(this.body); }
  createElement(tagName: string): TestNode { return new TestNode(tagName, this); }
  createElementNS(_namespace: string, tagName: string): TestNode { return this.createElement(tagName); }
  getElementById(id: string): TestNode | null { return this.querySelectorAll("[id]").find(node => node.id === id) ?? null; }
  addEventListener(): void {}
  removeEventListener(): void {}
  get documentElement(): TestNode { return this.body; }
}

class TestFormData implements Iterable<[string, string | { name: string; size: number }]> {
  readonly values: Array<[string, string | { name: string; size: number }]> = [];
  constructor(form: TestNode) {
    for (const control of form.querySelectorAll("input,select,textarea")) {
      if (!control.name || control.disabled) continue;
      if (control.type === "checkbox") {
        if (control.checked) this.values.push([control.name, control.value || "on"]);
      } else if (control.type === "file") {
        if (control.files.length) for (const file of control.files) this.values.push([control.name, file]);
        else this.values.push([control.name, { name: "", size: 0 }]);
      } else if (control.tagName === "SELECT" && control.multiple) {
        for (const option of control.querySelectorAll("option")) if (option.selected) this.values.push([control.name, option.value]);
      } else this.values.push([control.name, control.value]);
    }
  }
  [Symbol.iterator](): Iterator<[string, string | { name: string; size: number }]> { return this.values[Symbol.iterator](); }
}

type ComponentConstructor = new () => TestNode;

function runtimeDocument(artefacts?: Record<string, unknown>, lang = "en") {
  const document = new TestDocument();
  document.body.setAttribute("lang", lang);
  const registry = new Map<string, ComponentConstructor>();
  class HTMLElement extends TestNode {
    constructor() { super("", document); }
  }
  const customElements = {
    define: (name: string, constructor: ComponentConstructor): void => { registry.set(name, constructor); },
    get: (name: string) => registry.get(name),
  };
  const mutationObservers: Array<() => void> = [];
  class MutationObserver { constructor(callback: () => void) { mutationObservers.push(callback); } observe(): void {} disconnect(): void {} }
  const pageKit: Record<string, unknown> = {};
  const window: Record<string, unknown> = { __a67PageKit: pageKit };
  if (artefacts) window.artefacts = artefacts;
  new Function("window", "document", "customElements", "HTMLElement", "MutationObserver", "FormData", PAGE_KIT_RUNTIME)(
    window, document, customElements, HTMLElement, MutationObserver, TestFormData,
  );
  const make = (name: string, attrs: Record<string, string> = {}, children: TestNode[] = []): TestNode => {
    const Constructor = registry.get(name)!;
    const element = new Constructor();
    element.tagName = name.toUpperCase();
    element.nodeName = element.tagName;
    for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
    element.append(...children);
    document.body.append(element);
    // The fixture observes the lifecycle promise; browsers intentionally ignore custom-element return values.
    const customElement = element as TestNode & { connectedCallback?: () => void | Promise<void>; ready?: Promise<void> };
    const pending = customElement.connectedCallback?.();
    if (pending instanceof Promise) customElement.ready = pending;
    return element;
  };
  return { document, registry, make, window, pageKit, triggerMutation: () => mutationObservers.forEach(callback => callback()) };
}

function textNode(document: TestDocument, value: string): TestNode {
  const node = new TestNode("#text", document);
  node.tagName = "";
  node.nodeName = "#text";
  node.nodeType = 3;
  node.textContent = value;
  return node;
}

test("runtime builds a TOC through whitespace and preserves its authored label", () => {
  const { document, make } = runtimeDocument();
  const heading = document.createElement("h2");
  heading.id = "overview";
  heading.textContent = "Overview";
  document.body.append(heading);
  const toc = make("a67-toc", { label: "Contents" }, [textNode(document, "\n  ")]);
  assert.equal(toc.querySelector("nav")?.getAttribute("aria-label"), "Contents");
  assert.equal(toc.querySelector("a")?.getAttribute("href"), "#overview");
  assert.equal(toc.querySelector("a")?.textContent, "Overview");
});

test("runtime scopes tabs, skips disabled tabs, and preserves literal KPI values", () => {
  const { document, registry, make } = runtimeDocument();
  const tablist = document.createElement("div");
  tablist.setAttribute("role", "tablist");
  const tab = (id: string, panel: string, selected: boolean, disabled = false): TestNode => {
    const button = document.createElement("button");
    button.id = id;
    button.setAttribute("role", "tab");
    button.setAttribute("aria-controls", panel);
    button.setAttribute("aria-selected", String(selected));
    if (disabled) button.setAttribute("disabled", "");
    return button;
  };
  const one = tab("one", "panel-one", true);
  const disabled = tab("disabled", "panel-disabled", false, true);
  const three = tab("three", "panel-three", false);
  tablist.append(one, disabled, three);
  const panel = (id: string, hidden: boolean): TestNode => {
    const element = document.createElement("section");
    element.id = id;
    element.setAttribute("role", "tabpanel");
    if (hidden) element.setAttribute("hidden", "");
    return element;
  };
  const firstPanel = panel("panel-one", false);
  const disabledPanel = panel("panel-disabled", true);
  const thirdPanel = panel("panel-three", true);
  const innerTablist = document.createElement("div");
  innerTablist.setAttribute("role", "tablist");
  const innerTab = tab("inner-tab", "inner-panel", true);
  innerTablist.append(innerTab);
  const innerPanel = panel("inner-panel", false);
  const inner = new (registry.get("a67-tabs")!)();
  inner.tagName = "A67-TABS";
  inner.append(innerTablist, innerPanel);
  thirdPanel.append(inner);
  const outer = new (registry.get("a67-tabs")!)();
  outer.tagName = "A67-TABS";
  outer.append(tablist, firstPanel, disabledPanel, thirdPanel);
  document.body.append(outer);
  (inner as TestNode & { connectedCallback?: () => void }).connectedCallback?.();
  (outer as TestNode & { connectedCallback?: () => void }).connectedCallback?.();

  const outerController = outer as TestNode & {
    onKeydown: (event: { target: TestNode; key: string; preventDefault(): void }) => void;
    onClick: (event: { target: TestNode }) => void;
  };
  const keydown = (target: TestNode, key: string) => {
    let prevented = false;
    outerController.onKeydown({ target, key, preventDefault: () => { prevented = true; } });
    return prevented;
  };
  assert.equal(keydown(one, "ArrowRight"), true);
  assert.equal(three.getAttribute("aria-selected"), "true");
  assert.equal(disabled.getAttribute("tabindex"), "-1");
  assert.equal(thirdPanel.hidden, false);
  assert.equal(keydown(innerTab, "ArrowRight"), false);
  outerController.onClick({ target: innerTab });
  assert.equal(three.getAttribute("aria-selected"), "true");


  const kpi = make("a67-kpi", { label: "Revenue", value: "$12m", delta: "+2%", trend: "up" });
  assert.equal(kpi.querySelector('[role="group"]')?.getAttribute("aria-label"), "Revenue");
  assert.equal(kpi.querySelector("[data-a67-kpi-value]")?.textContent, "$12m");
  assert.equal(kpi.querySelector("[data-a67-kpi-delta]")?.textContent, "Increase: +2%");
});

test("runtime pairs reordered tab panels by their aria-controls IDs", () => {
  const { document, registry } = runtimeDocument();
  const tablist = document.createElement("div");
  tablist.setAttribute("role", "tablist");
  const button = (id: string, panel: string, selected: boolean): TestNode => {
    const element = document.createElement("button");
    element.id = id;
    element.setAttribute("role", "tab");
    element.setAttribute("aria-controls", panel);
    element.setAttribute("aria-selected", String(selected));
    return element;
  };
  const tabA = button("tab-a", "panel-a", true);
  const tabB = button("tab-b", "panel-b", false);
  tablist.append(tabA, tabB);
  const panel = (id: string, hidden: boolean): TestNode => {
    const element = document.createElement("section");
    element.id = id;
    element.setAttribute("role", "tabpanel");
    if (hidden) element.setAttribute("hidden", "");
    return element;
  };
  const panelB = panel("panel-b", true);
  const panelA = panel("panel-a", false);
  const tabs = new (registry.get("a67-tabs")!)();
  tabs.tagName = "A67-TABS";
  tabs.append(tablist, panelB, panelA);
  document.body.append(tabs);
  (tabs as TestNode & { connectedCallback?: () => void }).connectedCallback?.();

  assert.equal(tabA.getAttribute("aria-selected"), "true");
  assert.equal(panelA.hidden, false);
  assert.equal(panelB.hidden, true);
  const controller = tabs as TestNode & {
    onKeydown: (event: { target: TestNode; key: string; preventDefault(): void }) => void;
  };
  controller.onKeydown({ target: tabA, key: "ArrowRight", preventDefault() {} });
  assert.equal(tabB.getAttribute("aria-selected"), "true");
  assert.equal(panelB.hidden, false);
  assert.equal(panelA.hidden, true);
});

test("runtime renders accessible line and donut charts from visible tables and applies resolved logo data", () => {
  const { document, make, window } = runtimeDocument();
  const table = document.createElement("table");
  table.id = "metrics";
  const head = document.createElement("thead");
  const header = document.createElement("tr");
  for (const label of ["Month", "Value"]) {
    const cell = document.createElement("th");
    cell.textContent = label;
    header.append(cell);
  }
  head.append(header);
  const body = document.createElement("tbody");
  for (const [label, value] of [["Jan", "2"], ["Feb", "5"]]) {
    const row = document.createElement("tr");
    const heading = document.createElement("th");
    heading.textContent = label;
    const cell = document.createElement("td");
    cell.textContent = value;
    row.append(heading, cell);
    body.append(row);
  }
  table.append(head, body);
  document.body.append(table);
  const attrs = { for: "metrics", "label-column": "Month", "value-column": "Value", title: "Monthly values" };
  const line = make("a67-chart", { ...attrs, id: "line", type: "line" });
  const donut = make("a67-chart", { ...attrs, id: "donut", type: "donut" });
  const lineSvg = line.querySelector("svg")!;
  const donutSvg = donut.querySelector("svg")!;
  assert.ok(lineSvg.querySelector("polyline"));
  assert.equal(lineSvg.querySelector("desc")?.textContent, "Values from the visible data table: Jan, 2; Feb, 5.");
  assert.ok(line.querySelector("figcaption")?.textContent.includes("visible table"));
  assert.equal(donutSvg.querySelectorAll("circle").length, 2);
  assert.ok(Number(donutSvg.getAttribute("viewBox")!.split(" ")[3]) >= 176);

  const logo = make("a67-logo", { label: "Example" });
  assert.equal(logo.querySelectorAll("path").length, 2);
  assert.equal(logo.querySelector("svg")?.getAttribute("aria-label"), "Example");
  const pageKit = window.__a67PageKit;
  if (!pageKit || typeof pageKit !== "object" || !("configure" in pageKit) || typeof pageKit.configure !== "function")
    throw new Error("runtime exposes its trusted configuration hook");
  pageKit.configure({ logo: "data:image/png;base64,AA==" });
  assert.equal(logo.querySelector("image")?.getAttribute("href"), "data:image/png;base64,AA==");
  assert.equal(logo.querySelector("svg")?.getAttribute("aria-label"), "Example");
  pageKit.configure({ logo: "https://example.test/logo.png" });
  assert.equal(logo.querySelector("image"), null);
  assert.equal(logo.querySelectorAll("path").length, 2);
});
test("charts follow asynchronously loaded records tables and retain the visible table alternative", async () => {
  const sdk = { data: {
    schema: async () => ({ name: "sales", kind: "records", visitors: false, fields: { month: { type: "text" }, revenue: { type: "number" } } }),
    list: async () => ({ records: [
      { id: "jan", collection: "sales", version: 1, data: { month: "January", revenue: 2 } },
      { id: "feb", collection: "sales", version: 1, data: { month: "February", revenue: 5 } },
      { id: "mar", collection: "sales", version: 1, data: { month: "March" } },
      { id: "apr", collection: "sales", version: 1, data: { month: "April", revenue: 0 } },
    ], cursor: null }),
  } };
  const { make, triggerMutation } = runtimeDocument(sdk);
  const records = make("a67-records", { id: "sales-data", collection: "sales", fields: "month,revenue" });
  const chart = make("a67-chart", { for: "sales-data", type: "bar", title: "Sales", "label-column": "month", "value-column": "revenue" });
  await records.ready;
  triggerMutation();
  assert.equal(chart.querySelector("svg")?.getAttribute("role"), "img");
  assert.match(chart.textContent, /January/);
  const chartDescription = chart.querySelector("svg desc")?.textContent ?? "";
  assert.match(chartDescription, /April, 0/, "a present zero remains chart data");
  assert.doesNotMatch(chartDescription, /March/, "a missing numeric value is not converted to zero");
  const table = records.querySelector("table");
  assert.ok(table);
  assert.equal(table.hidden, false);
  const component = records as TestNode & { sort(name: string, heading: TestNode): void };
  component.sort("month", records.querySelector("th")!);
  triggerMutation();
  assert.match(chart.textContent, /February/);
  assert.equal(records.querySelector("table")?.hidden, false);
});

test("charts parse and render locale-formatted numeric cells", () => {
  const { document, make } = runtimeDocument(undefined, "hr-HR");
  const table = document.createElement("table");
  table.id = "locale-sales";
  const head = document.createElement("thead");
  const header = document.createElement("tr");
  const monthHeader = document.createElement("th"), revenueHeader = document.createElement("th");
  monthHeader.textContent = "Month";
  revenueHeader.textContent = "Revenue";
  header.append(monthHeader, revenueHeader);
  head.append(header);
  const body = document.createElement("tbody");
  const row = document.createElement("tr");
  const month = document.createElement("td"), revenue = document.createElement("td");
  month.textContent = "April";
  revenue.textContent = "1.234,5";
  row.append(month, revenue);
  body.append(row);
  table.append(head, body);
  document.body.append(table);
  const chart = make("a67-chart", { for: "locale-sales", type: "bar", title: "Sales", "label-column": "Month", "value-column": "Revenue" });
  assert.match(chart.querySelector("svg desc")?.textContent ?? "", /April, 1234\.5/);
  assert.equal(parseLocalizedNumber("1.234,5", "hr-HR"), 1234.5);
  assert.equal(parseLocalizedNumber("1.234,5", "en-US"), null);
});
test("page kit registers each data-bound element alongside interactive components", () => {
  const { registry } = runtimeDocument();
  for (const name of ["a67-form", "a67-checklist", "a67-records", "a67-kpi"]) {
    assert.ok(registry.has(name), `${name} is registered`);
  }
});
test("bound forms use schema constraints and keep values after validation errors", async () => {
  const sdk = {
    data: {
      schema: async () => ({ name: "rsvp", kind: "responses", visitors: true, fields: {
        email: { type: "email", required: true },
        choice: { type: "choice", options: ["yes", "no"], required: true },
        title: { type: "text", maxLength: 40 },
        amount: { type: "number", min: 0.5, max: 5.5, integer: true },
        attachment: { type: "file", accept: [".pdf"], multiple: true, maxBytes: 4096 },
      } }),
      submit: async () => { throw Object.assign(new Error("Invalid response."), { code: "validation", issues: [{ field: "email", message: "Enter a valid email." }] }); },
    },
  };
  const { document, make } = runtimeDocument(sdk);
  const authoredErrorId = document.createElement("p");
  authoredErrorId.id = "a67-field-error-1";
  document.body.append(authoredErrorId);
  const descriptor = document.createElement("label");
  descriptor.setAttribute("data-field", "email");
  descriptor.setAttribute("label", "Contact address");
  const choiceDescriptor = document.createElement("label");
  choiceDescriptor.setAttribute("data-field", "choice");
  choiceDescriptor.setAttribute("label", "Attendance");
  const textDescriptor = document.createElement("label");
  textDescriptor.setAttribute("data-field", "title");
  const numberDescriptor = document.createElement("label");
  numberDescriptor.setAttribute("data-field", "amount");
  const fileDescriptor = document.createElement("label");
  fileDescriptor.setAttribute("data-field", "attachment");
  const formElement = make("a67-form", { collection: "rsvp", "submit-label": "Send response" }, [descriptor, choiceDescriptor, textDescriptor, numberDescriptor, fileDescriptor]);
  assert.equal(formElement.querySelector('[role="status"]')?.dataset.state, "loading");
  await formElement.ready;
  const component = formElement as TestNode & { form: TestNode; onSubmit(event: TestEvent): Promise<void> };
  const input = component.form.querySelector('[name="email"]')!;
  assert.equal(formElement.querySelector('[role="status"]')?.dataset.state, "ready");
  assert.equal(input.type, "email");
  assert.equal(input.required, true);
  const choice = component.form.querySelector('[name="choice"]')!;
  const title = component.form.querySelector('[name="title"]')!;
  const amount = component.form.querySelector('[name="amount"]')!;
  const attachment = component.form.querySelector('[name="attachment"]')!;
  assert.equal(choice.multiple, false);
  assert.equal(choice.required, true);
  assert.deepEqual(choice.querySelectorAll("option").map(option => option.value), ["", "yes", "no"]);
  assert.equal(choice.querySelector("option")?.selected, true);
  assert.equal(title.maxLength, 40);
  assert.deepEqual([amount.min, amount.max, amount.step], ["1", "5", "1"]);
  assert.notEqual(component.form.querySelector('[data-field-error="email"]')?.id, authoredErrorId.id);
  assert.deepEqual([attachment.accept, attachment.multiple], [".pdf", true]);
  assert.equal(attachment.getAttribute("data-max-bytes"), "4096");
  assert.equal(component.form.querySelector("label span")?.textContent, "Contact address");
  input.value = "ana@example.test";
  await component.onSubmit({ type: "submit", currentTarget: component.form, preventDefault() {} });
  assert.equal(input.value, "ana@example.test");
  assert.equal(input.getAttribute("aria-invalid"), "true");
  const fieldError = component.form.querySelector('[data-field-error="email"]')!;
  assert.equal(input.getAttribute("aria-describedby"), fieldError.id);
  assert.equal(fieldError.textContent, "Enter a valid email.");
  assert.equal(formElement.querySelector('[role="alert"]')?.textContent, "email: Enter a valid email.");
});

test("bound form exposes native controls to SDK serialization before disabling them", async () => {
  let controlsEnabledAtSubmit = false;
  const sdk = { data: {
    schema: async () => ({ name: "rsvp", kind: "responses", visitors: true, fields: { email: { type: "email", required: true } } }),
    submit: async (_collection: string, form: TestNode) => {
      controlsEnabledAtSubmit = !form.querySelector('[name="email"]')?.disabled;
    },
  } };
  const { make } = runtimeDocument(sdk);
  const element = make("a67-form", { collection: "rsvp" });
  await element.ready;
  const component = element as TestNode & { form: TestNode; onSubmit(event: TestEvent): Promise<void> };
  component.form.querySelector('[name="email"]')!.value = "ana@example.test";

  await component.onSubmit({ type: "submit", currentTarget: component.form, preventDefault() {} });

  assert.equal(controlsEnabledAtSubmit, true, "the SDK must serialize successful controls before the component disables them");
});

test("standalone and forbidden forms fail accessibly without rendering a pretend submit form", async () => {
  const { make } = runtimeDocument();
  const form = make("a67-form", { collection: "responses" });
  assert.equal(form.querySelector('[role="status"]')?.dataset.state, "loading");
  await form.ready;
  assert.equal(form.querySelector('[role="alert"]')?.dataset.state, "error");
  assert.match(form.querySelector('[role="alert"]')?.textContent ?? "", /hosted viewer/i);
  assert.equal(form.querySelector("form"), null);

  const deniedRuntime = runtimeDocument({ data: {
    schema: async () => { throw Object.assign(new Error("Denied"), { code: "forbidden" }); },
  } });
  const denied = deniedRuntime.make("a67-form", { collection: "responses" });
  await denied.ready;
  assert.equal(denied.querySelector('[role="alert"]')?.dataset.state, "forbidden");
  assert.equal(denied.querySelector("form"), null);
});

test("checklists expose empty, error, and forbidden states through scoped storage", async () => {
  const empty = runtimeDocument().make("a67-checklist", { "storage-key": "reading" });
  await empty.ready;
  assert.equal(empty.querySelector('[role="status"]')?.dataset.state, "empty");

  const brokenRuntime = runtimeDocument({ storage: {
    get: async () => { throw new Error("Storage unavailable."); },
  } });
  const brokenItem = brokenRuntime.document.createElement("span");
  brokenItem.setAttribute("data-item", "chapter-1");
  const broken = brokenRuntime.make("a67-checklist", { "storage-key": "reading" }, [brokenItem]);
  await broken.ready;
  assert.equal(broken.querySelector('[role="alert"]')?.dataset.state, "error");

  const deniedRuntime = runtimeDocument({ storage: {
    get: async () => { throw Object.assign(new Error("Denied"), { code: "forbidden" }); },
  } });
  const deniedItem = deniedRuntime.document.createElement("span");
  deniedItem.setAttribute("data-item", "chapter-1");
  const denied = deniedRuntime.make("a67-checklist", { "storage-key": "reading" }, [deniedItem]);
  await denied.ready;
  assert.equal(denied.querySelector('[role="alert"]')?.dataset.state, "forbidden");
  assert.equal(denied.querySelector("input")?.disabled, true);
});

test("checklists use the requested storage scope and label a temporary fallback", async () => {
  const calls: Array<{ method: string; key: string; scope: string; value?: unknown }> = [];
  const sdk = { storage: {
    get: async (key: string, options: { scope: string }) => {
      calls.push({ method: "get", key, scope: options.scope });
      return ["chapter-1"];
    },
    set: async (key: string, value: unknown, options: { scope: string }) => {
      calls.push({ method: "set", key, scope: options.scope, value });
    },
  } };
  const { document, make } = runtimeDocument({ storage: sdk.storage });
  const item = document.createElement("span");
  item.setAttribute("data-item", "chapter-1");
  item.textContent = "Read chapter one";
  const checklist = make("a67-checklist", { "storage-key": "reading", "storage-scope": "shared" }, [item]);
  await checklist.ready;
  assert.deepEqual(calls[0], { method: "get", key: "reading", scope: "shared" });
  assert.equal(checklist.querySelector("input")?.checked, true);
  const component = checklist as TestNode & { save(key: string, checked: boolean): Promise<void> };
  await component.save("chapter-1", false);
  assert.deepEqual(calls[1], { method: "set", key: "reading", scope: "shared", value: [] });
  assert.match(checklist.querySelector('[role="status"]')?.textContent ?? "", /saved/i);

  const standaloneDocument = runtimeDocument();
  const standaloneItem = standaloneDocument.document.createElement("span");
  standaloneItem.setAttribute("data-item", "chapter-1");
  standaloneItem.textContent = "Read chapter one";
  const standalone = standaloneDocument.make("a67-checklist", { "storage-key": "reading" }, [standaloneItem]);
  await standalone.ready;
  assert.match(standalone.querySelector('[role="status"]')?.textContent ?? "", /session-only.*not saved/i);
});

test("record edits preserve repeated fields, explicit false booleans, and existing files", async () => {
  const record = { id: "one", collection: "sales", version: 4, data: {
    title: "Old title", enabled: true, tags: ["alpha", "beta"], attachments: [{ id: "old", name: "old.pdf", type: "application/pdf", size: 2 }], hidden: "preserved",
  } };
  let submitted: Record<string, unknown> | undefined;
  const sdk = { data: {
    schema: async () => ({ name: "sales", kind: "records", visitors: true, fields: {
      title: { type: "text", required: true }, enabled: { type: "boolean" },
      tags: { type: "choice", multiple: true, options: ["alpha", "beta", "gamma"] },
      attachments: { type: "file", multiple: true, required: true, maxBytes: 4096 },
    } }),
    list: async () => ({ records: [record], cursor: null }),
    get: async () => record,
    update: async (_collection: string, _id: string, data: Record<string, unknown>) => { submitted = data; return record; },
  } };
  const { make, pageKit } = runtimeDocument(sdk);
  pageKit.canWriteRecords = true;
  const records = make("a67-records", { collection: "sales", fields: "title,enabled,tags,attachments", editable: "" });
  await records.ready;
  const component = records as TestNode & { edit(id: string): Promise<void>; save(event: TestEvent, id: string, version: number): Promise<void>; editor: TestNode };
  await component.edit("one");
  const tags = component.editor.querySelector('[name="tags"]')!;
  assert.deepEqual(tags.querySelectorAll("option").filter(option => option.selected).map(option => option.value), ["alpha", "beta"]);
  const attachment = component.editor.querySelector('[name="attachments"]')!;
  assert.equal(attachment.required, false, "an existing required attachment satisfies the native control");
  assert.match(component.editor.textContent, /old\.pdf/);
  for (const option of tags.querySelectorAll("option")) option.selected = option.value === "alpha" || option.value === "gamma";
  component.editor.querySelector('[name="title"]')!.value = "New title";
  component.editor.querySelector('[name="enabled"]')!.checked = false;
  attachment.files = [{ name: "new-one.pdf", size: 3 }, { name: "new-two.pdf", size: 5 }];

  await component.save({ type: "submit", currentTarget: component.editor, preventDefault() {} }, "one", 4);

  assert.ok(submitted);
  assert.deepEqual(Object.fromEntries(Object.entries(submitted)), {
    title: "New title", enabled: false, tags: ["alpha", "gamma"],
    attachments: [{ name: "new-one.pdf", size: 3 }, { name: "new-two.pdf", size: 5 }], hidden: "preserved",
  });
});

test("editable records require trusted viewer write authority", async () => {
  const sdk = { data: {
    schema: async () => ({ name: "sales", kind: "records", visitors: true, fields: { title: { type: "text" } } }),
    list: async () => ({ records: [{ id: "one", collection: "sales", version: 1, data: { title: "January" } }], cursor: null }),
  } };
  const { make, pageKit } = runtimeDocument(sdk);
  pageKit.canWriteRecords = false;
  const records = make("a67-records", { collection: "sales", editable: "" });
  await records.ready;
  assert.deepEqual(records.querySelectorAll("button").map(button => button.textContent), ["title"]);
});

test("record edit locks the table and discards stale concurrent get responses", async () => {
  const resolve: Record<string, (record: unknown) => void> = {};
  const sdk = { data: {
    schema: async () => ({ name: "sales", kind: "records", visitors: true, fields: { title: { type: "text" } } }),
    list: async () => ({ records: [{ id: "one", collection: "sales", version: 1, data: { title: "row" } }], cursor: null }),
    get: (_collection: string, id: string) => new Promise(resolveRecord => { resolve[id] = resolveRecord; }),
  } };
  const { make, pageKit } = runtimeDocument(sdk);
  pageKit.canWriteRecords = true;
  const records = make("a67-records", { collection: "sales", editable: "" });
  await records.ready;
  const component = records as TestNode & { edit(id: string): Promise<void>; editor: TestNode };
  const first = component.edit("first");
  assert.equal(records.querySelector('[data-a67-state]')?.dataset.state, "loading");
  assert.ok(records.querySelectorAll("button").every(button => button.disabled));
  const second = component.edit("second");
  resolve.second!({ id: "second", collection: "sales", version: 2, data: { title: "Second" } });
  await second;
  resolve.first!({ id: "first", collection: "sales", version: 1, data: { title: "First" } });
  await first;
  assert.equal(component.editor.querySelector('[name="title"]')?.value, "Second");
});

test("record deletion uses an in-document confirmation instead of a sandbox modal", async () => {
  let deletes = 0;
  const sdk = { data: {
    schema: async () => ({ name: "sales", kind: "records", visitors: true, fields: { title: { type: "text" } } }),
    get: async () => ({ id: "one", collection: "sales", version: 1, data: { title: "January" } }),
    list: async () => ({ records: [{ id: "one", collection: "sales", version: 1, data: { title: "January" } }], cursor: null }),
    delete: async () => { deletes++; },
  } };
  const { make, pageKit } = runtimeDocument(sdk);
  pageKit.canWriteRecords = true;
  const records = make("a67-records", { collection: "sales", editable: "" });
  await records.ready;
  const component = records as TestNode & { remove(id: string, version: number): void; edit(id: string): Promise<void> };
  await component.edit("one");
  component.remove("one", 1);
  const confirmation = records.querySelector('[role="alertdialog"]')!;
  assert.ok(confirmation);
  assert.equal(deletes, 0);
  confirmation.querySelectorAll("button").find(button => button.textContent === "Delete record")!.dispatchEvent({ type: "click" });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(deletes, 1);
});

test("switching record editors releases a detached deletion confirmation", async () => {
  const recordsList = [
    { id: "one", collection: "sales", version: 1, data: { title: "One" } },
    { id: "two", collection: "sales", version: 2, data: { title: "Two" } },
  ];
  const sdk = { data: {
    schema: async () => ({ name: "sales", kind: "records", visitors: true, fields: { title: { type: "text" } } }),
    get: async (_collection: string, id: string) => recordsList.find(record => record.id === id) ?? null,
    list: async () => ({ records: recordsList, cursor: null }),
  } };
  const { make, pageKit } = runtimeDocument(sdk);
  pageKit.canWriteRecords = true;
  const records = make("a67-records", { collection: "sales", editable: "" });
  await records.ready;
  const component = records as TestNode & { remove(id: string, version: number): void; edit(id: string): Promise<void>; editor: TestNode };
  await component.edit("one");
  component.remove("one", 1);
  assert.ok(component.editor.querySelector('[role="alertdialog"]'));
  await component.edit("two");
  component.remove("two", 2);
  assert.ok(component.editor.querySelector('[role="alertdialog"]'), "a confirmation can be opened for the newly edited record");
});
test("records render array fields and expose sort state on printable column headers", async () => {
  const sdk = { data: {
    schema: async () => ({ name: "sales", kind: "records", visitors: true, fields: {
      tags: { type: "choice", multiple: true, options: ["a", "b"] },
      files: { type: "file", multiple: true },
    } }),
    list: async () => ({ records: [{ id: "one", collection: "sales", version: 1, data: {
      tags: ["a", "b"], files: [{ id: "f1", name: "report.pdf", type: "application/pdf", size: 10 }, { id: "f2", name: "notes.csv", type: "text/csv", size: 20 }],
    } }], cursor: null }),
  } };
  const { make } = runtimeDocument(sdk);
  const records = make("a67-records", { collection: "sales", fields: "tags,files" });
  await records.ready;
  assert.deepEqual(records.querySelector("tbody tr")!.cells.map(cell => cell.textContent), ["a, b", "report.pdf, notes.csv"]);
  const heading = records.querySelectorAll("thead th")[0]!;
  const sorter = heading.querySelector("button")!;
  sorter.dispatchEvent({ type: "click" });
  assert.equal(records.querySelectorAll("thead th")[0]?.getAttribute("aria-sort"), "ascending");
  assert.equal(records.querySelector("thead button")?.getAttribute("aria-sort"), null);
});

test("records apply initial numeric sort with absent values last and correct header state", async () => {
  const sdk = { data: {
    schema: async () => ({ name: "sales", kind: "records", visitors: true, fields: {
      amount: { type: "number" },
    } }),
    list: async () => ({ records: [
      { id: "positive-fraction-b", data: { amount: 1.2 } },
      { id: "negative-b", data: { amount: -2 } },
      { id: "missing", data: {} },
      { id: "negative-a", data: { amount: -10 } },
      { id: "positive-fraction-a", data: { amount: 1.11 } },
    ], cursor: null }),
  } };
  const { make } = runtimeDocument(sdk);
  const records = make("a67-records", { collection: "sales", fields: "amount", sort: "amount" });
  await records.ready;
  assert.deepEqual(records.querySelectorAll("tbody tr").map(row => row.dataset.recordId),
    ["negative-a", "negative-b", "positive-fraction-a", "positive-fraction-b", "missing"]);
  assert.equal(records.querySelector("thead th")?.getAttribute("aria-sort"), "ascending");
  const heading = records.querySelector("thead th")!;
  (heading.querySelector("button")!).dispatchEvent({ type: "click" });
  assert.deepEqual(records.querySelectorAll("tbody tr").map(row => row.dataset.recordId),
    ["positive-fraction-b", "positive-fraction-a", "negative-b", "negative-a", "missing"]);
});
test("records preserve authored initial ordering and header state on reload", async () => {
  let current = [{ id: "a", data: { amount: 1 } }, { id: "b", data: { amount: 2 } }];
  const sdk = { data: {
    schema: async () => ({ name: "sales", kind: "records", visitors: true, fields: { amount: { type: "number" } } }),
    list: async () => ({ records: current }),
  } };
  const { make } = runtimeDocument(sdk);
  const records = make("a67-records", { collection: "sales", fields: "amount", sort: "amount" });
  await records.ready;
  (records.querySelector("thead button")!).dispatchEvent({ type: "click" });
  assert.deepEqual(records.querySelectorAll("tbody tr").map(row => row.dataset.recordId), ["b", "a"]);
  current = [{ id: "c", data: { amount: 0 } }, { id: "d", data: { amount: 4 } }];
  await (records as TestNode & { load(): Promise<void> }).load();
  assert.deepEqual(records.querySelectorAll("tbody tr").map(row => row.dataset.recordId), ["c", "d"]);
  assert.equal(records.querySelector("thead th")?.getAttribute("aria-sort"), "ascending");
});

test("generated numeric record cells chart machine values in hr-HR", async () => {
  const sdk = { data: {
    schema: async () => ({ name: "sales", kind: "records", visitors: true, fields: {
      month: { type: "text" }, amount: { type: "number" },
    } }),
    list: async () => ({ records: [
      { id: "a", data: { month: "Jan", amount: 1.234 } },
      { id: "b", data: { month: "Feb", amount: 1.2 } },
    ] }),
  } };
  const { make, triggerMutation } = runtimeDocument(sdk, "hr-HR");
  const records = make("a67-records", { id: "records-numeric", collection: "sales", fields: "month,amount" });
  await records.ready;
  const chart = make("a67-chart", { for: "records-numeric", type: "bar", "label-column": "month", "value-column": "amount" });
  triggerMutation();
  assert.equal(records.querySelectorAll("tbody td")[1]?.getAttribute("data-value"), "1.234");
  assert.match(chart.querySelector("svg desc")?.textContent ?? "", /Jan, 1\.234; Feb, 1\.2/);
});

test("localized number parsing honors decimal and grouping separators", () => {
  assert.equal(parseLocalizedNumber("1.234,5", "hr-HR"), 1234.5);
  assert.equal(parseLocalizedNumber("-2,75", "hr-HR"), -2.75);
  assert.equal(parseLocalizedNumber("1,234.5", "en-US"), 1234.5);
  assert.equal(parseLocalizedNumber("1.234,5", "en-US"), null);
});

test("records render a semantic table and KPI aggregates every collection page with distinct states", async () => {
  const recordPages = [
    { records: [{ id: "one", collection: "sales", version: 1, data: { amount: 2, title: "Jan" } }], cursor: "next" },
    { records: [{ id: "two", collection: "sales", version: 1, data: { amount: 7, title: "Feb" } }], cursor: null },
  ];
  let pageIndex = 0;
  const schema = async () => ({ name: "sales", kind: "records", visitors: true, fields: {
    amount: { type: "number" }, title: { type: "text", required: true },
  } });
  const sdk = { data: {
    schema,
    list: async (_collection: string, options: { cursor?: string }) => {
      if (options.cursor) return recordPages[1];
      return recordPages[pageIndex++ % recordPages.length]!;
    },
  } };
  const { make } = runtimeDocument(sdk);
  const records = make("a67-records", { collection: "sales", fields: "title,amount", label: "Monthly sales" });
  assert.equal(records.querySelector('[role="status"]')?.dataset.state, "loading");
  await records.ready;
  assert.equal(records.querySelector('[role="status"]')?.dataset.state, "ready");
  assert.equal(records.querySelector("caption")?.textContent, "Monthly sales");
  assert.deepEqual(records.querySelectorAll("thead th").map(cell => cell.scope), ["col", "col"]);
  assert.equal(records.querySelectorAll("tbody tr").length, 2);

  pageIndex = 0;
  const kpi = make("a67-kpi", { label: "Revenue", collection: "sales", field: "amount", aggregate: "sum" });
  assert.equal(kpi.querySelector('[role="status"]')?.dataset.state, "loading");
  await kpi.ready;
  assert.equal(kpi.querySelector('[role="status"]')?.dataset.state, "ready");
  assert.equal(kpi.querySelector("[data-a67-kpi-value]")?.textContent, "9");

  const emptyRecords = runtimeDocument({ data: { schema, list: async () => ({ records: [], cursor: null }) } })
    .make("a67-records", { collection: "sales" });
  await emptyRecords.ready;
  assert.equal(emptyRecords.querySelector('[role="status"]')?.dataset.state, "empty");

  const failedRecordsRuntime = runtimeDocument({ data: {
    schema,
    list: async () => { throw new Error("Records unavailable."); },
  } });
  const failedRecords = failedRecordsRuntime.make("a67-records", { collection: "sales" });
  await failedRecords.ready;
  assert.equal(failedRecords.querySelector('[role="alert"]')?.dataset.state, "error");
  assert.equal(failedRecords.querySelector("table"), null);

  const emptyKpi = runtimeDocument({ data: { schema, list: async () => ({ records: [], cursor: null }) } })
    .make("a67-kpi", { label: "Revenue", collection: "sales", field: "amount", aggregate: "sum" });
  await emptyKpi.ready;
  assert.equal(emptyKpi.querySelector('[role="status"]')?.dataset.state, "empty");

  const failedKpi = runtimeDocument({ data: {
    schema: async () => { throw new Error("Schema unavailable."); },
    list: async () => ({ records: [], cursor: null }),
  } }).make("a67-kpi", { label: "Revenue", collection: "sales", field: "amount", aggregate: "sum" });
  await failedKpi.ready;
  assert.equal(failedKpi.querySelector('[role="alert"]')?.dataset.state, "error");

  const denied = runtimeDocument({ data: {
    schema: async () => { throw Object.assign(new Error("Denied"), { code: "forbidden" }); },
    list: async () => ({ records: [], cursor: null }),
  } }).make("a67-records", { collection: "private", fields: "title" });
  await denied.ready;
  assert.equal(denied.querySelector('[role="alert"]')?.dataset.state, "forbidden");
  assert.match(denied.querySelector('[role="alert"]')?.textContent ?? "", /access denied/i);

  const deniedKpi = runtimeDocument({ data: {
    schema: async () => { throw Object.assign(new Error("Denied"), { code: "forbidden" }); },
    list: async () => ({ records: [], cursor: null }),
  } }).make("a67-kpi", { label: "Revenue", collection: "private", field: "amount", aggregate: "sum" });
  await deniedKpi.ready;
  assert.equal(deniedKpi.querySelector('[role="alert"]')?.dataset.state, "forbidden");
});

test("page kit declares the approved cascade order and stays within the gzip budget", () => {
  const declarations = [...PAGE_KIT_CSS.matchAll(/@layer\s+([\w,\s-]+);/g)].map(match => match[1].split(",").map((name: string) => name.trim()));
  assert.deepEqual(declarations, [layers]);
  assert.ok(gzipSync(PAGE_KIT_CSS).byteLength <= 6_000, `kit CSS gzip is ${gzipSync(PAGE_KIT_CSS).byteLength} bytes`);
});

test("page kit provides all registered fallback tokens for both color schemes", () => {
  const defaults: Record<string, [string, string]> = {
    bg: ["#ffffff", "#141923"], surface: ["#ffffff", "#202938"], ink: ["#18202c", "#f3f5f8"],
    muted: ["#526173", "#bac4d1"], line: ["#778496", "#8390a1"], accent: ["#2457a7", "#b3caff"],
    "accent-ink": ["#17447f", "#d1deff"], "on-accent": ["#ffffff", "#121a29"],
    ok: ["#176b45", "#8cddb0"], warn: ["#795100", "#ffd078"], crit: ["#a42323", "#ffaaa3"],
    focus: ["#8b3d00", "#ffe08a"], c1: ["#155da8", "#a9d0ff"], c2: ["#8c3d79", "#f2b6e3"],
    c3: ["#267246", "#a2e3b9"], c4: ["#8a4b15", "#ffd08c"], c5: ["#58489b", "#c7b8ff"],
    c6: ["#087679", "#8fe2e3"],
  };
  const light = PAGE_KIT_CSS.match(/:root\s*\{([^}]*)\}/)?.[1] ?? "";
  const dark = PAGE_KIT_CSS.match(/\[data-theme=["']dark["']\]\s*\{([^}]*)\}/)?.[1] ?? "";
  assert.ok(light, "light fallback token block exists");
  assert.ok(dark, "dark fallback token block exists");
  const token = (block: string, name: string): string | undefined => block.match(new RegExp(`--a67-${name}:([^;]+)`))?.[1].trim();
  for (const [name, [lightValue, darkValue]] of Object.entries(defaults)) {
    assert.equal(token(light, name), lightValue, `light ${name}`);
    assert.equal(token(dark, name), darkValue, `dark ${name}`);
  }
  for (const [name, value] of Object.entries({ radius: "1rem", space: "1.15rem", density: "1", shadow: "0 12px 36px #1729441c", "section-gap": "3.4rem", "card-pad": "1.5rem", "heading-weight": "700", "font-heading": "system-ui,sans-serif", "font-body": "system-ui,sans-serif", "font-mono": "ui-monospace,monospace", "card-border": "1px solid var(--a67-line)", "table-head-bg": "var(--a67-surface)", "table-stripe": "color-mix(in srgb,var(--a67-muted) 6%,var(--a67-surface))", "section-rule": "1px solid var(--a67-line)" })) {
    assert.equal(token(light, name), value, `light ${name} fallback`);
    assert.equal(token(dark, name), value, `dark ${name} fallback`);
  }
});

test("page kit styles every semantic content and native interactive base element", () => {
  for (const selector of ["body", "h1", "h2", "h3", "h4", "h5", "h6", "p", "a", "strong", "em", "small", "mark", "hr", "blockquote", "figure", "figcaption", "img", "ul", "ol", "dl", "table", "caption", "th", "td", "pre", "code", "button", "input", "select", "details", "summary", "progress", "meter", "svg"]) {
    assert.match(PAGE_KIT_CSS, new RegExp(`(?:^|[,\\s])${selector.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\b`), `${selector} base style`);
  }
  assert.match(PAGE_KIT_CSS, /img\s*\{[^}]*max-width\s*:\s*100%[^}]*height\s*:\s*auto/s);
  assert.match(PAGE_KIT_CSS, /:focus-visible/);
});


test("density scales layout rhythm without changing control hit-target padding or text", () => {
  assert.match(PAGE_KIT_CSS, /gap:calc\(var\(--a67-space\) \* var\(--a67-density\)\)/);
  assert.match(PAGE_KIT_CSS, /padding:calc\(var\(--a67-card-pad\) \* var\(--a67-density\)\)/);
  assert.doesNotMatch(PAGE_KIT_CSS, /(?:font-size|line-height|button,input,select)\s*:[^;}]*var\(--a67-density\)/);
});

test("inverse sections coordinate opaque code and table surface palettes", () => {
  assert.match(PAGE_KIT_CSS, /\[data-tone="inverse"\] :is\(pre,thead\):not\(\[data-tone="inverse"\]\)\s*\{[^}]*background-color:var\(--a67-surface\); color:var\(--a67-ink\)/);
  assert.match(PAGE_KIT_CSS, /\[data-tone="inverse"\] tbody tr:nth-child\(even\):not\(\[data-tone="inverse"\]\)\s*\{[^}]*background-color:var\(--a67-table-stripe\); color:var\(--a67-ink\)/);
});
test("inverse content retains paired foregrounds on opaque table and code surfaces", () => {
  assert.match(PAGE_KIT_CSS, /\[data-tone="inverse"\] :is\(pre,thead\):not\(\[data-tone="inverse"\]\)\s*\{[^}]*background-color:var\(--a67-surface\); color:var\(--a67-ink\)/);
  assert.match(PAGE_KIT_CSS, /\[data-tone="inverse"\] tbody tr:nth-child\(even\):not\(\[data-tone="inverse"\]\)\s*\{[^}]*background-color:var\(--a67-table-stripe\); color:var\(--a67-ink\)/);
  assert.match(PAGE_KIT_CSS, /\[data-tone="inverse"\] :is\(h1,h2,h3,h4,h5,h6,a\)\s*\{[^}]*color:var\(--a67-on-accent\)/);
  assert.doesNotMatch(PAGE_KIT_CSS, /\[data-tone="inverse"\]\s+\[data-tone="inverse"\]/);
});
test("page kit has explicit fixed layouts and tone palettes for the validated allowlists", () => {
  assert.deepEqual([...new Set([...PAGE_KIT_CSS.matchAll(/\[data-variant="([^"]+)"\]/g)].map(match => match[1]))].sort(), [...variants].sort());
  assert.deepEqual([...new Set([...PAGE_KIT_CSS.matchAll(/\[data-tone="([^"]+)"\]/g)].map(match => match[1]))].sort(), [...tones].sort());
  assert.match(PAGE_KIT_CSS, /@media\s*\(max-width\s*:\s*[^)]+\)/);
  assert.match(PAGE_KIT_CSS, /grid-template-columns/);
  assert.match(PAGE_KIT_CSS, /overflow-wrap\s*:\s*anywhere/);
});

test("page kit preserves meaningful content in print and disables nonessential motion", () => {
  const print = PAGE_KIT_CSS.slice(PAGE_KIT_CSS.indexOf("@media print"));
  assert.ok(print.startsWith("@media print"));
  assert.match(print, /color\s*:\s*#000/);
  assert.match(print, /background\s*:\s*#fff/);
  assert.match(print, /visibility\s*:\s*visible/);
  assert.match(PAGE_KIT_CSS, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(PAGE_KIT_CSS, /scroll-behavior\s*:\s*auto/);
  assert.match(PAGE_KIT_CSS, /animation\s*:\s*none\s*!important/);
  assert.match(PAGE_KIT_CSS, /transition\s*:\s*none\s*!important/);
});
test("page kit opens closed disclosure content containers for print", () => {
  const print = PAGE_KIT_CSS.slice(PAGE_KIT_CSS.indexOf("@media print"));
  assert.match(print, /details:not\(\[open\]\)::details-content\s*\{[^}]*content-visibility\s*:\s*visible/s);
});
test("page kit reveals inactive tab panels in print", () => {
  const print = PAGE_KIT_CSS.slice(PAGE_KIT_CSS.indexOf("@media print"));
  assert.match(print, /a67-tabs \[role="tabpanel"\]\[hidden\]\s*\{\s*display:block !important/s);
});

test("inverse tone preserves its accent container palette and readable semantic descendants", () => {
  assert.match(PAGE_KIT_CSS, /\[data-tone="inverse"\]\s*\{[^}]*background\s*:\s*var\(--a67-accent\)[^}]*color\s*:\s*var\(--a67-on-accent\)/s);
  assert.match(PAGE_KIT_CSS, /\[data-tone="inverse"\]\s+\:is\(h1,h2,h3,h4,h5,h6,a\)\s*\{[^}]*color\s*:\s*var\(--a67-on-accent\)/s);
  for (const [theme, accent, onAccent] of [
    ["light", "#2457a7", "#ffffff"],
    ["dark", "#b3caff", "#121a29"],
  ]) {
    assert.ok(contrastRatio(accent, onAccent) >= 4.5, `${theme} inverse palette contrast`);
  }
});

function contrastRatio(background: string, foreground: string): number {
  const luminance = (hex: string): number => {
    const channels = hex.slice(1).match(/../g)!.map(channel => Number.parseInt(channel, 16) / 255);
    const [red, green, blue] = channels.map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    return 0.2126 * red! + 0.7152 * green! + 0.0722 * blue!;
  };
  const values = [luminance(background), luminance(foreground)].sort((a, b) => b - a);
  return (values[0]! + 0.05) / (values[1]! + 0.05);
}
test("inverse tone sets a contrast-safe foreground for semantic descendants in both schemes", () => {
  assert.match(PAGE_KIT_CSS, /\[data-tone="inverse"\]\s+\:is\(h1,h2,h3,h4,h5,h6,a\)\s*\{[^}]*color\s*:\s*var\(--a67-on-accent\)/s);
  for (const scheme of ["light", "dark"]) {
    const block = scheme === "light"
      ? PAGE_KIT_CSS.match(/:root\s*\{([^}]*)\}/)?.[1] ?? ""
      : PAGE_KIT_CSS.match(/:root\[data-theme="dark"\]\s*\{([^}]*)\}/)?.[1] ?? "";
    assert.match(block, /--a67-on-accent\s*:/, `${scheme} inverse foreground`);
  }
});

test("inverse tone keeps variant backgrounds readable for band and full-bleed layouts", () => {
  assert.match(PAGE_KIT_CSS, /\[data-tone="inverse"\]\[data-variant\]\s*\{[^}]*background\s*:\s*var\(--a67-accent\)/s);
});
test("page kit exposes the trusted runtime as an executable bundle", () => {
  assert.equal(EXPORTED_RUNTIME, PAGE_KIT_RUNTIME);
  assert.ok(gzipSync(PAGE_KIT_RUNTIME).byteLength <= 15_000, `kit runtime gzip is ${gzipSync(PAGE_KIT_RUNTIME).byteLength} bytes`);
});
test("visitor-share frames exclude record-write authority even for signed-in editors", async () => {
  const originalFetch = globalThis.fetch;
  const locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
  Object.defineProperty(globalThis, "location", { configurable: true, value: { origin: "https://example.test" } });
  globalThis.fetch = async () => new Response(JSON.stringify({ html: "<p>Reader</p>", runtime: { grant: "grant" } }), {
    status: 200, headers: { "Content-Type": "application/json" },
  });
  try {
    const share = await openArtifact({
      loadUrl: "/_runtime/load", runtime: { kind: "share", path: "app-one", token: "local" }, permissions: { write: true },
    });
    assert.equal(share.permissions.write, false);
    const console = await openArtifact({
      loadUrl: "/_runtime/load", runtime: { kind: "console", artifactId: "artifact" }, permissions: { write: true },
    });
    assert.equal(console.permissions.write, true);
  } finally {
    globalThis.fetch = originalFetch;
    if (locationDescriptor) Object.defineProperty(globalThis, "location", locationDescriptor);
    else Reflect.deleteProperty(globalThis, "location");
  }
});
test("opening fallback page accepts the checked compiled theme with retained unavailable identity", async () => {
  const originalFetch = globalThis.fetch;
  const locationDescriptor = Object.getOwnPropertyDescriptor(globalThis, "location");
  const fallback = PLATFORM_THEMES.find(theme => theme.slug === "report")!;
  Object.defineProperty(globalThis, "location", { configurable: true, value: { origin: "https://example.test" } });
  let selected = "unavailable";
  globalThis.fetch = async () => new Response(JSON.stringify({
    html: "<p>Reader</p>", runtime: { grant: "grant" },
    page: { type: "page", theme: { scope: "platform", slug: selected }, brandLock: false, compiledTheme: fallback },
  }), { status: 200, headers: { "Content-Type": "application/json" } });
  try {
    const opened = await openArtifact({ loadUrl: "/_runtime/load", runtime: { kind: "public", path: "app-one" }, permissions: { write: false } });
    assert.equal(opened.page?.theme?.slug, "unavailable");
    assert.equal(opened.page?.compiledTheme?.slug, "report");
    selected = "launch";
    await assert.rejects(
      openArtifact({ loadUrl: "/_runtime/load", runtime: { kind: "public", path: "app-one" }, permissions: { write: false } }),
      /mismatched page theme metadata/,
    );
  } finally {
    globalThis.fetch = originalFetch;
    if (locationDescriptor) Object.defineProperty(globalThis, "location", locationDescriptor);
    else Reflect.deleteProperty(globalThis, "location");
  }
});
