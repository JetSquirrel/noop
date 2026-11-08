import { expect, open, test } from "nsh/test";

const URL = "http://hub.test:8787";
const STORAGE = { "hub.url": URL, "hub.token": "tok", "hub.lang": "en" };
const PATH = "reports/study/T-0123-Sync.md";
const LESSON = `---
title: Sync
project: noop
---
# Sync

How the file sync works.

## 自测
Q: Why compare-and-swap?
A: So only one machine claims a task.
`;

function network(posts: { text: string }[]) {
  return {
    [`GET ${URL}/api/feed`]: { body: { events: [] } },
    [`GET ${URL}/api/feed?*`]: { body: { events: [] } },
    [`GET ${URL}/api/status`]: { body: { tasks: {}, active: [], decisions: [], recent: [], hosts: [] } },
    [`GET ${URL}/api/files/list?*`]: { body: { files: [{ path: PATH, size: 10, updated: 100, version: 1 }] } },
    [`GET ${URL}/api/files/read?*`]: { body: { path: PATH, content: LESSON, size: 10, updated: 100, version: 1 } },
    [`POST ${URL}/api/messages`]: (r: { body?: string | null }) => {
      const m = JSON.parse(r.body!);
      posts.push(m);
      return { body: { id: `o${posts.length}`, ts: new Date().toISOString(), from: "owner", kind: "owner", text: m.text, client_id: m.client_id } };
    },
  };
}

test("asks for a lesson with the chosen project and angle", async () => {
  const posts: { text: string }[] = [];
  const app = await open("./App.tsx", { storage: STORAGE, network: network(posts), width: 1200, height: 800 });
  await app.press("label:Study");
  await app.waitFor("id:study");
  await app.type("id:study-project", "noop");
  await app.type("id:study-topic", "file sync");
  await app.press("id:study-mode-design");
  await app.press("id:study-start");
  await app.waitFor("id:study-note");
  expect(posts.map((p) => p.text)).toEqual(["/study mode=design project=noop file sync"]);
});

test("will not send an empty request", async () => {
  const posts: { text: string }[] = [];
  const app = await open("./App.tsx", { storage: STORAGE, network: network(posts), width: 1200, height: 800 });
  await app.press("label:Study");
  await app.press("id:study-start");
  await app.waitFor("id:study-note");
  expect(posts).toEqual([]);
});

test("reads a lesson, keeps the answer hidden until asked, and remembers it was finished", async () => {
  const app = await open("./App.tsx", { storage: STORAGE, network: network([]), width: 1200, height: 800 });
  await app.press("label:Study");
  await app.press("id:lesson-T-0123");
  await app.waitFor("id:study-lesson");
  await app.waitFor("How the file sync works.");
  expect(app.shows("id:quiz-answer-0")).toBe(false);
  await app.press("id:quiz-show-0");
  await app.waitFor("id:quiz-answer-0");
  await app.press("id:study-finish");
  expect(JSON.parse(app.storage()["hub.study.done"])).toEqual([PATH]);
});
