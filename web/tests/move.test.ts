import { expect, test } from "bun:test";
import { clearDraft, loadDraft, moveDrafts, saveDraft, type Draft } from "../src/lib/draft";
import { getFavorites, getRecents, moveRecentPages, pushRecent, toggleFavorite } from "../src/lib/recents";
import { followPageMove } from "../src/lib/actions";
import { useStore } from "../src/store";

test("moving a subtree relocates local records and preserves drafts", () => {
  const storage: Record<string, string> = {};
  Object.defineProperties(storage, {
    getItem: { value: (k: string) => storage[k] ?? null },
    setItem: { value: (k: string, v: string) => { storage[k] = v; } },
    removeItem: { value: (k: string) => { delete storage[k]; } },
  });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: storage });
  const draft: Draft = { title: "unsaved", body: "keep content", meta: { tags: [], draft: false, date: "", description: "" }, baseSha: "original", at: 1 };
  saveDraft("wiki", "b/c", draft);
  saveDraft("other", "b/c", draft);
  toggleFavorite("wiki", "b/c", "C");
  pushRecent("wiki", "b", "B");
  pushRecent("wiki", "bx", "unrelated");
  const move = (from: string, to: string) => { moveDrafts("wiki", from, to); moveRecentPages("wiki", from, to); };
  move("b", "a/b");
  move("b", "a/b"); // WebSocket and HTTP response may both report the same move
  expect(loadDraft("wiki", "a/b/c")).toEqual(draft);
  expect(loadDraft("wiki", "b/c")).toBeNull();
  expect(loadDraft("other", "b/c")).toEqual(draft);
  expect(getFavorites("wiki")[0].page).toBe("a/b/c");
  expect(getRecents("wiki").map(e => e.page)).toEqual(["bx", "a/b"]);
  move("a/b", "b");
  move("b", "a/b");
  expect(loadDraft("wiki", "a/b/c")).toEqual(draft);
  saveDraft("wiki", "destination/c", { ...draft, body: "existing" });
  expect(() => move("a/b", "destination")).toThrow("已有本机草稿");
  expect(loadDraft("wiki", "a/b/c")).toEqual(draft);
  expect(loadDraft("wiki", "destination/c")?.body).toBe("existing");
  clearDraft("wiki", "a/b/c");
  expect(loadDraft("wiki", "a/b/c")).toBeNull();

  const events = new EventTarget();
  Object.defineProperty(globalThis, "window", { configurable: true, value: events });
  events.addEventListener("gitwiki:page-moved", () => saveDraft("wiki", "new/c", draft));
  useStore.setState({ currentRepo: "wiki", currentPageId: "old/c", dirty: true });
  followPageMove("wiki", "old", "new");
  expect(useStore.getState().currentPageId).toBe("new/c");
  expect(loadDraft("wiki", "new/c")).toEqual(draft);
  useStore.setState({ currentPageId: "unrelated", dirty: true });
  followPageMove("wiki", "old", "new");
  expect(useStore.getState().currentPageId).toBe("unrelated");
  expect(useStore.getState().dirty).toBe(true);
  expect(useStore.getState().lastSavedBy).toBe("");
});
