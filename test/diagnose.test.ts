import { expect, test } from "bun:test";
import { withPrimary } from "../src/diagnose";
import { startupLauncher } from "../src/setup";

const toml = `[fleet]
primary = "MacBook-Pro---Jet"            # always-on
[server]
url = "http://MacBook-Pro---Jet:8787"
[cloud]
url = "https://noop.example.workers.dev"
`;

test("switching the primary moves its name and server address and nothing else", () => {
  const next = withPrimary(toml, "jet-pc")!;
  expect(next).toContain('primary = "jet-pc"            # always-on');
  expect(next).toContain('url = "http://jet-pc:8787"');
  expect(next).toContain('url = "https://noop.example.workers.dev"');
  expect(next).not.toContain("MacBook");
});

test("a config that names no primary is left alone", () => {
  expect(withPrimary("[fleet]\nmax = 1\n", "jet-pc")).toBeNull();
});

test("the Startup launcher quotes paths with spaces for VBScript", () => {
  expect(startupLauncher("C:\\Users\\A B\\bun.exe", "C:\\n\\cli.ts")).toBe('CreateObject("WScript.Shell").Run """C:\\Users\\A B\\bun.exe"" ""C:\\n\\cli.ts"" daemon", 0, False\r\n');
});
