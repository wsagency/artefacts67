import { parseLocalizedNumber } from "./page-numbers.js";
import type { CompiledTheme } from "./theme-compiler.js";

/** Trusted inline bootstrap for the resolved, compiler-checked theme logo. */
export function themeConfigurationScript(theme: Pick<CompiledTheme, "logo">): string {
  const logo = JSON.stringify(theme.logo).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
  return `window.__a67PageKit.configure({logo:${logo}});`;
}

export const PAGE_KIT_CSS = String.raw`@layer kit, theme, recipes, artefact, object;
@layer kit {
:root {
  color-scheme: light dark;
  --a67-bg:#ffffff; --a67-surface:#ffffff; --a67-ink:#18202c; --a67-muted:#526173; --a67-line:#778496;
  --a67-accent:#2457a7; --a67-accent-ink:#17447f; --a67-on-accent:#ffffff;
  --a67-ok:#176b45; --a67-warn:#795100; --a67-crit:#a42323; --a67-focus:#8b3d00;
  --a67-c1:#155da8; --a67-c2:#8c3d79; --a67-c3:#267246; --a67-c4:#8a4b15; --a67-c5:#58489b; --a67-c6:#087679;
  --a67-font-heading:system-ui,sans-serif; --a67-font-body:system-ui,sans-serif; --a67-font-mono:ui-monospace,monospace;
  --a67-radius:1rem; --a67-space:1.15rem; --a67-density:1; --a67-shadow:0 12px 36px #1729441c;
  --a67-card-border:1px solid var(--a67-line); --a67-section-gap:3.4rem; --a67-card-pad:1.5rem;
  --a67-heading-weight:700; --a67-table-head-bg:var(--a67-surface);
  --a67-table-stripe:color-mix(in srgb,var(--a67-muted) 6%,var(--a67-surface)); --a67-section-rule:1px solid var(--a67-line);
  font-family:var(--a67-font-body); color:var(--a67-ink); background:var(--a67-bg);
  font-size:100%; line-height:1.6; text-size-adjust:100%;
}
:root[data-theme="dark"] {
  --a67-bg:#141923; --a67-surface:#202938; --a67-ink:#f3f5f8; --a67-muted:#bac4d1; --a67-line:#8390a1;
  --a67-accent:#b3caff; --a67-accent-ink:#d1deff; --a67-on-accent:#121a29;
  --a67-ok:#8cddb0; --a67-warn:#ffd078; --a67-crit:#ffaaa3; --a67-focus:#ffe08a;
  --a67-c1:#a9d0ff; --a67-c2:#f2b6e3; --a67-c3:#a2e3b9; --a67-c4:#ffd08c; --a67-c5:#c7b8ff; --a67-c6:#8fe2e3;
  --a67-font-heading:system-ui,sans-serif; --a67-font-body:system-ui,sans-serif; --a67-font-mono:ui-monospace,monospace;
  --a67-radius:1rem; --a67-space:1.15rem; --a67-density:1; --a67-shadow:0 12px 36px #1729441c;
  --a67-card-border:1px solid var(--a67-line); --a67-section-gap:3.4rem; --a67-card-pad:1.5rem;
  --a67-heading-weight:700; --a67-table-head-bg:var(--a67-surface);
  --a67-table-stripe:color-mix(in srgb,var(--a67-muted) 6%,var(--a67-surface)); --a67-section-rule:1px solid var(--a67-line);
}
*,*::before,*::after { box-sizing:border-box; }
html { scroll-behavior:smooth; }
body { max-width:76rem; margin:0 auto; padding:clamp(1rem,4vw,3rem); color:var(--a67-ink); background:var(--a67-bg); }
header,footer,main,nav,section,article,aside,figure,blockquote,table,fieldset { min-width:0; }
section,article { margin-block:calc(var(--a67-section-gap) * var(--a67-density)); }
h1,h2,h3,h4,h5,h6 { color:var(--a67-ink); font-family:var(--a67-font-heading); font-weight:var(--a67-heading-weight); line-height:1.2; text-wrap:balance; }
h1 { font-size:clamp(2rem,6vw,3.5rem); }
h2 { font-size:clamp(1.5rem,4vw,2.25rem); }
h3 { font-size:1.35rem; }
em,i { font-style:italic; }
p,li,dd,dt,figcaption,blockquote { max-width:72ch; }
a { color:var(--a67-accent-ink); text-decoration-thickness:.08em; text-underline-offset:.15em; }
a:hover { text-decoration-thickness:.14em; }
:focus-visible { outline:3px solid var(--a67-focus); outline-offset:3px; }
strong,b { font-weight:700; }
small { color:var(--a67-muted); }
mark { color:var(--a67-ink); background:color-mix(in srgb,var(--a67-warn) 32%,var(--a67-bg)); }
hr { border:0; border-top:var(--a67-section-rule); margin-block:calc(var(--a67-section-gap) * var(--a67-density)); }
blockquote { margin-inline:0; padding-inline:calc(1.25rem * var(--a67-density)); border-inline-start:4px solid var(--a67-accent); }
figure { margin:0; }
figcaption { color:var(--a67-muted); font-size:.9em; margin-block-start:calc(.5rem * var(--a67-density)); }
img { max-width:100%; height:auto; }
svg { max-width:100%; }
ul,ol { padding-inline-start:calc(1.5em * var(--a67-density)); }
dl { display:grid; grid-template-columns:minmax(8rem,1fr) 3fr; gap:calc(.35rem * var(--a67-density)) calc(1rem * var(--a67-density)); }
dt { font-weight:700; } dd { margin:0; }
table { width:100%; border-collapse:collapse; font-variant-numeric:tabular-nums; }
caption { text-align:start; font-weight:700; margin-block:calc(.5rem * var(--a67-density)); }
th,td { padding:.65rem .8rem; border:var(--a67-card-border); text-align:start; vertical-align:top; }
thead { background:var(--a67-table-head-bg); }
tbody tr:nth-child(even) { background:var(--a67-table-stripe); }
pre { max-width:100%; overflow:auto; padding:calc(var(--a67-card-pad) * var(--a67-density)); border:var(--a67-card-border); border-radius:var(--a67-radius); background:var(--a67-surface); font-family:var(--a67-font-mono); white-space:pre-wrap; overflow-wrap:anywhere; }
code,kbd,samp,var { font-family:var(--a67-font-mono); overflow-wrap:anywhere; }
button,input,select,progress,meter { max-width:100%; font:inherit; }
button,input,select { color:var(--a67-ink); background:var(--a67-surface); border:var(--a67-card-border); border-radius:.35rem; padding:.45em .7em; }
button { cursor:pointer; } button:disabled,input:disabled,select:disabled { cursor:not-allowed; opacity:.7; }
details { border-block:var(--a67-card-border); padding:.75rem 0; } summary { cursor:pointer; font-weight:700; }
[data-tone="accent"] { color:var(--a67-accent-ink); border-color:var(--a67-accent); }
[data-tone="muted"] { color:var(--a67-muted); }
[data-tone="inverse"] { background:var(--a67-accent); color:var(--a67-on-accent); }
[data-tone="inverse"] :is(h1,h2,h3,h4,h5,h6,a) { color:var(--a67-on-accent); }
[data-tone="inverse"] :is(pre,thead):not([data-tone="inverse"]) { background-color:var(--a67-surface); color:var(--a67-ink); }
[data-tone="inverse"] tbody tr:nth-child(even):not([data-tone="inverse"]) { background-color:var(--a67-table-stripe); color:var(--a67-ink); }
[data-tone="inverse"] :is(pre,thead,tbody tr:nth-child(even)):not([data-tone="inverse"]) :is(h1,h2,h3,h4,h5,h6) { color:var(--a67-ink); }
[data-tone="inverse"] :is(pre,thead,tbody tr:nth-child(even)):not([data-tone="inverse"]) a { color:var(--a67-accent-ink); }
[data-tone="info"] { color:var(--a67-accent-ink); border-color:var(--a67-accent); }
[data-tone="ok"] { color:var(--a67-ok); border-color:var(--a67-ok); }
[data-tone="warn"] { color:var(--a67-warn); border-color:var(--a67-warn); }
[data-tone="crit"] { color:var(--a67-crit); border-color:var(--a67-crit); }
[data-variant="hero"] { display:grid; grid-template-columns:minmax(0,1.4fr) minmax(14rem,.6fr); align-items:center; gap:calc(var(--a67-space) * var(--a67-density)); padding-block:calc(var(--a67-section-gap) * var(--a67-density)); }
[data-variant="band"] { padding:calc(var(--a67-card-pad) * var(--a67-density)); border-block:var(--a67-section-rule); background:var(--a67-surface); }
[data-variant="split"] { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); align-items:start; gap:calc(var(--a67-space) * var(--a67-density)); }
[data-variant="feature"] { display:grid; grid-template-columns:minmax(0,1fr) minmax(12rem,1fr); gap:calc(var(--a67-space) * var(--a67-density)); align-items:center; }
[data-variant="grid"] { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,15rem),1fr)); gap:calc(var(--a67-space) * var(--a67-density)); }
[data-variant="full-bleed"] { width:100%; margin-inline:0; padding:calc(var(--a67-card-pad) * var(--a67-density)); background:var(--a67-surface); }
[data-tone="inverse"][data-variant] { background:var(--a67-accent); }
[data-variant="timeline"] { border-inline-start:2px solid var(--a67-line); padding-inline-start:calc(var(--a67-space) * var(--a67-density)); }
[data-variant="steps"] { display:grid; grid-template-columns:repeat(auto-fit,minmax(min(100%,13rem),1fr)); gap:calc(var(--a67-space) * var(--a67-density)); counter-reset:a67-step; }
[data-variant="steps"] > * { min-width:0; }
[data-variant="steps"] > *::before { counter-increment:a67-step; content:counter(a67-step); display:grid; place-items:center; width:2rem; aspect-ratio:1; border-radius:50%; color:var(--a67-on-accent); background:var(--a67-accent); font-weight:700; }
@media (max-width:40rem) {
  body { padding:1rem; }
  [data-variant="hero"],[data-variant="split"],[data-variant="feature"] { grid-template-columns:minmax(0,1fr); }
  dl { grid-template-columns:minmax(0,1fr); }
  table { font-size:.9em; table-layout:fixed; }
  th,td { padding:.45rem; overflow-wrap:anywhere; }
}
@media (prefers-reduced-motion:reduce) {
  *,*::before,*::after { scroll-behavior:auto !important; animation:none !important; transition:none !important; }
}
@media print {
  :root,:root[data-theme="dark"] { color-scheme:light; --a67-bg:#fff; --a67-surface:#fff; --a67-ink:#000; --a67-muted:#333; --a67-line:#555; --a67-shadow:none; }
  *,*::before,*::after { color:#000 !important; background:#fff !important; box-shadow:none !important; text-shadow:none !important; }
  body { max-width:none; padding:0; }
  a { color:#000; text-decoration:underline; }
  button { display:none; }
  a67-records thead button { display:inline-block; }
  details:not([open])::details-content { content-visibility:visible; block-size:auto; }
  [hidden] { display:none !important; }
  a67-tabs [role="tabpanel"][hidden] { display:block !important; }
  img,svg,table,figure,blockquote,pre { break-inside:avoid; }
  table { border-collapse:collapse; }
  th,td { border:1px solid #555; }
  nav,main,section,article,aside,footer { visibility:visible; }
}
}
@layer theme {}
@layer recipes {}
@layer artefact {}
@layer kit {
  a67-toc nav { border:1px solid var(--a67-line); border-radius:var(--a67-radius); padding:var(--a67-card-pad); }
  a67-toc ul { margin:0; }
  a67-toc li { margin-block:.35rem; }
  a67-tabs [role="tablist"] { display:flex; flex-wrap:wrap; gap:.25rem; border-bottom:1px solid var(--a67-line); }
  a67-tabs [role="tab"][aria-selected="true"] { border-bottom:3px solid var(--a67-accent); font-weight:700; }
  a67-tabs [role="tabpanel"] { padding-block:var(--a67-card-pad); }
  a67-kpi [data-a67-kpi-value] { display:block; font-size:2rem; font-weight:700; }
  a67-kpi [data-a67-kpi-delta] { display:inline-flex; gap:.4em; color:var(--a67-muted); }
  a67-chart svg { display:block; width:100%; height:auto; overflow:visible; }
  a67-chart [data-a67-chart-label] { fill:var(--a67-ink); font:14px var(--a67-font-body); }
  a67-chart [data-a67-chart-shape] { fill:var(--a67-c1); }
  a67-chart [data-a67-chart-shape="1"] { fill:var(--a67-c2); }
  a67-chart [data-a67-chart-shape="2"] { fill:var(--a67-c3); }
  a67-chart [data-a67-chart-shape="3"] { fill:var(--a67-c4); }
  a67-chart [data-a67-chart-shape="4"] { fill:var(--a67-c5); }
  a67-chart [data-a67-chart-shape="5"] { fill:var(--a67-c6); }
  a67-logo svg { display:block; width:min(100%,12rem); height:auto; }
}
@layer object {}`;

export const PAGE_KIT_RUNTIME = String.raw`(() => { const parseLocalizedNumber = ${parseLocalizedNumber.toString()};
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const pageKit = window.__a67PageKit || (window.__a67PageKit = {});
  const createSvg = name => document.createElementNS(SVG_NS, name);
  const svgText = (svg, value, x, y, options = {}) => {
    const node = createSvg('text');
    node.setAttribute('x', String(x));
    node.setAttribute('y', String(y));
    node.setAttribute('data-a67-chart-label', '');
    for (const [key, setting] of Object.entries(options)) node.setAttribute(key, String(setting));
    node.textContent = value;
    svg.append(node);
    return node;
  };

  class A67Toc extends HTMLElement {
    connectedCallback() {
      if (this.querySelector('nav') || [...this.childNodes].some(node => node.nodeType !== 3 || node.textContent.trim())) return;
      this.pendingInitialization = () => this.initialize();
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', this.pendingInitialization, { once: true });
      else this.initialize();
    }
    initialize() {
      if (!this.isConnected || this.querySelector('nav') || [...this.childNodes].some(node => node.nodeType !== 3 || node.textContent.trim())) return;
      const headings = [...document.querySelectorAll('h2, h3')];
      if (!headings.length) return;
      const nav = document.createElement('nav');
      nav.setAttribute('aria-label', this.getAttribute('label') || 'On this page');
      const list = document.createElement('ul');
      headings.forEach((heading, index) => {
        if (!heading.id) {
          let id = 'a67-section-' + (index + 1);
          while (document.getElementById(id)) id += '-section';
          heading.id = id;
        }
        const item = document.createElement('li');
        if (heading.tagName === 'H3') item.setAttribute('data-depth', '3');
        const link = document.createElement('a');
        link.href = '#' + encodeURIComponent(heading.id);
        link.textContent = heading.textContent.trim();
        item.append(link);
        list.append(item);
      });
      nav.append(list);
      this.append(nav);
      if ('IntersectionObserver' in window) {
        this.observer = new IntersectionObserver(entries => {
          const current = entries.filter(entry => entry.isIntersecting).sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
          if (!current) return;
          nav.querySelectorAll('[aria-current="location"]').forEach(link => link.removeAttribute('aria-current'));
          nav.querySelector('a[href="#' + encodeURIComponent(current.target.id) + ']')?.setAttribute('aria-current', 'location');
        }, { rootMargin: '0px 0px -70% 0px' });
        headings.forEach(heading => this.observer.observe(heading));
      }
    }
    disconnectedCallback() {
      this.observer?.disconnect();
      if (this.pendingInitialization) document.removeEventListener('DOMContentLoaded', this.pendingInitialization);
    }
  }
  class A67Chart extends HTMLElement {
    connectedCallback() {
      this.pendingInitialization = () => this.initialize();
      if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', this.pendingInitialization, { once: true });
      else this.initialize();
    }
    disconnectedCallback() {
      this.tableObserver?.disconnect();
      document.removeEventListener('DOMContentLoaded', this.pendingInitialization);
    }
    initialize() {
      if (!this.isConnected) return;
      const source = document.getElementById(this.getAttribute('for'));
      if (!source || (source.tagName !== 'TABLE' && source.tagName !== 'A67-RECORDS')) return;
      if (!this.tableObserver) {
        this.tableObserver = new MutationObserver(records => {
          if (!records || !records.length || records.some(record => !this.contains(record.target))) {
            this.replaceChildren();
            this.initialize();
          }
        });
        this.tableObserver.observe(source, { subtree: true, childList: true, characterData: true });
      }
      const table = source.tagName === 'TABLE' ? source : source.querySelector('table');
      if (!table || this.querySelector('svg')) return;
      const headers = [...table.querySelectorAll('thead th')].map(cell => cell.textContent.trim());
      const labelIndex = headers.indexOf(this.getAttribute('label-column'));
      const valueIndex = headers.indexOf(this.getAttribute('value-column'));
      if (labelIndex < 0 || valueIndex < 0) return;
      const rows = [...table.querySelectorAll('tbody tr')].map(row => [...row.cells]).map(cells => {
        const valueCell = cells[valueIndex];
        const machineValue = valueCell?.getAttribute('data-value');
        const valueText = valueCell?.textContent.trim() || '';
        const value = machineValue !== null && machineValue !== undefined && machineValue !== ''
          ? Number.isFinite(Number(machineValue)) ? Number(machineValue) : null
          : valueText ? parseLocalizedNumber(valueText, document.documentElement.getAttribute('lang') || 'en') : null;
        return { label: cells[labelIndex]?.textContent.trim() || '', value };
        return { label: cells[labelIndex]?.textContent.trim() || '', value: valueText ? parseLocalizedNumber(valueText, document.documentElement.getAttribute('lang') || 'en') : null };
      }).filter(row => row.label && row.value !== null);
      if (!rows.length) return;
      const title = this.getAttribute('title') || 'Chart';
      const kind = this.getAttribute('type');
      const wrapper = document.createElement('figure');
      const svg = createSvg('svg');
      let baseId = this.id || 'a67-chart-' + document.querySelectorAll('a67-chart').length;
      while (document.getElementById(baseId + '-title') || document.getElementById(baseId + '-description')) baseId += '-chart';
      const chartHeight = kind === 'donut' ? Math.max(176, rows.length * 28 + 24) : Math.max(120, rows.length * 42 + 24);
      svg.setAttribute('viewBox', '0 0 640 ' + chartHeight);
      svg.setAttribute('role', 'img');
      svg.setAttribute('aria-labelledby', baseId + '-title ' + baseId + '-description');
      const titleElement = createSvg('title');
      titleElement.id = baseId + '-title';
      titleElement.textContent = title;
      svg.append(titleElement);
      const description = createSvg('desc');
      description.id = baseId + '-description';
      description.textContent = 'Values from the visible data table: ' + rows.map(row => row.label + ', ' + row.value).join('; ') + '.';
      svg.append(description);
      if (kind === 'donut') this.drawDonut(svg, rows);
      else if (kind === 'line') this.drawLine(svg, rows);
      else this.drawBars(svg, rows);
      const caption = document.createElement('figcaption');
      caption.textContent = 'Chart summary: ' + rows.map(row => row.label + ' — ' + row.value).join('; ') + '. Data are also shown in the visible table.';
      wrapper.append(svg, caption);
      this.prepend(wrapper);
    }
    drawBars(svg, rows) {
      const max = Math.max(...rows.map(row => Math.abs(row.value)), 1);
      const baseline = 375;
      rows.forEach((row, index) => {
        const y = 28 + index * 42;
        svgText(svg, row.label, 4, y + 16);
        const width = Math.max(1, 180 * Math.abs(row.value) / max);
        const bar = createSvg('rect');
        bar.setAttribute('x', String(row.value < 0 ? baseline - width : baseline));
        bar.setAttribute('y', String(y));
        bar.setAttribute('width', String(width));
        bar.setAttribute('height', '24');
        bar.setAttribute('data-a67-chart-shape', String(index % 6));
        svg.append(bar);
        svgText(svg, String(row.value), row.value < 0 ? baseline - width - 8 : baseline + width + 8, y + 16, { 'text-anchor': row.value < 0 ? 'end' : 'start' });
      });
      const axis = createSvg('line');
      axis.setAttribute('x1', String(baseline));
      axis.setAttribute('x2', String(baseline));
      axis.setAttribute('y1', '20');
      axis.setAttribute('y2', String(28 + rows.length * 42));
      axis.setAttribute('stroke', 'var(--a67-line)');
      svg.append(axis);
    }
    drawLine(svg, rows) {
      const min = Math.min(...rows.map(row => row.value));
      const max = Math.max(...rows.map(row => row.value));
      const range = Math.max(1, max - min);
      const points = rows.map((row, index) => ({ ...row, x: 200 + index * (380 / Math.max(1, rows.length - 1)), y: 104 - 80 * (row.value - min) / range }));
      const path = createSvg('polyline');
      path.setAttribute('points', points.map(point => point.x + ',' + point.y).join(' '));
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', 'var(--a67-c1)');
      path.setAttribute('stroke-width', '4');
      svg.append(path);
      points.forEach(point => {
        const marker = createSvg('circle');
        marker.setAttribute('cx', String(point.x));
        marker.setAttribute('cy', String(point.y));
        marker.setAttribute('r', '5');
        marker.setAttribute('fill', 'var(--a67-c1)');
        svg.append(marker);
        svgText(svg, point.value + ' — ' + point.label, point.x, point.y - 10, { 'text-anchor': 'middle' });
      });
    }
    drawDonut(svg, rows) {
      const total = rows.reduce((sum, row) => sum + row.value, 0);
      if (rows.some(row => row.value < 0) || !total) return this.drawBars(svg, rows);
      const circumference = 2 * Math.PI * 58;
      let offset = 0;
      rows.forEach((row, index) => {
        const length = circumference * row.value / total;
        const arc = createSvg('circle');
        arc.setAttribute('cx', '110');
        arc.setAttribute('cy', '88');
        arc.setAttribute('r', '58');
        arc.setAttribute('fill', 'none');
        arc.setAttribute('stroke', 'var(--a67-c' + (index % 6 + 1) + ')');
        arc.setAttribute('stroke-width', '30');
        arc.setAttribute('stroke-dasharray', length + ' ' + (circumference - length));
        arc.setAttribute('stroke-dashoffset', String(-offset));
        arc.setAttribute('transform', 'rotate(-90 110 88)');
        svg.append(arc);
        offset += length;
        svgText(svg, row.label + ': ' + row.value, 210, 32 + index * 28);
      });
    }
  }

  class A67Tabs extends HTMLElement {
    connectedCallback() {
      const tablist = [...this.children].find(child => child.getAttribute('role') === 'tablist');
      this.tabs = tablist ? [...tablist.querySelectorAll('[role="tab"]')] : [];
      this.panels = [...this.children].filter(child => child.getAttribute('role') === 'tabpanel');
      if (!this.tabs.length || this.tabs.length !== this.panels.length) return;
      const selected = this.tabs.findIndex(tab => !tab.disabled && tab.getAttribute('aria-selected') === 'true');
      const firstEnabled = this.tabs.findIndex(tab => !tab.disabled);
      this.activate(selected >= 0 ? selected : firstEnabled);
      this.addEventListener('click', this.onClick);
      this.addEventListener('keydown', this.onKeydown);
    }
    disconnectedCallback() {
      this.removeEventListener('click', this.onClick);
      this.removeEventListener('keydown', this.onKeydown);
    }
    activate(index, focus = false) {
      if (index < 0) index = this.tabs.findIndex(tab => !tab.disabled);
      if (index < 0 || this.tabs[index].disabled) return;
      this.tabs.forEach((tab, current) => {
        const selected = current === index;
        tab.setAttribute('aria-selected', String(selected));
        tab.setAttribute('tabindex', selected ? '0' : '-1');
        const panel = this.panels.find(panel => panel.id === tab.getAttribute('aria-controls'));
        if (panel) panel.hidden = !selected;
      });
      if (focus) this.tabs[index]?.focus();
    }
    onClick = event => {
      if (event.target.closest('a67-tabs') !== this) return;
      const tab = event.target.closest('[role="tab"]');
      const index = this.tabs.indexOf(tab);
      if (index >= 0 && !tab.disabled) this.activate(index);
    };
    onKeydown = event => {
      if (event.target.closest('a67-tabs') !== this) return;
      const index = this.tabs.indexOf(event.target.closest('[role="tab"]'));
      if (index < 0 || this.tabs[index].disabled) return;
      const enabled = this.tabs.map((tab, current) => tab.disabled ? -1 : current).filter(current => current >= 0);
      const position = enabled.indexOf(index);
      let next = position;
      if (event.key === 'ArrowRight') next = (position + 1) % enabled.length;
      else if (event.key === 'ArrowLeft') next = (position + enabled.length - 1) % enabled.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = enabled.length - 1;
      else return;
      event.preventDefault();
      this.activate(enabled[next], true);
    };
  }

  const state = (host, name, message, role = name === 'error' || name === 'forbidden' ? 'alert' : 'status') => {
    host.stateName = name;
    if (!host.stateNode) {
      host.stateNode = document.createElement('p');
      host.stateNode.setAttribute('data-a67-state', '');
    }
    host.stateNode.dataset.state = name;
    host.stateNode.setAttribute('role', role);
    host.stateNode.textContent = message;
    if (!host.stateNode.isConnected) host.prepend(host.stateNode);
  };
  const setDisabled = (host, disabled) => host.querySelectorAll('button,input,select,textarea').forEach(control => { control.disabled = disabled; });
  const codeError = error => error && typeof error.code === 'string' ? error.code : '';
  const errorMessage = error => typeof error?.message === 'string' ? error.message : 'The request failed.';
  const announceFailure = (host, error) => {
    if (codeError(error) === 'forbidden') {
      setDisabled(host, true);
      state(host, 'forbidden', 'Access denied. Controls are disabled.');
    } else state(host, 'error', errorMessage(error));
  };
  const unusedId = prefix => {
    let id;
    do { id = prefix + (++fieldSequence); } while (document.getElementById(id));
    return id;
  };
  const formValues = form => {
    const values = Object.create(null);
    for (const [name, value] of new FormData(form)) {
      if (typeof value !== 'string' && value.name === '' && value.size === 0) continue;
      if (!Object.hasOwn(values, name)) values[name] = value;
      else if (Array.isArray(values[name])) values[name].push(value);
      else values[name] = [values[name], value];
    }
    return values;
  };
  const recordValues = (form, fields, schema, previous) => {
    const values = Object.assign(Object.create(null), previous ?? {});
    const submitted = formValues(form);
    for (const name of fields) {
      const spec = schema.fields[name];
      if (spec.type === 'boolean') {
        values[name] = form.querySelector('[name="' + name + '"]')?.checked === true;
      } else if (spec.type === 'choice' && spec.multiple) {
        const value = submitted[name];
        values[name] = value === undefined ? [] : Array.isArray(value) ? value : [value];
      } else if (spec.type === 'file') {
        if (Object.hasOwn(submitted, name)) values[name] = submitted[name];
      } else if (Object.hasOwn(submitted, name)) values[name] = submitted[name];
    }
    return values;
  };
  let fieldSequence = 0;
  const fieldInput = (spec, name, value, labelText = name) => {
    const label = document.createElement('label');
    const title = document.createElement('span');
    title.textContent = labelText || name;
    const error = document.createElement('span');
    error.id = unusedId('a67-field-error-');
    error.hidden = true;
    error.setAttribute('data-field-error', name);
    let control, currentFileNotice;
    if (spec.type === 'choice') {
      control = document.createElement('select');
      if (spec.multiple) control.multiple = true;
      if (spec.required && !spec.multiple) {
        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.disabled = true;
        placeholder.selected = true;
        placeholder.textContent = 'Choose an option';
        control.append(placeholder);
      }
      const selectedValues = new Set(Array.isArray(value) ? value : value == null ? [] : [value]);
      for (const optionValue of spec.options || []) {
        const option = document.createElement('option');
        option.value = optionValue;
        option.textContent = optionValue;
        option.selected = selectedValues.has(optionValue);
        control.append(option);
      }
    } else {
      control = document.createElement('input');
      control.type = ({ text: 'text', email: 'email', number: 'number', boolean: 'checkbox', date: 'date', file: 'file' })[spec.type] || 'text';
      if (spec.type === 'text' && spec.maxLength) control.maxLength = spec.maxLength;
      if (spec.type === 'number') {
        const min = spec.integer && spec.min !== undefined ? Math.ceil(spec.min) : spec.min;
        const max = spec.integer && spec.max !== undefined ? Math.floor(spec.max) : spec.max;
        if (min !== undefined) control.min = String(min);
        if (max !== undefined) control.max = String(max);
        control.step = spec.integer ? '1' : 'any';
      }
      if (spec.type === 'file') {
        if (Array.isArray(spec.accept)) control.accept = spec.accept.join(',');
        if (spec.multiple) control.multiple = true;
        if (Number.isInteger(spec.maxBytes)) {
          control.setAttribute('data-max-bytes', String(spec.maxBytes));
          control.addEventListener('change', () => {
            const oversized = Array.from(control.files || []).some(file => file.size > spec.maxBytes);
            control.setCustomValidity(oversized ? 'Each file must be at most ' + spec.maxBytes + ' bytes.' : '');
          });
        }
        const currentFiles = Array.isArray(value) ? value : value ? [value] : [];
        if (currentFiles.length) {
          currentFileNotice = document.createElement('span');
          currentFileNotice.textContent = 'Current files: ' + currentFiles.map(file => file?.name || 'Attached file').join(', ');
        }
      }
    }
    control.name = name;
    const hasCurrentFile = spec.type === 'file' && (Array.isArray(value) ? value.length > 0 : value !== undefined && value !== null);
    control.required = Boolean(spec.required && !hasCurrentFile);
    control.setAttribute('data-field', name);
    if (spec.type === 'boolean') control.checked = value === true;
    else if (value !== undefined && value !== null && spec.type !== 'file' && !(spec.type === 'choice' && spec.multiple)) control.value = String(value);
    label.append(title);
    if (currentFileNotice) label.append(currentFileNotice);
    label.append(control, error);
    return { label, control, error };
  };
  const formSchema = async (collection, expectedKind) => {
    const sdk = window.artefacts?.data;
    if (!sdk?.schema) throw Object.assign(new Error('Open this page in the hosted viewer to load this collection.'), { code: 'unavailable' });
    const schema = await sdk.schema(collection);
    if (schema.kind !== expectedKind) throw Object.assign(new Error('This page binding requires a ' + expectedKind + ' collection.'), { code: 'wrong-kind' });
    return schema;
  };
  class A67Form extends HTMLElement {
    connectedCallback() { return this.load(); }
    async load() {
      const collection = this.getAttribute('collection') || '';
      state(this, 'loading', 'Loading response form…');
      setDisabled(this, true);
      try {
        const schema = await formSchema(collection, 'responses');
        const authored = [...this.children].filter(child => child.hasAttribute('data-field'));
        const fields = authored.length
          ? authored.map(child => [child.getAttribute('data-field'), child.getAttribute('label') || child.textContent.trim()])
          : Object.keys(schema.fields || {}).map(name => [name, name]);
        const form = document.createElement('form');
        this.fieldErrors = Object.create(null);
        for (const [name, label] of fields) {
          const spec = schema.fields?.[name];
          if (!spec) throw new Error('The response field ' + name + ' is not in the collection schema.');
          const field = fieldInput(spec, name, undefined, label);
          this.fieldErrors[name] = field.error;
          form.append(field.label);
        }
        if (!fields.length) {
          this.form = null;
          this.replaceChildren();
          state(this, 'empty', 'This response form has no fields.');
          return;
        }
        const submit = document.createElement('button');
        submit.type = 'submit';
        submit.textContent = this.getAttribute('submit-label') || 'Submit';
        form.append(submit);
        this.form = form;
        this.replaceChildren(form);
        form.addEventListener('submit', this.onSubmit);
        state(this, 'ready', 'Response form ready.');
        setDisabled(this, false);
      } catch (error) {
        this.replaceChildren();
        this.form = null;
        this.fieldErrors = null;
        announceFailure(this, error);
        setDisabled(this, true);
      }
    }
    onSubmit = async event => {
      event.preventDefault();
      if (!this.form || !window.artefacts?.data) return;
      const button = this.form.querySelector('button');
      for (const [name, errorNode] of Object.entries(this.fieldErrors || {})) {
        const control = this.form.querySelector('[name="' + name + '"]');
        errorNode.textContent = '';
        errorNode.hidden = true;
        control?.removeAttribute('aria-invalid');
        control?.removeAttribute('aria-describedby');
      }
      try {
        const submission = window.artefacts.data.submit(this.getAttribute('collection'), this.form);
        setDisabled(this, true);
        await submission;
        state(this, 'ready', 'Response submitted.');
      } catch (error) {
        if (codeError(error) === 'forbidden') {
          this.replaceChildren();
          this.form = null;
          this.fieldErrors = null;
          announceFailure(this, error);
        } else {
          const issues = Array.isArray(error?.issues) ? error.issues : [];
          for (const issue of issues) {
            const input = this.form.querySelector('[name="' + issue.field + '"]');
            const errorNode = this.fieldErrors?.[issue.field];
            if (input && errorNode) {
              input.setAttribute('aria-invalid', 'true');
              input.setAttribute('aria-describedby', errorNode.id);
              errorNode.textContent = issue.message;
              errorNode.hidden = false;
            }
          }
          state(this, 'error', issues.map(issue => issue.field + ': ' + issue.message).join(' ') || errorMessage(error));
          setDisabled(this, false);
          button?.focus();
        }
      }
    };
    disconnectedCallback() { this.form?.removeEventListener('submit', this.onSubmit); }
  }
  class A67Checklist extends HTMLElement {
    connectedCallback() { return this.load(); }
    async load() {
      this.items = [...this.children].filter(child => child.hasAttribute('data-item')).map(child => ({
        key: child.getAttribute('data-item'), label: child.textContent.trim(),
      }));
      const key = this.getAttribute('storage-key') || '';
      this.scope = this.getAttribute('storage-scope') || 'personal';
      this.checked = new Set();
      state(this, 'loading', 'Loading checklist…');
      if (!this.items.length) { state(this, 'empty', 'This checklist has no items.'); return; }
      try {
        const storage = window.artefacts?.storage;
        const saved = storage ? await storage.get(key, { scope: this.scope }) : [];
        if (saved !== null && !Array.isArray(saved)) throw new Error('Saved checklist data is invalid.');
        this.checked = new Set(Array.isArray(saved) ? saved.filter(value => this.items.some(item => item.key === value)) : []);
        this.render();
        state(this, 'ready', storage ? 'Checklist loaded.' : 'Session-only checklist; changes are not saved.');
      } catch (error) {
        this.render();
        announceFailure(this, error);
        if (codeError(error) !== 'forbidden') setDisabled(this, true);
      }
    }
    render() {
      const list = document.createElement('div');
      for (const item of this.items) {
        const label = document.createElement('label');
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = this.checked.has(item.key);
        input.addEventListener('change', () => this.save(item.key, input.checked));
        const text = document.createElement('span');
        text.textContent = item.label;
        label.append(input, text);
        list.append(label);
      }
      this.replaceChildren(list);
    }
    async save(key, checked) {
      if (checked) this.checked.add(key); else this.checked.delete(key);
      const storage = window.artefacts?.storage;
      if (!storage) {
        state(this, 'ready', 'Session-only checklist; changes are not saved.');
        return;
      }
      setDisabled(this, true);
      state(this, 'loading', 'Saving checklist…');
      try {
        await storage.set(this.getAttribute('storage-key') || '', [...this.checked], { scope: this.scope });
        state(this, 'ready', 'Checklist saved.');
        setDisabled(this, false);
      } catch (error) {
        announceFailure(this, error);
        if (codeError(error) !== 'forbidden') {
          state(this, 'error', 'Checklist change is unsaved: ' + errorMessage(error));
          setDisabled(this, false);
        }
      }
    }
  }
  class A67Records extends HTMLElement {
    connectedCallback() { return this.load(); }
    async load() {
      const collection = this.getAttribute('collection') || '';
      this.editRequestId = (this.editRequestId || 0) + 1;
      this.canEdit = this.hasAttribute('editable') && pageKit.canWriteRecords === true;
      this.replaceChildren();
      this.table = null;
      this.addButton = null;
      this.editor = null;
      this.deleteConfirmation = null;
      state(this, 'loading', 'Loading records…');
      setDisabled(this, true);
      try {
        this.schema = await formSchema(collection, 'records');
        const sdk = window.artefacts.data;
        const records = [];
        let cursor;
        do {
          const page = await sdk.list(collection, { limit: 500, cursor });
          records.push(...page.records);
          cursor = page.cursor;
        } while (cursor);
        this.records = records;
        const initialSort = this.getAttribute('sort');
        if (initialSort) this.sort(initialSort, null, true);
        else this.render();
        if (!records.length) state(this, 'empty', 'No records are available.');
        else state(this, 'ready', records.length + ' records loaded.');
        setDisabled(this, false);
      } catch (error) {
        this.replaceChildren();
        this.table = null;
        this.addButton = null;
        this.editor = null;
        announceFailure(this, error);
      }
    }
    render() {
      const fields = (this.getAttribute('fields') || Object.keys(this.schema.fields).join(',')).split(',').map(value => value.trim()).filter(Boolean);
      if (fields.some(name => !Object.hasOwn(this.schema.fields, name))) throw new Error('The records fields attribute names a field outside this collection.');
      this.fields = fields;
      this.table?.remove();
      this.addButton?.remove();
      const table = document.createElement('table');
      const caption = document.createElement('caption');
      caption.textContent = this.getAttribute('label') || this.getAttribute('collection');
      table.append(caption);
      const head = document.createElement('thead'), row = document.createElement('tr');
      for (const name of this.fields) {
        const th = document.createElement('th');
        th.scope = 'col';
        th.setAttribute('aria-sort', this.sortName === name ? this.sortDirection : 'none');
        const button = document.createElement('button');
        button.type = 'button';
        button.textContent = name;
        button.addEventListener('click', () => this.sort(name, th));
        th.append(button);
        row.append(th);
      }
      head.append(row); table.append(head);
      const body = document.createElement('tbody');
      for (const record of this.records) {
        const tr = document.createElement('tr');
        tr.dataset.recordId = record.id;
        for (const name of this.fields) {
          const td = document.createElement('td');
          const value = record.data?.[name], spec = this.schema.fields[name];
          if (Array.isArray(value)) td.textContent = value.map(item => spec.type === 'file' ? item?.name || 'Attached file' : String(item)).join(', ');
          else td.textContent = spec.type === 'file' && value && typeof value === 'object' ? value.name || 'Attached file' : value == null ? '' : String(value);
          if (spec.type === 'number' && value != null && Number.isFinite(Number(value))) td.setAttribute('data-value', String(value));
          tr.append(td);
        }
        if (this.canEdit) {
          const action = document.createElement('td');
          const edit = document.createElement('button');
          edit.type = 'button'; edit.textContent = 'Edit';
          edit.addEventListener('click', () => this.edit(record.id));
          action.append(edit); tr.append(action);
        }
        body.append(tr);
      }
      table.append(body); this.table = table; this.append(table);
      if (this.canEdit) {
        this.addButton = document.createElement('button');
        this.addButton.type = 'button'; this.addButton.textContent = 'Add record';
        this.addButton.addEventListener('click', () => this.edit());
        this.append(this.addButton);
      }
    }
    sort(name, heading = null, initial = false) {
      const visibleFields = (this.getAttribute('fields') || Object.keys(this.schema.fields).join(',')).split(',').map(value => value.trim()).filter(Boolean);
      if (!visibleFields.includes(name) || !Object.hasOwn(this.schema.fields, name)) throw new Error('The records sort attribute must name a displayed field in this collection.');
      const currentDirection = initial ? 'none' : heading?.getAttribute('aria-sort') ?? (this.sortName === name ? this.sortDirection : 'none');
      this.sortName = name;
      this.sortDirection = currentDirection === 'ascending' ? 'descending' : 'ascending';
      const direction = this.sortDirection === 'ascending' ? 1 : -1;
      const field = this.schema.fields[name];
      const collator = new Intl.Collator(document.documentElement.getAttribute('lang') || 'en', { numeric: true });
      this.records.sort((a, b) => {
        const first = a.data?.[name], second = b.data?.[name];
        const firstAbsent = first === null || first === undefined;
        const secondAbsent = second === null || second === undefined;
        if (firstAbsent !== secondAbsent) return firstAbsent ? 1 : -1;
        if (firstAbsent) return 0;
        const comparison = field.type === 'number'
          ? Number(first) - Number(second)
          : collator.compare(String(first), String(second));
        return comparison * direction;
      });
      this.render();
      state(this, 'ready', 'Records sorted by ' + name + '.');
    }
    async edit(id) {
      if (!this.canEdit) return;
      const requestId = this.editRequestId = (this.editRequestId || 0) + 1;
      if (id) {
        state(this, 'loading', 'Loading record…');
        setDisabled(this, true);
      }
      try {
        const editing = id ? await window.artefacts.data.get(this.getAttribute('collection'), id) : null;
        if (requestId !== this.editRequestId || !this.isConnected) return;
        this.editRecord = editing;
        if (id && !editing) throw Object.assign(new Error('This record is no longer available.'), { code: 'not-found' });
        const form = document.createElement('form');
        for (const name of this.fields) form.append(fieldInput(this.schema.fields[name], name, editing?.data?.[name]).label);
        const save = document.createElement('button'); save.type = 'submit'; save.textContent = id ? 'Save record' : 'Create record';
        form.append(save);
        form.addEventListener('submit', event => this.save(event, id, editing?.version));
        if (id) {
          const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = 'Delete record';
          remove.addEventListener('click', () => this.remove(id, editing.version));
          form.append(remove);
        }
        this.deleteConfirmation?.remove();
        this.deleteConfirmation = null;
        this.editor?.remove();
        this.editor = form; this.append(form); state(this, 'ready', id ? 'Editing record.' : 'Creating record.');
      } catch (error) {
        if (requestId === this.editRequestId) announceFailure(this, error);
      } finally {
        if (requestId === this.editRequestId && this.stateName !== 'forbidden') setDisabled(this, false);
      }
    }
    async save(event, id, version) {
      event.preventDefault();
      if (!this.canEdit) return;
      const form = event.currentTarget;
      try {
        const values = recordValues(form, this.fields, this.schema, this.editRecord?.data);
        const request = id
          ? window.artefacts.data.update(this.getAttribute('collection'), id, values, { ifVersion: version })
          : window.artefacts.data.create(this.getAttribute('collection'), values);
        setDisabled(this, true);
        await request;
        this.editor.remove(); this.editor = null; await this.load();
      } catch (error) {
        announceFailure(this, error);
        if (codeError(error) !== 'forbidden') { state(this, 'error', errorMessage(error)); setDisabled(this, false); }
      }
    }
    remove(id, version) {
      if (!this.canEdit || this.deleteConfirmation) return;
      const confirmation = document.createElement('div');
      confirmation.setAttribute('role', 'alertdialog');
      const title = document.createElement('strong');
      title.id = unusedId('a67-delete-confirm-');
      title.textContent = 'Delete this record?';
      confirmation.setAttribute('aria-labelledby', title.id);
      const message = document.createElement('p');
      message.textContent = 'This action cannot be undone.';
      const confirm = document.createElement('button');
      confirm.type = 'button'; confirm.textContent = 'Delete record';
      const cancel = document.createElement('button');
      cancel.type = 'button'; cancel.textContent = 'Cancel';
      const close = () => { confirmation.remove(); this.deleteConfirmation = null; };
      cancel.addEventListener('click', () => { close(); this.editor?.querySelector('button[type="submit"]')?.focus(); });
      confirm.addEventListener('click', () => { close(); void this.deleteRecord(id, version); });
      confirmation.append(title, message, confirm, cancel);
      this.deleteConfirmation = confirmation;
      this.editor?.append(confirmation);
      cancel.focus();
    }
    async deleteRecord(id, version) {
      if (!this.canEdit) return;
      setDisabled(this, true);
      try {
        await window.artefacts.data.delete(this.getAttribute('collection'), id, { ifVersion: version });
        this.editor?.remove(); this.editor = null; await this.load();
      } catch (error) {
        announceFailure(this, error);
        if (codeError(error) !== 'forbidden') { state(this, 'error', errorMessage(error)); setDisabled(this, false); }
      }
    }
  }
  class A67Kpi extends HTMLElement {
    connectedCallback() {
      if (this.hasAttribute('collection') || this.hasAttribute('field') || this.hasAttribute('aggregate')) return this.loadAggregate();
      this.renderLiteral();
    }
    renderLiteral() {
      const label = this.getAttribute('label') || '';
      const value = this.getAttribute('value') || '';
      const group = document.createElement('div');
      group.setAttribute('role', 'group');
      group.setAttribute('aria-label', label);
      const number = document.createElement('span');
      number.setAttribute('data-a67-kpi-value', '');
      number.textContent = value;
      group.append(number);
      const delta = this.getAttribute('delta');
      if (delta !== null) {
        const trend = this.getAttribute('trend');
        const trendText = trend === 'up' ? 'Increase' : trend === 'down' ? 'Decrease' : '';
        const detail = document.createElement('span');
        detail.setAttribute('data-a67-kpi-delta', '');
        detail.textContent = trendText ? trendText + ': ' + delta : delta;
        group.append(detail);
      }
      this.replaceChildren(group);
    }
    async loadAggregate() {
      this.replaceChildren();
      state(this, 'loading', 'Loading aggregate…');
      try {
        const sdk = window.artefacts?.data;
        if (!sdk?.schema || !sdk?.list) throw Object.assign(new Error('Live aggregate is available only in the hosted viewer.'), { code: 'unavailable' });
        const collection = this.getAttribute('collection'), field = this.getAttribute('field');
        const schema = await sdk.schema(collection);
        if (schema.kind !== 'records' || schema.fields?.[field]?.type !== 'number' || this.getAttribute('aggregate') !== 'sum')
          throw new Error('This aggregate requires a numeric records field and aggregate="sum".');
        const records = [];
        let cursor;
        do {
          const page = await sdk.list(collection, { limit: 500, cursor });
          records.push(...page.records); cursor = page.cursor;
        } while (cursor);
        const values = records.map(record => record.data?.[field]).filter(value => typeof value === 'number' && Number.isFinite(value));
        if (!values.length) {
          this.replaceChildren();
          state(this, 'empty', 'No numeric values are available for this aggregate.');
          return;
        }
        this.replaceChildren();
        const group = document.createElement('div');
        group.setAttribute('role', 'group'); group.setAttribute('aria-label', this.getAttribute('label') || field);
        const value = document.createElement('span');
        value.setAttribute('data-a67-kpi-value', ''); value.textContent = String(values.reduce((sum, item) => sum + item, 0));
        group.append(value); this.append(group);
        state(this, 'ready', 'Aggregate ready.');
      } catch (error) {
        this.replaceChildren();
        announceFailure(this, error);
      }
    }
  }


  const PLATFORM_MARK_PATHS = [
    'M297.8,0a10.33,10.33,0,0,1,8.6,4.6l98.35,147.52a10.33,10.33,0,0,1-8.59,16.06H270.07a10.33,10.33,0,0,1-8.6-16.06l30.61-45.9a3.92,3.92,0,0,1,5.45-1.09l10.62,7.07a4,4,0,0,1,1.1,5.5l-16.91,25.37a2.87,2.87,0,0,0,2.38,4.46h76.61a3,3,0,0,0,2.46-4.6L300.27,32.64a3,3,0,0,0-4.94,0L213.09,163.58c-3.84,5.75-13.34,5.75-17.18,0l-30.38-45.46L177.94,99.3,202,135.5a3,3,0,0,0,5,0L289.21,4.6A10.32,10.32,0,0,1,297.8,0',
    'M10.33,0H68a5.37,5.37,0,0,1,5.37,5.38v9.91A5.35,5.35,0,0,1,68,20.65H37.72a4.33,4.33,0,0,0-3.61,6.73L105,133.73c1.32,2,3.49,2,4.81,0l71-106.52a4.22,4.22,0,0,0-3.51-6.56H133.79a4.46,4.46,0,0,0-3.71,7l14.58,21.84a1.3,1.3,0,0,1,0,1.44L133.8,67.22a1.29,1.29,0,0,1-2.15,0L97.55,16.05a10.32,10.32,0,0,1,8.6-16H204.5a10.32,10.32,0,0,1,8.6,16.05L114.74,163.58c-3.84,5.75-10.81,5.75-14.66,0L1.73,16.05a10.32,10.32,0,0,1,8.6-16',
  ];
  class A67Logo extends HTMLElement {
    connectedCallback() { this.render(); }
    render() {
      const label = this.getAttribute('label') || '';
      const svg = createSvg('svg');
      svg.setAttribute('viewBox', '0 0 406.48 168.18');
      svg.setAttribute('width', '406.48');
      svg.setAttribute('height', '168.18');
      if (label) {
        svg.setAttribute('role', 'img');
        svg.setAttribute('aria-label', label);
      } else svg.setAttribute('aria-hidden', 'true');
      if (pageKit.logo) {
        const image = createSvg('image');
        image.setAttribute('x', '0');
        image.setAttribute('y', '0');
        image.setAttribute('width', '406.48');
        image.setAttribute('height', '168.18');
        image.setAttribute('preserveAspectRatio', 'xMidYMid meet');
        image.setAttribute('href', pageKit.logo);
        svg.append(image);
      } else {
        PLATFORM_MARK_PATHS.forEach((data, index) => {
          const path = createSvg('path');
          path.setAttribute('d', data);
          path.setAttribute('fill', index === 0 ? '#ea9423' : '#273238');
          svg.append(path);
        });
      }
      this.replaceChildren(svg);
    }
  }

  pageKit.configure = ({ logo } = {}) => {
    pageKit.logo = typeof logo === 'string' && /^data:image\/(?:png|svg\+xml);base64,[A-Za-z0-9+/]+={0,2}$/.test(logo) ? logo : null;
    document.querySelectorAll('a67-logo').forEach(element => element.render());
  };
  for (const [name, constructor] of [
    ['a67-toc', A67Toc], ['a67-tabs', A67Tabs], ['a67-kpi', A67Kpi],
    ['a67-chart', A67Chart], ['a67-logo', A67Logo], ['a67-form', A67Form],
    ['a67-checklist', A67Checklist], ['a67-records', A67Records],
  ]) if (!customElements.get(name)) customElements.define(name, constructor);
})();`;
