import { expect, open, test } from "nsh/test";

const URL = "http://hub.test:8787";
const STORAGE = { "hub.url": URL, "hub.token": "tok", "hub.lang": "en" };
const HOST = { host: "jet-pc", caps: ["os:windows", "kb"] };

function network(posts: { text: string }[], hosts: unknown[]) {
  return {
    [`GET ${URL}/api/feed`]: { body: { events: [] } },
    [`GET ${URL}/api/feed?*`]: { body: { events: [] } },
    [`GET ${URL}/api/status`]: { body: { tasks: {}, active: [], decisions: [], recent: [], hosts } },
    [`POST ${URL}/api/messages`]: (r: { body?: string | null }) => {
      const m = JSON.parse(r.body!);
      posts.push(m);
      return { body: { id: `o${posts.length}`, ts: new Date().toISOString(), from: "owner", kind: "owner", text: m.text, client_id: m.client_id } };
    },
  };
}

test("lists the machine with notes and asks the channel to search them", async () => {
  const posts: { text: string }[] = [];
  const app = await open("./App.tsx", { storage: STORAGE, network: network(posts, [HOST, { host: "mac", caps: ["os:macos"] }]), width: 1200, height: 800 });
  await app.press("label:Knowledge base");
  await app.waitFor("id:kb");
  await app.waitFor("jet-pc");
  // Both machines are in the sidebar; only the one with notes is also on the page.
  expect(app.texts().filter((t) => t === "jet-pc").length).toBe(2);
  expect(app.texts().filter((t) => t === "mac").length).toBe(1);
  await app.type("id:kb-query", "sync");
  await app.press("id:kb-search");
  await app.waitFor("id:channel-swipe");
  expect(posts.map((p) => p.text)).toEqual(["在我的笔记里搜：sync"]);
});

test("says how to connect notes when no machine has them", async () => {
  const app = await open("./App.tsx", { storage: STORAGE, network: network([], []), width: 1200, height: 800 });
  await app.press("label:Knowledge base");
  await app.waitFor("No machine has notes connected");
});
