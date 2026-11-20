import { createElement } from "react";

export function MultiFileDiff(props) {
  if (typeof globalThis.__onMultiFileDiffRender === "function") {
    globalThis.__onMultiFileDiffRender(props);
  }
  return null;
}

export function WorkerPoolContextProvider({ children }) {
  return children ?? null;
}
