import { useCallback, useEffect, useRef, useState } from "react";
import type { FilesBuffer } from "@/files-workbench/filesEditorTypes.js";

export interface FilesEditorTabEntry {
  viewId: string;
  buffer: FilesBuffer;
}

interface DisplayFilesEditorTabEntry extends FilesEditorTabEntry {
  entering: boolean;
  exiting: boolean;
}

const FILES_EDITOR_TAB_TRANSITION_MS = 200;

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true
  );
}

function listenTabFlexTransition(node: HTMLElement, onDone: () => void): () => void {
  let finished = false;
  const finish = (event?: TransitionEvent) => {
    if (event && (event.target !== node || event.propertyName !== "flex-grow")) return;
    if (finished) return;
    finished = true;
    onDone();
  };
  const onTransitionEnd = (event: TransitionEvent) => finish(event);
  node.addEventListener("transitionend", onTransitionEnd);
  const fallback = window.setTimeout(() => finish(), FILES_EDITOR_TAB_TRANSITION_MS + 50);
  return () => {
    node.removeEventListener("transitionend", onTransitionEnd);
    window.clearTimeout(fallback);
  };
}

/** Keep exiting tabs mounted until their width/opacity transition finishes. */
export function useAnimatedFilesEditorTabs(tabs: readonly FilesEditorTabEntry[]) {
  const [displayTabs, setDisplayTabs] = useState<DisplayFilesEditorTabEntry[]>(() =>
    tabs.map((entry) => ({ ...entry, entering: false, exiting: false })),
  );

  useEffect(() => {
    const reducedMotion = prefersReducedMotion();
    setDisplayTabs((previous) => {
      const nextById = new Map(tabs.map((entry) => [entry.viewId, entry]));
      const previousById = new Map(previous.map((entry) => [entry.viewId, entry]));
      const previousIndexById = new Map(previous.map((entry, index) => [entry.viewId, index]));
      const exitingEntries: DisplayFilesEditorTabEntry[] = [];

      for (const entry of previous) {
        if (nextById.has(entry.viewId)) continue;
        if (entry.exiting) {
          exitingEntries.push(entry);
        } else if (!reducedMotion) {
          exitingEntries.push({ ...entry, entering: false, exiting: true });
        }
      }

      const next = tabs.map((entry): DisplayFilesEditorTabEntry => {
        const existing = previousById.get(entry.viewId);
        if (existing) {
          return {
            ...existing,
            ...entry,
            entering: existing.entering,
            exiting: false,
          };
        }
        return { ...entry, entering: !reducedMotion, exiting: false };
      });

      const exitingAtIndex = new Map<number, DisplayFilesEditorTabEntry[]>();
      for (const entry of exitingEntries) {
        const oldIndex = Math.min(previousIndexById.get(entry.viewId) ?? 0, next.length);
        const entriesAtIndex = exitingAtIndex.get(oldIndex) ?? [];
        entriesAtIndex.push(entry);
        exitingAtIndex.set(oldIndex, entriesAtIndex);
      }

      const result: DisplayFilesEditorTabEntry[] = [];
      for (let index = 0; index <= next.length; index += 1) {
        result.push(...(exitingAtIndex.get(index) ?? []));
        const entry = next[index];
        if (entry) result.push(entry);
      }
      return result;
    });
  }, [tabs]);

  const onEnterComplete = useCallback((viewId: string) => {
    setDisplayTabs((previous) =>
      previous.map((entry) =>
        entry.viewId === viewId && entry.entering ? { ...entry, entering: false } : entry,
      ),
    );
  }, []);

  const onExitComplete = useCallback((viewId: string) => {
    setDisplayTabs((previous) =>
      previous.filter((entry) => entry.viewId !== viewId || !entry.exiting),
    );
  }, []);

  return { displayTabs, onEnterComplete, onExitComplete };
}

/** Animate a tab's entry/exit by transitioning flex-grow and opacity over two frames. */
export function useFilesEditorTabAnimation(
  viewId: string,
  entering: boolean,
  exiting: boolean,
  onEnterComplete: (viewId: string) => void,
  onExitComplete: (viewId: string) => void,
) {
  const tabRef = useRef<HTMLDivElement | null>(null);
  const [enterActive, setEnterActive] = useState(false);
  const [exitActive, setExitActive] = useState(false);

  useEffect(() => {
    if (!entering) {
      setEnterActive(false);
      return;
    }
    if (prefersReducedMotion()) {
      onEnterComplete(viewId);
      return;
    }
    const frame = window.requestAnimationFrame(() => setEnterActive(true));
    return () => window.cancelAnimationFrame(frame);
  }, [entering, onEnterComplete, viewId]);

  useEffect(() => {
    if (!entering || !enterActive) return;
    const node = tabRef.current;
    if (!node || prefersReducedMotion()) {
      onEnterComplete(viewId);
      return;
    }
    return listenTabFlexTransition(node, () => onEnterComplete(viewId));
  }, [enterActive, entering, onEnterComplete, viewId]);

  useEffect(() => {
    if (!exiting) {
      setExitActive(false);
      return;
    }
    if (prefersReducedMotion()) {
      onExitComplete(viewId);
      return;
    }
    const frame = window.requestAnimationFrame(() => setExitActive(true));
    return () => window.cancelAnimationFrame(frame);
  }, [exiting, onExitComplete, viewId]);

  useEffect(() => {
    if (!exiting || !exitActive) return;
    const node = tabRef.current;
    if (!node || prefersReducedMotion()) {
      onExitComplete(viewId);
      return;
    }
    return listenTabFlexTransition(node, () => onExitComplete(viewId));
  }, [exitActive, exiting, onExitComplete, viewId]);

  return {
    tabRef,
    collapsed: (entering && !enterActive) || (exiting && exitActive),
  };
}
