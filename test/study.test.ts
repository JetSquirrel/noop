import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findProject, parseStudyCommand, studyTask } from "../src/study";

const dir = mkdtempSync(join(tmpdir(), "study-test-"));
mkdirSync(join(dir, "noop"));
const cfg = { study: { project_dirs: [dir] } };
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("parses the study command and leaves everything else alone", () => {
  expect(parseStudyCommand("/study mode=design project=noop 同步层")).toEqual({ topic: "同步层", project: "noop", mode: "design" });
  expect(parseStudyCommand("/study 什么是 CAS")).toEqual({ topic: "什么是 CAS", project: undefined, mode: "auto" });
  expect(parseStudyCommand("/study project=noop")).toEqual({ topic: "", project: "noop", mode: "auto" });
  expect(parseStudyCommand("/study mode=bogus 话题")).toEqual({ topic: "话题", project: undefined, mode: "auto" });
  expect(parseStudyCommand("/study")).toBeNull();
  expect(parseStudyCommand("/studying x")).toBeNull();
  expect(parseStudyCommand("帮我 /study x")).toBeNull();
});

test("finds a checkout by name, by owner/name and by path, and refuses to leave the project folders", () => {
  const local = join(dir, "noop");
  expect(findProject(cfg, "noop")).toBe(local);
  expect(findProject(cfg, "JetSquirrel/noop")).toBe(local);
  expect(findProject(cfg, local)).toBe(local);
  expect(findProject(cfg, "missing")).toBeNull();
  expect(findProject(cfg, "../noop")).toBeNull();
  expect(findProject(cfg, undefined)).toBeNull();
});

test("a lesson on a local checkout runs on this machine; otherwise it prefers the one with the notes", () => {
  expect(studyTask(cfg, { topic: "同步", project: "noop", mode: "architecture" }, "jet-pc")).toMatchObject({ agent: "tutor", repo: join(dir, "noop"), host: "jet-pc", title: "学习：noop · 同步" });
  const elsewhere = studyTask(cfg, { topic: "同步", project: "acme/widget", mode: "activity" }, "jet-pc");
  expect(elsewhere).toMatchObject({ repo: "acme/widget", prefer: "kb" });
  expect(elsewhere.host).toBeUndefined();
  expect(elsewhere.body).toContain("tasks/done");
  expect(studyTask(cfg, { topic: "CAS", mode: "auto" }, "jet-pc")).toMatchObject({ prefer: "kb", title: "学习：CAS" });
});
