import { expect, test } from "bun:test";
import { parseLesson, studyCommand, studyItems } from "../app/study";
import { parseStudyCommand } from "../src/study";

test("lists lessons newest first, taking titles from file names and ignoring anything else", () => {
  expect(studyItems([
    { path: "reports/study/T-0002-同步层如何工作.md", updated: 100 },
    { path: "reports/study/T-M0003-CAS.md", updated: 200 },
    { path: "reports/study/随手.md", updated: 50 },
    { path: "reports/study/notes.txt", updated: 300 },
    { path: "reports/daily/2026-11-09.md", updated: 400 },
  ])).toEqual([
    { path: "reports/study/T-M0003-CAS.md", id: "T-M0003", title: "CAS", updated: 200 },
    { path: "reports/study/T-0002-同步层如何工作.md", id: "T-0002", title: "同步层如何工作", updated: 100 },
    { path: "reports/study/随手.md", id: "", title: "随手", updated: 50 },
  ]);
});

const LESSON = `---
title: 同步层
project: noop
mode: architecture
---
# 同步层

结论。

## 全局图
图。

## 自测
Q: 为什么用 CAS？
A: 防止两台机器同时认领。
见 \`_claim\`。
Q：第二题
A：第二个答案
Q: 没有答案的题
`;

test("splits off the quiz, hides nothing else, and tolerates full-width colons and multi-line answers", () => {
  const l = parseLesson(LESSON);
  expect(l).toMatchObject({ title: "同步层", project: "noop", mode: "architecture" });
  expect(l.body).toContain("## 全局图");
  expect(l.body).not.toContain("自测");
  expect(l.quiz).toEqual([{ q: "为什么用 CAS？", a: "防止两台机器同时认领。\n见 `_claim`。" }, { q: "第二题", a: "第二个答案" }]);
});

test("a lesson without a quiz or front matter still reads", () => {
  expect(parseLesson("# 标题\n\n正文")).toMatchObject({ title: "标题", quiz: [], body: "# 标题\n\n正文" });
});

test("what the page sends is what the primary parses", () => {
  const sent = studyCommand({ topic: "同步 层", project: " noop ", mode: "design" })!;
  expect(sent).toBe("/study mode=design project=noop 同步 层");
  expect(parseStudyCommand(sent)).toEqual({ topic: "同步 层", project: "noop", mode: "design" });
  expect(studyCommand({ topic: " ", project: "", mode: "auto" })).toBeNull();
  expect(studyCommand({ topic: "CAS", project: "", mode: "auto" })).toBe("/study CAS");
});
