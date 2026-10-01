export function formatRelativeTime(when?: string | number): string {
  if (!when) return "";
  const t = new Date(when).getTime();
  if (!t) return "";
  const min = Math.floor((Date.now() - t) / 60000);
  if (min < 1) return "刚刚";
  if (min < 60) return `${min} 分钟前`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} 天前`;
  return new Date(t).toLocaleDateString();
}

// Uploaded files are stored with a content hash in their name ("notes-0d94338dc05f.txt");
// people know a file by the name they uploaded it under.
export function attachmentName(stored: string): string {
  return stored.replace(/-[0-9a-f]{8}(?:[0-9a-f]{4})?(?=\.[^.]*$|$)/, "");
}

// The commit messages gitwiki writes ("wiki: update <id>") as what happened to the page.
const actions: [RegExp, string][] = [
  [/^wiki: new page/, "新建了页面"],
  [/^wiki: update/, "编辑了内容"],
  [/^wiki: rename/, "改了标题"],
  [/^wiki: add asset/, "上传了附件"],
  [/^wiki: delete asset/, "删除了附件"],
  [/^wiki: delete/, "删除了页面"],
  [/^wiki: move/, "移动了页面"],
  [/^wiki: restore .+ to /, "恢复了旧版本"],
  [/^wiki: restore/, "恢复了页面"],
];

// changeLabel says what a change did to the page, in readers' terms. Changes made outside the
// wiki only carry a commit message written for developers, so they read as a plain edit.
export function changeLabel(message: string, linksOnly = false): string {
  if (linksOnly) return "更新了链接";
  return actions.find(([re]) => re.test(message))?.[1] ?? "修改了页面";
}
