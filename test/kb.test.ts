import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATA, HOME_DIR, hostCaps } from "../src/core";
import { type KbConfig, indexKb, kbConfig, kbPrompt, kbStatus, readSy, searchKb, setLocalSection, setupKb, showKb } from "../src/kb";

const root = mkdtempSync(join(tmpdir(), "kb-test-"));
const data = join(root, "data");
const NB = "20230313095926-42o3ho0", OTHER = "20220626095229-80lsh43";

const text = (t: string) => ({ Type: "NodeText", Data: t });
const para = (t: string) => ({ Type: "NodeParagraph", Children: [text(t)] });
const heading = (id: string, t: string) => ({ ID: id, Type: "NodeHeading", Children: [text(t)] });
const sy = (id: string, title: string, children: unknown[]) => JSON.stringify({ ID: id, Type: "NodeDocument", Properties: { id, title, updated: "20260101000000" }, Children: children });

function put(rel: string, content: string) {
  const f = join(data, rel);
  mkdirSync(join(f, ".."), { recursive: true });
  writeFileSync(f, content);
  return f;
}
for (const [dir, name] of [[NB, "知识库"], [OTHER, "Archive"]]) put(`${dir}/.siyuan/conf.json`, JSON.stringify({ name }));
const parentId = "20240101000000-aaaaaaa", childId = "20240101000001-bbbbbbb";
put(`${NB}/${parentId}.sy`, sy(parentId, "分布式系统", [para("顶层笔记")]));
const childFile = put(`${NB}/${parentId}/${childId}.sy`, sy(childId, "同步协议", [para("开场白"), heading("20240101000002-ccccccc", "比较并交换"), para("每个路径用 base_version 做 CAS 锁"), { Type: "NodeCodeBlock", Children: [{ Type: "NodeCodeBlockFenceInfoMarker", CodeBlockInfo: "dHM=" }, { Type: "NodeCodeBlockCode", Data: "commitPush(state)" }] }]));
put(`${NB}/20240101000003-ddddddd.sy`, sy("20240101000003-ddddddd", "杂记", [{ Type: "NodeParagraph", Children: [{ Type: "NodeTextMark", TextMarkType: "strong", TextMarkTextContent: "架构" }, text(" 随手记 100%_done")] }]));
put(`${NB}/20240101000004-eeeeeee.sy`, "{ not json");
put(`${OTHER}/20240101000005-fffffff.sy`, sy("20240101000005-fffffff", "旧归档", [para("架构 归档内容")]));

const kb: KbConfig = { data, notebooks: ["知识库"] };
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("reading a note", () => {
  test("cuts at headings and keeps code, marks and tables, but no picture alt text or embed queries", () => {
    const r = readSy({ ID: "d", Type: "NodeDocument", Properties: { title: "T" }, Children: [
      para("前言"),
      { ID: "h1", Type: "NodeHeading", Children: [text("第一节")] },
      { Type: "NodeParagraph", Children: [{ Type: "NodeTextMark", TextMarkTextContent: "重点" }, { Type: "NodeImage", Children: [{ Type: "NodeLinkText", Data: "配图说明" }] }] },
      { Type: "NodeBlockQueryEmbed", Children: [{ Type: "NodeText", Data: "SELECT *" }] },
      { Type: "NodeTable", Children: [{ Type: "NodeTableRow", Children: [{ Type: "NodeTableCell", Children: [text("甲")] }, { Type: "NodeTableCell", Children: [text("乙")] }] }] },
    ] } as any);
    expect(r.title).toBe("T");
    expect(r.chunks.map((c) => [c.heading, c.blockId])).toEqual([["", "d"], ["第一节", "h1"]]);
    expect(r.chunks[1].text).toContain("重点");
    expect(r.chunks[1].text).toContain("甲 | 乙");
    expect(r.chunks[1].text).not.toContain("配图说明");
    expect(r.chunks[1].text).not.toContain("SELECT");
  });

  test("splits a very long section", () => {
    const long = Array.from({ length: 400 }, (_, i) => `第 ${i} 行内容内容内容`).join("\n");
    const r = readSy({ ID: "d", Type: "NodeDocument", Properties: { title: "T" }, Children: [para(long)] } as any);
    expect(r.chunks.length).toBeGreaterThan(1);
    expect(r.chunks.every((c) => c.text.length <= 1600)).toBe(true);
  });
});

describe("index and search", () => {
  test("indexes only the chosen notebooks, skips a broken note, and builds the readable path", () => {
    const r = indexKb(kb, true);
    expect(r).toMatchObject({ docs: 3, changed: 3, failed: 1 });
    expect(kbStatus().notebooks).toEqual({ 知识库: 3 });
    expect(searchKb(kb, "base_version")[0]).toMatchObject({ title: "同步协议", path: "知识库/分布式系统/同步协议", heading: "比较并交换", link: "siyuan://blocks/20240101000002-ccccccc" });
  });

  test("finds two-character Chinese words, text marks and code, and never another notebook", () => {
    const hits = searchKb(kb, "架构");
    expect(hits.map((h) => h.title)).toEqual(["杂记"]);
    expect(searchKb(kb, "commitPush")[0].title).toBe("同步协议");
  });

  test("% and _ are ordinary characters", () => {
    expect(searchKb(kb, "100%_done").map((h) => h.title)).toEqual(["杂记"]);
    expect(searchKb(kb, "100_%done")).toEqual([]);
  });

  test("falls back to any word when no section has them all, ranking title matches first", () => {
    const hits = searchKb(kb, "同步协议 架构");
    expect(hits[0].title).toBe("同步协议");
    expect(hits.map((h) => h.title)).toContain("杂记");
  });

  test("shows a note by document or block id", () => {
    const byDoc = showKb(kb, childId)!;
    expect(byDoc.title).toBe("同步协议");
    expect(byDoc.text).toContain("## 比较并交换");
    expect(showKb(kb, "20240101000002-ccccccc")!.id).toBe(childId);
    expect(showKb(kb, "nope")).toBeNull();
  });

  test("re-reads only what changed and drops what was deleted", () => {
    expect(indexKb(kb).changed).toBe(0);
    writeFileSync(childFile, sy(childId, "同步协议", [para("改写后的内容 乐观锁")]));
    utimesSync(childFile, new Date(), new Date(Date.now() + 5000));
    expect(indexKb(kb).changed).toBe(1);
    expect(searchKb(kb, "乐观锁")).toHaveLength(1);
    expect(searchKb(kb, "base_version")).toEqual([]);
    rmSync(childFile);
    expect(indexKb(kb)).toMatchObject({ removed: 1, docs: 2 });
  });

  test("the index lives outside the synced data folder", () => {
    expect(existsSync(join(HOME_DIR, "kb", "index.sqlite"))).toBe(true);
    expect(join(HOME_DIR, "kb").startsWith(DATA)).toBe(false);
  });
});

describe("configuration", () => {
  test("a machine has a knowledge base only when its folder exists", () => {
    expect(kbConfig({})).toBeNull();
    expect(kbConfig({ kb: { siyuan_dir: join(root, "missing") } })).toBeNull();
    expect(kbConfig({ kb: { siyuan_dir: root, notebooks: ["知识库"] } })).toEqual(kb);
  });

  test("a machine with one advertises the capability and tells its agents", () => {
    const cfg = { kb: { siyuan_dir: root } };
    expect(hostCaps(cfg)).toContain("kb");
    expect(hostCaps({})).not.toContain("kb");
    expect(kbPrompt(cfg)).toContain("kb search");
    expect(kbPrompt({})).toBe("");
  });

  test("setup rejects an unknown notebook and writes only its own section", () => {
    mkdirSync(DATA, { recursive: true });
    const file = join(DATA, "config.local.toml");
    writeFileSync(file, "[host]\n# name = \"x\"\n\n[notify]\nslack = \"y\"\n");
    expect(() => setupKb(root, ["不存在"])).toThrow("no such notebook");
    setupKb(root, ["知识库"]);
    setupKb(root, ["知识库", "Archive"]);
    setLocalSection("study", 'project_dirs = ["E:/proj"]');
    const toml = readFileSync(file, "utf8");
    expect(toml.match(/\[kb\]/g)).toHaveLength(1);
    expect(toml).toContain('notebooks = ["知识库","Archive"]');
    expect(toml).toContain('slack = "y"');
    expect(toml).toContain('project_dirs = ["E:/proj"]');
    rmSync(file);
  });
});
