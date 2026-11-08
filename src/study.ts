// Study: the tutor agent explains a project (its architecture, design, technical choices) or what the agents did in it,
// from the code, the fleet's history and the owner's notes. A lesson is a Markdown file under reports/study/, which the
// app can already read, so this needs no Worker change. Format and method live in templates/agents/tutor/profile.md.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import type { Cfg } from "./core";

export const STUDY_MODES = ["auto", "architecture", "design", "tech", "activity"] as const;
export type StudyMode = (typeof STUDY_MODES)[number];
export type StudyRequest = { topic: string; project?: string; mode: StudyMode };

const FOCUS: Record<StudyMode, string> = {
  auto: "Pick whichever angle best answers the request.",
  architecture: "Focus on the architecture: components and their responsibilities, how data and control flow between them, boundaries, and why it is shaped this way.",
  design: "Focus on the design: the problem being solved, the options that existed, what was chosen, the trade-offs, and what the design makes easy or hard.",
  tech: "Focus on the technical solution: the key mechanisms, data structures, protocols and algorithms, traced through the real code.",
  activity: "Focus on what the agents actually did: go through tasks/done, tasks/failed, the journal, reviews and the git history, then explain what changed, why, how it was decided, and what is worth learning from it.",
};

const expand = (p: string) => resolve(p.replace(/^~/, homedir()));

/** `/study mode=design project=noop how sync works`. Null when the text is not a study command. */
export function parseStudyCommand(text: string): StudyRequest | null {
  const m = /^\/study(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  let rest = (m[1] ?? "").trim(), project: string | undefined, mode: StudyMode = "auto";
  for (;;) {
    const opt = /^(mode|project)=(\S+)\s*/.exec(rest);
    if (!opt) break;
    if (opt[1] === "project") project = opt[2];
    else if ((STUDY_MODES as readonly string[]).includes(opt[2])) mode = opt[2] as StudyMode;
    rest = rest.slice(opt[0].length);
  }
  return rest || project ? { topic: rest, project, mode } : null;
}

/** A local checkout of the project on this machine: an absolute path, or a folder in one of the project directories. */
export function findProject(cfg: Cfg, project: string | undefined): string | null {
  if (!project) return null;
  if (isAbsolute(project) || project.startsWith("~")) return existsSync(expand(project)) ? expand(project) : null;
  if (project.includes("..") || /[\\/]/.test(project.replace(/^[\w.-]+\/(?=[\w.-]+$)/, ""))) return null;
  const name = project.split("/").pop()!;
  for (const dir of [...(cfg.study?.project_dirs ?? []), ...(cfg.resources?.work_dirs ?? []), join(homedir(), "work")]) {
    const candidate = join(expand(String(dir)), name);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

export type StudyPlace = { repo?: string; host?: string; prefer?: string };
export type StudyTask = StudyPlace & { title: string; body: string; agent: "tutor" };

/** Where a lesson runs. A checkout only exists on one machine, so it runs there; otherwise it prefers the machine with the notes. */
export function studyPlace(cfg: Cfg, project: string | undefined, host: string): StudyPlace {
  const local = findProject(cfg, project);
  return local ? { repo: local, host } : { ...(project ? { repo: project } : {}), prefer: "kb" };
}

export function studyTask(cfg: Cfg, req: StudyRequest, host: string): StudyTask {
  const local = findProject(cfg, req.project);
  const about = req.topic || req.project || "";
  return {
    title: `学习：${[req.project, req.topic].filter(Boolean).join(" · ").slice(0, 70) || about}`,
    agent: "tutor",
    body: [
      `The owner wants to learn: ${about}`,
      req.project ? `Project: ${local ?? req.project}` : "",
      `Angle: ${req.mode}. ${FOCUS[req.mode]}`,
      "Teach it as described in your profile and write the lesson file it specifies.",
    ].filter(Boolean).join("\n\n"),
    ...studyPlace(cfg, req.project, host),
  };
}
