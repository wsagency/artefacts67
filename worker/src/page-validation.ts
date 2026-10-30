import { parseFragment, Tokenizer, type DefaultTreeAdapterTypes, type TokenHandler } from "parse5";
import * as css from "css-tree";
import type { ValidationIssue } from "./validate.js";
import { parseLocalizedNumber } from "../../frontend/src/page-numbers.js";

export interface PageDocument {
  source: string;
  fragment: DefaultTreeAdapterTypes.DocumentFragment;
}

type PageError = Error & { code: "validation"; issues: ValidationIssue[] };
type Element = DefaultTreeAdapterTypes.Element;
type Node = DefaultTreeAdapterTypes.ChildNode;

const HTML_NS = "http://www.w3.org/1999/xhtml";
const SVG_NS = "http://www.w3.org/2000/svg";
const UTF8_ENCODER = new TextEncoder();
const HTML_ELEMENTS = new Set(("body header footer main nav section article aside h1 h2 h3 h4 h5 h6 p span strong em b i small mark del ins sub sup br hr div ul ol li dl dt dd figure figcaption img blockquote q cite time abbr code pre kbd samp var table caption colgroup col thead tbody tfoot tr th td a button label input select option optgroup fieldset legend details summary progress output meter").split(" "));
const SVG_ELEMENTS = new Set(("svg g path circle rect line polyline polygon ellipse text title desc defs marker").split(" "));
const VOID_ELEMENTS = new Set(["br", "hr", "input", "col", "img"]);
const OPAQUE_TONE_SURFACES: Record<string, true> = { table: true, thead: true, th: true, pre: true, code: true };
const COMMON_ATTRS = new Set(["id", "lang", "dir", "role", "tabindex", "title", "hidden"]);
const ARIA_ATTRS = new Set(["aria-label", "aria-labelledby", "aria-describedby", "aria-controls", "aria-selected", "aria-sort", "aria-live", "aria-current"]);
const DATA_VALUES: Record<string, ReadonlySet<string> | null> = {
  "data-variant": new Set(["hero", "band", "split", "feature", "grid", "full-bleed", "timeline", "steps"]),
  "data-tone": new Set(["accent", "muted", "inverse", "info", "ok", "warn", "crit"]),
  "data-style": new Set(["aurora", "glow"]), "data-severity": new Set(["ok", "warn", "crit"]),
  "data-trend": new Set(["up", "down"]), "data-status": new Set(["ok", "info", "warn", "crit"]),
  "data-role": new Set(["eyebrow"]), "data-layout": new Set(["hero", "hero-copy", "hero-metrics", "kpis"]),
  "data-scroll": new Set(["table"]), "data-badge": null, "data-finding": null,
  "data-item": null, "data-field": null,
};
const COMPONENT_ATTRS: Record<string, ReadonlySet<string>> = {
  "a67-toc": new Set(["label"]), "a67-kpi": new Set(["label", "value", "delta", "trend", "data-style", "collection", "field", "aggregate"]),
  "a67-chart": new Set(["id", "for", "type", "title", "label-column", "value-column"]),
  "a67-tabs": new Set(), "a67-form": new Set(["collection", "submit-label"]),
  "a67-checklist": new Set(["storage-key", "storage-scope"]), "a67-logo": new Set(["label"]),
  "a67-records": new Set(["id", "collection", "fields", "sort", "editable", "label"]),
};
const SVG_ROOT_ATTRS = new Set(["viewbox", "width", "height", "xmlns"]);
const SVG_SHAPE_ATTRS = new Set(("d fill stroke stroke-width stroke-linecap stroke-linejoin cx cy r x y x1 x2 y1 y2 points font-size text-anchor marker-end refx refy markerwidth markerheight orient").split(" "));
const TOKENS = new Set(("bg surface ink muted line accent accent-ink on-accent ok warn crit focus c1 c2 c3 c4 c5 c6 font-heading font-body font-mono radius space density shadow card-border section-gap card-pad heading-weight table-head-bg table-stripe section-rule").split(" "));
const COLOR_TOKENS = new Set(("bg surface ink muted line accent accent-ink on-accent ok warn crit focus c1 c2 c3 c4 c5 c6").split(" "));
const IMAGE_TYPES = new Set(["png", "jpeg", "webp", "gif", "avif"]);
const LABELABLE_ELEMENTS = new Set(["button", "input", "meter", "output", "progress", "select"]);

function reject(issues: ValidationIssue[]): never {
  const first = issues[0] ?? { code: "invalid-page", message: "Page content is invalid." };
  throw Object.assign(new Error(first.message), { code: "validation", issues }) as PageError;
}

function attrAllowed(element: string, attr: string, namespace: string, formFieldDescriptor = false): boolean {
  if (attr.startsWith("on") || ["class", "srcdoc", "srcset", "sizes", "usemap", "ismap", "crossorigin", "referrerpolicy", "action", "formaction", "formmethod", "formtarget", "target", "ping", "manifest"].includes(attr)) return false;
  if (namespace === SVG_NS) {
    if (COMMON_ATTRS.has(attr) || ARIA_ATTRS.has(attr) || Object.hasOwn(DATA_VALUES, attr) || attr === "style") return true;
    return element === "svg" ? SVG_ROOT_ATTRS.has(attr) : SVG_SHAPE_ATTRS.has(attr);
  }
  if (COMMON_ATTRS.has(attr) || ARIA_ATTRS.has(attr) || Object.hasOwn(DATA_VALUES, attr)) return true;
  if (attr === "style") return true;
  if (element.startsWith("a67-")) return COMPONENT_ATTRS[element]?.has(attr) ?? false;
  if (element === "img") return ["src", "alt", "width", "height", "loading", "decoding"].includes(attr);
  if (element === "a") return attr === "href";
  if (element === "button") return ["type", "disabled"].includes(attr);
  if (element === "input") return ["name", "value", "type", "min", "max", "step", "required", "disabled", "checked", "placeholder", "autocomplete", "maxlength", "minlength", "pattern", "accept"].includes(attr);
  if (element === "select" || element === "option" || element === "optgroup") return ["name", "value", "required", "disabled", "selected", "multiple", "label"].includes(attr);
  if (element === "label") return attr === "for" || attr === "label" && formFieldDescriptor;
  if (element === "table" || element === "colgroup" || element === "col") return attr === "span";
  if (element === "th" || element === "td") return ["scope", "colspan", "rowspan", "headers", "aria-sort"].includes(attr);
  if (element === "details") return attr === "open";
  return false;
}

function completeAvif(bytes: Uint8Array): boolean {
  const uint32 = (offset: number) => (bytes[offset] * 0x1000000 + bytes[offset + 1] * 0x10000 + bytes[offset + 2] * 0x100 + bytes[offset + 3]) >>> 0;
  const uint16 = (offset: number) => bytes[offset] * 0x100 + bytes[offset + 1];
  const typeAt = (offset: number) => String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
  const scan = (start: number, end: number, visit: (type: string, payload: number, boxEnd: number) => void): boolean => {
    let offset = start;
    while (offset < end) {
      if (offset + 8 > end) return false;
      const smallSize = uint32(offset), type = typeAt(offset + 4);
      let header = 8, size = smallSize;
      if (smallSize === 1) {
        if (offset + 16 > end || uint32(offset + 8) !== 0) return false;
        size = uint32(offset + 12);
        header = 16;
      }
      if (size < header || size > end - offset) return false;
      visit(type, offset + header, offset + size);
      offset += size;
    }
    return offset === end;
  };
  const readUInt = (offset: number, size: number, end: number): bigint | null => {
    if (size > 8 || offset + size > end) return null;
    let value = 0n;
    for (let i = 0; i < size; i++) value = value * 256n + BigInt(bytes[offset + i]);
    return value;
  };
  type ItemExtent = { offset: bigint; length: bigint };
  type ItemLocation = { method: number; dataReference: number; baseOffset: bigint; extents: ItemExtent[] };
  const parseItemInfo = (content: number, end: number): Map<number, string> | null => {
    if (end - content < 6) return null;
    const version = bytes[content], countSize = version === 0 ? 2 : version === 1 ? 4 : 0;
    if (!countSize) return null;
    const count = countSize === 2 ? uint16(content + 4) : uint32(content + 4);
    const items = new Map<number, string>();
    let itemCount = 0, valid = true;
    const boxesValid = scan(content + 4 + countSize, end, (type, payload, boxEnd) => {
      if (type !== "infe" || boxEnd - payload < 12) { valid = false; return; }
      const itemVersion = bytes[payload], idSize = itemVersion === 2 ? 2 : itemVersion === 3 ? 4 : 0;
      if (!idSize || boxEnd - payload < 4 + idSize + 6) { valid = false; return; }
      const id = idSize === 2 ? uint16(payload + 4) : uint32(payload + 4);
      const itemTypeOffset = payload + 4 + idSize + 2;
      items.set(id, typeAt(itemTypeOffset));
      itemCount++;
    });
    return boxesValid && valid && itemCount === count ? items : null;
  };
  const parseItemLocations = (content: number, end: number): Map<number, ItemLocation> | null => {
    if (end - content < 8) return null;
    const version = bytes[content];
    if (version > 2) return null;
    const offsetSize = bytes[content + 4] >>> 4, lengthSize = bytes[content + 4] & 0x0f;
    const baseOffsetSize = bytes[content + 5] >>> 4, indexSize = bytes[content + 5] & 0x0f;
    if (offsetSize > 8 || lengthSize > 8 || baseOffsetSize > 8 || indexSize > 8 || lengthSize === 0) return null;
    const countSize = version === 2 ? 4 : 2, idSize = version === 2 ? 4 : 2;
    if (content + 6 + countSize > end) return null;
    const itemCount = countSize === 2 ? uint16(content + 6) : uint32(content + 6);
    const result = new Map<number, ItemLocation>();
    let offset = content + 6 + countSize, valid = true;
    for (let item = 0; item < itemCount; item++) {
      if (offset + idSize > end) return null;
      const id = idSize === 2 ? uint16(offset) : uint32(offset);
      offset += idSize;
      let method = 0;
      if (version >= 1) {
        if (offset + 2 > end) return null;
        const methodField = uint16(offset);
        if (methodField & 0xfff0) return null;
        method = methodField & 0x0f;
        offset += 2;
      }
      if (offset + 2 > end) return null;
      const dataReference = uint16(offset);
      offset += 2;
      const baseOffset = readUInt(offset, baseOffsetSize, end);
      if (baseOffset === null) return null;
      offset += baseOffsetSize;
      if (offset + 2 > end) return null;
      const extentCount = uint16(offset);
      offset += 2;
      const extents: ItemExtent[] = [];
      for (let extent = 0; extent < extentCount; extent++) {
        if (version >= 1 && indexSize) {
          const index = readUInt(offset, indexSize, end);
          if (index === null || index !== 0n) return null;
          offset += indexSize;
        }
        const extentOffset = readUInt(offset, offsetSize, end);
        if (extentOffset === null) return null;
        offset += offsetSize;
        const extentLength = readUInt(offset, lengthSize, end);
        if (extentLength === null || extentLength === 0n) return null;
        offset += lengthSize;
        extents.push({ offset: extentOffset, length: extentLength });
      }
      if (result.has(id)) valid = false;
      result.set(id, { method, dataReference, baseOffset, extents });
    }
    return valid && offset === end ? result : null;
  };
  const parseItemReferences = (content: number, end: number): Map<number, number[]> | null => {
    if (end - content < 4) return null;
    const version = bytes[content], idSize = version === 0 ? 2 : version === 1 ? 4 : 0;
    if (!idSize || bytes[content + 1] !== 0 || bytes[content + 2] !== 0 || bytes[content + 3] !== 0) return null;
    const result = new Map<number, number[]>();
    let valid = true;
    const boxesValid = scan(content + 4, end, (type, payload, boxEnd) => {
      if (boxEnd - payload < idSize + 2) { valid = false; return; }
      const from = idSize === 2 ? uint16(payload) : uint32(payload);
      const count = uint16(payload + idSize);
      if (boxEnd - payload !== idSize + 2 + count * idSize) { valid = false; return; }
      if (type !== "dimg") return;
      if (result.has(from)) { valid = false; return; }
      const to: number[] = [];
      for (let i = 0; i < count; i++) {
        const at = payload + idSize + 2 + i * idSize;
        to.push(idSize === 2 ? uint16(at) : uint32(at));
      }
      result.set(from, to);
    });
    return boxesValid && valid ? result : null;
  };
  const mediaData: Array<[bigint, bigint]> = [];
  let brand = false, metadata = false, primaryType: string | undefined;
  let primaryLocation: ItemLocation | undefined, primaryIdat: [bigint, bigint] | null = null;
  let primaryReferences: number[] | undefined;
  let primaryItemInfo: Map<number, string> | null = null;
  let primaryItemLocations: Map<number, ItemLocation> | null = null;
  let metaCount = 0;
  const topLevelValid = scan(0, bytes.length, (type, content, end) => {
    if (type === "ftyp") {
      brand = content + 8 <= end && ["avif", "avis"].includes(typeAt(content));
    } else if (type === "mdat") {
      if (end > content) mediaData.push([BigInt(content), BigInt(end)]);
    } else if (type === "meta") {
      metaCount++;
      if (end - content < 4) return;
      const meta = {
        primaryItem: undefined as number | undefined,
        itemInfo: null as Map<number, string> | null,
        itemLocations: null as Map<number, ItemLocation> | null,
        itemReferences: null as Map<number, number[]> | null,
        idat: null as [bigint, bigint] | null,
      };
      let properties = false, ispe = false, associations = false, childrenValid = true;
      const childBoxesValid = scan(content + 4, end, (childType, childContent, childEnd) => {
        if (childType === "pitm") {
          if (meta.primaryItem !== undefined || childEnd - childContent < 6) { childrenValid = false; return; }
          const version = bytes[childContent], idSize = version === 0 ? 2 : version === 1 ? 4 : 0;
          if (!idSize || childEnd - childContent < 4 + idSize) { childrenValid = false; return; }
          meta.primaryItem = idSize === 2 ? uint16(childContent + 4) : uint32(childContent + 4);
        } else if (childType === "iinf") {
          if (meta.itemInfo) { childrenValid = false; return; }
          meta.itemInfo = parseItemInfo(childContent, childEnd);
          childrenValid &&= meta.itemInfo !== null;
        } else if (childType === "iloc") {
          if (meta.itemLocations) { childrenValid = false; return; }
          meta.itemLocations = parseItemLocations(childContent, childEnd);
          childrenValid &&= meta.itemLocations !== null;
        } else if (childType === "idat") {
          if (meta.idat) { childrenValid = false; return; }
          meta.idat = [BigInt(childContent), BigInt(childEnd)];
        } else if (childType === "iref") {
          if (meta.itemReferences) { childrenValid = false; return; }
          meta.itemReferences = parseItemReferences(childContent, childEnd);
          childrenValid &&= meta.itemReferences !== null;
        } else if (childType === "iprp") {
          const propertiesValid = scan(childContent, childEnd, (propertyType, propertyContent, propertyEnd) => {
            if (propertyType === "ipma") associations = propertyEnd - propertyContent >= 8;
            if (propertyType === "ipco") {
              const propertyListValid = scan(propertyContent, propertyEnd, (name, value, valueEnd) => {
                if (name === "ispe" && valueEnd - value >= 12)
                  ispe = uint32(value + 4) > 0 && uint32(value + 8) > 0;
              });
              properties = propertyListValid;
            }
          });
          childrenValid &&= propertiesValid;
        }
      });
      childrenValid &&= childBoxesValid;
      primaryType = meta.primaryItem === undefined ? undefined : meta.itemInfo?.get(meta.primaryItem);
      primaryLocation = meta.primaryItem === undefined ? undefined : meta.itemLocations?.get(meta.primaryItem);
      primaryReferences = meta.primaryItem === undefined ? undefined : meta.itemReferences?.get(meta.primaryItem);
      primaryItemInfo = meta.itemInfo;
      primaryItemLocations = meta.itemLocations;
      primaryIdat = meta.idat;
      metadata = childrenValid && meta.primaryItem !== undefined && meta.itemInfo !== null &&
        meta.itemLocations !== null && properties && ispe && associations;
    }
  });
  const itemStart = (itemLocation: ItemLocation, extent: ItemExtent): bigint | null => {
    if (itemLocation.method === 0) return itemLocation.baseOffset + extent.offset;
    if (itemLocation.method === 1 && primaryIdat) return primaryIdat[0] + itemLocation.baseOffset + extent.offset;
    return null;
  };
  const itemRanges = (itemLocation: ItemLocation): Array<[bigint, bigint]> =>
    itemLocation.method === 0 ? mediaData : itemLocation.method === 1 && primaryIdat ? [primaryIdat] : [];
  const itemHasData = (itemLocation: ItemLocation | undefined): boolean => itemLocation !== undefined &&
    itemLocation.dataReference === 0 && itemLocation.extents.length > 0 &&
    itemLocation.extents.every(extent => {
      const start = itemStart(itemLocation, extent);
      return start !== null && itemRanges(itemLocation).some(([rangeStart, rangeEnd]) =>
        start >= rangeStart && start + extent.length <= rangeEnd);
    });
  const readItemData = (itemLocation: ItemLocation, maxLength: number): Uint8Array | null => {
    if (!itemHasData(itemLocation)) return null;
    const totalLength = itemLocation.extents.reduce((sum, extent) => sum + extent.length, 0n);
    if (totalLength > BigInt(maxLength)) return null;
    const result = new Uint8Array(Number(totalLength));
    let written = 0;
    for (const extent of itemLocation.extents) {
      const start = itemStart(itemLocation, extent);
      if (start === null) return null;
      const length = Number(extent.length);
      result.set(bytes.subarray(Number(start), Number(start) + length), written);
      written += length;
    }
    return result;
  };
  const gridTileCount = (descriptor: Uint8Array | null): number | null => {
    if (!descriptor || descriptor.length < 8 || descriptor[0] !== 0 || (descriptor[1] & 0xfe) !== 0) return null;
    const dimensionSize = descriptor[1] & 1 ? 4 : 2;
    if (descriptor.length !== 4 + dimensionSize * 2) return null;
    const dimension = (at: number): number => dimensionSize === 2
      ? descriptor[at] * 256 + descriptor[at + 1]
      : descriptor[at] * 0x1000000 + descriptor[at + 1] * 0x10000 + descriptor[at + 2] * 0x100 + descriptor[at + 3];
    if (dimension(4) === 0 || dimension(4 + dimensionSize) === 0) return null;
    return (descriptor[2] + 1) * (descriptor[3] + 1);
  };
  const primaryHasData = primaryType === "av01"
    ? itemHasData(primaryLocation)
    : primaryType === "grid" && itemHasData(primaryLocation) && primaryLocation !== undefined && primaryReferences !== undefined
      ? (() => {
        const count = gridTileCount(readItemData(primaryLocation, 12));
        if (count === null || primaryReferences.length !== count || new Set(primaryReferences).size !== count) return false;
        return primaryReferences.every(id =>
          primaryItemInfo?.get(id) === "av01" && itemHasData(primaryItemLocations?.get(id)));
      })()
      : false;
  return topLevelValid && metaCount === 1 && brand && metadata && primaryHasData;
}
function checkImage(source: string, mime: string): string | null {
  const match = /^data:image\/(png|jpeg|webp|gif|avif);base64,([A-Za-z0-9+/]+={0,2})$/.exec(source);
  if (!match || !IMAGE_TYPES.has(match[1]) || match[1] !== mime) return "img src must be a supported base64 data image.";
  const encoded = match[2];
  if (encoded.length % 4 !== 0) return "Image base64 is malformed.";
  let bytes: Uint8Array;
  try {
    const binary = atob(encoded);
    bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  } catch { return "Image base64 is malformed."; }
  if (bytes.byteLength > 1024 * 1024) return "Decoded image exceeds the 1 MiB limit.";
  const canonical: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 0x6000)
    canonical.push(btoa(String.fromCharCode(...bytes.subarray(offset, offset + 0x6000))));
  if (canonical.join("") !== encoded) return "Image base64 is not canonical.";
  const starts = (...values: number[]) => values.every((value, index) => bytes[index] === value);
  const uint32 = (offset: number) => (bytes[offset] * 0x1000000 + bytes[offset + 1] * 0x10000 + bytes[offset + 2] * 0x100 + bytes[offset + 3]) >>> 0;
  const uint32le = (offset: number) => (bytes[offset] | bytes[offset + 1] << 8 | bytes[offset + 2] << 16 | bytes[offset + 3] << 24) >>> 0;
  let png = false;
  if (match[1] === "png" && starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) {
    let offset = 8, valid = true, ended = false, hasImageData = false, imageDataEnded = false;
    while (valid && offset + 12 <= bytes.length) {
      const size = uint32(offset), type = String.fromCharCode(bytes[offset + 4], bytes[offset + 5], bytes[offset + 6], bytes[offset + 7]);
      if (size > bytes.length - offset - 12 || (offset === 8 && (type !== "IHDR" || size !== 13))) valid = false;
      else {
        const next = offset + size + 12;
        if (type === "IDAT") {
          if (imageDataEnded || offset === 8) valid = false;
          if (size > 0) hasImageData = true;
        } else if (hasImageData) imageDataEnded = true;
        if (type === "IEND") { ended = size === 0 && next === bytes.length; offset = next; break; }
        offset = next;
      }
    }
    png = valid && ended && hasImageData && offset === bytes.length;
  }
  let jpeg = false;
  if (match[1] === "jpeg" && bytes.length >= 8 && starts(0xff, 0xd8) && bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9) {
    let offset = 2, sawScan = false, valid = true;
    while (valid && offset + 4 <= bytes.length - 2) {
      if (bytes[offset] !== 0xff) { valid = false; break; }
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++];
      if (marker === 0xda) { sawScan = true; break; }
      if (marker === 0xd8 || marker === 0x01 || marker >= 0xd0 && marker <= 0xd7) continue;
      if (offset + 2 > bytes.length - 2) { valid = false; break; }
      const size = bytes[offset] * 0x100 + bytes[offset + 1];
      if (size < 2 || offset + size > bytes.length - 2) valid = false;
      else offset += size;
    }
    jpeg = valid && sawScan;
  }
  const gif = match[1] === "gif" && bytes.length >= 14 &&
    (starts(0x47, 0x49, 0x46, 0x38, 0x37, 0x61) || starts(0x47, 0x49, 0x46, 0x38, 0x39, 0x61)) && bytes.at(-1) === 0x3b;
  let webp = false;
  if (match[1] === "webp" && bytes.length >= 20 && starts(0x52, 0x49, 0x46, 0x46) &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50 &&
      uint32le(4) === bytes.length - 8) {
    let offset = 12, image = false, valid = true;
    while (valid && offset + 8 <= bytes.length) {
      const size = (bytes[offset + 4] | bytes[offset + 5] << 8 | bytes[offset + 6] << 16 | bytes[offset + 7] << 24) >>> 0;
      const type = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
      const next = offset + 8 + size + (size & 1);
      if (next > bytes.length) valid = false;
      else { image ||= type === "VP8 " || type === "VP8L" || type === "VP8X"; offset = next; }
    }
    webp = valid && image && offset === bytes.length;
  }
  const avif = match[1] === "avif" && completeAvif(bytes);
  return png || jpeg || gif || webp || avif ? null : "Image MIME type does not match a complete supported file signature.";
}

const DIMENSION_TOKENS = new Set(["radius", "space", "section-gap", "card-pad"]);
const FONT_STACKS = new Set([
  "system-ui, sans-serif", "ui-monospace, monospace",
  '"manrope", sans-serif', '"ibm plex mono", monospace',
]);
const CSS_NUMBER = "(?:\\d+(?:\\.\\d+)?|\\.\\d+)";
const CSS_DIMENSION = `(?:0|${CSS_NUMBER}(?:px|rem|em|vw|vh|%))`;
const CSS_MATH_DIMENSION = `(?:${CSS_DIMENSION}|calc\\(\\s*${CSS_DIMENSION}\\s*[+-]\\s*${CSS_DIMENSION}\\s*\\)|clamp\\(\\s*${CSS_DIMENSION}\\s*,\\s*${CSS_DIMENSION}\\s*,\\s*${CSS_DIMENSION}\\s*\\))`;
const COLOR_REFERENCE = `var\\(\\s*--a67-(?:${[...COLOR_TOKENS].join("|")})\\s*\\)`;
const CSS_COLOR = `(?:#[0-9a-f]{3}(?:[0-9a-f]{3})?|${COLOR_REFERENCE})`;
const CSS_ANY_REFERENCE = /^var\(\s*--a67-([a-z0-9-]+)\s*\)$/i;

function tokenReferenceDomain(name: string): string | null {
  if (COLOR_TOKENS.has(name) || name === "table-head-bg" || name === "table-stripe") return "color";
  if (name.startsWith("font-")) return "font-stack";
  if (name === "heading-weight") return "heading-weight";
  if (name === "density") return "density";
  if (DIMENSION_TOKENS.has(name)) return "dimension";
  if (name === "shadow") return "shadow";
  if (name === "card-border" || name === "section-rule") return "border";
  return null;
}

function validTokenValue(name: string, text: string, functions: string[]): boolean {
  const references = [...text.matchAll(/var\(\s*--a67-([a-z0-9-]+)\s*\)/gi)];
  if (references.some(match => !TOKENS.has(match[1]))) return false;
  const allowedFunctions = DIMENSION_TOKENS.has(name) ? ["calc", "clamp", "var"]
    : name === "table-stripe" ? ["color-mix", "var"]
      : ["var"];
  if (functions.some(fn => !allowedFunctions.includes(fn))) return false;
  const wholeReference = CSS_ANY_REFERENCE.exec(text);
  if (wholeReference) {
    const domain = tokenReferenceDomain(name);
    return wholeReference[1] !== name && domain !== null && tokenReferenceDomain(wholeReference[1]) === domain;
  }
  if (COLOR_TOKENS.has(name)) return /^#[0-9a-f]{3}(?:[0-9a-f]{3})?$/i.test(text);
  if (name.startsWith("font-")) return FONT_STACKS.has(text.toLowerCase().replace(/\s*,\s*/g, ", ").replace(/\s+/g, " "));
  if (name === "density") {
    const value = Number(text);
    return /^(?:\d+(?:\.\d+)?|\.\d+)$/.test(text) && value >= 0.75 && value <= 1.25;
  }
  if (name === "heading-weight") return /^(?:[1-8]\d{2}|900)$/.test(text);
  if (DIMENSION_TOKENS.has(name))
    return new RegExp(`^${CSS_MATH_DIMENSION}$`, "i").test(text);
  if (name === "shadow") {
    const shadowColor = `(?:#(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})|${COLOR_REFERENCE})`;
    return text === "none" || new RegExp(`^${CSS_DIMENSION}\\s+${CSS_DIMENSION}\\s+${CSS_DIMENSION}(?:\\s+${CSS_DIMENSION})?\\s+${shadowColor}$`, "i").test(text);
  }
  if (name === "card-border" || name === "section-rule") {
    const borderStyle = "(?:solid|dashed|dotted|double)";
    return new RegExp(`^${CSS_DIMENSION}\\s+${borderStyle}\\s+${CSS_COLOR}$`, "i").test(text);
  }
  if (name === "table-head-bg") return new RegExp(`^${CSS_COLOR}$`, "i").test(text);
  if (name === "table-stripe") {
    const percent = "(?:100(?:\\.0+)?|\\d{1,2}(?:\\.\\d+)?|\\.\\d+)%";
    const mix = new RegExp(`^color-mix\\(\\s*in srgb\\s*,\\s*${CSS_COLOR}\\s+(${percent})\\s*,\\s*${CSS_COLOR}\\s*\\)$`, "i").exec(text);
    return new RegExp(`^${CSS_COLOR}$`, "i").test(text) ||
      Boolean(mix && Number.parseFloat(mix[1]) <= 100);
  }
  return false;
}

function checkStyle(value: string): boolean {
  if (value.includes("\\")) return false;
  try {
    const ast = css.parse(value, { context: "declarationList", positions: false, parseCustomProperty: true });
    let valid = true;
    css.walk(ast, node => {
      if (node.type === "Declaration") {
        const property = css.ident.decode(node.property);
        const name = property.replace(/^--a67-/, "");
        const text = css.generate(node.value).trim();
        const functions: string[] = [];
        css.walk(node.value, child => {
          if (child.type === "Function") functions.push(css.ident.decode(child.name).toLowerCase());
          if (child.type === "Url" || child.type === "Atrule" || child.type === "Raw") valid = false;
        });
        if (!property.startsWith("--a67-") || !TOKENS.has(name) || node.important ||
          /[{};]/.test(text) || !text || !validTokenValue(name, text, functions)) valid = false;
      }
      if (node.type === "Url" || node.type === "Atrule" || node.type === "Raw") valid = false;
    });
    return valid;
  } catch { return false; }
}

function attrValue(element: Element, name: string): string | undefined {
  return element.attrs.find(attribute => attribute.name === name)?.value;
}

function sourceTagOffsets(root: { childNodes: Node[] }): { starts: Set<number>; ends: Set<number> } {
  const starts = new Set<number>(), ends = new Set<number>();
  const visit = (node: Node): void => {
    if (node.nodeName !== "#text" && node.nodeName !== "#comment" && node.nodeName !== "#documentType") {
      const element = node as Element, location = element.sourceCodeLocation;
      if (location?.startTag) starts.add(location.startTag.startOffset);
      if (location?.endTag) ends.add(location.endTag.startOffset);
      for (const child of element.childNodes) visit(child);
    }
  };
  for (const child of root.childNodes) visit(child);
  return { starts, ends };
}

interface SourceTagTokens {
  starts: Map<number, boolean>;
  ends: Set<number>;
  locationless: boolean;
}

function sourceTagTokens(source: string): SourceTagTokens {
  const starts = new Map<number, boolean>(), ends = new Set<number>(), noop = () => {};
  let locationless = false;
  const handler: TokenHandler = {
    onComment: noop, onDoctype: noop,
    onStartTag: token => {
      if (token.location) starts.set(token.location.startOffset, token.selfClosing);
      else locationless = true;
    },
    onEndTag: token => {
      if (token.location) ends.add(token.location.startOffset);
      else locationless = true;
    },
    onEof: noop, onCharacter: noop, onNullCharacter: noop, onWhitespaceCharacter: noop,
  };
  new Tokenizer({ sourceCodeLocationInfo: true }, handler).write(source, true);
  return { starts, ends, locationless };
}

export function validatePageFragment(source: string, options: { lang?: string } = {}): PageDocument {
  if (typeof source !== "string" || source.length > 1_500_000) reject([{ code: "too-large", message: "Page source must be a string no longer than 1,500,000 characters." }]);
  const parseErrors: ValidationIssue[] = [];
  const fragment = parseFragment(source, { sourceCodeLocationInfo: true, onParseError: error => {
    parseErrors.push({ code: "page-parse", message: `HTML parser error: ${error.code}` });
  } });
  if (parseErrors.length) reject(parseErrors);
  const sourceTokens = sourceTagTokens(source);
  const issues: ValidationIssue[] = [], ids = new Map<string, Element>(), normalizedIds = new Set<string>(), items = new Set<string>();
  const refs: Array<{ value: string; kind: string; target?: "labelable" | "records" | "table" | "table-source" | "th" | "marker" }> = [];
  const components: Element[] = [];
  const addComponentIssue = (message: string): void => { issues.push({ code: "page-component", message }); };
  const textContent = (node: Node): string => node.nodeName === "#text"
    ? (node as DefaultTreeAdapterTypes.TextNode).value
    : "childNodes" in node ? (node as Element).childNodes.map(textContent).join("") : "";
  const contentChildren = (element: Element): Node[] => element.childNodes.filter(node =>
    node.nodeName !== "#text" || (node as DefaultTreeAdapterTypes.TextNode).value.trim() !== "");
  const descendants = (node: Node, predicate: (element: Element) => boolean): Element[] => {
    if (!("tagName" in node)) return [];
    const element = node as Element;
    return [...(predicate(element) ? [element] : []), ...element.childNodes.flatMap(child => descendants(child, predicate))];
  };
  const visit = (node: Node): void => {
    const location = node.sourceCodeLocation;
    if (!location) issues.push({ code: "page-source-location", message: "Page contains a parser-implied node without a source location." });
    if (node.nodeName === "#comment") {
      const comment = node as DefaultTreeAdapterTypes.CommentNode;
      if (comment.data.includes("--")) issues.push({ code: "page-comment", message: "HTML comments may not contain --." });
      return;
    }
    if (node.nodeName === "#text") {
      const text = (node as DefaultTreeAdapterTypes.TextNode).value;
      if (/[\u0000\u0001-\u0008\u000b\u000c\u000e-\u001f\ufffd]/.test(text)) issues.push({ code: "page-text", message: "Page text contains a forbidden control or replacement character." });
      return;
    }
    if (node.nodeName === "#documentType") {
      issues.push({ code: "page-doctype", message: "A page fragment cannot contain a doctype." });
      return;
    }
    const element = node as Element, name = element.tagName.toLowerCase();
    if (attrValue(element, "data-tone") === "inverse") {
      let ancestor: DefaultTreeAdapterTypes.ParentNode | null = element.parentNode;
      let nestedInverse = false;
      let opaqueAncestor = false;
      while (ancestor && "tagName" in ancestor) {
        const parent = ancestor as Element;
        const parentName = parent.tagName.toLowerCase();
        nestedInverse ||= attrValue(parent, "data-tone") === "inverse";
        opaqueAncestor ||= OPAQUE_TONE_SURFACES[parentName] === true;
        ancestor = parent.parentNode;
      }
      if (nestedInverse) issues.push({
        code: "page-data",
        message: 'data-tone="inverse" cannot be nested inside another inverse region.',
      });
      if (opaqueAncestor || OPAQUE_TONE_SURFACES[name] === true) issues.push({
        code: "page-data",
        message: 'data-tone="inverse" is not allowed on or inside <table>, <thead>, <th>, <pre>, or <code>.',
      });
    }
    if (name === "a67-toc" || name === "a67-kpi" || name === "a67-chart" || name === "a67-tabs" || name === "a67-logo" || name === "a67-form") components.push(element);
    if (name === "header" && attrValue(element, "data-variant") === "hero" && attrValue(element, "data-style") === "aurora") {
      for (const child of element.childNodes) {
        if (child.nodeName !== "figure") continue;
        const hasDirectText = (child as Element).childNodes.some(content =>
          content.nodeName === "#text" && (content as DefaultTreeAdapterTypes.TextNode).value.trim() !== "");
        if (hasDirectText) issues.push({
          code: "page-content-model",
          message: "Aurora hero figures may not contain direct text; wrap text in a child element to keep it on an opaque surface.",
        });
      }
    }
    const svg = SVG_ELEMENTS.has(name) || element.namespaceURI === SVG_NS;
    const startOffset = element.sourceCodeLocation?.startTag?.startOffset;
    const explicitlySelfClosing = svg && startOffset !== undefined && sourceTokens.starts.get(startOffset) === true;
    if (!element.sourceCodeLocation?.startTag || (!HTML_ELEMENTS.has(name) && !SVG_ELEMENTS.has(name) && !COMPONENT_ATTRS[name])) {
      issues.push({ code: "page-element", message: `Element <${name}> is not in the page vocabulary.` });
    }
    if (!VOID_ELEMENTS.has(name) && !element.sourceCodeLocation?.endTag && !explicitlySelfClosing)
      issues.push({ code: "page-source-end-tag", message: `Element <${name}> requires an explicit end tag.` });
    if (svg ? element.namespaceURI !== SVG_NS : element.namespaceURI !== HTML_NS) issues.push({ code: "page-namespace", message: "Custom and unexpected element namespaces are not allowed." });
    if (VOID_ELEMENTS.has(name) && element.childNodes.length) issues.push({ code: "page-content-model", message: `<${name}> must be empty.` });
    if (name === "form" || name === "textarea" || name === "style" || name === "script" || name === "a67-custom")
      issues.push({ code: "page-element", message: `<${name}> is not authorable page content.` });
    if (name === "img") {
      const src = attrValue(element, "src"), alt = attrValue(element, "alt"), width = attrValue(element, "width"), height = attrValue(element, "height");
      if (src === undefined || !/^data:image\/(png|jpeg|webp|gif|avif);base64,/.test(src)) issues.push({ code: "page-image-src", message: "Images require an inline supported data URI." });
      else {
        const mime = /^data:image\/([^;]+)/.exec(src)?.[1] ?? "";
        const imageError = checkImage(src, mime);
        if (imageError) issues.push({ code: "page-image", message: imageError });
      }
      if (alt === undefined) issues.push({ code: "page-image-alt", message: "Images require an alt attribute." });
      if (width === undefined || !/^[1-9]\d*$/.test(width)) issues.push({ code: "page-image-width", message: "Images require a positive integer width." });
      if (height === undefined || !/^[1-9]\d*$/.test(height)) issues.push({ code: "page-image-height", message: "Images require a positive integer height." });
      if (attrValue(element, "loading") !== undefined && attrValue(element, "loading") !== "lazy") issues.push({ code: "page-image-loading", message: "Image loading may only be lazy." });
      if (attrValue(element, "decoding") !== undefined && attrValue(element, "decoding") !== "async") issues.push({ code: "page-image-decoding", message: "Image decoding may only be async." });
    }
    if (name === "a") {
      const href = attrValue(element, "href");
      if (href !== undefined && !/^#[^\s#]+$/.test(href)) issues.push({ code: "page-link", message: "Links may only reference a fragment identifier." });
    }
    for (const attribute of element.attrs) {
      const attr = attribute.name.toLowerCase(), value = attribute.value;
      const sourceLocation = element.sourceCodeLocation?.attrs?.[attr];
      if (!sourceLocation) issues.push({ code: "page-attribute-source", message: `Attribute ${attr} has no source location.` });
      else {
        const raw = source.slice(sourceLocation.startOffset, sourceLocation.endOffset), equal = raw.indexOf("="), quote = equal < 0 ? "" : raw.slice(equal + 1).trimStart()[0];
        if (quote !== '"' || !raw.endsWith('"')) issues.push({ code: "page-attribute-quote", message: `Attribute ${attr} must use double quotes.` });
      }
      if (!attrAllowed(name, attr, element.namespaceURI, element.attrs.some(attribute => attribute.name === "data-field"))) issues.push({ code: "page-attribute", message: `Attribute ${attr} is not allowed on <${name}>.` });
      if (Object.hasOwn(DATA_VALUES, attr)) {
        const allowed = DATA_VALUES[attr];
        if (attr === "data-item" && !/^[A-Za-z0-9_-]{1,64}$/.test(value)) issues.push({ code: "page-data", message: "data-item is invalid." });
        else if (attr === "data-item" && items.has(value)) issues.push({ code: "page-data", message: "data-item values must be unique within a page." });
        else if (attr === "data-item") items.add(value);
        if (attr === "data-field" && !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value)) issues.push({ code: "page-data", message: "data-field is invalid." });
        else if (allowed && !allowed.has(value)) issues.push({ code: "page-data", message: `${attr} has an unsupported value.` });
        else if ((attr === "data-badge" || attr === "data-finding") && value !== "") issues.push({ code: "page-data", message: `${attr} is a boolean presence flag.` });
        else if (!allowed && attr !== "data-badge" && attr !== "data-finding" && value.length === 0) issues.push({ code: "page-data", message: `${attr} requires a value.` });
      }
      if (attr === "style" && !checkStyle(value)) issues.push({ code: "page-style", message: "Inline style may contain only parsed, registered --a67-* declarations." });
      if (attr === "id") {
        const normalized = value.normalize("NFC");
        if (!/^\p{L}[\p{L}\p{M}\p{N}_.:-]*$/u.test(value) || UTF8_ENCODER.encode(value).length > 128 || normalizedIds.has(normalized)) issues.push({ code: "page-id", message: "IDs must be unique, valid, and at most 128 UTF-8 bytes." });
        else {
          normalizedIds.add(normalized);
          ids.set(value, element);
        }
      }
      if (["for", "headers", "aria-labelledby", "aria-describedby", "aria-controls"].includes(attr)) {
        const target = attr === "headers" ? "th"
          : attr === "for" && name === "label" ? "labelable"
            : attr === "for" && name === "a67-chart" ? "table-source" : undefined;
        const values = attr === "for" ? [value] : value.trim().split(/\s+/);
        for (const id of values) refs.push({ value: id, kind: attr, target });
      }
      if (attr === "width" || attr === "height" || attr === "colspan" || attr === "rowspan" || attr === "span") {
        if (!/^[1-9]\d*$/.test(value)) issues.push({ code: "page-number", message: `${attr} must be a positive integer.` });
      }
      if (attr === "type" && name === "button" && value !== "button") issues.push({ code: "page-button", message: "Buttons may only use type=button." });
      if (attr === "href" && value.startsWith("#")) refs.push({ value: value.slice(1), kind: "id" });
      if (element.namespaceURI === SVG_NS && ["fill", "stroke"].includes(attr)) {
        const validPaint = value === "none" || value === "currentColor" ||
          /^var\(--a67-(?:bg|surface|ink|muted|line|accent|accent-ink|on-accent|ok|warn|crit|focus|c[1-6])\)$/.test(value);
        if (!validPaint) issues.push({ code: "page-svg-paint", message: `SVG ${attr} accepts only none, currentColor, or a registered --a67 color token.` });
      }
      if (element.namespaceURI === SVG_NS && attr === "marker-end") {
        try {
          const paint = css.parse(value, { context: "value", parseCustomProperty: true });
          let hasUrl = false;
          css.walk(paint, node => {
            if (node.type === "Url" || node.type === "Function" && css.ident.decode(node.name).toLowerCase() === "url") hasUrl = true;
          });
          if (hasUrl) {
            const localMarker = /^url\(\s*#([^\s#)]+)\s*\)$/i.exec(value);
            if (localMarker) refs.push({ value: localMarker[1]!, kind: "SVG marker", target: "marker" });
            else issues.push({ code: "page-svg-reference", message: "SVG marker values may not reference external resources." });
          }
        } catch {
          issues.push({ code: "page-svg-value", message: "SVG marker value is malformed." });
        }
      }
      if (attr === "xmlns" && (name !== "svg" || value !== SVG_NS)) issues.push({ code: "page-namespace", message: "Only the fixed SVG namespace is allowed." });
    }
    for (const child of element.childNodes) visit(child);
  };
  for (const child of fragment.childNodes) visit(child);
  for (const component of components) {
    const name = component.tagName.toLowerCase(), children = contentChildren(component);
    const required = (attribute: string): boolean => {
      const value = attrValue(component, attribute);
      return value !== undefined && value.trim().length > 0;
    };
    if (["a67-toc", "a67-kpi", "a67-chart", "a67-logo"].includes(name) && children.length)
      addComponentIssue(`<${name}> may not have authored children.`);
    if (name === "a67-form") {
      const descriptors = children.filter(child => "tagName" in child && (child as Element).tagName.toLowerCase() === "label" && attrValue(child as Element, "data-field") !== undefined);
      if (descriptors.length !== children.length) addComponentIssue("<a67-form> children must be label field descriptors.");
      const names = descriptors.map(child => attrValue(child as Element, "data-field") ?? "");
      if (new Set(names).size !== names.length) addComponentIssue("<a67-form> field descriptors must use unique data-field names.");
    }
    if (name === "a67-kpi") {
      const collection = attrValue(component, "collection"), field = attrValue(component, "field"), aggregate = attrValue(component, "aggregate");
      const bound = collection !== undefined || field !== undefined || aggregate !== undefined;
      if (!required("label")) addComponentIssue("<a67-kpi> requires a non-empty label attribute.");
      if (bound) {
        if (!required("collection") || !/^[a-z][a-z0-9_-]{0,63}$/.test(collection ?? "")) addComponentIssue("<a67-kpi> collection must be a valid project collection name.");
        if (!required("field") || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(field ?? "")) addComponentIssue("<a67-kpi> field must be a valid collection field name.");
        if (aggregate !== "sum") addComponentIssue("<a67-kpi> aggregate must be sum.");
        if (attrValue(component, "value") !== undefined || attrValue(component, "delta") !== undefined || attrValue(component, "trend") !== undefined)
          addComponentIssue("<a67-kpi> record bindings cannot include literal value, delta, or trend attributes.");
      } else if (!required("value")) addComponentIssue("<a67-kpi> requires a non-empty value attribute when unbound.");
      const trend = attrValue(component, "trend");
      if (!bound && trend !== undefined && !["up", "down"].includes(trend)) addComponentIssue("<a67-kpi> trend must be up or down.");
      if (!bound && trend !== undefined && !required("delta")) addComponentIssue("<a67-kpi> trend requires a non-empty delta.");
    }
    if (name === "a67-chart") {
      const type = attrValue(component, "type");
      if (!required("for") || !required("type") || !required("title") || !required("label-column") || !required("value-column"))
        addComponentIssue("<a67-chart> requires for, type, title, label-column, and value-column.");
      if (type !== undefined && !["bar", "line", "donut"].includes(type)) addComponentIssue("<a67-chart> type must be bar, line, or donut.");
      const source = ids.get(attrValue(component, "for") ?? "");
      if (source?.tagName.toLowerCase() === "a67-records") {
        let hiddenAncestor: DefaultTreeAdapterTypes.ParentNode | null = source;
        while (hiddenAncestor) {
          if ("attrs" in hiddenAncestor && (hiddenAncestor as Element).attrs.some(attribute => attribute.name === "hidden")) break;
          hiddenAncestor = "parentNode" in hiddenAncestor ? hiddenAncestor.parentNode : null;
        }
        if (hiddenAncestor) addComponentIssue("<a67-chart> referenced records table and its ancestors must be visible.");
        const fields = attrValue(source, "fields");
        if (fields !== undefined) {
          const names = fields.split(",").map(field => field.trim()).filter(Boolean);
          if (!names.includes(attrValue(component, "label-column") ?? "") || !names.includes(attrValue(component, "value-column") ?? ""))
            addComponentIssue("<a67-chart> columns must name fields in its referenced records table.");
        }
      } else if (source?.tagName.toLowerCase() === "table") {
        const table = source;
        let hiddenAncestor: DefaultTreeAdapterTypes.ParentNode | null = table;
        while (hiddenAncestor) {
          if ("attrs" in hiddenAncestor && (hiddenAncestor as Element).attrs.some(attribute => attribute.name === "hidden")) break;
          hiddenAncestor = "parentNode" in hiddenAncestor ? hiddenAncestor.parentNode : null;
        }
        if (hiddenAncestor) addComponentIssue("<a67-chart> referenced table and its ancestors must be visible.");
        const withinSection = (element: Element, section: string): boolean => {
          let parent: DefaultTreeAdapterTypes.ParentNode | null = element.parentNode;
          while (parent && parent !== table) {
            if ("tagName" in parent && (parent as Element).tagName.toLowerCase() === section) return true;
            parent = "parentNode" in parent ? parent.parentNode : null;
          }
          return false;
        };
        const headers = descendants(table, element => element.tagName.toLowerCase() === "th" && withinSection(element, "thead"))
          .map(header => textContent(header).trim());
        if (!headers.includes(attrValue(component, "label-column") ?? "") || !headers.includes(attrValue(component, "value-column") ?? ""))
          addComponentIssue("<a67-chart> columns must name headings in its referenced table.");
        const valueHeadingIndex = headers.indexOf(attrValue(component, "value-column") ?? "");
        const bodyRows = descendants(table, element => element.tagName.toLowerCase() === "tr" && withinSection(element, "tbody"));
        if (valueHeadingIndex < 0 || bodyRows.length === 0 || bodyRows.some(row => {
          const cells = row.childNodes.filter(cell => cell.nodeName === "th" || cell.nodeName === "td") as Element[];
          const value = cells[valueHeadingIndex] ? textContent(cells[valueHeadingIndex]).trim() : "";
          return value.length === 0 || parseLocalizedNumber(value, options.lang ?? "en") === null;
        })) addComponentIssue("<a67-chart> referenced table must contain finite numeric values for its value column.");
        const values = bodyRows.map(row => {
          const cells = row.childNodes.filter(cell => cell.nodeName === "th" || cell.nodeName === "td") as Element[];
          return parseLocalizedNumber((cells[valueHeadingIndex] ? textContent(cells[valueHeadingIndex]) : "").trim(), options.lang ?? "en")!;
        });
        if (type === "donut" && (values.some(value => value < 0) || values.every(value => value === 0)))
          addComponentIssue("<a67-chart> donut charts require non-negative values with a positive total.");
      }
    }
    if (name === "a67-tabs") {
      const tablist = children[0];
      const tabLists = children.filter(child => "tagName" in child && attrValue(child as Element, "role") === "tablist");
      const tabItems = tablist && "tagName" in tablist ? contentChildren(tablist as Element) : [];
      const tabs = tabItems.filter(child => "tagName" in child && (child as Element).tagName.toLowerCase() === "button" && attrValue(child as Element, "role") === "tab") as Element[];
      const panels = children.slice(1).filter(child => "tagName" in child && attrValue(child as Element, "role") === "tabpanel") as Element[];
      if (children.length < 2 || tabLists.length !== 1 || tablist !== tabLists[0] || panels.length !== children.length - 1 || tabs.length === 0 || tabs.length !== panels.length || tabItems.length !== tabs.length)
        addComponentIssue("<a67-tabs> requires one first tablist of buttons followed by one matching panel per tab.");
      const selectedTabs = tabs.filter(tab => attrValue(tab, "aria-selected") === "true");
      if (selectedTabs.length !== 1) addComponentIssue("<a67-tabs> requires exactly one selected tab.");
      if (tabs.length > 0 && tabs.every(tab => tab.attrs.some(attribute => attribute.name === "disabled")))
        addComponentIssue("<a67-tabs> requires at least one enabled tab.");
      if (selectedTabs.some(tab => tab.attrs.some(attribute => attribute.name === "disabled")))
        addComponentIssue("<a67-tabs> selected tab cannot be disabled.");
      for (const tab of tabs) {
        const panelId = attrValue(tab, "aria-controls");
        const panel = panels.find(candidate => attrValue(candidate, "id") === panelId);
        const selected = attrValue(tab, "aria-selected") === "true";
        if (attrValue(tab, "id") === undefined || !panel || attrValue(panel, "aria-labelledby") !== attrValue(tab, "id"))
          addComponentIssue("<a67-tabs> tab and panel IDs must be paired through aria-controls and aria-labelledby.");
        if (attrValue(tab, "tabindex") !== (selected ? "0" : "-1"))
          addComponentIssue("<a67-tabs> requires roving tabindex on its tabs.");
        if (panel && selected === panel.attrs.some(attribute => attribute.name === "hidden"))
          addComponentIssue("<a67-tabs> selected tab and visible panel state must match.");
      }
    }
  }
  const fragmentTags = sourceTagOffsets(fragment);
  if (sourceTokens.locationless)
    issues.push({ code: "page-source-coverage", message: "A source tag has no tokenizer location." });
  for (const offset of sourceTokens.starts.keys()) if (!fragmentTags.starts.has(offset))
    issues.push({ code: "page-source-coverage", message: "A source tag was discarded by fragment parsing." });
  for (const offset of sourceTokens.ends) if (!fragmentTags.ends.has(offset))
    issues.push({ code: "page-source-coverage", message: "A source end tag was discarded by fragment parsing." });
  for (const offset of fragmentTags.starts) if (!sourceTokens.starts.has(offset))
    issues.push({ code: "page-source-coverage", message: "A fragment element has no matching source start tag." });
  for (const offset of fragmentTags.ends) if (!sourceTokens.ends.has(offset))
    issues.push({ code: "page-source-coverage", message: "A fragment end tag has no matching source token." });
  for (const ref of refs) {
    const target = ids.get(ref.value);
    if (!target) {
      issues.push({ code: "page-reference", message: `Unresolved ${ref.kind} reference: ${ref.value}.` });
      continue;
    }
    const tag = target.tagName.toLowerCase();
    const validTarget = ref.target === undefined ||
      ref.target === "labelable" && LABELABLE_ELEMENTS.has(tag) && !(tag === "input" && attrValue(target, "type")?.toLowerCase() === "hidden") ||
      ref.target === "records" && tag === "a67-records" ||
      ref.target === "table" && tag === "table" ||
      ref.target === "table-source" && (tag === "table" || tag === "a67-records") ||
      ref.target === "th" && tag === "th" ||
      ref.target === "marker" && tag === "marker";
    if (!validTarget) issues.push({ code: "page-reference-target", message: `${ref.kind} reference targets an incompatible element: ${ref.value}.` });
  }
  if (issues.length) reject(issues);
  return { source, fragment };
}
