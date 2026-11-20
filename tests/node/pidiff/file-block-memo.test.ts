/**
 * Verify memoized prepareDiffFiles, comment/form pre-grouping, and FileBlock React.memo (#1183).
 */
import { register } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import React, { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { installReactDomShim } from "./react-dom-shim.mjs";

const here = dirname(fileURLToPath(import.meta.url));
register(pathToFileURL(join(here, "pierre-mock-loader.mjs")).href);

(globalThis as { React?: typeof React }).React = React;
const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
Object.defineProperty(globalThis, "navigator", {
  configurable: true,
  value: { hardwareConcurrency: 2 } as Navigator,
});
after(() => {
  if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
  else delete (globalThis as { navigator?: Navigator }).navigator;
});
if (!globalThis.window) {
  globalThis.window = { location: { protocol: "http:", host: "localhost" } } as Window & typeof globalThis;
}
if (!globalThis.Worker) {
  globalThis.Worker = class { constructor() {} } as unknown as typeof Worker;
}
if (!globalThis.WebSocket) {
  globalThis.WebSocket = class {
    static OPEN = 1;
    readyState = 0;
    send() {}
    close() {}
  } as unknown as typeof WebSocket;
}

const {
  FileBlock,
  groupCommentsByFile,
  groupOpenFormsByFile,
  prepareDiffFiles,
} = await import("../../../extensions/pidiff/pidiff-ui/src/App.tsx");

describe("prepareDiffFiles", () => {
  it("sorts directories before root files and precomputes cacheKey on FileContents", () => {
    const prepared = prepareDiffFiles([
      { name: "z.ts", status: "modified", oldContents: "a", newContents: "b", area: "committed" },
      { name: "src/b.ts", status: "modified", oldContents: "old", newContents: "new", area: "staged" },
      { name: "src/a.ts", status: "added", oldContents: "", newContents: "hi", area: "unstaged" },
    ]);

    assert.deepEqual(prepared.map(f => f.path), ["src/a.ts", "src/b.ts", "z.ts"]);
    assert.equal(prepared[0].area, "unstaged");
    assert.equal(prepared[1].area, "staged");
    assert.equal(prepared[2].area, undefined);
    assert.ok(prepared[1].oldFile.cacheKey?.startsWith("src/b.ts:"));
    assert.ok(prepared[1].newFile.cacheKey?.startsWith("src/b.ts:"));
    assert.notEqual(prepared[1].oldFile.cacheKey, prepared[1].newFile.cacheKey);
  });
});

describe("groupCommentsByFile and groupOpenFormsByFile", () => {
  it("excludes resolved comments while preserving original globalIndex", () => {
    const comments = [
      { file: "a.ts", line: 1, side: "new" as const, body: "c0", resolved: true },
      { file: "b.ts", line: 2, side: "new" as const, body: "c1" },
      { file: "a.ts", line: 3, side: "old" as const, body: "c2" },
    ];
    const byFile = groupCommentsByFile(comments);
    assert.deepEqual(byFile.get("a.ts")?.map(x => x.globalIndex), [2]);
    assert.deepEqual(byFile.get("b.ts")?.map(x => x.globalIndex), [1]);

    const formsByFile = groupOpenFormsByFile([
      { file: "a.ts", side: "additions", lineNumber: 5 },
    ]);
    assert.equal(formsByFile.get("a.ts")?.length, 1);
    assert.equal(formsByFile.get("b.ts"), undefined);
  });
});

describe("FileBlock memoization", () => {
  it("skips re-rendering unchanged files when parent renders or another file gets a comment", async () => {
    const container = installReactDomShim();
    const prepared = prepareDiffFiles([
      { name: "a.ts", status: "modified", oldContents: "1", newContents: "2", area: "unstaged" },
      { name: "b.ts", status: "modified", oldContents: "3", newContents: "4", area: "unstaged" },
    ]);
    const renders = new Map<string, number>([["a.ts", 0], ["b.ts", 0]]);
    const emptyComments: never[] = [];
    const emptyForms: never[] = [];
    const noop = () => {};
    const prevHook = (globalThis as any).__onMultiFileDiffRender;
    (globalThis as any).__onMultiFileDiffRender = (props: { oldFile?: { name?: string } }) => {
      const name = props?.oldFile?.name;
      if (name) renders.set(name, (renders.get(name) ?? 0) + 1);
    };

    function Harness({
      tick,
      commentsA,
    }: {
      tick: number;
      commentsA: ReadonlyArray<{ comment: any; globalIndex: number }>;
    }) {
      return createElement(
        "div",
        { "data-tick": tick },
        ...prepared.map((f) =>
          createElement(FileBlock, {
            key: f.key,
            oldFile: f.oldFile,
            newFile: f.newFile,
            path: f.path,
            diffStyle: "split",
            diffIndicators: "bars",
            lineDiffType: "word-alt",
            disableBackground: false,
            overflow: "scroll",
            disableLineNumbers: false,
            hunkSeparators: "line-info",
            fontSize: 13,
            theme: "pierre-dark",
            area: f.area,
            comments: f.path === "a.ts" ? commentsA : emptyComments,
            openForms: emptyForms,
            hasOpenForm: false,
            onAddCommentForm: noop,
            onSubmitComment: noop,
            onCancelCommentForm: noop,
            onEditComment: noop,
            onDeleteComment: noop,
            onResolveComment: noop,
            onReplyComment: noop,
          }),
        ),
      );
    }

    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(createElement(Harness, { tick: 1, commentsA: emptyComments }));
      });
      assert.deepEqual(Object.fromEntries(renders), { "a.ts": 1, "b.ts": 1 });

      // Parent re-renders with new tick and a comment only for a.ts — b.ts must NOT re-render.
      await act(async () => {
        root.render(createElement(Harness, {
          tick: 2,
          commentsA: [{ comment: { file: "a.ts", line: 1, side: "new", body: "hi" }, globalIndex: 0 }],
        }));
      });
      assert.equal(renders.get("a.ts"), 2);
      assert.equal(renders.get("b.ts"), 1, "unchanged FileBlock skipped via React.memo");
    } finally {
      (globalThis as any).__onMultiFileDiffRender = prevHook;
      await act(async () => { root.unmount(); });
    }
  });
});
