/**
 * TEST-BUILD-ONLY layout diagnostic (see build-layout-debug.sh). Compiled in
 * only when the build-time constant __RUNE_LAYOUT_DEBUG__ is true; release
 * builds define it false so none of this ships.
 *
 * It records geometry and computed style only. It NEVER reads or emits any
 * text: no line text, no textContent/innerText, no characters of the note.
 * Class names and numbers only.
 */

export const LAYOUT_DEBUG: boolean =
  typeof __RUNE_LAYOUT_DEBUG__ !== "undefined" && __RUNE_LAYOUT_DEBUG__ === true;

export const LAYOUT_DEBUG_PATH = "_rune/layout-debug.md";

/** The few DOM members the collector reads; real elements satisfy it. */
export interface ElLike {
  className?: string;
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
  offsetTop?: number;
  offsetHeight?: number;
  getBoundingClientRect(): { top: number; left: number; width: number; height: number };
  querySelectorAll?(sel: string): ArrayLike<ElLike>;
}

export interface LayoutDebugInput {
  host: ElLike;
  /** Obsidian's .view-content (our contentEl). */
  viewContent: ElLike;
  editorDom: ElLike;
  scroller: ElLike;
  content: ElLike;
  /** CM6 view: only viewport / visibleRanges / contentHeight / state.doc.lines. */
  view: {
    viewport: { from: number; to: number };
    visibleRanges: readonly { from: number; to: number }[];
    contentHeight: number;
    state: { doc: { lines: number } };
  };
  lines: ArrayLike<ElLike>;
  visualViewport: { width: number; height: number; offsetTop: number } | null;
  innerHeight: number;
  getComputedStyle(el: ElLike): { getPropertyValue(name: string): string };
  /** What fired this report, and when (ISO). */
  label: string;
  time: string;
  outerHeight: number;
  docClientHeight: number;
  /** document.body.className (class names only). */
  bodyClasses: string;
  /** Is .cm-content the document's active element? */
  contentIsActive: boolean;
}

const n = (v: unknown): string =>
  typeof v === "number" && Number.isFinite(v) ? String(Math.round(v * 100) / 100) : "?";

/** CSS values and class names only; strip anything that is not plain token text. */
const tok = (v: string | undefined): string =>
  (v ?? "").replace(/[^A-Za-z0-9 _.,:%()#+\-/]/g, "").slice(0, 80);

function rect(el: ElLike): string {
  const r = el.getBoundingClientRect();
  return `top=${n(r.top)} left=${n(r.left)} w=${n(r.width)} h=${n(r.height)}`;
}

function styleOf(input: LayoutDebugInput, el: ElLike, props: string[]): string {
  const cs = input.getComputedStyle(el);
  return props.map((p) => `${p}=${tok(cs.getPropertyValue(p))}`).join(" ");
}

const BOX_PROPS = ["overflow", "overflow-y", "position", "transform", "will-change", "opacity", "visibility", "contain"];
const LINE_PROPS = ["color", "opacity", "visibility", "display"];

export function collectLayoutDebug(input: LayoutDebugInput): string {
  const out: string[] = [`## ${tok(input.label)} @ ${tok(input.time)}`, "", "```"];
  const vv = input.visualViewport;
  out.push(
    `window.outerHeight=${n(input.outerHeight)} documentElement.clientHeight=${n(input.docClientHeight)}`,
    `body.classes=[${tok(input.bodyClasses)}]`,
    `cm-content is document.activeElement=${input.contentIsActive ? "yes" : "no"}`,
    `visualViewport w=${n(vv?.width)} h=${n(vv?.height)} offsetTop=${n(vv?.offsetTop)}`,
    `window.innerHeight=${n(input.innerHeight)}`,
    ""
  );
  const boxes: [string, ElLike][] = [
    ["view-content", input.viewContent],
    ["host", input.host],
    [".cm-editor", input.editorDom],
    [".cm-scroller", input.scroller],
    [".cm-content", input.content],
  ];
  for (const [name, el] of boxes) {
    out.push(
      `${name}: ${rect(el)} clientHeight=${n(el.clientHeight)} scrollHeight=${n(el.scrollHeight)} scrollTop=${n(el.scrollTop)}`,
      `  ${styleOf(input, el, BOX_PROPS)}`
    );
  }
  const v = input.view;
  out.push(
    "",
    `cm viewport=${n(v.viewport.from)}-${n(v.viewport.to)} contentHeight=${n(v.contentHeight)} doc.lines=${n(v.state.doc.lines)}`,
    `cm visibleRanges=${v.visibleRanges.map((r) => `${n(r.from)}-${n(r.to)}`).join(",")}`,
    "",
    `rendered .cm-line count=${n(input.lines.length)}`
  );
  for (let i = 0; i < input.lines.length; i++) {
    const l = input.lines[i];
    out.push(
      `line ${i}: offsetTop=${n(l.offsetTop)} height=${n(l.offsetHeight)} rectTop=${n(l.getBoundingClientRect().top)} ${styleOf(input, l, LINE_PROPS)} classes=[${tok(l.className)}]`
    );
  }
  out.push("```", "");
  return out.join("\n");
}

export const LAYOUT_DEBUG_MAX_BYTES = 200 * 1024;

/**
 * Append a section to the report, keeping the file under ~200 KB by dropping
 * the OLDEST sections (the newest are kept). Pure.
 */
export function appendCapped(existing: string, section: string, max = LAYOUT_DEBUG_MAX_BYTES): string {
  const title = "# rune layout debug\n\n";
  let body = existing.startsWith(title) ? existing.slice(title.length) : existing;
  body += (body && !body.endsWith("\n") ? "\n" : "") + section;
  while (body.length + title.length > max) {
    const next = body.indexOf("\n## ", 1);
    if (next < 0) {
      body = body.slice(body.length - (max - title.length));
      break;
    }
    body = body.slice(next + 1);
  }
  return title + body;
}

/** Collect from a live CM6 view and append to `_rune/layout-debug.md`. Never throws. */
export async function writeLayoutDebug(
  ed: import("@codemirror/view").EditorView,
  host: HTMLElement,
  adapter: {
    exists(p: string): Promise<boolean>;
    mkdir(p: string): Promise<void>;
    read(p: string): Promise<string>;
    write(p: string, data: string): Promise<void>;
  },
  label: string,
  viewContent: HTMLElement
): Promise<void> {
  try {
    const section = collectLayoutDebug({
      host: host as unknown as ElLike,
      viewContent: viewContent as unknown as ElLike,
      editorDom: ed.dom as unknown as ElLike,
      scroller: ed.scrollDOM as unknown as ElLike,
      content: ed.contentDOM as unknown as ElLike,
      view: ed,
      lines: ed.dom.querySelectorAll(".cm-line") as unknown as ArrayLike<ElLike>,
      visualViewport: window.visualViewport,
      innerHeight: window.innerHeight,
      getComputedStyle: (el) => window.getComputedStyle(el as unknown as Element),
      label,
      time: new Date().toISOString(),
      outerHeight: window.outerHeight,
      docClientHeight: document.documentElement.clientHeight,
      bodyClasses: document.body.className,
      contentIsActive: document.activeElement === ed.contentDOM,
    });
    if (!(await adapter.exists("_rune"))) await adapter.mkdir("_rune");
    const prev = (await adapter.exists(LAYOUT_DEBUG_PATH)) ? await adapter.read(LAYOUT_DEBUG_PATH) : "";
    await adapter.write(LAYOUT_DEBUG_PATH, appendCapped(prev, section + "\n"));
  } catch {
    /* diagnostic only */
  }
}
