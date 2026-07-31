// @ts-check
/**
 * The keyboard sink's focus and selection handling.
 *
 * Written for a real bug: every printable keystroke ran
 * `window.getSelection().removeAllRanges()` before letting the character
 * through. Chrome and Safari expose a focused <textarea>'s own internal
 * selection through that call, so it destroyed the caret the browser was about
 * to insert into -- the keystroke was dropped, no `input` event fired, and
 * typing was dead in every engine except Firefox, which per spec keeps text
 * control selections out of `window.getSelection()` entirely.
 *
 * It failed silently, it failed only in the browsers most visitors use, and it
 * was invisible in Firefox where it was developed. So the rule is asserted here
 * rather than trusted: **while the sink has focus, nothing may touch the
 * selection.**
 */

import test from "node:test";
import assert from "node:assert/strict";

/* ── Fakes ──────────────────────────────────────────────────────────────────
 * Hand-rolled rather than jsdom: the suite runs under a bare `node --test` with
 * no dependencies, and Terminal only needs a small slice of the DOM. */

class FakeNode {
  constructor(tag = "div") {
    this.tag = tag;
    /** @type {FakeNode[]} */ this.childNodes = [];
    this.nodeType = 1;
    this.textContent = "";
    this.className = "";
    this.hidden = false;
    this.disabled = false;
    this.value = "";
    this.tabIndex = 0;
    /** @type {Record<string, string>} */ this.dataset = {};
    /** @type {Record<string, Array<(ev: any) => void>>} */ this.listeners = {};
    this.scrollTop = 0;
    this.scrollLeft = 0;
    this.clientWidth = 640;
    this.clientHeight = 480;
    /** @type {Record<string, string>} */ this.styles = {};
    this.style = new Proxy(/** @type {any} */ ({}), {
      get: (_t, prop) => this.styles[String(prop)],
      set: (_t, prop, value) => {
        this.styles[String(prop)] = String(value);
        return true;
      },
    });
  }
  appendChild(child) {
    this.childNodes.push(child);
    return child;
  }
  replaceChildren(...kids) {
    this.childNodes = kids;
  }
  remove() {}
  querySelector(sel) {
    return this.childNodes.find((k) => "." + k.className === sel) ?? null;
  }
  addEventListener(type, fn) {
    (this.listeners[type] ??= []).push(fn);
  }
  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] ?? []).filter((f) => f !== fn);
  }
  fire(type, ev = {}) {
    let prevented = false;
    const event = { preventDefault: () => (prevented = true), ...ev };
    for (const fn of this.listeners[type] ?? []) fn(event);
    return prevented;
  }
  // Metrics divides a 100-glyph run by 100; 800/100 gives an 8px cell.
  getBoundingClientRect() {
    return { width: 800, height: 20, top: 0, left: 0 };
  }
}

/** The <textarea>, which additionally tracks focus the way the browser would. */
class FakeSink extends FakeNode {
  /** @param {{ current: FakeNode | null }} active */
  constructor(active) {
    super("textarea");
    this.active = active;
    this.className = "kbd-sink";
  }
  focus() {
    this.active.current = this;
    this.fire("focus");
  }
  blur() {
    if (this.active.current === this) this.active.current = null;
    this.fire("blur");
  }
}

/**
 * Stand up a Terminal over fakes, plus handles on the globals under test.
 *
 * The module is imported *inside* the harness because it reads `document` and
 * `window` at call time only -- but Writer captures a DocumentFragment in a
 * field initializer, so the fakes must exist before construction.
 */
async function harness() {
  const saved = {
    document: /** @type {any} */ (globalThis).document,
    window: /** @type {any} */ (globalThis).window,
    ResizeObserver: /** @type {any} */ (globalThis).ResizeObserver,
    KeyboardEvent: /** @type {any} */ (globalThis).KeyboardEvent,
    HTMLElement: /** @type {any} */ (globalThis).HTMLElement,
  };
  // terminal.js validates its input-line lookups with `instanceof HTMLElement`,
  // so the fake has to satisfy it.
  /** @type {any} */ (globalThis).HTMLElement = FakeNode;

  /** @type {{ current: FakeNode | null }} */
  const active = { current: null };

  const root = new FakeNode();
  const viewport = new FakeNode();
  const output = new FakeNode();
  const probe = new FakeNode("span");
  const inputline = new FakeNode();
  for (const cls of ["prompt", "line", "line-pre", "cursor", "line-post"]) {
    const el = new FakeNode("span");
    el.className = cls;
    inputline.appendChild(el);
  }
  // .line-pre/.cursor/.line-post are looked up on #inputline in the real DOM
  // because they are nested inside .line; the flat fake keeps them siblings.
  const kbd = new FakeSink(active);

  /** Every removeAllRanges() call, with whether the sink was focused for it. */
  /** @type {Array<{ sinkFocused: boolean }>} */
  const cleared = [];
  let collapsed = true;
  let selectionText = "";

  const selection = {
    get isCollapsed() {
      return collapsed;
    },
    toString: () => selectionText,
    removeAllRanges() {
      cleared.push({ sinkFocused: active.current === kbd });
      collapsed = true;
      selectionText = "";
    },
  };

  /** @type {any} */ (globalThis).document = {
    get activeElement() {
      return active.current;
    },
    title: "",
    createElement: (tag) => new FakeNode(String(tag).toLowerCase()),
    createTextNode: (t) => {
      const n = new FakeNode("#text");
      n.nodeType = 3;
      n.textContent = String(t);
      return n;
    },
    createDocumentFragment: () => new FakeNode("#fragment"),
    addEventListener: (type, fn) => root.addEventListener("doc:" + type, fn),
    removeEventListener: (type, fn) => root.removeEventListener("doc:" + type, fn),
    fonts: undefined,
  };
  /** @type {any} */ (globalThis).window = {
    getSelection: () => selection,
    innerHeight: 800,
  };
  /** @type {any} */ (globalThis).ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  /** @type {any} */ (globalThis).KeyboardEvent = class {
    constructor(type, init = {}) {
      this.type = type;
      this.key = init.key ?? "";
    }
  };
  // Node exposes Node.TEXT_NODE via the DOM in browsers only.
  /** @type {any} */ (globalThis).Node ??= { TEXT_NODE: 3 };

  const { Terminal } = await import("../site/js/terminal/terminal.js");
  const term = new Terminal(
    /** @type {any} */ ({ root, viewport, output, inputline, kbd, probe }),
  );

  /** A minimal mode that records the text it is handed. */
  /** @type {string[]} */
  const inserted = [];
  term.modes.push({
    id: "test",
    label: "test",
    editable: false,
    buffer: null,
    prompt: () => [],
    onKey() {},
    onInsertText(text) {
      inserted.push(text);
    },
  });

  return {
    kbd,
    root,
    inserted,
    cleared,
    active,
    /** Simulate a document-level keydown, as terminal.js listens for. */
    keydown: (init) => root.fire("doc:keydown", { key: "", ...init }),
    /** Simulate the browser delivering a character into the textarea. */
    type: (ch) => {
      kbd.value += ch;
      kbd.fire("input");
    },
    /** Put a live, non-empty document selection in place. */
    select: (text) => {
      collapsed = false;
      selectionText = text;
    },
    restore: () => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete /** @type {any} */ (globalThis)[k];
        else /** @type {any} */ (globalThis)[k] = v;
      }
    },
  };
}

/* ── The regression ─────────────────────────────────────────────────────── */

test("a printable keystroke never clears the selection while the sink is focused", async () => {
  // The whole bug, in one assertion. In Chrome and Safari this call clears the
  // textarea's own caret, so the character that follows goes nowhere.
  const h = await harness();
  try {
    h.kbd.focus();
    for (const ch of "help") h.keydown({ key: ch });
    assert.deepEqual(h.cleared, [], "the sink's selection must be left alone");
  } finally {
    h.restore();
  }
});

test("characters still reach the buffer after a run of keystrokes", async () => {
  const h = await harness();
  try {
    h.kbd.focus();
    for (const ch of "help") {
      h.keydown({ key: ch });
      h.type(ch); // what the browser does when the keystroke is not prevented
    }
    assert.deepEqual(h.inserted, ["h", "e", "l", "p"]);
    assert.equal(h.kbd.value, "", "the sink is drained after every read");
  } finally {
    h.restore();
  }
});

test("a printable keystroke is not prevented, so the character can land", async () => {
  // preventDefault here would stop the `input` event that carries the text --
  // the same dead-keyboard symptom by a different route.
  const h = await harness();
  try {
    h.kbd.focus();
    assert.equal(h.keydown({ key: "x" }), false);
  } finally {
    h.restore();
  }
});

test("typing over a selection made elsewhere does clear it, and takes focus", async () => {
  // The behaviour the removeAllRanges() call was there for in the first place:
  // with focus outside the sink there is no caret to destroy, and a real
  // terminal replaces the selection with the character.
  const h = await harness();
  try {
    h.select("some output");
    assert.equal(h.active.current, null);

    h.keydown({ key: "x" });

    assert.equal(h.cleared.length, 1, "a foreign selection must be cleared");
    assert.equal(h.cleared[0].sinkFocused, false);
    assert.equal(h.active.current, h.kbd, "and the sink must take focus");
  } finally {
    h.restore();
  }
});

test("editing keys are prevented and do not disturb the sink's selection", async () => {
  const h = await harness();
  try {
    h.kbd.focus();
    for (const key of ["ArrowLeft", "Home", "End", "Backspace", "Tab", "Enter"]) {
      assert.equal(h.keydown({ key }), true, `${key} must be prevented`);
    }
    assert.deepEqual(h.cleared, []);
  } finally {
    h.restore();
  }
});

test("Ctrl+C with a selection copies without touching a focused sink", async () => {
  // Copy is the one path that legitimately clears the selection. It still must
  // not do so when the sink owns it, or the abort keystroke would kill typing.
  const h = await harness();
  const savedNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  try {
    /** @type {string[]} */
    const copied = [];
    // Node defines `navigator` as a getter-only global, so plain assignment
    // throws; the property has to be replaced outright and put back after.
    Object.defineProperty(globalThis, "navigator", {
      configurable: true,
      value: { clipboard: { writeText: (s) => (copied.push(s), Promise.resolve()) } },
    });

    h.select("picked text");
    h.keydown({ key: "c", ctrlKey: true });
    assert.deepEqual(copied, ["picked text"]);
    assert.equal(h.cleared.length, 1);
    assert.equal(h.cleared[0].sinkFocused, false);
  } finally {
    if (savedNavigator !== undefined) {
      Object.defineProperty(globalThis, "navigator", savedNavigator);
    } else {
      delete /** @type {any} */ (globalThis).navigator;
    }
    h.restore();
  }
});

test("Meta-modified keys are left entirely to the browser", async () => {
  // Cmd+C, Cmd+A, Cmd+R. Clearing the selection under Cmd+C would break copy on
  // macOS in exactly the browsers this file exists for.
  const h = await harness();
  try {
    h.select("picked text");
    assert.equal(h.keydown({ key: "c", metaKey: true }), false);
    assert.deepEqual(h.cleared, []);
  } finally {
    h.restore();
  }
});
